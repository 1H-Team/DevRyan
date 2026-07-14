import crypto from 'node:crypto';
import http from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const QUESTION_SERVER_NAME = 'devryan_question';
const ELIGIBLE_AGENTS = new Set(['builder', 'orchestrator']);

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const createOpaqueId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

const questionOptionSchema = z.object({
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000),
}).strict();

const questionSchema = z.object({
  header: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(4000),
  options: z.array(questionOptionSchema).min(2).max(3),
  multiple: z.boolean().optional(),
}).strict();

const questionToolInputSchema = {
  questions: z.array(questionSchema).min(1).max(3),
};

const writeJson = (res, status, body) => {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBoundedJsonBody = (req, maxBodyBytes) => new Promise((resolve, reject) => {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    req.resume();
    reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
    return;
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', reject);
  req.on('end', () => {
    if (tooLarge) {
      reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
    }
  });
});

const bearerMatches = (authorization, expectedToken) => {
  const prefix = 'Bearer ';
  if (typeof authorization !== 'string' || !authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
};

const createAnsweredResult = (request, answers) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      status: 'answered',
      answers: request.questions.map((question, index) => ({
        question: question.question,
        answers: answers[index],
      })),
    }),
  }],
});

const createSkippedResult = () => ({
  content: [{
    type: 'text',
    text: 'The user skipped this question. Continue using your best judgment and state the assumption you make.',
  }],
});

const createCancelledResult = (reason) => ({
  content: [{
    type: 'text',
    text: `The question was cancelled because ${trimString(reason) || 'the Cursor run ended'}.`,
  }],
  isError: true,
});

const normalizeAnswers = (request, answers) => {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) {
    throw new TypeError('Answers must contain one ordered entry for each question.');
  }
  return answers.map((answer) => {
    if (!Array.isArray(answer)) {
      throw new TypeError('Each question answer must be an array of strings.');
    }
    const normalized = answer.map(trimString).filter(Boolean);
    if (normalized.length === 0) {
      throw new TypeError('Each question requires at least one answer.');
    }
    return normalized;
  });
};

export const isCursorQuestionAgent = (agent) => ELIGIBLE_AGENTS.has(trimString(agent).toLowerCase());

export function createCursorQuestionRuntime(options = {}) {
  const emitEvent = typeof options.emitEvent === 'function' ? options.emitEvent : () => {};
  const logger = options.logger || console;
  const createHttpServer = typeof options.createHttpServer === 'function'
    ? options.createHttpServer
    : (handler) => http.createServer(handler);
  const maxBodyBytes = Math.max(256, Number(options.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES);
  const instanceID = createOpaqueId('bridge');
  const scopesBySession = new Map();
  const scopesByPath = new Map();
  const pendingById = new Map();
  let server = null;
  let startPromise = null;
  let origin = '';
  let expectedHost = '';
  let disposed = false;

  const emit = (event, directory) => {
    emitEvent(event, { directory: trimString(directory) || undefined });
  };

  const settlePending = (pending, result, event) => {
    if (!pendingById.delete(pending.request.id)) return false;
    if (event) emit(event, pending.directory);
    pending.resolve(result);
    return true;
  };

  const cancelPendingQuestions = ({ sessionID, messageID, reason }) => {
    const normalizedSessionID = trimString(sessionID);
    const normalizedMessageID = trimString(messageID);
    let cancelled = 0;
    for (const pending of [...pendingById.values()]) {
      if (pending.request.sessionID !== normalizedSessionID) continue;
      if (normalizedMessageID && pending.messageID !== normalizedMessageID) continue;
      if (settlePending(
        pending,
        createCancelledResult(reason),
        {
          type: 'question.rejected',
          properties: { sessionID: pending.request.sessionID, requestID: pending.request.id },
        },
      )) {
        cancelled += 1;
      }
    }
    return cancelled;
  };

  const createMcpServer = (scope, requestSignal) => {
    const mcpServer = new McpServer({
      name: 'devryan-cursor-question',
      version: '1.0.0',
    });
    mcpServer.registerTool('question', {
      title: 'Ask the user a clarifying question',
      description: 'Ask when unresolved user-answerable ambiguity remains. This call waits for the user to answer or skip.',
      inputSchema: questionToolInputSchema,
    }, async ({ questions }, extra) => {
      if (disposed) return createCancelledResult('the question bridge was disposed');
      if (scope.revoked) return createCancelledResult('the question scope was superseded');

      const request = {
        id: createOpaqueId('que'),
        sessionID: scope.sessionID,
        questions,
        tool: {
          messageID: scope.messageID,
          callID: createOpaqueId('call'),
        },
      };
      let pending;
      const result = new Promise((resolve) => {
        pending = {
          request,
          directory: scope.directory,
          messageID: scope.messageID,
          resolve,
        };
        pendingById.set(request.id, pending);
      });
      const handleAbort = () => settlePending(
        pending,
        createCancelledResult('the MCP request disconnected'),
        {
          type: 'question.rejected',
          properties: { sessionID: request.sessionID, requestID: request.id },
        },
      );
      const abortSignals = [extra?.signal, requestSignal].filter(Boolean);
      for (const signal of abortSignals) {
        signal.addEventListener?.('abort', handleAbort, { once: true });
      }
      emit({ type: 'question.asked', properties: request }, scope.directory);
      if (abortSignals.some((signal) => signal.aborted)) handleAbort();
      return result.finally(() => {
        for (const signal of abortSignals) {
          signal.removeEventListener?.('abort', handleAbort);
        }
      });
    });
    return mcpServer;
  };

  const handleMcpRequest = async (req, res, scope) => {
    if (scope.revoked) {
      req.resume();
      writeJson(res, 410, { error: 'Question scope is no longer active.' });
      return;
    }
    if (req.headers.host !== expectedHost) {
      req.resume();
      writeJson(res, 421, { error: 'Invalid Host header.' });
      return;
    }
    if (!bearerMatches(req.headers.authorization, scope.token)) {
      req.resume();
      writeJson(res, 401, { error: 'Unauthorized.' });
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      writeJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    let body;
    try {
      body = await readBoundedJsonBody(req, maxBodyBytes);
    } catch (error) {
      writeJson(res, error?.status || 400, { error: error instanceof Error ? error.message : 'Invalid request.' });
      return;
    }

    const requestAbortController = new AbortController();
    const abortDisconnectedRequest = () => requestAbortController.abort();
    const cleanupDisconnectListeners = () => {
      req.off('aborted', abortDisconnectedRequest);
      req.socket?.off?.('close', abortDisconnectedRequest);
    };
    req.once('aborted', abortDisconnectedRequest);
    req.socket?.once?.('close', abortDisconnectedRequest);
    const mcpServer = createMcpServer(scope, requestAbortController.signal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const closeTransport = () => {
      if (!res.writableEnded) abortDisconnectedRequest();
      cleanupDisconnectListeners();
      Promise.resolve(transport.close()).catch(() => {});
      Promise.resolve(mcpServer.close()).catch(() => {});
    };
    res.once('close', closeTransport);
    res.once('finish', cleanupDisconnectListeners);
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error?.('[CursorQuestion] MCP request failed:', error instanceof Error ? error.message : error);
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error.' },
        id: null,
      });
    }
  };

  const handleRequest = (req, res) => {
    res.setHeader('cache-control', 'no-store');
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', origin || 'http://127.0.0.1').pathname;
    } catch {
      writeJson(res, 400, { error: 'Invalid URL.' });
      return;
    }
    const scope = scopesByPath.get(pathname);
    if (!scope) {
      req.resume();
      writeJson(res, 404, { error: 'Not found.' });
      return;
    }
    handleMcpRequest(req, res, scope).catch((error) => {
      logger.error?.('[CursorQuestion] request handling failed:', error instanceof Error ? error.message : error);
      writeJson(res, 500, { error: 'Internal server error.' });
    });
  };

  const ensureStarted = async () => {
    if (disposed) throw new Error('Cursor question bridge is disposed.');
    if (origin) return;
    if (startPromise) return startPromise;

    startPromise = new Promise((resolve, reject) => {
      const nextServer = createHttpServer(handleRequest);
      server = nextServer;
      const onError = (error) => {
        nextServer.off('listening', onListening);
        server = null;
        startPromise = null;
        reject(new Error(`Cursor question bridge failed to start: ${error instanceof Error ? error.message : String(error)}`));
      };
      const onListening = () => {
        nextServer.off('error', onError);
        const address = nextServer.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Cursor question bridge failed to resolve its loopback address.'));
          return;
        }
        expectedHost = `127.0.0.1:${address.port}`;
        origin = `http://${expectedHost}`;
        resolve();
      };
      nextServer.once('error', onError);
      nextServer.once('listening', onListening);
      nextServer.listen(0, '127.0.0.1');
    });
    return startPromise;
  };

  const createScope = ({ sessionID, directory, messageID }) => {
    const scopeID = createOpaqueId('scope');
    const scope = {
      sessionID,
      scopeID,
      identity: `${instanceID}:${scopeID}`,
      path: `/mcp/${scopeID}`,
      token: crypto.randomBytes(32).toString('base64url'),
      directory,
      messageID,
      revoked: false,
    };
    scopesBySession.set(sessionID, scope);
    scopesByPath.set(scope.path, scope);
    return scope;
  };

  const getOrCreateScope = (input) => {
    const sessionID = trimString(input.sessionID);
    if (!sessionID) throw new TypeError('Cursor question bridge requires a session ID.');
    const directory = trimString(input.directory);
    const messageID = trimString(input.messageID);
    const existing = scopesBySession.get(sessionID);
    if (existing) {
      if (existing.messageID && messageID && existing.messageID !== messageID) {
        existing.revoked = true;
        scopesByPath.delete(existing.path);
        cancelPendingQuestions({
          sessionID,
          messageID: existing.messageID,
          reason: 'the prompt was superseded',
        });
        return createScope({ sessionID, directory, messageID });
      }
      if (directory) existing.directory = directory;
      if (messageID) existing.messageID = messageID;
      return existing;
    }
    return createScope({ sessionID, directory, messageID });
  };

  const cancelSession = (sessionID, options = {}) => {
    return cancelPendingQuestions({
      sessionID,
      messageID: options.messageID,
      reason: options.reason,
    });
  };

  const revokeSessionScope = (sessionID, options = {}) => {
    const normalizedSessionID = trimString(sessionID);
    const normalizedIdentity = trimString(options.identity);
    const normalizedMessageID = trimString(options.messageID);
    const scope = scopesBySession.get(normalizedSessionID);
    if (!scope) return false;
    if (normalizedIdentity && scope.identity !== normalizedIdentity) return false;
    if (normalizedMessageID && scope.messageID !== normalizedMessageID) return false;

    scope.revoked = true;
    if (scopesBySession.get(normalizedSessionID) === scope) {
      scopesBySession.delete(normalizedSessionID);
    }
    scopesByPath.delete(scope.path);
    cancelPendingQuestions({
      sessionID: normalizedSessionID,
      messageID: scope.messageID || normalizedMessageID,
      reason: options.reason,
    });
    return true;
  };

  return {
    async getMcpServerConfig(input = {}) {
      if (!isCursorQuestionAgent(input.agent)) return null;
      await ensureStarted();
      const scope = getOrCreateScope(input);
      return {
        identity: scope.identity,
        mcpServers: {
          [QUESTION_SERVER_NAME]: {
            type: 'http',
            url: `${origin}${scope.path}`,
            headers: { Authorization: `Bearer ${scope.token}` },
          },
        },
      };
    },
    listPendingQuestions(listOptions = {}) {
      const directory = trimString(listOptions.directory);
      return [...pendingById.values()]
        .filter((pending) => !directory || pending.directory === directory)
        .map((pending) => pending.request);
    },
    async replyToQuestion(requestID, answers) {
      const pending = pendingById.get(trimString(requestID));
      if (!pending) return false;
      const normalizedAnswers = normalizeAnswers(pending.request, answers);
      return settlePending(
        pending,
        createAnsweredResult(pending.request, normalizedAnswers),
        {
          type: 'question.replied',
          properties: {
            sessionID: pending.request.sessionID,
            requestID: pending.request.id,
            answers: normalizedAnswers,
          },
        },
      );
    },
    async rejectQuestion(requestID) {
      const pending = pendingById.get(trimString(requestID));
      if (!pending) return false;
      return settlePending(
        pending,
        createSkippedResult(),
        {
          type: 'question.rejected',
          properties: { sessionID: pending.request.sessionID, requestID: pending.request.id },
        },
      );
    },
    cancelSession,
    revokeSessionScope,
    async deleteSession(sessionID) {
      const normalizedSessionID = trimString(sessionID);
      const revoked = revokeSessionScope(normalizedSessionID, { reason: 'the session was deleted' });
      const cancelled = revoked
        ? 0
        : cancelSession(normalizedSessionID, { reason: 'the session was deleted' });
      return revoked || cancelled > 0;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const sessionID of [...scopesBySession.keys()]) {
        revokeSessionScope(sessionID, { reason: 'the question bridge was disposed' });
      }
      scopesBySession.clear();
      scopesByPath.clear();
      const activeServer = server;
      server = null;
      origin = '';
      expectedHost = '';
      if (activeServer) {
        await new Promise((resolve) => activeServer.close(() => resolve()));
      }
    },
  };
}

import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import {
  BUG_REPORTS_MIGRATION,
  DIAGNOSTIC_DISPOSITION_MIGRATION,
  ERROR_DIAGNOSTICS_MIGRATION,
  ERROR_LOG_CLEAR_MIGRATION,
  createBugReportsApi,
  validateClientErrorBatch,
  validateErrorLogClearRange,
  validateBugReportStatusUpdate,
  validateBugReportSubmission,
} from "./bug-reports.js";
import { SupabaseRequestError } from "./supabase-client.js";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID_2 = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ERROR_EVENT_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-08-09T18:00:00.000Z";
const UPDATED_AT = "2026-08-09T18:01:00.000Z";

const developer = {
  id: USER_ID,
  email: "developer@example.test",
  displayName: "Test Developer",
  role: "developer",
  scope: "managed",
};
const admin = {
  ...developer,
  role: "admin",
  displayName: "Test Administrator",
};

const reportRow = (overrides = {}) => ({
  id: REPORT_ID,
  reporter_user_id: USER_ID,
  reporter_display_name: "Test Developer",
  reporter_email: "developer@example.test",
  reporter_role: "developer",
  title: "Editor stops responding",
  description: "The editor stops responding after opening a large file.",
  status: "submitted",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  ...overrides,
});

const createResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const createRouteHarness = ({
  rest,
  rpc = vi.fn(async () => ({ clearedCount: 0, linkedResolutionCount: 0 })),
  audit = vi.fn(async () => {}),
  canEdit = () => true,
  withAuditDeliveryBarrier = vi.fn(async (operation) => operation()),
} = {}) => {
  const routes = new Map();
  const app = Object.fromEntries(
    ["get", "post", "patch", "delete"].map((method) => [
      method,
      (routePath, handler) =>
        routes.set(`${method.toUpperCase()} ${routePath}`, handler),
    ]),
  );
  createBugReportsApi({
    supabase: { rest, rpc },
    audit,
    dataDirectory: "/private/devryan-data",
    canEditBugReports: canEdit,
    withAuditDeliveryBarrier,
    logger: { warn: vi.fn() },
  }).registerRoutes(app);

  const invoke = async (method, routePath, request = {}) => {
    const handler = routes.get(`${method} ${routePath}`);
    if (!handler) throw new Error(`Missing route ${method} ${routePath}`);
    const response = createResponse();
    const next = vi.fn();
    await handler(
      { body: {}, query: {}, params: {}, ...request },
      response,
      next,
    );
    return { response, next };
  };
  return { invoke, audit, rpc, withAuditDeliveryBarrier };
};

const clientReport = (overrides = {}) => ({
  fingerprint: "a1b2c3",
  name: "TypeError",
  message: "Cannot read properties of undefined",
  stack: "TypeError: boom\n    at render (App.tsx:1:1)",
  source: "window_error",
  route: "/settings",
  occurrenceCount: 3,
  firstSeenAt: CREATED_AT,
  ...overrides,
});

describe("client error capture", () => {
  it("accepts only the report contract within its bounds", () => {
    expect(validateClientErrorBatch({ errors: [clientReport()] })).toMatchObject({
      valid: true,
      reports: [{ fingerprint: "a1b2c3", errorName: "TypeError", occurrenceCount: 3, source: "window_error" }],
    });
    expect(validateClientErrorBatch({ errors: [] }).error).toBe("errors must be a non-empty array");
    expect(
      validateClientErrorBatch({ errors: Array.from({ length: 11 }, () => clientReport()) }).error,
    ).toBe("errors must contain 10 reports or fewer");
    expect(validateClientErrorBatch({ errors: [clientReport({ cookies: "x" })] }).error).toBe(
      "A report contains unsupported fields",
    );
    expect(validateClientErrorBatch({ errors: [clientReport({ source: "keylogger" })] }).error).toContain(
      "source must be",
    );
    expect(validateClientErrorBatch({ errors: [clientReport({ fingerprint: "../etc" })] }).error).toBe(
      "fingerprint must be an alphanumeric token",
    );
    expect(validateClientErrorBatch({ errors: [clientReport({ firstSeenAt: "today" })] }).error).toBe(
      "firstSeenAt must be an ISO timestamp",
    );

    const capped = validateClientErrorBatch({
      errors: [clientReport({ message: "m".repeat(5_000), stack: "s".repeat(30_000), occurrenceCount: -4 })],
    });
    expect(capped.reports[0].message).toHaveLength(2_000);
    expect(capped.reports[0].stack).toHaveLength(16_000);
    expect(capped.reports[0].occurrenceCount).toBe(1);
  });

  it("captures reports from any managed user with a stable idempotent event id", async () => {
    const audit = vi.fn(async () => {});
    const harness = createRouteHarness({ rest: vi.fn(async () => []), audit });

    const { response } = await harness.invoke("POST", "/api/client-errors", {
      principal: developer,
      body: { errors: [clientReport(), clientReport({ fingerprint: "d4e5f6", source: "error_boundary" })] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.payload).toEqual({ accepted: 2 });
    expect(audit).toHaveBeenCalledTimes(2);

    const [firstPrincipal, firstAction, firstDetails] = audit.mock.calls[0];
    expect(firstPrincipal).toBe(developer);
    expect(firstAction).toBe("client.error");
    expect(firstDetails).toMatchObject({
      success: false,
      occurredAt: CREATED_AT,
      diagnosticImpact: "medium",
      diagnosticSource: "observed",
      diagnosticDisposition: "actionable",
      targetType: "client_error",
      metadata: { kind: "client", failureClass: "client_runtime", occurrenceCount: 3, route: "/settings" },
    });
    // A boundary crash blanks a surface, so it outranks a stray listener error.
    expect(audit.mock.calls[1][2].diagnosticImpact).toBe("high");

    const replay = await harness.invoke("POST", "/api/client-errors", {
      principal: developer,
      body: { errors: [clientReport()] },
    });
    expect(replay.response.statusCode).toBe(202);
    expect(audit.mock.calls[2][2].eventId).toBe(firstDetails.eventId);
  });

  it("defers unmanaged callers and rate limits a crash loop", async () => {
    const audit = vi.fn(async () => {});
    const harness = createRouteHarness({ rest: vi.fn(async () => []), audit });

    const local = await harness.invoke("POST", "/api/client-errors", {
      principal: { scope: "local" },
      body: { errors: [clientReport()] },
    });
    expect(local.next).toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    for (let batch = 0; batch < 3; batch += 1) {
      const { response } = await harness.invoke("POST", "/api/client-errors", {
        principal: developer,
        body: {
          errors: Array.from({ length: 10 }, (_, index) => clientReport({ fingerprint: `f${batch}${index}` })),
        },
      });
      expect(response.statusCode).toBe(202);
    }

    const { response } = await harness.invoke("POST", "/api/client-errors", {
      principal: developer,
      body: { errors: [clientReport({ fingerprint: "overflow" })] },
    });
    expect(response.statusCode).toBe(429);
    expect(response.payload).toMatchObject({ code: "rate_limited", retryable: true });
    expect(response.payload.retryAfter).toBeGreaterThan(0);
  });

  it("redacts environment secrets before the report reaches the outbox", async () => {
    const secret = "zyxwvutsrqponmlkjihgfedcba987654";
    // The sanitizer snapshots the environment when the API is constructed.
    process.env.DEVRYAN_TEST_CLIENT_ERROR_TOKEN = secret;
    const audit = vi.fn(async () => {});
    try {
      const harness = createRouteHarness({ rest: vi.fn(async () => []), audit });
      await harness.invoke("POST", "/api/client-errors", {
        principal: developer,
        body: { errors: [clientReport({ message: `Request failed with ${secret}` })] },
      });
    } finally {
      delete process.env.DEVRYAN_TEST_CLIENT_ERROR_TOKEN;
    }
    expect(JSON.stringify(audit.mock.calls.at(-1)[2].metadata)).not.toContain(secret);
  });
});

describe("bug report validation", () => {
  it("accepts only a UUID, title, and description within the contract bounds", () => {
    expect(
      validateBugReportSubmission({
        id: REPORT_ID,
        title: "  Broken ",
        description: " Details ",
      }),
    ).toEqual({
      valid: true,
      submission: { id: REPORT_ID, title: "Broken", description: "Details" },
    });
    expect(
      validateBugReportSubmission({
        id: REPORT_ID,
        title: "x",
        description: "y",
        status: "resolved",
      }).valid,
    ).toBe(false);
    expect(
      validateBugReportSubmission({
        id: "not-a-uuid",
        title: "x",
        description: "y",
      }).valid,
    ).toBe(false);
    expect(
      validateBugReportSubmission({
        id: REPORT_ID,
        title: "x".repeat(201),
        description: "y",
      }).valid,
    ).toBe(false);
    expect(
      validateBugReportSubmission({
        id: REPORT_ID,
        title: "x",
        description: "y".repeat(20_001),
      }).valid,
    ).toBe(false);
    expect(
      validateBugReportSubmission({
        id: REPORT_ID,
        title: ["not text"],
        description: "y",
      }).valid,
    ).toBe(false);
  });

  it("accepts reversible statuses with an optimistic concurrency timestamp", () => {
    for (const status of ["submitted", "in_progress", "resolved"]) {
      expect(
        validateBugReportStatusUpdate({ status, expectedUpdatedAt: UPDATED_AT })
          .valid,
      ).toBe(true);
    }
    expect(
      validateBugReportStatusUpdate({
        status: "closed",
        expectedUpdatedAt: UPDATED_AT,
      }).valid,
    ).toBe(false);
    expect(
      validateBugReportStatusUpdate({
        status: "resolved",
        expectedUpdatedAt: UPDATED_AT,
        title: "nope",
      }).valid,
    ).toBe(false);
  });

  it("accepts only supported error-log clear ranges", () => {
    expect(validateErrorLogClearRange("24h", 2_000)).toEqual({
      valid: true,
      clear: { range: "24h", since: 2_000 - 24 * 60 * 60 * 1000 },
    });
    expect(validateErrorLogClearRange("all", 2_000)).toEqual({
      valid: true,
      clear: { range: "all" },
    });
    expect(validateErrorLogClearRange("30d", 2_000).valid).toBe(false);
    expect(validateErrorLogClearRange(["24h"], 2_000).valid).toBe(false);
  });
});

describe("bug reports API", () => {
  it("submits with server-derived identity and status, then replays the same UUID idempotently", async () => {
    let stored = null;
    const rest = vi.fn(async (table, options) => {
      expect(table).toBe("bug_reports");
      if (options.method === "POST") {
        if (stored) return [];
        stored = reportRow({ ...options.body, status: "submitted" });
        return [stored];
      }
      return stored;
    });
    const harness = createRouteHarness({ rest });
    const request = {
      principal: developer,
      body: {
        id: REPORT_ID,
        title: "Editor stops responding",
        description: "The editor stops responding after opening a large file.",
      },
    };

    const created = await harness.invoke("POST", "/api/bug-reports", request);
    const replayed = await harness.invoke("POST", "/api/bug-reports", request);

    expect(created.response.statusCode).toBe(201);
    expect(replayed.response.statusCode).toBe(200);
    expect(created.response.payload.report).toMatchObject({
      id: REPORT_ID,
      status: "submitted",
      reporter: {
        id: USER_ID,
        displayName: developer.displayName,
        email: developer.email,
        role: developer.role,
      },
    });
    const inserted = rest.mock.calls.find(
      ([, options]) => options.method === "POST",
    )[1].body;
    expect(inserted).toMatchObject({
      reporter_user_id: USER_ID,
      reporter_display_name: developer.displayName,
      reporter_email: developer.email,
      reporter_role: developer.role,
    });
    expect(inserted).not.toHaveProperty("status");
    expect(harness.audit).toHaveBeenCalledTimes(2);
    expect(harness.audit.mock.calls[0][2].eventId).toBe(
      harness.audit.mock.calls[1][2].eventId,
    );
  });

  it("preserves the idempotency key by rejecting different content", async () => {
    const rest = vi.fn(async (_table, options) =>
      options.method === "POST" ? [] : reportRow({ title: "Original title" }),
    );
    const harness = createRouteHarness({ rest });
    const { response } = await harness.invoke("POST", "/api/bug-reports", {
      principal: developer,
      body: {
        id: REPORT_ID,
        title: "Different title",
        description: reportRow().description,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.payload.code).toBe("idempotency_conflict");
    expect(harness.audit).not.toHaveBeenCalled();
  });

  it("requires Edit permission for submission and exact admin role for review", async () => {
    const rest = vi.fn(async () => []);
    const deniedSubmit = createRouteHarness({ rest, canEdit: () => false });
    const submit = await deniedSubmit.invoke("POST", "/api/bug-reports", {
      principal: developer,
      body: { id: REPORT_ID, title: "Title", description: "Description" },
    });
    const deniedReview = await deniedSubmit.invoke("GET", "/api/bug-reports", {
      principal: { ...developer, role: "senior_developer" },
    });

    expect(submit.response.statusCode).toBe(403);
    expect(deniedReview.response.statusCode).toBe(403);
    expect(rest).not.toHaveBeenCalled();
  });

  it("lists newest-first with status filtering and an opaque cursor", async () => {
    const rows = [
      reportRow(),
      reportRow({ id: REPORT_ID_2, created_at: "2026-08-09T17:00:00.000Z" }),
    ];
    const rest = vi.fn(async () => rows);
    const harness = createRouteHarness({ rest });
    const first = await harness.invoke("GET", "/api/bug-reports", {
      principal: admin,
      query: { status: "submitted", limit: "1" },
    });

    expect(first.response.payload.reports).toHaveLength(1);
    expect(first.response.payload.nextCursor).toEqual(expect.any(String));
    expect(first.response.payload.nextCursor).not.toContain(CREATED_AT);
    expect(rest.mock.calls[0][1].query).toMatchObject({
      status: "eq.submitted",
      order: "created_at.desc,id.desc",
      limit: 2,
    });

    await harness.invoke("GET", "/api/bug-reports", {
      principal: admin,
      query: {
        status: "submitted",
        limit: "1",
        cursor: first.response.payload.nextCursor,
      },
    });
    expect(rest.mock.calls[1][1].query.or).toContain(`id.lt.${REPORT_ID}`);
  });

  it("returns 409 before writing a stale status update", async () => {
    const rest = vi.fn(async () => ({
      id: REPORT_ID,
      status: "in_progress",
      updated_at: UPDATED_AT,
    }));
    const harness = createRouteHarness({ rest });
    const { response } = await harness.invoke("PATCH", "/api/bug-reports/:id", {
      principal: admin,
      params: { id: REPORT_ID },
      body: { status: "resolved", expectedUpdatedAt: CREATED_AT },
    });

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({
      code: "stale_update",
      current: { status: "in_progress", updatedAt: UPDATED_AT },
    });
    expect(rest).toHaveBeenCalledTimes(1);
    expect(harness.audit).not.toHaveBeenCalled();
  });

  it("updates status in either direction without copying report content into the audit", async () => {
    const rest = vi.fn(async (_table, options) =>
      options.method === "PATCH"
        ? reportRow({
            status: "submitted",
            updated_at: "2026-08-09T18:02:00.000Z",
          })
        : { id: REPORT_ID, status: "resolved", updated_at: UPDATED_AT },
    );
    const harness = createRouteHarness({ rest });
    const { response } = await harness.invoke("PATCH", "/api/bug-reports/:id", {
      principal: admin,
      params: { id: REPORT_ID },
      body: { status: "submitted", expectedUpdatedAt: UPDATED_AT },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.report.status).toBe("submitted");
    expect(harness.audit).toHaveBeenCalledWith(
      admin,
      "bug_report.status_changed",
      expect.objectContaining({
        metadata: { fromStatus: "resolved", toStatus: "submitted" },
      }),
    );
    expect(JSON.stringify(harness.audit.mock.calls[0][2])).not.toContain(
      reportRow().description,
    );
  });

  it("identifies a missing schema migration and distinguishes transient dependency failure", async () => {
    const schemaError = new SupabaseRequestError(
      "Could not find public.bug_reports",
      {
        status: 404,
        payload: {
          code: "PGRST205",
          message: "Could not find the table 'public.bug_reports'",
        },
      },
    );
    const missing = createRouteHarness({
      rest: vi.fn(async () => {
        throw schemaError;
      }),
    });
    const missingResponse = await missing.invoke("GET", "/api/bug-reports", {
      principal: admin,
    });
    expect(missingResponse.response).toMatchObject({
      statusCode: 503,
      payload: {
        code: "schema_migration_required",
        requiredMigration: BUG_REPORTS_MIGRATION,
        retryable: false,
      },
    });

    const transient = createRouteHarness({
      rest: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const transientResponse = await transient.invoke(
      "GET",
      "/api/bug-reports",
      { principal: admin },
    );
    expect(transientResponse.response).toMatchObject({
      statusCode: 503,
      payload: { code: "dependency_unavailable", retryable: true },
    });
  });
});

describe("error logs API", () => {
  it("requires exact admin access and uses opaque event cursors", async () => {
    const rows = [
      {
        id: 2,
        event_id: ERROR_EVENT_ID,
        actor_user_id: null,
        actor_role: "developer",
        action: "session.error",
        project_id: null,
        session_id: "ses_2",
        success: false,
        metadata: { kind: "session", errorName: "APIError" },
        created_at: CREATED_AT,
      },
      {
        id: 1,
        event_id: "45555555-5555-4555-8555-555555555555",
        actor_user_id: null,
        actor_role: "developer",
        action: "session.error",
        project_id: null,
        session_id: "ses_1",
        success: false,
        metadata: { kind: "session", errorName: "UnknownError" },
        created_at: "2026-08-09T17:00:00.000Z",
      },
    ];
    const rest = vi.fn(async () => rows);
    const harness = createRouteHarness({ rest });
    const denied = await harness.invoke("GET", "/api/error-logs", {
      principal: developer,
    });
    expect(denied.response.statusCode).toBe(403);
    expect(rest).not.toHaveBeenCalled();

    const first = await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { kind: "session", limit: "1" },
    });
    expect(first.response.payload.logs).toHaveLength(1);
    expect(first.response.payload.nextCursor).toEqual(expect.any(String));
    expect(first.response.payload.nextCursor).not.toContain(ERROR_EVENT_ID);

    await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: {
        kind: "session",
        limit: "1",
        cursor: first.response.payload.nextCursor,
      },
    });
    const cursorRequest = rest.mock.calls.find(([, options]) => options.query?.or);
    expect(cursorRequest[1].query.or).toContain(
      `event_id.lt.${ERROR_EVENT_ID}`,
    );
    expect(first.response.payload.logs[0]).toMatchObject({
      impact: "high",
      disposition: "actionable",
      classificationSource: "inferred",
      failureClass: "session_runtime",
      outcome: "unresolved",
    });
    expect(rest.mock.calls[0][1].query.diagnostic_disposition).toBe("eq.actionable");
  });

  it("defaults to actionable diagnostics and supports expected and all dispositions", async () => {
    const rest = vi.fn(async () => []);
    const harness = createRouteHarness({ rest });

    await harness.invoke("GET", "/api/error-logs", { principal: admin, query: {} });
    await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { disposition: "expected" },
    });
    await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { disposition: "all" },
    });

    expect(rest.mock.calls[0][1].query.diagnostic_disposition).toBe("eq.actionable");
    expect(rest.mock.calls[1][1].query.diagnostic_disposition).toBe("eq.expected");
    expect(rest.mock.calls[2][1].query.diagnostic_disposition).toBeUndefined();
  });

  it("returns only allowlisted sanitized context and supports task diagnostics identifiers", async () => {
    const row = {
      id: 1,
      event_id: ERROR_EVENT_ID,
      actor_user_id: USER_ID,
      actor_role: "developer",
      action: "tool.failed",
      project_id: PROJECT_ID,
      session_id: "ses_root",
      success: false,
      diagnostic_impact: "low",
      diagnostic_source: "observed",
      diagnostic_disposition: "expected",
      metadata: {
        kind: "tool",
        tool: "bash",
        rootSessionId: "ses_root",
        childSessionId: "ses_child",
        failureClass: "filesystem_target",
        failureText: `Failed in ${os.homedir()}/private with Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`,
        prompt: "must not be returned",
        responseBody: "must not be returned",
        responseHeaders: { authorization: "must not be returned" },
      },
      created_at: CREATED_AT,
    };
    const rest = vi.fn(async (table, options) => {
      if (table === "activity_logs" && options.query?.action?.includes("diagnostic.")) {
        return [{
          event_id: "65555555-5555-4555-8555-555555555555",
          action: "diagnostic.recovered",
          target_id: ERROR_EVENT_ID,
          metadata: { outcome: "recovered" },
          created_at: "2026-08-09T18:02:00.000Z",
        }];
      }
      if (table === "activity_logs") return [row];
      if (table === "user_profiles")
        return [
          {
            id: USER_ID,
            display_name: "Test Developer",
            email: "developer@example.test",
            role: "developer",
          },
        ];
      if (table === "managed_projects")
        return [{ id: PROJECT_ID, label: "DevRyan" }];
      throw new Error(`Unexpected table ${table}`);
    });
    const harness = createRouteHarness({ rest });
    const { response } = await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { kind: "tool", limit: "50" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.logs[0]).toMatchObject({
      eventId: ERROR_EVENT_ID,
      kind: "tool",
      sessionId: "ses_root",
      actor: { id: USER_ID, role: "developer" },
      project: { id: PROJECT_ID, label: "DevRyan" },
      impact: "low",
      disposition: "expected",
      classificationSource: "observed",
      failureClass: "filesystem_target",
      outcome: "recovered",
    });
    expect(rest.mock.calls[0][1].query).toMatchObject({
      action: "eq.tool.failed",
      order: "created_at.desc,event_id.desc",
      limit: 51,
    });

    rest.mockImplementation(async (table, options) => {
      if (table === "activity_logs" && options.query?.action?.includes("diagnostic.")) {
        return [{
          event_id: "65555555-5555-4555-8555-555555555555",
          action: "diagnostic.recovered",
          target_id: ERROR_EVENT_ID,
          metadata: { outcome: "recovered" },
          created_at: "2026-08-09T18:02:00.000Z",
        }];
      }
      if (table === "activity_logs") return row;
      if (table === "user_profiles")
        return [
          {
            id: USER_ID,
            display_name: "Test Developer",
            email: "developer@example.test",
            role: "developer",
          },
        ];
      if (table === "managed_projects")
        return [{ id: PROJECT_ID, label: "DevRyan" }];
      return [];
    });
    const detail = await harness.invoke("GET", "/api/error-logs/:eventId", {
      principal: admin,
      params: { eventId: ERROR_EVENT_ID },
    });
    const serialized = JSON.stringify(detail.response.payload.log);
    expect(detail.response.payload.log.disposition).toBe("expected");
    const detailRequest = rest.mock.calls.find(([, options]) => options.query?.event_id);
    expect(detailRequest[1].query.diagnostic_disposition).toBeUndefined();
    expect(detail.response.payload.log.context).toMatchObject({
      kind: "tool",
      tool: "bash",
      rootSessionId: "ses_root",
      childSessionId: "ses_child",
    });
    expect(serialized).not.toContain("must not be returned");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(serialized).not.toContain(`${os.homedir()}/private`);
  });

  it("truncates the list summary but returns full failure text and stack on the detail", async () => {
    const failureText = `Boom ${"x".repeat(600)}`;
    const stack = ["Error: Boom", ...Array.from({ length: 40 }, (_, index) => `    at frame${index} (file.js:${index}:1)`)].join("\n");
    const row = {
      id: 1,
      event_id: ERROR_EVENT_ID,
      actor_user_id: USER_ID,
      actor_role: "developer",
      action: "session.error",
      project_id: PROJECT_ID,
      session_id: "ses_root",
      success: false,
      diagnostic_impact: "medium",
      diagnostic_source: "observed",
      metadata: {
        kind: "session",
        errorName: "ProviderError",
        failureClass: "session_runtime",
        failureText,
        stack,
      },
      created_at: CREATED_AT,
    };
    const rest = vi.fn(async (table, options) => {
      if (table === "activity_logs" && options.query?.action?.includes("diagnostic.")) return [];
      if (table === "activity_logs") return options.query?.event_id ? row : [row];
      return [];
    });
    const harness = createRouteHarness({ rest });

    const list = await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: {},
    });
    expect(list.response.payload.logs[0].summary).toHaveLength(238);
    expect(list.response.payload.logs[0].summary.endsWith("…")).toBe(true);
    expect(list.response.payload.logs[0].stack).toBeUndefined();

    const detail = await harness.invoke("GET", "/api/error-logs/:eventId", {
      principal: admin,
      params: { eventId: ERROR_EVENT_ID },
    });
    expect(detail.response.payload.log.failureText).toBe(failureText);
    expect(detail.response.payload.log.stack).toBe(stack);
    expect(detail.response.payload.log.context.stack).toBe(stack);
  });

  it("rejects malformed search, date, actor, and limit filters", async () => {
    const harness = createRouteHarness({ rest: vi.fn(async () => []) });
    const cases = [
      [{ q: "x".repeat(201) }, "q must be 200 characters or fewer"],
      [{ from: "yesterday" }, "from must be an ISO timestamp"],
      [{ to: "2026-13-99" }, "to must be an ISO timestamp"],
      [{ actor: "not-a-uuid" }, "actor must be a UUID"],
      [{ limit: "201" }, "limit must be an integer between 1 and 200"],
      [{ disposition: "ignored" }, "disposition must be actionable, expected, or all"],
    ];
    for (const [query, error] of cases) {
      const { response } = await harness.invoke("GET", "/api/error-logs", {
        principal: admin,
        query,
      });
      expect(response.statusCode).toBe(400);
      expect(response.payload).toMatchObject({ error });
    }
  });

  it("nests the cursor, search, and date range under a single and filter", async () => {
    const rest = vi.fn(async () => []);
    const harness = createRouteHarness({ rest });
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, kind: "error_logs", createdAt: CREATED_AT, eventId: ERROR_EVENT_ID }),
      "utf8",
    ).toString("base64url");

    await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: {
        q: "timed out",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-09T00:00:00.000Z",
        actor: USER_ID,
        limit: "200",
        cursor,
      },
    });

    const { query } = rest.mock.calls[0][1];
    expect(query.or).toBeUndefined();
    expect(query.and).toBe(
      `(or(created_at.lt.${CREATED_AT},and(created_at.eq.${CREATED_AT},event_id.lt.${ERROR_EVENT_ID}))`
        + ",or(metadata->>failureText.ilike.*timed out*,metadata->>tool.ilike.*timed out*"
        + ",metadata->>errorName.ilike.*timed out*)"
        + ",created_at.gte.2026-08-01T00:00:00.000Z,created_at.lte.2026-08-09T00:00:00.000Z)",
    );
    expect(query.actor_user_id).toBe(`eq.${USER_ID}`);
    expect(query.limit).toBe(201);
  });

  it("keeps a lone date bound on the column and strips PostgREST grammar from searches", async () => {
    const rest = vi.fn(async () => []);
    const harness = createRouteHarness({ rest });

    await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { from: "2026-08-01T00:00:00.000Z" },
    });
    expect(rest.mock.calls[0][1].query.created_at).toBe("gte.2026-08-01T00:00:00.000Z");
    expect(rest.mock.calls[0][1].query.and).toBeUndefined();

    await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { q: 'boom*,or(x)"' },
    });
    expect(rest.mock.calls[1][1].query.or).toBe(
      "(metadata->>failureText.ilike.*boom  or x*,metadata->>tool.ilike.*boom  or x*"
        + ",metadata->>errorName.ilike.*boom  or x*)",
    );
  });

  it("combines disposition, kind, and impact filters without changing keyset pagination", async () => {
    const rest = vi.fn(async (table, options) => {
      if (table !== "activity_logs") return [];
      if (options.query?.action?.includes("diagnostic.")) return [];
      return [];
    });
    const harness = createRouteHarness({ rest });
    const { response } = await harness.invoke("GET", "/api/error-logs", {
      principal: admin,
      query: { disposition: "expected", kind: "tool", impact: "medium", limit: "20" },
    });

    expect(response.statusCode).toBe(200);
    expect(rest.mock.calls[0][1].query).toMatchObject({
      action: "eq.tool.failed",
      diagnostic_disposition: "eq.expected",
      diagnostic_impact: "eq.medium",
      order: "created_at.desc,event_id.desc",
      limit: 21,
    });
  });

  it("never lets a recovery event downgrade terminal high impact", async () => {
    const row = {
      id: 1,
      event_id: ERROR_EVENT_ID,
      actor_user_id: null,
      actor_role: "developer",
      action: "session.error",
      project_id: null,
      session_id: "ses_terminal",
      success: false,
      diagnostic_impact: "high",
      diagnostic_source: "observed",
      metadata: { kind: "session", errorName: "APIError", failureClass: "session_runtime" },
      created_at: CREATED_AT,
    };
    const rest = vi.fn(async (table, options) => {
      if (table !== "activity_logs") return [];
      if (options.query?.action?.includes("diagnostic.")) {
        return [{
          event_id: "75555555-5555-4555-8555-555555555555",
          action: "diagnostic.recovered",
          target_id: ERROR_EVENT_ID,
          metadata: { outcome: "recovered" },
          created_at: "2026-08-09T18:03:00.000Z",
        }];
      }
      return [row];
    });
    const harness = createRouteHarness({ rest });
    const { response } = await harness.invoke("GET", "/api/error-logs", { principal: admin });

    expect(response.payload.logs[0]).toMatchObject({ impact: "high", outcome: "unresolved" });
  });

  it("clears only error actions in the requested recent range for exact admins", async () => {
    const rest = vi.fn(async () => []);
    const rpc = vi.fn(async () => ({ clearedCount: 1, linkedResolutionCount: 2 }));
    const audit = vi.fn(async () => {});
    const withAuditDeliveryBarrier = vi.fn(async (operation) => operation());
    const harness = createRouteHarness({ rest, rpc, audit, withAuditDeliveryBarrier });

    const denied = await harness.invoke("DELETE", "/api/error-logs", {
      principal: developer,
      query: { range: "7d" },
    });
    expect(denied.response.statusCode).toBe(403);
    expect(rpc).not.toHaveBeenCalled();

    const invalid = await harness.invoke("DELETE", "/api/error-logs", {
      principal: admin,
      query: { range: "30d" },
    });
    expect(invalid.response.statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();

    const { response } = await harness.invoke("DELETE", "/api/error-logs", {
      principal: admin,
      query: { range: "7d" },
    });
    expect(response.payload).toEqual({
      clearedCount: 1,
      linkedResolutionCount: 2,
      range: "7d",
    });
    expect(audit).toHaveBeenCalledWith(admin, "error_logs.clear_requested", {
      metadata: { range: "7d" },
    });
    expect(withAuditDeliveryBarrier).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("devryan_clear_error_logs", {
      p_since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      p_until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    rpc.mockClear();
    await harness.invoke("DELETE", "/api/error-logs", {
      principal: admin,
      query: { range: "all" },
    });
    expect(rpc).toHaveBeenCalledWith("devryan_clear_error_logs", {
      p_since: null,
      p_until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("reports the Error Log clear migration when the RPC is unavailable", async () => {
    const schemaError = new SupabaseRequestError(
      "Could not find the function public.devryan_clear_error_logs(p_since, p_until) in the schema cache",
      {
        status: 404,
        payload: {
          code: "PGRST202",
          message: "Could not find the function public.devryan_clear_error_logs(p_since, p_until) in the schema cache",
        },
      },
    );
    const harness = createRouteHarness({
      rest: vi.fn(async () => []),
      rpc: vi.fn(async () => { throw schemaError; }),
    });
    const { response } = await harness.invoke("DELETE", "/api/error-logs", {
      principal: admin,
      query: { range: "all" },
    });

    expect(response).toMatchObject({
      statusCode: 503,
      payload: {
        code: "schema_migration_required",
        requiredMigration: ERROR_LOG_CLEAR_MIGRATION,
        retryable: false,
      },
    });
  });

  it("reports the additive diagnostic migration when PostgREST has no impact columns", async () => {
    const schemaError = new SupabaseRequestError(
      "Could not find the 'diagnostic_impact' column of 'activity_logs' in the schema cache",
      {
        status: 400,
        payload: {
          code: "PGRST204",
          message: "Could not find the 'diagnostic_impact' column of 'activity_logs' in the schema cache",
        },
      },
    );
    const harness = createRouteHarness({ rest: vi.fn(async () => { throw schemaError; }) });
    const { response } = await harness.invoke("GET", "/api/error-logs", { principal: admin });

    expect(response).toMatchObject({
      statusCode: 503,
      payload: {
        code: "schema_migration_required",
        requiredMigration: ERROR_DIAGNOSTICS_MIGRATION,
        retryable: false,
      },
    });
  });

  it("reports the disposition migration when PostgREST has no disposition column", async () => {
    const schemaError = new SupabaseRequestError(
      "Could not find the 'diagnostic_disposition' column of 'activity_logs' in the schema cache",
      {
        status: 400,
        payload: {
          code: "PGRST204",
          message: "Could not find the 'diagnostic_disposition' column of 'activity_logs' in the schema cache",
        },
      },
    );
    const harness = createRouteHarness({ rest: vi.fn(async () => { throw schemaError; }) });
    const { response } = await harness.invoke("GET", "/api/error-logs", { principal: admin });

    expect(response).toMatchObject({
      statusCode: 503,
      payload: {
        code: "schema_migration_required",
        requiredMigration: DIAGNOSTIC_DISPOSITION_MIGRATION,
        retryable: false,
      },
    });
  });
});

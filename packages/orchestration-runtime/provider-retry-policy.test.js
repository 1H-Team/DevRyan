import { describe, expect, it } from 'bun:test';

import {
  DEADLINE_EXCEEDED_FAILURE_KIND,
  MANAGED_TASK_TIMEOUT_REASON_PREFIX,
  classifyManagedTaskFailure,
  classifyProviderRetryFailure,
  classifyProviderRetryStatus,
  classifyProviderTransportFailure,
  isManagedTaskDeadlineExceeded,
  isManagedTaskModelUnavailable,
  isProviderPromptRejected,
  PROVIDER_PROMPT_REJECTED_FAILURE_KIND,
  MODEL_UNAVAILABLE_FAILURE_KIND,
  PROVIDER_TRANSPORT_FAILURE_KINDS,
} from './provider-retry-policy.js';

describe('managed task deadline classification', () => {
  it('recognizes only the scheduler-owned timeout prefix', () => {
    const timeout = `${MANAGED_TASK_TIMEOUT_REASON_PREFIX}1786540028910`;

    expect(isManagedTaskDeadlineExceeded(timeout)).toBe(true);
    expect(classifyManagedTaskFailure(timeout)).toBe(DEADLINE_EXCEEDED_FAILURE_KIND);
    expect(isManagedTaskDeadlineExceeded('Managed task timed out')).toBe(false);
    expect(classifyManagedTaskFailure('Managed task timed out')).toBeNull();
  });
});

describe('managed task model availability classification', () => {
  it('recognizes authoritative model catalog failures without broadening transport failures', () => {
    const failure = 'ProviderModelNotFoundError: Model not found: opencode/retired-model';
    expect(isManagedTaskModelUnavailable(failure)).toBe(true);
    expect(classifyManagedTaskFailure(failure)).toBe(MODEL_UNAVAILABLE_FAILURE_KIND);
    expect(classifyManagedTaskFailure('ProviderModelNotFoundError: Requested model does not exist'))
      .toBe(MODEL_UNAVAILABLE_FAILURE_KIND);
    expect(classifyManagedTaskFailure('The model did not respond')).toBeNull();
  });
});

describe('classifyProviderRetryFailure', () => {
  it.each([
    'Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt.',
    'The model provider could not complete this turn: INVALID PROMPT — prompt flagged for a policy violation.',
    'Invalid prompt. The prompt was flagged as violating policy.',
  ])('classifies provider prompt rejection: %s', (message) => {
    expect(classifyProviderRetryFailure(message)).toBe(PROVIDER_PROMPT_REJECTED_FAILURE_KIND);
    expect(isProviderPromptRejected(message)).toBe(true);
  });

  it.each([
    ['Usage limit reached', 'provider_usage_limit'],
    ['Free usage exceeded, subscribe to Go', 'provider_usage_limit'],
    ['Invalid prompt: required field messages is missing', null],
    ['The prompt was flagged for review', null],
    ['A policy violation occurred in a tool response', null],
    ['Provider connection ended', null],
  ])('does not broaden %s beyond its verified class', (message, expected) => {
    expect(classifyProviderRetryFailure(message)).toBe(expected);
  });

  it('prefers OpenCode structured free-tier exhaustion over retry message wording', () => {
    expect(classifyProviderRetryStatus({
      type: 'retry',
      message: 'Subscribe to continue',
      action: { reason: 'free_tier_limit' },
    })).toBe('provider_usage_limit');
  });

  it.each([
    { type: 'retry', message: 'temporarily unavailable' },
    { type: 'retry', message: 'temporarily unavailable', action: { reason: 'provider_busy' } },
  ])('keeps unrelated retry status live: $message', (status) => {
    expect(classifyProviderRetryStatus(status)).toBeNull();
  });
});

describe('classifyProviderTransportFailure', () => {
  it.each([
    ['UnknownError', 'The operation timed out.', 'request_timeout'],
    ['TimeoutError', 'The request timed out', 'request_timeout'],
    ['UnknownError', '"Request TimeoutError."', 'request_timeout'],
    [null, 'UnknownError: The operation timed out.', 'request_timeout'],
    ['HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT', 'response_header_timeout'],
    ['UnknownError', 'Timed out waiting for response headers', 'response_header_timeout'],
    ['BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT', 'stream_idle_timeout'],
    ['UnknownError', 'SSE read timed out waiting for stream data', 'stream_idle_timeout'],
    [
      'UnknownError',
      '{"message":"Streaming response failed: [504] Upstream idle timeout exceeded","statusCode":504}',
      'stream_idle_timeout',
    ],
    ['UnknownError', 'Upstream request failed: ECONNRESET', 'connection_failure'],
    ['UnknownError', 'The streaming response failed because the socket hung up', 'connection_failure'],
    [
      'UnknownError',
      '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}',
      'connection_failure',
    ],
  ])('classifies %s: %s as %s', (name, detail, expected) => {
    expect(classifyProviderTransportFailure(name, detail)).toBe(expected);
  });

  it.each([
    ['AuthenticationError', 'The operation timed out while refreshing an access token'],
    ['ProviderModelNotFoundError', 'The requested model was not found after an upstream request failed'],
    ['ProviderModelNotFoundError', 'Upstream request failed'],
    ['UnknownError', 'Unable to verify the first certificate'],
    ['AbortError', 'The operation timed out while cancelling'],
    ['UnknownError', 'A provider-specific validation error occurred'],
  ])('does not let transport wording override %s', (name, detail) => {
    expect(classifyProviderTransportFailure(name, detail)).toBeNull();
  });

  it('exports only the stable diagnostic failure kinds', () => {
    expect(PROVIDER_TRANSPORT_FAILURE_KINDS).toEqual([
      'request_timeout',
      'response_header_timeout',
      'stream_idle_timeout',
      'connection_failure',
      'provider_queue_timeout',
    ]);
  });
});

describe('provider queue failures', () => {
  // Verbatim strings captured from opencode.log / activity_logs on 2026-08-21.
  // All three surfaced to the user as an unretryable dead-end turn because the
  // trailing "abort." matched NON_TRANSPORT_FAILURE_PATTERN first.
  const XAI_QUEUE_TIMEOUT = 'Request 8f1d57cc-e1b2-9ec5-9dbc-f3ff661ceab0-n0-part0-a0-2 timed out in queue, abort.';
  const XAI_UNAVAILABLE = 'Service temporarily unavailable. The model did not respond to this request.';

  it('classifies the xAI queue timeout as transient despite the trailing abort', () => {
    expect(classifyProviderTransportFailure('UnknownError', XAI_QUEUE_TIMEOUT))
      .toBe('provider_queue_timeout');
  });

  it('classifies it from the detail alone', () => {
    expect(classifyProviderTransportFailure('', XAI_QUEUE_TIMEOUT))
      .toBe('provider_queue_timeout');
  });

  it('classifies the temporarily-unavailable variant', () => {
    expect(classifyProviderTransportFailure('UnknownError', XAI_UNAVAILABLE))
      .toBe('provider_queue_timeout');
  });

  it('still treats a genuine user abort as non-transient', () => {
    expect(classifyProviderTransportFailure('MessageAbortedError', 'Aborted')).toBe(null);
    expect(classifyProviderTransportFailure('AbortError', 'The operation was aborted')).toBe(null);
  });

  it('still treats auth failures as non-transient', () => {
    expect(classifyProviderTransportFailure('Error', 'invalid api key')).toBe(null);
  });

  it('the new kind is registered as a transport failure kind', () => {
    expect(PROVIDER_TRANSPORT_FAILURE_KINDS).toContain('provider_queue_timeout');
  });
});

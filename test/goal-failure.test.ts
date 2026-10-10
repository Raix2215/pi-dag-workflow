import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyModelError, goalRetryDelay } from '../src/goal/failure.ts';

test('quota/billing/auth errors take priority over rate-limit and server wording', () => {
  for (const text of ['429 insufficient_quota', '429 usage_limit_reached', 'The usage limit has been reached', 'billing limit exhausted (HTTP 500)', 'insufficient credits', '401 invalid_api_key', 'HTTP 403: permission denied', 'authentication_error', 'model_not_found']) assert.equal(classifyModelError(text), 'permanent', text);
  for (const text of ['429 rate_limit_exceeded', 'HTTP 503 billing service temporarily unavailable', 'HTTP 503 overloaded', 'ECONNRESET', 'stream interrupted', 'timeout', 'fetch failed']) assert.equal(classifyModelError(text), 'transient', text);
  for (const text of ['', 'something unexpected happened', 'context length exceeded']) assert.equal(classifyModelError(text), 'unknown', text);
});

test('recovery backs off exponentially, remains capped, and starts over after a success', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(goalRetryDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(goalRetryDelay(0), 1000);
});

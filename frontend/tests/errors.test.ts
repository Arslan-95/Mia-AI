import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api';
import { CancelledError, UserFacingError, userErrorMessage } from '../src/errors';

test('raw service and native failures cannot expose internal details in the interface', () => {
  const detail = 'POST https://internal.example/v1/debug failed; provider=private; /app/audio/cache.wav';
  for (const reason of [new ApiError(500, 'INTERNAL_ERROR', detail), new ApiError(400, 'UNKNOWN', detail), new Error(detail), detail]) {
    const message = userErrorMessage(reason);
    assert.ok(message);
    assert.ok(!message.includes('internal.example'));
    assert.ok(!message.includes('provider'));
    assert.ok(!message.includes('/app/'));
    assert.ok(!message.includes('/v1/'));
  }
});

test('expected sign-in failures remain actionable and local audio errors retain their explanation', () => {
  assert.match(userErrorMessage(new ApiError(401, 'INVALID_OTP', 'internal')) ?? '', /code is incorrect or has expired/);
  assert.match(userErrorMessage(new ApiError(429, 'OTP_LOCKED', 'internal')) ?? '', /Request a new code/);
  assert.match(userErrorMessage(new ApiError(409, 'USERNAME_TAKEN', 'internal')) ?? '', /username is already taken/);
  const permission = new UserFacingError('Enable microphone access in your iPhone settings to record.');
  assert.equal(userErrorMessage(permission), permission.message);
  assert.equal(userErrorMessage(new CancelledError()), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api';
import { CancelledError } from '../src/errors';
import { DeviceActionError, deviceActionFailure } from '../src/deviceActionFeedback';

test('device feedback distinguishes validation, presentation and speech failures without leaking raw errors', () => {
  assert.deepEqual(deviceActionFailure(new DeviceActionError('ACTION_CONTEXT_CHANGED', 'This request view changed.'), 'validation'),
    { code: 'ACTION_CONTEXT_CHANGED', stage: 'validation', message: 'This request view changed.' });
  assert.equal(deviceActionFailure(new DeviceActionError('PRESENTATION_NO_SPACE', 'There is not enough space.'), 'presentation').code, 'PRESENTATION_NO_SPACE');
  const speech = deviceActionFailure(new ApiError(503, 'TTS_UNAVAILABLE', 'Secret provider response'), 'narration');
  assert.equal(speech.stage, 'narration'); assert.equal(speech.code, 'TTS_UNAVAILABLE');
  assert.doesNotMatch(speech.message, /Secret/);
  assert.equal(deviceActionFailure(new CancelledError(), 'execution').code, 'ACTION_CANCELLED');
  const raw = deviceActionFailure(new Error('file:///private/audio.wav and credentials'), 'narration');
  assert.equal(raw.code, 'DEVICE_ACTION_FAILED'); assert.doesNotMatch(raw.message, /private|credentials/);
});

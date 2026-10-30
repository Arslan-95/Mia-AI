import { ApiError } from './api';
import { CancelledError, UserFacingError, userErrorMessage } from './errors';

export type DeviceActionStage = 'validation' | 'execution' | 'presentation' | 'narration' | 'confirmation';
export class DeviceActionError extends UserFacingError {
  constructor(readonly code: string, message: string) { super(message); }
}

export function speechFailure(code: unknown) {
  return new ApiError(503, typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'TTS_UNAVAILABLE', '');
}

// Report only known error codes and sanitized text, never native/provider error
// details. The stage and actual context let the agent explain partial success.
export function deviceActionFailure(reason: unknown, stage: DeviceActionStage) {
  const code = reason instanceof DeviceActionError ? reason.code
    : reason instanceof CancelledError ? 'ACTION_CANCELLED'
    : reason instanceof ApiError && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason.code) ? reason.code : 'DEVICE_ACTION_FAILED';
  return { code, stage, message: userErrorMessage(reason) ?? 'This device action was cancelled.' };
}

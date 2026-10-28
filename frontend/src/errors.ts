import { ApiError } from './api';

export class UserFacingError extends Error {}
export class CancelledError extends Error {}
export class VoiceCaptureUnavailable extends UserFacingError {}

const messages: Record<string, string> = {
  OFFLINE: 'Unable to connect to Mia. Check your internet connection and try again.',
  UNAUTHORIZED: 'Please sign in again to continue.',
  INVALID_OTP: 'That code is incorrect or has expired. Try again or request a new code.',
  OTP_LOCKED: 'Too many incorrect attempts. Request a new code to continue.',
  OTP_RATE_LIMIT: 'Please wait a little before requesting another code.',
  USERNAME_TAKEN: 'That username is already taken. Choose another one.',
  INVALID_PHONE_NUMBER: 'Enter the full phone number with country code, for example +1 202 555 0101.',
  PHONE_AUTH_UNAVAILABLE: 'Sign-in is temporarily unavailable. Please try again later.',
  AGENT_UNAVAILABLE: 'Mia is temporarily unavailable. Please try again shortly.',
  MODEL_UNAVAILABLE: 'Mia is temporarily unavailable. Please try again shortly.',
  MODEL_RATE_LIMITED: 'Mia is busy right now. Please try again shortly.',
  ASR_UNAVAILABLE: 'We could not transcribe that recording. Try again or type your request.',
  TTS_UNAVAILABLE: 'We could not play the response. You can still read it here.',
  INVALID_TTS_AUDIO: 'We could not play the response. You can still read it here.',
  VALIDATION_ERROR: 'Please check your details and try again.',
  NOT_FOUND: 'This conversation or item is no longer available.',
  TURN_RATE_LIMIT: 'Please wait a moment before asking Mia again.',
};

export function userErrorMessage(reason: unknown) {
  if (reason instanceof CancelledError) return null;
  if (reason instanceof UserFacingError) return reason.message;
  if (reason instanceof ApiError) {
    if (messages[reason.code]) return messages[reason.code]!;
    if (reason.code === 'CONFLICT') return 'This item changed. Please review it and try again.';
    if (reason.status === 429) return 'Please wait a moment and try again.';
    if (reason.status >= 500) return 'Mia is temporarily unavailable. Please try again shortly.';
  }
  return 'Something went wrong. Please try again.';
}

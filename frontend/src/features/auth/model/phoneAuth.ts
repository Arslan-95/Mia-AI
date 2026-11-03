import { ApiError, type Api } from '../../../shared/api/api';
import { CancelledError } from '../../../shared/errors';
import type { OtpChallenge, Session } from '../../../shared/types';

// The backend owns the allowed phone/code pairs. No provider SDK or SMS is used.
export class PhoneSignIn {
  private challenge?: OtpChallenge;
  private revision = 0;
  private pending?: AbortController;

  constructor(private readonly api: Pick<Api, 'request'>) {}

  async request(phoneNumber: string): Promise<OtpChallenge> {
    if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) throw new ApiError(400, 'INVALID_PHONE_NUMBER', 'Enter a full international number.');
    if (this.pending) throw new ApiError(429, 'OTP_RATE_LIMIT', 'Sign-in is already in progress.');
    const revision = ++this.revision;
    const controller = new AbortController();
    this.pending = controller;
    try {
      const challenge = await this.api.request<OtpChallenge>('/v1/auth/otp/request', 'POST', { phoneNumber }, controller.signal);
      if (revision !== this.revision) throw new CancelledError();
      this.challenge = challenge;
      return challenge;
    } catch (error) {
      if (revision !== this.revision) throw new CancelledError();
      throw error;
    } finally { if (this.pending === controller) this.pending = undefined; }
  }

  async verify(challengeId: string, code: string): Promise<Session> {
    if (this.pending) throw new ApiError(429, 'OTP_RATE_LIMIT', 'Sign-in is already in progress.');
    if (!this.challenge || this.challenge.challengeId !== challengeId || !/^\d{6}$/.test(code)) {
      throw new ApiError(401, 'INVALID_OTP', 'Start sign-in again.');
    }
    const revision = this.revision;
    const controller = new AbortController();
    this.pending = controller;
    try {
      const session = await this.api.request<Session>('/v1/auth/otp/verify', 'POST', { challengeId, code }, controller.signal);
      if (revision !== this.revision) throw new CancelledError();
      this.challenge = undefined;
      return session;
    } catch (error) {
      if (revision !== this.revision) throw new CancelledError();
      throw error;
    } finally { if (this.pending === controller) this.pending = undefined; }
  }

  cancel() {
    this.revision++;
    this.challenge = undefined;
    this.pending?.abort();
    this.pending = undefined;
  }
}

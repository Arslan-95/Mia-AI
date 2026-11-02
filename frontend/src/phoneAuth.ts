import { ApiError } from './api';
import { CancelledError } from './errors';
import type { OtpChallenge } from './types';
import { SmsAttemptBudget } from './smsAttemptBudget';

export type PhoneCredential = { phoneNumber: string | null; getIdToken(forceRefresh: boolean): Promise<string> };
export type PhoneConfirmation = { verificationId: string | null; confirm(code: string): Promise<PhoneCredential | null> };
export type PhoneAuthDriver = { sendCode(phoneNumber: string): Promise<PhoneConfirmation>; signOut(): Promise<void> };
type Attempt = { id: string; phoneNumber: string; confirmation: PhoneConfirmation; expiresAt: number; credential?: PhoneCredential };

function phoneError(error: unknown): never {
  if (error instanceof ApiError || error instanceof CancelledError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (code === 'auth/internal-error' && message.includes('OTP_RATE_LIMIT')) {
    throw new ApiError(429, 'OTP_RATE_LIMIT', 'Please try again later.');
  }
  if (['auth/invalid-verification-code', 'auth/invalid-verification-id', 'auth/session-expired', 'auth/code-expired'].includes(code)) {
    throw new ApiError(401, 'INVALID_OTP', 'The code is incorrect or expired.');
  }
  if (code === 'auth/invalid-phone-number') throw new ApiError(400, 'INVALID_PHONE_NUMBER', 'Enter a full international number.');
  if (code === 'auth/too-many-requests' || code === 'auth/quota-exceeded') throw new ApiError(429, 'OTP_RATE_LIMIT', 'Please try again later.');
  if (code === 'auth/network-request-failed') throw new ApiError(0, 'OFFLINE', 'Check your connection and try again.');
  throw new ApiError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is temporarily unavailable.');
}

// Firebase is used only to prove phone ownership. Mia sessions remain in the
// device Keychain; a persisted Firebase identity never automatically signs in.
export class PhoneSignIn {
  private driver?: PhoneAuthDriver;
  private attempt?: Attempt;
  private revision = 0;
  private nextSendAt = 0;
  private pending = false;
  private cleanup: Promise<void> = Promise.resolve();
  constructor(private readonly load: () => Promise<PhoneAuthDriver>, private readonly now = Date.now,
    private readonly budget = new SmsAttemptBudget()) {}

  async request(phoneNumber: string): Promise<OtpChallenge> {
    if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) throw new ApiError(400, 'INVALID_PHONE_NUMBER', 'Enter a full international number.');
    if (this.pending || this.now() < this.nextSendAt) throw new ApiError(429, 'OTP_RATE_LIMIT', 'Please wait before requesting another code.');
    const revision = ++this.revision;
    this.pending = true;
    // A failed network response may still represent a billed SMS attempt.
    this.nextSendAt = this.now() + 60_000;
    try {
      await this.cleanup;
      if (revision !== this.revision) throw new CancelledError();
      await this.budget.reserve(this.now());
      if (revision !== this.revision) throw new CancelledError();
      this.driver ??= await this.load();
      await this.driver.signOut();
      if (revision !== this.revision) throw new CancelledError();
      const confirmation = await this.driver.sendCode(phoneNumber);
      if (revision !== this.revision) throw new CancelledError();
      if (!confirmation.verificationId) throw new ApiError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is unavailable.');
      const expiresAt = this.now() + 300_000;
      this.attempt = { id: confirmation.verificationId, confirmation, phoneNumber, expiresAt };
      return { challengeId: confirmation.verificationId, expiresAt: new Date(expiresAt).toISOString(),
        resendAt: new Date(this.nextSendAt).toISOString(), delivery: 'firebase' };
    } catch (error) { return phoneError(error); }
    finally {
      if (revision !== this.revision) await this.driver?.signOut().catch(() => {});
      this.pending = false;
    }
  }

  async verify<T>(id: string, code: string, exchange: (idToken: string) => Promise<T>): Promise<T> {
    const attempt = this.attempt;
    if (this.pending) throw new ApiError(429, 'OTP_RATE_LIMIT', 'Verification is already in progress.');
    if (!attempt || attempt.id !== id || attempt.expiresAt <= this.now() || !/^\d{6}$/.test(code)) {
      throw new ApiError(401, 'INVALID_OTP', 'Request a new code.');
    }
    const revision = this.revision;
    this.pending = true;
    try {
      // Keep a confirmed credential until the exchange succeeds so transient
      // backend errors can be retried without confirming the SMS twice.
      attempt.credential ??= await attempt.confirmation.confirm(code) ?? undefined;
      if (revision !== this.revision) throw new CancelledError();
      if (!attempt.credential || attempt.credential.phoneNumber !== attempt.phoneNumber) throw new ApiError(401, 'INVALID_OTP', 'Request a new code.');
      const idToken = await attempt.credential.getIdToken(true);
      if (revision !== this.revision) throw new CancelledError();
      const result = await exchange(idToken);
      if (revision !== this.revision) throw new CancelledError();
      this.attempt = undefined;
      // A cleanup error must not turn a successful Mia session into a failure.
      await this.driver?.signOut().catch(() => {});
      if (revision !== this.revision) throw new CancelledError();
      return result;
    } catch (error) { return phoneError(error); }
    finally {
      // A cancelled confirmation may still finish signing into native Firebase.
      // Clear that identity before permitting another attempt.
      if (revision !== this.revision) await this.driver?.signOut().catch(() => {});
      this.pending = false;
    }
  }

  cancel() {
    this.revision++; this.attempt = undefined;
    // After a failed backend exchange the credential is retained for retry.
    // Cancelling that idle flow must clear native Firebase persistence too.
    if (!this.pending && this.driver) {
      const driver = this.driver;
      this.cleanup = this.cleanup.then(() => driver.signOut()).catch(() => {});
    }
  }
}

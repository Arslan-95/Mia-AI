import { ApiError } from './api';

export type SmsAttemptStore = { get(): Promise<string | null>; set(value: string): Promise<void> };
const DAY = 24 * 60 * 60_000;

// Device-side throttling is a usability layer. The Firebase blocking trigger
// enforces the authoritative IP/phone/global limits before an SMS is sent.
export class SmsAttemptBudget {
  private attempts: number[] = [];
  constructor(private readonly store?: SmsAttemptStore) {}

  async reserve(now: number) {
    let saved: unknown;
    try {
      const raw = await this.store?.get();
      saved = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(saved) || saved.length > 100 || saved.some(time => !Number.isSafeInteger(time) || time < 0)) throw new Error('Invalid local budget');
    } catch {
      throw new ApiError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is temporarily unavailable.');
    }
    const attempts = [...new Set([...this.attempts, ...(saved as number[])])].filter(time => time > now - DAY);
    if (attempts.some(time => time > now - 60_000) || attempts.filter(time => time > now - 15 * 60_000).length >= 5 || attempts.length >= 10) {
      throw new ApiError(429, 'OTP_RATE_LIMIT', 'Please wait before requesting another code.');
    }
    attempts.push(now);
    try { await this.store?.set(JSON.stringify(attempts)); }
    catch { throw new ApiError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is temporarily unavailable.'); }
    this.attempts = attempts;
  }
}

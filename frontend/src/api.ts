import type { Session } from './types';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export class Api {
  constructor(public base: string, public session: Session | null, private expired?: () => void) {}
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      if (!this.base) throw new Error('Service unavailable');
      response = await fetch(this.base + path, { method, headers: { ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(this.session ? { Authorization: `Bearer ${this.session.token}` } : {}) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    } catch { throw new ApiError(0, 'OFFLINE', 'Unable to connect to Mia. Check your internet connection and try again.'); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && this.session) this.expired?.();
      throw new ApiError(response.status, data.error?.code ?? 'REQUEST_FAILED', data.error?.message ?? data.message ?? `Request failed (${response.status}).`);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
}

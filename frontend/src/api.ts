import type { Session } from './types';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function normalizeAddress(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter a server origin, such as https://mia.example.com.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error('Use HTTPS for a public server. HTTP is available for local development.');
  return url.origin;
}
export class Api {
  constructor(public base: string, public session: Session | null, private expired?: () => void) {}
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.base + path, { method, headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(this.session ? { Authorization: `Bearer ${this.session.token}` } : {}) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    } catch { throw new ApiError(0, 'OFFLINE', 'Cannot reach your server. Check the address and connection, then try again.'); }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && this.session) this.expired?.();
      throw new ApiError(response.status, data.error?.code ?? 'REQUEST_FAILED', data.error?.message ?? data.message ?? `Request failed (${response.status}).`);
    }
    return response.status === 204 ? undefined as T : response.json();
  }
}

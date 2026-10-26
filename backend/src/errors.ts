export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export const notFound = () => new AppError(404, 'NOT_FOUND', 'The requested resource was not found.');
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function isDatabaseError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

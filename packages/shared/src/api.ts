export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'CONFLICT',
  'LINEAR_ERROR',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as Record<string, unknown>;
  return (
    typeof code === 'string' &&
    (API_ERROR_CODES as readonly string[]).includes(code) &&
    typeof message === 'string'
  );
}

import type { ZodType } from 'zod';
import { AppError } from './errors.js';

export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The request is invalid', result.error.flatten());
  }
  return result.data;
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key must contain 8-128 safe characters',
    );
  }
  return value;
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function conflict(code: string, message: string): never {
  throw new AppError(409, code, message);
}

export function forbidden(code: string, message: string): never {
  throw new AppError(403, code, message);
}

export function notFound(code: string, message: string): never {
  throw new AppError(404, code, message);
}

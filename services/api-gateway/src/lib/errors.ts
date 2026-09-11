export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /**
     * Diagnostic context that is logged but never serialized to the client. Schema validation
     * failures carry the request contract's own field paths and messages, which would
     * otherwise hand an unauthenticated caller a map of every accepted field.
     */
    readonly internalDetails?: unknown,
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

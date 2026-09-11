import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { canonicalJson, hmacHex, safeEqualText } from './crypto.js';
import { AppError } from './errors.js';

const BOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_BOT_DUMMY_KEY = Buffer.alloc(32);

export interface AuthenticatedBot {
  readonly botId: string;
  readonly secret: Buffer;
  readonly expectedServerHost: string;
  readonly expectedUsername: string;
  readonly method: string;
  readonly path: string;
  readonly requestTimestamp: string;
}

export function botRequestSignaturePayload(
  method: string,
  path: string,
  botId: string,
  timestamp: string,
  body: unknown,
): string {
  return canonicalJson({
    audience: 'donut-upgrader-api',
    version: 2,
    method: method.toUpperCase(),
    path,
    botId: botId.toLowerCase(),
    timestamp,
    body,
  });
}

export function botResponseSignaturePayload(
  authenticated: AuthenticatedBot,
  responseTimestamp: string,
  statusCode: number,
  requestBody: unknown,
  responseBody: unknown,
): string {
  return canonicalJson({
    audience: 'donut-upgrader-bot',
    version: 1,
    method: authenticated.method,
    path: authenticated.path,
    botId: authenticated.botId,
    requestTimestamp: authenticated.requestTimestamp,
    responseTimestamp,
    statusCode,
    requestBody,
    responseBody,
  });
}

export function verifyBotSignature(
  request: FastifyRequest,
  config: AppConfig,
): AuthenticatedBot {
  const botIdHeader = request.headers['x-bot-id'];
  const timestampHeader = request.headers['x-bot-timestamp'];
  const signature = request.headers['x-bot-signature'];
  if (
    typeof botIdHeader !== 'string' ||
    typeof timestampHeader !== 'string' ||
    typeof signature !== 'string'
  ) {
    throw new AppError(401, 'BOT_SIGNATURE_REQUIRED', 'Bot authentication headers are required');
  }
  if (
    !BOT_ID_PATTERN.test(botIdHeader) ||
    !/^\d{13}$/.test(timestampHeader) ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    throw new AppError(401, 'INVALID_BOT_SIGNATURE', 'Bot authentication headers are malformed');
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) {
    throw new AppError(
      401,
      'STALE_BOT_SIGNATURE',
      'Bot signature timestamp is outside the allowed window',
    );
  }

  const botId = botIdHeader.toLowerCase();
  const provisioned = config.botCredentials.get(botId);
  if (typeof request.method !== 'string') {
    throw new AppError(401, 'INVALID_BOT_SIGNATURE', 'Bot signature audience is invalid');
  }
  const method = request.method.toUpperCase();
  const path = request.routeOptions.url;
  if (typeof path !== 'string' || !path.startsWith('/internal/v1/minecraft/')) {
    throw new AppError(401, 'INVALID_BOT_SIGNATURE', 'Bot signature audience is invalid');
  }
  let payload: string;
  try {
    payload = botRequestSignaturePayload(method, path, botId, timestampHeader, request.body);
  } catch {
    throw new AppError(400, 'INVALID_BOT_BODY', 'Bot request body is not canonicalizable JSON');
  }
  const expected = hmacHex(provisioned?.secret ?? UNKNOWN_BOT_DUMMY_KEY, payload);
  if (!provisioned || !safeEqualText(signature, expected)) {
    throw new AppError(401, 'INVALID_BOT_SIGNATURE', 'Bot signature is invalid');
  }
  return {
    botId,
    secret: provisioned.secret,
    expectedServerHost: provisioned.serverHost,
    expectedUsername: provisioned.username,
    method,
    path,
    requestTimestamp: timestampHeader,
  };
}

export function sendAuthenticatedBotResponse(
  reply: FastifyReply,
  authenticated: AuthenticatedBot,
  requestBody: unknown,
  responseBody: unknown,
  statusCode = 200,
): unknown {
  const responseTimestamp = Date.now().toString();
  const signature = hmacHex(
    authenticated.secret,
    botResponseSignaturePayload(
      authenticated,
      responseTimestamp,
      statusCode,
      requestBody,
      responseBody,
    ),
  );
  reply.header('x-api-timestamp', responseTimestamp);
  reply.header('x-api-signature', signature);
  return reply.code(statusCode).send(responseBody);
}

export function requireMatchingBotId(authenticatedBotId: string, bodyBotId: string): void {
  if (authenticatedBotId !== bodyBotId.toLowerCase()) {
    throw new AppError(
      403,
      'BOT_IDENTITY_MISMATCH',
      'The signed bot identity does not match the request body',
    );
  }
}

export function deriveLeaseToken(secret: Buffer, eventId: string, jobId: string): string {
  return hmacHex(secret, `donut-upgrader:job-lease:v1:${eventId}:${jobId}`);
}

export function deriveDepositLeaseToken(
  secret: Buffer,
  botId: string,
  authorizationEventId: string,
  depositId: string,
): string {
  return hmacHex(
    secret,
    `donut-upgrader:deposit-authorization:v1:${botId.toLowerCase()}:${authorizationEventId.toLowerCase()}:${depositId.toLowerCase()}`,
  );
}

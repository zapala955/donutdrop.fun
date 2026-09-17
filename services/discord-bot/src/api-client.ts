import type { BotConfig } from './config.js';
import { canonicalJson, hmacHex } from './canonical.js';

/**
 * api-client.ts — the only way this process talks to the platform.
 *
 * Every request carries an HMAC over the canonical form of the method, path, timestamp and body.
 * The gateway recomputes it. That gives two properties worth stating:
 *
 *   * the body cannot be altered in flight without invalidating the signature, so a proxy between
 *     the bot and the gateway cannot rewrite which bot gets quarantined;
 *   * the timestamp is inside the signed payload and the gateway rejects anything more than a
 *     minute old, so a captured request cannot be replayed tomorrow.
 *
 * The Discord user id travels in the BODY, inside the signature, rather than in a header. A header
 * outside the signed payload would be the one field an attacker with network position could swap,
 * and it is the field that decides whose privileges are used.
 */

export interface CommandContext {
  readonly discordUserId: string;
  readonly discordGuildId: string | null;
  readonly discordChannelId: string | null;
}

export type CommandResult =
  | { readonly kind: 'data'; readonly title: string; readonly fields: Record<string, unknown> }
  | { readonly kind: 'rows'; readonly title: string; readonly rows: Record<string, unknown>[] }
  | { readonly kind: 'link'; readonly url: string; readonly expiresAt: string }
  | { readonly kind: 'confirm'; readonly nonce: string; readonly summary: string }
  | { readonly kind: 'done'; readonly summary: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly code?: unknown;
  readonly message?: unknown;
}

export class ControlApi {
  constructor(private readonly config: BotConfig) {}

  async command(context: CommandContext, request: Record<string, unknown>): Promise<CommandResult> {
    const path = '/internal/v1/discord/command';
    const body = { context, request };
    const timestamp = Date.now().toString();
    const signature = hmacHex(
      this.config.DISCORD_CONTROL_HMAC_KEY,
      canonicalJson({
        audience: 'donut-upgrader-discord-control',
        version: 1,
        method: 'POST',
        path,
        timestamp,
        body,
      }),
    );

    /* A hung request would hold a Discord interaction token past the three-second acknowledgement
     * window and the operator would see "the application did not respond" with no idea whether the
     * command ran. An explicit abort turns that into an error we can actually render. */
    const abort = AbortSignal.timeout(this.config.REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.config.API_INTERNAL_BASE_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-discord-timestamp': timestamp,
          'x-discord-signature': signature,
        },
        body: JSON.stringify(body),
        signal: abort,
      });
    } catch (error) {
      throw new ApiError(
        503,
        'API_UNREACHABLE',
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The platform did not answer in time'
          : 'The platform could not be reached',
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(response.status, 'INVALID_RESPONSE', 'The platform sent an unreadable reply');
    }

    if (!response.ok) {
      const shape = parsed as ErrorBody;
      const code = shape.error?.code ?? shape.code;
      const message = shape.error?.message ?? shape.message;
      throw new ApiError(
        response.status,
        typeof code === 'string' ? code : 'REQUEST_FAILED',
        typeof message === 'string' ? message : 'The command failed',
      );
    }
    return parsed as CommandResult;
  }
}

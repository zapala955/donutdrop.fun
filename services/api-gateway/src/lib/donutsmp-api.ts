import type { AppConfig } from '../config.js';
import { AppError } from './errors.js';

/**
 * Read-only client for the DonutSMP public API.
 *
 * This exists because in-game payment messages abbreviate amounts above 999 ("1234" arrives as
 * "1.2K"), so chat can say who paid but never how much. The API reports balances exactly, which
 * makes it the only usable source of truth for money.
 */

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
// Money is a float64 rendered as a string and is not always whole: DonutSMP reports values such
// as "1975372.25". Minor units are hundredths, so two decimal places are kept exactly.
const MONEY_PATTERN = /^(0|[1-9]\d{0,17})(?:\.(\d{1,6}))?$/;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export const MONEY_MINOR_SCALE = 100n;

/** Converts an exact decimal money string into integer hundredths without going through a float. */
export function parseMoneyToMinor(value: string): bigint | undefined {
  const match = MONEY_PATTERN.exec(value);
  if (!match) return undefined;
  const whole = BigInt(match[1] ?? '0');
  // Truncate rather than round: crediting a player less than they sent is recoverable, crediting
  // more than the house actually received is not.
  const fraction = (match[2] ?? '').padEnd(2, '0').slice(0, 2);
  return whole * MONEY_MINOR_SCALE + BigInt(fraction);
}

export class DonutSmpApi {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.donutsmpApiKey && this.config.donutsmpApiBaseUrl);
  }

  /**
   * Exact balance for one player, in integer hundredths.
   *
   * Throws rather than returning a fallback: a caller deciding whether real money arrived must
   * never mistake "could not check" for "no change".
   */
  async fetchMoneyMinor(username: string): Promise<bigint> {
    if (!this.configured) {
      throw new AppError(
        503,
        'DONUTSMP_API_UNCONFIGURED',
        'The DonutSMP API is not configured',
      );
    }
    if (!USERNAME_PATTERN.test(username)) {
      throw new AppError(400, 'INVALID_USERNAME', 'Invalid Minecraft username');
    }

    const url = `${this.config.donutsmpApiBaseUrl}/v1/stats/${encodeURIComponent(username)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          // The key authorizes reads of public stats. It is never echoed into errors or logs.
          authorization: `Bearer ${this.config.donutsmpApiKey}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new AppError(
        503,
        'DONUTSMP_API_UNREACHABLE',
        'Could not reach the DonutSMP API',
        undefined,
        { cause: error instanceof Error ? error.message : 'unknown' },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new AppError(503, 'DONUTSMP_API_FAILED', 'The DonutSMP API rejected the request', {
        status: response.status,
      });
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new AppError(503, 'DONUTSMP_API_FAILED', 'The DonutSMP API response was too large');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AppError(503, 'DONUTSMP_API_FAILED', 'The DonutSMP API returned invalid JSON');
    }

    const money = readMoneyField(payload);
    if (money === undefined) {
      throw new AppError(503, 'DONUTSMP_API_FAILED', 'The DonutSMP API returned no usable balance');
    }
    const minor = parseMoneyToMinor(money);
    if (minor === undefined) {
      throw new AppError(503, 'DONUTSMP_API_FAILED', 'The DonutSMP API returned an unreadable balance');
    }
    return minor;
  }
}

function readMoneyField(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const result = (payload as Record<string, unknown>)['result'];
  if (result === null || typeof result !== 'object') return undefined;
  const money = (result as Record<string, unknown>)['money'];
  return typeof money === 'string' ? money : undefined;
}

import type { CommunityConfig } from './config.js';
import { canonicalJson, hmacHex } from './canonical.js';

/**
 * api-client.ts — the one call this process makes to the platform.
 *
 * Signed the same way the operator bot signs its calls, with a different key and a different
 * audience string. The audience is inside the signed payload, so a signature minted here does not
 * verify against a control-plane route even if the body is byte-identical — see
 * services/api-gateway/src/lib/community-bot-auth.ts for the other half.
 *
 * The Discord snowflake travels in the BODY, inside the signature. In a header it would be the
 * one field an attacker with network position could swap, and it is the field that decides whose
 * profile comes back.
 */

export interface VipStanding {
  readonly current: {
    readonly label: string;
    readonly tierLabel: string;
    readonly ratePercent: number;
  };
  readonly next: { readonly label: string } | null;
  readonly progress: { readonly ratio: number; readonly remainingMinor: string };
}

export type ProfileLookup =
  | { readonly linked: false }
  | {
      readonly linked: true;
      readonly username: string;
      readonly memberSince: string;
      readonly linkedAt: string | null;
      readonly wageredMinor: string;
      readonly vip: VipStanding;
    };

export class ApiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUnavailable';
  }
}

export class PlatformApi {
  /** Null when the deployment did not configure the lookup, which is a supported way to run. */
  static from(config: CommunityConfig): PlatformApi | null {
    if (!config.apiInternalUrl || !config.apiSecret) return null;
    return new PlatformApi(config.apiInternalUrl, config.apiSecret);
  }

  private constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async profile(discordUserId: string): Promise<ProfileLookup> {
    const path = '/internal/v1/community/profile';
    const body = { discordUserId };
    const timestamp = Date.now().toString();
    const signature = hmacHex(
      this.secret,
      canonicalJson({
        audience: 'donut-upgrader-community-bot',
        version: 1,
        method: 'POST',
        path,
        timestamp,
        body,
      }),
    );

    /* A hung request would hold a Discord interaction token past the acknowledgement window and
     * the member would see "the application did not respond" with no idea what happened. An
     * explicit abort turns that into an error the handler can render. */
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-community-timestamp': timestamp,
          'x-community-signature': signature,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new ApiUnavailable(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The platform did not answer in time'
          : 'The platform could not be reached',
      );
    }

    if (!response.ok) {
      /* The gateway's own error text is not repeated into a public channel. It is written for an
       * operator reading a log, and this reply is read by whoever typed the command. */
      throw new ApiUnavailable(`The platform refused the lookup (${response.status})`);
    }

    return (await response.json()) as ProfileLookup;
  }
}

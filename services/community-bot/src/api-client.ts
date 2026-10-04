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

/** The platform answered and said no, with a reason written for the player. */
export class ApiRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRefused';
  }
}

export interface RewardLine {
  readonly kind: 'join' | 'tag' | 'invite';
  readonly amountMinor: string;
  readonly to: 'you' | 'inviter';
}

export interface LinkResult {
  readonly username: string;
  readonly rewards: RewardLine[];
  readonly joinSkipped: string | null;
}

export type TagResult =
  | { readonly paid: true; readonly amountMinor: string; readonly username: string }
  | { readonly paid: false; readonly reason: string; readonly nextAt?: string };

export interface RewardStatus {
  readonly linked: boolean;
  readonly username: string | null;
  readonly enabled: boolean;
  readonly amounts: { joinMinor: string; tagMinor: string; inviteMinor: string };
  readonly minAccountAgeDays: number;
  readonly join: { claimed: boolean } | null;
  readonly tag: { claimedToday: boolean; days: number } | null;
  readonly invites: { rewarded: number; totalMinor: string } | null;
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
    return this.post<ProfileLookup>('/internal/v1/community/profile', { discordUserId });
  }

  /** `/link <code>`: the code the site showed a signed-in player. */
  async link(body: {
    discordUserId: string;
    discordUsername: string;
    guildId: string;
    code: string;
  }): Promise<LinkResult> {
    return this.post<LinkResult>('/internal/v1/community/link', body);
  }

  /** `/tag`: today's reward for wearing the server's tag, as far as this bot can see. */
  async claimTag(discordUserId: string, wearingTag: boolean): Promise<TagResult> {
    return this.post<TagResult>('/internal/v1/community/rewards/tag', {
      discordUserId,
      wearingTag,
    });
  }

  async rewardStatus(discordUserId: string): Promise<RewardStatus> {
    return this.post<RewardStatus>('/internal/v1/community/rewards/status', { discordUserId });
  }

  /**
   * One signed call. The gateway's refusals carry a code and a sentence written for players
   * (a wrong link code, an account linked elsewhere); those come back as `ApiRefused` so the
   * command can say what went wrong. Anything else is the platform being unavailable.
   */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
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
      const problem = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      /* Player-facing refusals (4xx with a code) are passed on; the text is the gateway's own
       * sentence for that code. Server errors are not repeated into a channel: they are written
       * for an operator reading a log. */
      if (response.status >= 400 && response.status < 500 && problem?.error?.code) {
        throw new ApiRefused(problem.error.code, problem.error.message ?? 'Refused');
      }
      throw new ApiUnavailable(`The platform refused the request (${response.status})`);
    }

    return (await response.json()) as T;
  }
}

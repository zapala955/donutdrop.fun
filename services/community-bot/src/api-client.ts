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
      /** Asked about yourself only: how many accounts this Discord carries, and how many it may.
       * Absent on an older gateway (one account per Discord). */
      readonly accounts?: number;
      readonly maxAccounts?: number;
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

/** `/link` from a member: not linked (they link on the site), or linked and the join reward's fate. */
export type JoinRewardResult =
  | { readonly linked: false }
  | {
      readonly linked: true;
      readonly username: string;
      readonly paidMinor: string | null;
      /** Why nothing was paid: already collected, too young a Discord, or rewards off. */
      readonly skipped: string | null;
    };

/** One of the site accounts linked to a Discord (`/accounts list`). */
export interface LinkedAccount {
  readonly username: string;
  /** The account the bot acts for: `/tag` pays it, `/profile` and `/rewards` show it. */
  readonly main: boolean;
  readonly active: boolean;
  readonly linkedAt: string | null;
  readonly lastLoginAt: string | null;
}

export type TagResult =
  | { readonly paid: true; readonly amountMinor: string; readonly username: string }
  | { readonly paid: false; readonly reason: string; readonly nextAt?: string };

export interface RewardStatus {
  readonly linked: boolean;
  readonly username: string | null;
  readonly enabled: boolean;
  readonly amounts: { joinMinor: string; tagMinor: string };
  /** Present when the gateway is new enough to say; the DM falls back to plain words without it. */
  readonly dailyCodes?: {
    readonly enabled: boolean;
    readonly maxPrizeMinor: string;
    /** What must be wagered on the site that day before a code opens. Absent on an older gateway. */
    readonly minWagerMinor?: string;
    /** What a player's first code pays at least ('0' = off). Absent on an older gateway. */
    readonly firstPrizeMinor?: string;
  };
  readonly minAccountAgeDays: number;
  readonly join: { claimed: boolean } | null;
  readonly tag: {
    claimedToday: boolean;
    days: number;
    /** When the next tag reward opens, while the tag is seen on after a first reward. Absent on an older gateway. */
    nextAt?: string | null;
  } | null;
}

export interface TagSighting {
  readonly discordUserId: string;
  readonly wearing: boolean;
}

/** The signup and invite figures the site advertises (GET /v1/promotions, which is public). */
export interface Promotions {
  readonly signupBonus: { readonly amountMinor: string } | null;
  readonly referral: { readonly bonusMinor: string } | null;
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

  /**
   * Whose profile, and who is asking. The site names the player in full only to the player
   * themselves; anybody else gets the mask the site's public pages use (`x********`). The asker
   * travels inside the signed body for the same reason the subject does.
   */
  async profile(discordUserId: string, viewerDiscordUserId: string): Promise<ProfileLookup> {
    return this.post<ProfileLookup>('/internal/v1/community/profile', {
      discordUserId,
      viewerDiscordUserId,
    });
  }

  /** `/link` from a member already linked on the site: the join reward, if it is still due. */
  async joinReward(body: { discordUserId: string; guildId: string }): Promise<JoinRewardResult> {
    return this.post<JoinRewardResult>('/internal/v1/community/join-reward', body);
  }

  /** `/tag`: the reward for wearing the server's tag, as far as this bot can see. */
  async claimTag(discordUserId: string, wearingTag: boolean): Promise<TagResult> {
    return this.post<TagResult>('/internal/v1/community/rewards/tag', {
      discordUserId,
      wearingTag,
    });
  }

  /** Whose tag to keep checking: everybody who has collected a tag reward lately. */
  async tagWatchList(): Promise<string[]> {
    const result = await this.post<{ discordUserIds: string[] }>(
      '/internal/v1/community/rewards/tag-watch',
      {},
    );
    return result.discordUserIds;
  }

  /** What this bot saw on those profiles, which the 24-hour rule is judged on. */
  async reportTagSightings(sightings: readonly TagSighting[]): Promise<void> {
    await this.post('/internal/v1/community/rewards/tag-seen', {
      sightings: sightings.map((s) => ({ discordUserId: s.discordUserId, wearing: s.wearing })),
    });
  }

  /**
   * What the site is offering new players right now.
   *
   * A public read, so there is nothing to sign. Null on any failure: it feeds a welcome message,
   * and a message without the figures is better than no message.
   */
  async promotions(): Promise<Promotions | null> {
    try {
      const response = await fetch(new URL('/v1/promotions', this.baseUrl), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Partial<Promotions>;
      return {
        signupBonus: body.signupBonus ?? null,
        referral: body.referral ?? null,
      };
    } catch {
      return null;
    }
  }

  /** `/accounts list`: every site account on this Discord, main first. */
  async accounts(discordUserId: string): Promise<{ max: number; accounts: LinkedAccount[] }> {
    return this.post('/internal/v1/community/accounts', { discordUserId });
  }

  /** `/accounts main`: which of the member's own accounts the bot acts for. */
  async setMainAccount(discordUserId: string, username: string): Promise<{ username: string }> {
    return this.post('/internal/v1/community/accounts/main', { discordUserId, username });
  }

  /** `/accounts unlink`: takes one of the member's own accounts off this Discord. */
  async unlinkAccount(
    discordUserId: string,
    username: string,
  ): Promise<{ unlinked: string; newMain: string | null }> {
    return this.post('/internal/v1/community/accounts/unlink', { discordUserId, username });
  }

  async rewardStatus(discordUserId: string): Promise<RewardStatus> {
    return this.post<RewardStatus>('/internal/v1/community/rewards/status', { discordUserId });
  }

  /**
   * One signed call. The gateway's refusals carry a code and a sentence written for players
   * (a tag reward not due yet, an account that is not linked); those come back as `ApiRefused` so the
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

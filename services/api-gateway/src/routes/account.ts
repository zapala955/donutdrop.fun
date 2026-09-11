import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { parseWith } from '../lib/validation.js';

const accountSchema = z
  .object({
    countryCode: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase()),
    dateOfBirth: z.iso.date(),
    acceptTerms: z.literal(true),
  })
  .strict();
const limitsSchema = z
  .object({
    dailyWagerLimitMinor: z.union([z.string().regex(/^[1-9]\d{0,15}$/), z.null()]).optional(),
    cooldownHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
  })
  .strict()
  .refine((value) => value.dailyWagerLimitMinor !== undefined || value.cooldownHours !== undefined);
const exclusionSchema = z
  .object({ durationDays: z.number().int().min(1).max(3650).nullable() })
  .strict();

interface AccountRow {
  id: string;
  minecraft_username: string;
  status: string;
  country_code: string | null;
  date_of_birth: Date | string | null;
  terms_accepted_at: Date | null;
  age_verified_at: Date | null;
  kyc_status: string;
}

interface LimitsRow {
  daily_wager_limit_minor: string | null;
  cooldown_until: Date | null;
  self_excluded_until: Date | null;
}

export async function registerAccountRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/account', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query(
      `SELECT u.id, u.minecraft_identity, u.minecraft_username, u.role, u.status, u.country_code,
              u.date_of_birth, u.terms_accepted_at, u.age_verified_at, u.kyc_status,
              r.daily_wager_limit_minor, r.cooldown_until, r.self_excluded_until
         FROM users u JOIN responsible_limits r ON r.user_id = u.id WHERE u.id = $1`,
      [request.authUser?.id],
    );
    return { account: result.rows[0] };
  });

  app.patch('/v1/account', { preHandler: guards.requireCsrf }, async (request) => {
    const body = parseWith(accountSchema, request.body);
    if (
      config.allowedCountries.size &&
      !config.allowedCountries.has(body.countryCode.toLowerCase())
    ) {
      throw new AppError(403, 'COUNTRY_NOT_ALLOWED', 'Service is not available in this country');
    }
    const birth = new Date(`${body.dateOfBirth}T00:00:00.000Z`);
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const birthdayPassed =
      now.getUTCMonth() > birth.getUTCMonth() ||
      (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
    if (!birthdayPassed) age -= 1;
    if (Number.isNaN(birth.getTime()) || age < 18 || age > 120) {
      throw new AppError(403, 'AGE_RESTRICTED', 'You must be at least 18 years old');
    }
    const result = await db.transaction(async (client) => {
      const updated = await client.query<AccountRow>(
        `UPDATE users SET country_code = $2, date_of_birth = $3,
              age_verified_at = CASE
                WHEN country_code IS DISTINCT FROM $2::char(2)
                  OR date_of_birth IS DISTINCT FROM $3::date THEN NULL
                ELSE age_verified_at END,
              kyc_status = CASE
                WHEN country_code IS DISTINCT FROM $2::char(2)
                  OR date_of_birth IS DISTINCT FROM $3::date THEN 'not_started'
                ELSE kyc_status END,
              status = CASE
                WHEN (country_code IS DISTINCT FROM $2::char(2)
                  OR date_of_birth IS DISTINCT FROM $3::date) AND status = 'active'
                  THEN 'pending_compliance'
                ELSE status END,
              terms_accepted_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING id, minecraft_username, status, country_code, date_of_birth,
                    terms_accepted_at, age_verified_at, kyc_status`,
        [request.authUser?.id, body.countryCode, body.dateOfBirth],
      );
      if (updated.rows[0]?.status !== 'active') {
        await client.query(
          `UPDATE deposit_intents SET status = 'cancelled'
            WHERE user_id = $1 AND status = 'pending'`,
          [request.authUser?.id],
        );
      }
      return updated;
    });
    return {
      account: result.rows[0],
      requiresAgeVerification: !result.rows[0]?.age_verified_at,
    };
  });

  app.put('/v1/account/limits', { preHandler: guards.requireCsrf }, async (request) => {
    const body = parseWith(limitsSchema, request.body);
    return db.transaction(async (client) => {
      const current = await client.query<{ daily_wager_limit_minor: string | null }>(
        'SELECT daily_wager_limit_minor FROM responsible_limits WHERE user_id = $1 FOR UPDATE',
        [request.authUser?.id],
      );
      const existing = current.rows[0]?.daily_wager_limit_minor;
      if (body.dailyWagerLimitMinor === null && existing !== null && existing !== undefined) {
        throw new AppError(
          409,
          'LIMIT_RELAXATION_REQUIRES_SUPPORT',
          'Contact support to remove a limit',
        );
      }
      if (
        typeof body.dailyWagerLimitMinor === 'string' &&
        existing &&
        BigInt(body.dailyWagerLimitMinor) > BigInt(existing)
      ) {
        throw new AppError(
          409,
          'LIMIT_INCREASE_REQUIRES_COOLING_OFF',
          'Limit increases require support and a cooling-off period',
        );
      }
      const result = await client.query<LimitsRow>(
        `UPDATE responsible_limits
            SET daily_wager_limit_minor = COALESCE($2::bigint, daily_wager_limit_minor),
                cooldown_until = CASE WHEN $3::integer IS NULL THEN cooldown_until
                                      ELSE GREATEST(
                                        COALESCE(cooldown_until, '-infinity'::timestamptz),
                                        now() + ($3 * interval '1 hour')
                                      ) END,
                updated_at = now()
          WHERE user_id = $1
          RETURNING daily_wager_limit_minor, cooldown_until, self_excluded_until`,
        [request.authUser?.id, body.dailyWagerLimitMinor ?? null, body.cooldownHours ?? null],
      );
      return { limits: result.rows[0] };
    });
  });

  app.post('/v1/account/self-exclusion', { preHandler: guards.requireCsrf }, async (request) => {
    const body = parseWith(exclusionSchema, request.body);
    await db.transaction(async (client) => {
      await client.query(
        `UPDATE responsible_limits
            SET self_excluded_until = CASE
                  WHEN $2::integer IS NULL THEN 'infinity'::timestamptz
                  WHEN self_excluded_until = 'infinity'::timestamptz THEN self_excluded_until
                  ELSE GREATEST(
                    COALESCE(self_excluded_until, '-infinity'::timestamptz),
                    now() + ($2 * interval '1 day')
                  ) END,
                updated_at = now()
          WHERE user_id = $1`,
        [request.authUser?.id, body.durationDays],
      );
      await client.query(
        `UPDATE users
            SET status = CASE WHEN status IN ('suspended', 'closed') THEN status
                              ELSE 'self_excluded' END,
                updated_at = now()
          WHERE id = $1`,
        [request.authUser?.id],
      );
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [
        request.authUser?.id,
      ]);
      await client.query(
        `UPDATE deposit_intents SET status = 'cancelled'
          WHERE user_id = $1 AND status = 'pending'`,
        [request.authUser?.id],
      );
    });
    return { selfExcluded: true };
  });
}

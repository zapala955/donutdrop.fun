# Discord control plane runbook

The Discord control plane turns a private guild into a remote control for the platform: read
commands, moderation commands, an alert feed, and a command that mints a single-use link into the
admin dashboard.

## Read this before enabling it

A redeemed dashboard link produces an administrator session with **MFA already marked satisfied**.

Everywhere else, an admin session requires the TOTP secret from `ADMIN_TOTP_SECRETS_JSON`, and
`authenticate()` re-checks that key's fingerprint on *every request* — so holding a stolen session
cookie is not enough. This is the one path that does not ask.

The consequence: **whoever controls an operator's Discord account controls the platform.** Discord
account security becomes admin account security. The compensating controls are real but they are
about shrinking the window, not closing it:

| Control | Where |
|---|---|
| Token stored only as SHA-256 | `discord_admin_links.token_hash` |
| Expires in ≤ 15 minutes (schema-capped) | `DISCORD_ADMIN_LINK_TTL_SECONDS` |
| Single use, claimed by one atomic `UPDATE` | `redeemAdminLink` |
| Minting revokes the operator's other live links | `mintAdminLink` |
| Bound to the Discord id that asked | `discord_admin_links.discord_user_id` |
| Role and status re-checked at redemption, not just at issue | `redeemAdminLink` |
| Issue and redemption both in the hash-chained audit log | `discord.admin_link.*` |
| Redeemed session capped at 8 hours regardless of `SESSION_TTL_HOURS` | `LINK_SESSION_TTL_HOURS` |

**Minimum bar for enabling this:** 2FA on every operator's Discord account, a guild nobody else can
join, and the bot token handled like a database password.

**If the trade stops looking worth it:** mint links with `require_totp`. The column exists, the
redemption path already reads it, and a link issued that way produces a session with null MFA
columns — which `authenticate()` refuses until the normal TOTP step completes. No schema change
needed, only the flag.

## Setup

1. **Create the Discord application** and a bot user. Note the application id and bot token.
2. **Invite the bot** to exactly one guild, with the `applications.commands` scope. It needs no
   privileged intents — it runs on `Guilds` only and cannot read message content by design.
3. **Configure the gateway** (`.env`):
   ```
   DISCORD_CONTROL_ENABLED=true
   DISCORD_BOT_TOKEN_FILE=/run/secrets/discord_bot_token
   DISCORD_GUILD_ID=<the one guild>
   DISCORD_CONTROL_HMAC_KEY_FILE=/run/secrets/discord_control_key   # openssl rand -base64 48
   DISCORD_OPERATORS_JSON_FILE=/run/secrets/discord_operators.json
   DISCORD_ALERT_CHANNEL_ID=<channel, or empty to disable alerts>
   ```
   `DISCORD_OPERATORS_JSON` maps Discord snowflake to platform identity:
   ```json
   { "123456789012345678": "mc:0123456789abcdef0123456789abcdef" }
   ```
   Every identity must also be in `ADMIN_MINECRAFT_IDS`, or the gateway refuses to boot. That check
   exists so that removing an administrator in one place cannot leave a door open in the other.
4. **Apply the migration**: `npm run db:migrate`. Adds `discord_admin_links`,
   `discord_command_invocations`, `discord_action_confirmations`, `discord_command_budgets`.
5. **Configure the bot process** (`services/discord-bot`): same token, key and guild, plus
   `DISCORD_APPLICATION_ID` and `API_INTERNAL_BASE_URL` pointing at the gateway's internal address.
6. **Publish the commands**: `npm run discord:commands`. Guild-scoped, so they appear nowhere else.
7. **Start the bot**: `npm run discord:start`.

`/internal/` routes must not be publicly reachable. They are signature-gated, not session-gated.

## Commands

| Command | Effect |
|---|---|
| `/stats` | Player, session, wallet-float and queue totals |
| `/user <query>` | Player lookup by username prefix |
| `/bots` | Bot health, reconciliation state, open jobs |
| `/jobs` | Job queue depth by status |
| `/dashboard` | Mints a single-use admin dashboard link |
| `/quarantine-bot` | Quarantine or release a bot — **confirmation required** |
| `/suspend-user` | Suspend or reinstate a player — **confirmation required** |

Every reply is ephemeral. Destructive commands return a summary and a button; nothing happens until
that exact nonce comes back, and the nonce is bound to the operator it was issued to.

Two things are deliberately impossible from Discord: changing an **administrator** account, and
overriding a **self-exclusion**. Both require the dashboard. The first is what a compromised Discord
account would reach for; the second is a responsible-gambling state that should not be undone from a
chat box.

## Why the link is a fragment

The minted URL is `https://<origin>/admin/#<token>` — the token is in the **fragment**, which is
never transmitted in an HTTP request.

This is not cosmetic. Discord unfurls links: the moment one is posted, Discord fetches it to build a
preview. If redemption happened on `GET`, the crawler would spend the token before the operator ever
clicked, and they would be told their brand-new link was already used. A fragment is invisible to
the crawler, to access logs, to proxies, and to the `Referer` header. The page reads it locally and
`POST`s it once.

## Incident response

**An operator's Discord account is compromised.** In order:

1. Remove their snowflake from `DISCORD_OPERATORS_JSON` and restart the gateway. This alone stops
   new commands and new links.
2. Revoke outstanding links and any sessions they created:
   ```sql
   UPDATE discord_admin_links
      SET revoked_at = now(), revoked_reason = 'operator compromise'
    WHERE discord_user_id = $1 AND claimed_at IS NULL AND revoked_at IS NULL;

   UPDATE sessions SET revoked_at = now()
    WHERE id IN (SELECT session_id FROM discord_admin_links
                  WHERE discord_user_id = $1 AND session_id IS NOT NULL)
      AND revoked_at IS NULL;
   ```
3. Review what they did:
   ```sql
   SELECT created_at, command, outcome, error_code, arguments
     FROM discord_command_invocations
    WHERE discord_user_id = $1
    ORDER BY created_at DESC LIMIT 200;
   ```
4. Cross-check against the tamper-evident log, which is the authority on what actually changed:
   ```sql
   SELECT created_at, action, target_type, target_id, details
     FROM audit_log
    WHERE action LIKE 'discord.%' OR details->>'via' = 'discord'
    ORDER BY sequence_no DESC LIMIT 200;
   ```

**The bot token leaks.** Regenerate it in the Discord developer portal and restart the bot. Note
what this does *not* require: the token alone cannot run a command, because the gateway still
demands a Discord user id from the operator allowlist and that list lives in gateway configuration
the bot cannot read. Rotate `DISCORD_CONTROL_HMAC_KEY` too if the leak may have included it.

**Commands stop working.** Check in order: gateway booted with `DISCORD_CONTROL_ENABLED=true`
(routes are not registered at all when it is off); clocks within 60 seconds of each other
(signatures carry a timestamp and stale ones are refused); the HMAC key matches on both sides; the
invoking user is in `DISCORD_OPERATORS_JSON` *and* `ADMIN_MINECRAFT_IDS`; the budget is not spent
(`discord_command_budgets`).

**A link will not redeem.** All failure modes report the same message on purpose — expired, already
used, revoked and never-existed are indistinguishable to the holder of a URL. Check
`discord_admin_links` for the real reason.

## Retention

`sweepDiscordControl()` prunes expired links, spent confirmations and stale budget windows. Call it
from the maintenance job.

`discord_command_invocations` is **never pruned and has no `DELETE` grant**. It is the record of who
asked for what, which is the first thing an incident review needs and the first thing an attacker
would want to tidy away.

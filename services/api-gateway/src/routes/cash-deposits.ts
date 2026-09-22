import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { pickBot } from '../lib/bots.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';

/** Shows the permanent cash deposit instruction for the online, provisioned bot. */
export async function registerCashDepositRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  app.get(
    '/v1/cash-deposits/info',
    {
      preHandler: guards.authenticate,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async () => {
      /* The teller, and only ever the teller. This endpoint's whole output is a username a
       * player is told to send money to, so it is the one place the vault's name must never be
       * able to reach. Asking by role rather than by "whichever is online" is what guarantees
       * that, rather than the ordering of a query. */
      const bot = await pickBot(db, config, 'teller');
      if (!bot) throw new AppError(503, 'BOT_OFFLINE', 'No payment bot is currently online');

      return {
        botUsername: bot.username,
        command: `/pay ${bot.username} <amount>`,
        example: `/pay ${bot.username} 1000000`,
        /* What the copy button puts on the clipboard: the command WITHOUT an amount.
         *
         * Copying `example` pasted a literal 1000000 into the player's chat box, so depositing
         * anything else meant deleting a figure somebody else chose before typing your own — and
         * the failure mode when you forget is paying exactly one million by accident. Pasting a
         * command that ends in a space leaves the cursor where the amount goes.
         *
         * Stated by the server rather than sliced off `command` in the browser, because the shape
         * of a DonutSMP pay command is the server's business and a client that reconstructs it is
         * a second opinion about it. */
        copy: `/pay ${bot.username} `,
      };
    },
  );
}

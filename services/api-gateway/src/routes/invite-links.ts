import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { compactMinor } from '../lib/anti-drain.js';
import { isLinkPreview } from '../lib/win-shares.js';

/**
 * An invite link: /r/<code>.
 *
 * A link preview (Discord, WhatsApp, X...) reads the page as served and runs no script, so the
 * offer has to be in the HTML. A preview gets a small page whose title and text name the invite
 * signup bonus, from the live settings; a person is sent on to the site with the code, where the
 * sign-in window opens with it filled in (`/?ref=<code>`), exactly as before. nginx also sends a
 * preview of an older `/?ref=<code>` link here, so links already handed out read the offer too.
 *
 * The code is not looked up: a link to a code that does not exist still lands on the site, where
 * signup ignores a code that matches nothing. Nothing about the inviter is shown.
 */

const CODE = /^[A-Za-z0-9]{6,16}$/;
const IMAGE = '/assets/img/brand/og-image.png?v=2';

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What the link offers, in words: the invite bonus when it is on, else the ordinary one, else none. */
export function inviteOffer(config: AppConfig): { title: string; description: string } {
  const games = 'crash, mines, plinko, blackjack and more';
  if (config.referralsEnabled && config.referralSignupBonusMinor > 0n) {
    const bonus = `$${compactMinor(config.referralSignupBonusMinor)}`;
    return {
      title: `Get a ${bonus} signup bonus on DonutLuxe`,
      description: `You're invited to DonutLuxe, the DonutSMP casino. Sign up with this invite and ${bonus} is added to your balance to play ${games}. Deposit and withdraw in game.`,
    };
  }
  if (config.signupBonusMinor > 0n) {
    const bonus = `$${compactMinor(config.signupBonusMinor)}`;
    return {
      title: `Get ${bonus} free on DonutLuxe`,
      description: `You're invited to DonutLuxe, the DonutSMP casino. Sign up and ${bonus} is added to your balance to play ${games}. Deposit and withdraw in game.`,
    };
  }
  return {
    title: "You're invited to DonutLuxe",
    description: `DonutLuxe is the DonutSMP casino: ${games}. Deposit and withdraw in game.`,
  };
}

export function invitePageHtml(config: AppConfig, code: string): string {
  const { title, description } = inviteOffer(config);
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const page = escapeHtml(`${config.appOrigin}/r/${code}`);
  const image = escapeHtml(`${config.appOrigin}${IMAGE}`);
  const landing = escapeHtml(`${config.appOrigin}/?ref=${code}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${t}</title>
<meta name="description" content="${d}" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#ffd700" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="DonutLuxe" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:url" content="${page}" />
<meta property="og:image" content="${image}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta name="twitter:image" content="${image}" />
</head>
<body>
<p><a href="${landing}">${t}</a></p>
</body>
</html>
`;
}

export async function registerInviteLinkRoutes(app: FastifyInstance, config: AppConfig) {
  app.get<{ Params: { code: string } }>(
    '/r/:code',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const raw = String(request.params.code ?? '');
      if (!CODE.test(raw)) return reply.header('cache-control', 'no-store').redirect('/', 302);
      const code = raw.toUpperCase();
      if (isLinkPreview(request.headers['user-agent'])) {
        return reply.header('content-type', 'text/html; charset=utf-8').send(invitePageHtml(config, code));
      }
      return reply.header('cache-control', 'no-store').redirect(`/?ref=${code}`, 302);
    },
  );
}

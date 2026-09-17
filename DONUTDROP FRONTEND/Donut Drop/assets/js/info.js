/* info.js — support, and the terms page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE TWO ARE NOT WRITTEN THE WAY THE OTHER ROUTES ARE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every other page on the site renders server state. These two would normally render prose, and
 * prose is the one thing that cannot be invented here.
 *
 * TERMS. A terms page is a legal instrument. Writing plausible-sounding clauses — withdrawal
 * rules, dispute handling, liability, account closure — would produce a document that reads as
 * binding and is not, drafted by nobody, agreed by nobody, and relied on by players. So this page
 * publishes the operative ECONOMIC terms instead, every one of them read live from the server
 * config the games actually enforce: the house edge, the return to player, the multiplier window,
 * the rakeback rates, the referral terms. Those are facts this codebase can prove. The legal
 * document is marked as not yet published, because it is not.
 *
 * SUPPORT. Same rule, smaller stakes. No invented response times, no invented ticket system, no
 * staffed-hours promise. It surfaces the things that genuinely help somebody stuck — their own
 * account and session identifiers for a report, the live service state, and the routes that
 * answer the questions support is most often asked — and says plainly where the contact channel
 * is not configured rather than printing an address that goes nowhere.
 */
import { state, bus } from './store.js';
import { $, el, money, pct } from './util.js';
import { toast } from './ui.js';

// ─────────── /support ───────────

let supportRoot = null;

export function mountSupport(view) {
  supportRoot = view;
  bindOnce(view, 'support', paintSupport);
  paintSupport();
}

function paintSupport() {
  if (!supportRoot?.isConnected) return;
  const root = ensureShell(supportRoot, 'Support', 'supportRoot');
  root.innerHTML = '';

  /* Service state first. "Is it me or is it them" is the question behind most support contacts,
   * and it is one the page can answer without anybody being contacted at all. */
  const status = panel('Service');
  status.appendChild(
    facts([
      ['API', state.online ? 'reachable' : 'unreachable', state.online ? 'up' : 'down'],
      ['Session', state.authenticated ? 'signed in' : 'signed out', state.authenticated ? 'up' : null],
      ['Chat', state.chat?.slowModeSeconds ? `slow mode ${state.chat.slowModeSeconds}s` : 'normal', null],
    ]),
  );
  root.appendChild(status);

  /* What a human needs pasted into a report. Without these, the first reply to every report is a
   * request for them. The account id is copyable rather than selectable-by-hand because it is a
   * uuid and nobody transcribes one correctly. */
  const identity = panel('Include this in a report');
  if (state.authenticated) {
    const rows = [
      ['Username', state.user?.minecraftUsername ?? '—'],
      ['Account id', state.user?.id ?? '—'],
    ];
    if (state.fairness?.serverSeedHash) {
      rows.push(['Active commitment', state.fairness.serverSeedHash.slice(0, 24) + '…']);
    }
    identity.appendChild(facts(rows));

    const copy = el('button', 'btn');
    copy.type = 'button';
    copy.textContent = 'COPY REPORT DETAILS';
    copy.addEventListener('click', () => copyReport());
    identity.appendChild(copy);
  } else {
    identity.appendChild(facts([['Account', 'signed out']]));
  }
  root.appendChild(identity);

  /* The self-serve answers, as links rather than as an FAQ. Every one of these routes already
   * answers a question support would otherwise be asked by hand. */
  const help = panel('Answer it yourself');
  const links = el('div', 'info__links');
  for (const [label, href] of [
    ['Verify a roll', '#/fairness'],
    ['Wallet ledger', '#/wallet'],
    ['Match history', '#/history'],
    ['Responsible play', '#/settings'],
    ['Terms', '#/terms'],
  ]) {
    const link = el('a', 'info__link');
    link.href = href;
    link.textContent = label;
    links.appendChild(link);
  }
  help.appendChild(links);
  root.appendChild(help);

  /* No contact channel is configured in this build. Saying so is the honest option; printing an
   * address that nobody reads would be worse than printing nothing. */
  const contact = panel('Contact');
  contact.appendChild(facts([['Channel', 'not configured in this build']]));
  root.appendChild(contact);
}

async function copyReport() {
  const lines = [
    `username: ${state.user?.minecraftUsername ?? '-'}`,
    `account: ${state.user?.id ?? '-'}`,
    `commitment: ${state.fairness?.serverSeedHash ?? '-'}`,
    `nonce: ${state.fairness?.nonce ?? '-'}`,
    `when: ${new Date().toISOString()}`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(lines);
    toast({ kind: 'win', title: 'Copied' });
  } catch {
    toast({ kind: 'lose', title: 'Clipboard blocked', body: 'Copy the fields above by hand.' });
  }
}

// ─────────── /terms ───────────

let termsRoot = null;

export function mountTerms(view) {
  termsRoot = view;
  bindOnce(view, 'terms', paintTerms);
  paintTerms();
}

function paintTerms() {
  if (!termsRoot?.isConnected) return;
  const root = ensureShell(termsRoot, 'Terms', 'termsRoot');
  root.innerHTML = '';

  const upgrade = state.upgradeConfig;
  const rake = state.rakeback;
  const referral = state.referrals;

  /* The house edge, as the platform actually applies it. Read from the live upgrade config rather
   * than restated, so this page cannot drift from what the server charges. */
  const economics = panel('What the house takes');
  if (upgrade) {
    const edge = Number(upgrade.houseEdgeBps) / 10_000;
    economics.appendChild(
      facts([
        ['House edge', pct(edge, 2)],
        ['Return to player', pct(1 - edge, 2)],
        ['Max win chance', pct(Number(upgrade.maxWinChancePpm) / 1_000_000, 2)],
        ['Multiplier floor', `${(Number(upgrade.minMultiplierBps) / 10_000).toFixed(2)}x`],
        ['Multiplier ceiling', `${(Number(upgrade.maxMultiplierBps) / 10_000).toFixed(2)}x`],
      ]),
    );
  } else {
    economics.appendChild(facts([['Terms', 'log in to load the live figures']]));
  }
  root.appendChild(economics);

  if (rake) {
    const back = panel('Rakeback');
    back.appendChild(
      facts(
        rake.tiers.map((tier) => [
          tier.tier,
          `${(tier.rateBps / 100).toFixed(0)}% of house margin`,
        ]),
      ),
    );
    root.appendChild(back);
  }

  if (referral) {
    const invites = panel('Referrals');
    invites.appendChild(
      facts([
        ['Bonus per invite', money(Number(referral.terms.bonusMinor))],
        ['Wager to unlock', money(Number(referral.terms.bonusWagerMinor))],
        ['Revenue share', `${(referral.terms.revshareBps / 100).toFixed(1)}% of house margin`],
      ]),
    );
    root.appendChild(invites);
  }

  const fairness = panel('Fairness');
  fairness.appendChild(
    facts([
      ['Algorithm', state.fairness?.algorithm ?? 'HMAC-SHA256'],
      ['Commitment', 'published before every roll'],
      ['Verification', 'in your browser, at /fairness'],
    ]),
  );
  root.appendChild(fairness);

  /* Stated last and stated plainly. A terms page that quietly omits the fact that there is no
   * legal document would imply one exists. */
  const legal = panel('Legal document');
  legal.appendChild(facts([['Status', 'not published yet', 'down']]));
  root.appendChild(legal);
}

// ─────────── shared ───────────

function panel(title) {
  const card = el('section', 'acct__panel');
  const label = el('span', 'acct__label');
  label.textContent = title;
  card.appendChild(label);
  return card;
}

function facts(rows) {
  const list = el('dl', 'acct__facts mono');
  for (const [term, value, tone] of rows) {
    const group = el('div');
    if (tone) group.dataset.tone = tone;
    const dt = el('dt');
    dt.textContent = term;
    const dd = el('dd');
    dd.textContent = value;
    group.append(dt, dd);
    list.appendChild(group);
  }
  return list;
}

function ensureShell(view, title, rootId) {
  let root = $('#' + rootId, view);
  if (!root) {
    view.innerHTML = '';
    const header = el('header', 'phead');
    const heading = el('h1');
    heading.textContent = title;
    header.appendChild(heading);
    root = el('div', 'acct');
    root.id = rootId;
    view.append(header, root);
  }
  return root;
}

function bindOnce(view, key, paint) {
  if (view.dataset.bound === key) return;
  view.dataset.bound = key;
  bus.addEventListener('change', (event) => {
    if (!view.isConnected) return;
    if (['login', 'logout', 'ready', 'private', 'account', 'rakeback', 'referrals'].includes(event.detail)) {
      paint();
    }
  });
}

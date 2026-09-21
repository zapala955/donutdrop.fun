/* info.js — support details and the public terms document. */
import { state, bus } from './store.js';
import { $, el } from './util.js';
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
    ['Verify a roll', '/fairness'],
    ['Wallet ledger', '/wallet'],
    ['Match history', '/history'],
    ['Your account', '/settings'],
    ['Terms', '/terms'],
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
  root.replaceChildren();

  const document = el('article', 'termsdoc');
  const effective = el('p', 'termsdoc__effective mono');
  effective.textContent = 'Effective: 21 September 2026';
  const intro = el('p', 'termsdoc__intro');
  intro.textContent =
    'These terms govern your use of Donut Drop. By creating an account, depositing, playing, or claiming a reward, you agree to them.';
  document.append(effective, intro);

  const sections = [
    [
      '1. Eligibility',
      [
        'You must be legally allowed to use the service where you live.',
        'Do not use Donut Drop from a location where this type of service is prohibited.',
      ],
    ],
    [
      '2. Your account',
      [
        'You are responsible for your account, your Minecraft account, and all activity performed through them.',
        'Do not share or sell access, impersonate another player, evade restrictions, or use multiple accounts to abuse promotions or rewards.',
      ],
    ],
    [
      '3. Balances and gameplay',
      [
        'Balances are denominated in DonutSMP in-game dollars. They are not legal tender, cryptocurrency, a bank deposit, or an investment.',
        'Games involve risk and you may lose the amount you wager. The probabilities and potential return shown before a play form part of that play.',
        'The platform record is authoritative for wagers, outcomes, credits, and debits. You may verify supported game outcomes on the Fairness page.',
      ],
    ],
    [
      '4. Deposits and withdrawals',
      [
        'Use only the supported deposit and withdrawal methods and provide the correct Minecraft username and payment details.',
        'Minimums, maximums, availability, and any verification requirements shown when you make a transfer apply to that transfer.',
        'Transfers may be delayed or refused when information is incorrect, the Minecraft server is unavailable, or fraud or abuse is suspected.',
      ],
    ],
    [
      '5. Rewards and referrals',
      [
        'Bonuses, daily rewards, rakeback, VIP benefits, and referral rewards are subject to the eligibility and wagering requirements displayed for them.',
        'Rewards obtained through self-referrals, coordinated abuse, bots, exploits, or misleading promotion may be withheld or reversed.',
      ],
    ],
    [
      '6. Prohibited conduct',
      [
        'You may not exploit bugs, automate play, interfere with the service, collude, manipulate outcomes, launder value, threaten users, or attempt unauthorized access.',
        'Report a suspected vulnerability or incorrect balance instead of attempting to benefit from it.',
      ],
    ],
    [
      '7. Suspension and closure',
      [
        'We may restrict, suspend, or close an account to investigate fraud, abuse, security incidents, legal requirements, or a breach of these terms.',
        'Where lawful and technically possible, a legitimate remaining balance will be handled after the investigation is complete.',
      ],
    ],
    [
      '8. Availability and changes',
      [
        'The service is provided as available. Features, games, limits, rewards, and these terms may change, and the service may be interrupted for maintenance or security.',
        'Material changes apply from the effective date shown on this page. Continuing to use the service after that date means you accept the updated terms.',
      ],
    ],
    [
      '9. Responsibility',
      [
        'To the fullest extent permitted by law, Donut Drop is not responsible for indirect losses, lost opportunities, third-party outages, or events outside its reasonable control.',
        'Nothing in these terms excludes rights or liability that cannot legally be excluded.',
      ],
    ],
  ];

  for (const [heading, paragraphs] of sections) {
    const section = el('section', 'termsdoc__section');
    const title = el('h2');
    title.textContent = heading;
    section.appendChild(title);
    for (const copy of paragraphs) {
      const paragraph = el('p');
      paragraph.textContent = copy;
      section.appendChild(paragraph);
    }
    document.appendChild(section);
  }

  const contact = el('section', 'termsdoc__section');
  const contactTitle = el('h2');
  contactTitle.textContent = '10. Questions';
  const contactCopy = el('p');
  contactCopy.append('If you have a question about these terms or your account, use the ');
  const support = el('a');
  support.href = '/support';
  support.textContent = 'Support page';
  contactCopy.append(support, '.');
  contact.append(contactTitle, contactCopy);
  document.appendChild(contact);

  root.appendChild(document);
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

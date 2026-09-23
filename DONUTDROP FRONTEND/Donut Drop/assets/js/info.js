/* info.js — where to get help, and the public terms document. */
import { bus } from './store.js';
import { $, el } from './util.js';

// ─────────── /support ───────────

/* The same server as the Discord tab. Duplicated as a constant rather than imported from
 * discord.js, which exists to mount a view and would drag a DOM module into this one for a
 * string; if a third page ever needs it, that is the point at which it earns its own home. */
const SUPPORT_INVITE_URL = 'https://discord.gg/aHfRsUaGgx';

let supportRoot = null;

export function mountSupport(view) {
  supportRoot = view;
  bindOnce(view, 'support', paintSupport);
  paintSupport();
}

function paintSupport() {
  if (!supportRoot?.isConnected) return;
  const root = ensureShell(supportRoot, 'Support', 'supportRoot');
  root.replaceChildren();

  /* One instruction, and nothing else.
   *
   * This page used to be a service dashboard: API reachability, session state, chat slow mode, a
   * copyable report bundle and five self-serve links. All of it was in service of a contact
   * channel the build never had -- the last panel read "not configured in this build" -- so the
   * page spent four sections preparing somebody for a conversation it could not start.
   *
   * Support happens in the Discord server now, so the page says that and gets out of the way. */
  const card = el('section', 'dsync__invite');

  const heading = el('h2', 'dsync__invitetitle');
  heading.textContent = 'Need help?';

  const copy = el('p', 'dsync__invitecopy');
  copy.textContent =
    'Open a ticket in our Discord server and a member of staff will get back to you. Include your ' +
    'in-game name and what happened, and we will pick it up from there.';

  /* The same anchor treatment the Discord tab uses: a real link, so middle-click, copy-address and
   * open-in-new-tab all behave, and rel="noopener" so the opened tab cannot navigate this one. */
  const go = el('a', 'btn btn--go dsync__go');
  go.href = SUPPORT_INVITE_URL;
  go.target = '_blank';
  go.rel = 'noopener noreferrer';
  go.textContent = 'OPEN A TICKET';
  go.setAttribute('aria-label', `Open a support ticket in the Donut Drop Discord at ${SUPPORT_INVITE_URL}`);

  const address = el('p', 'dsync__inviteurl mono');
  address.textContent = SUPPORT_INVITE_URL.replace(/^https:\/\//, '');

  card.append(heading, copy, go, address);
  root.appendChild(card);
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

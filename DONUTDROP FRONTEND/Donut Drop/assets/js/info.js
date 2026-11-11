/* info.js — the help centre (/support) and the public terms document. */
import { api } from './api.js';
import { bus, state } from './store.js';
import { $, el, money } from './util.js';

// ─────────── /support ───────────

/* The help centre (2026-11-11, the owner: "remake the support page with a lot of articles that will
 * help lost players"). Searchable articles in eight groups, each a <details> that opens in place,
 * and the ticket at the end for whatever they do not answer.
 *
 * Figures are the server's, never typed here: the bonus multipliers from /v1/promotions, the
 * Discord rewards and code drops from /v1/discord/rewards, and, signed in, the withdrawal minimum,
 * tax, cooldown and review threshold from /v1/cash-withdrawals/info. Every sentence still reads
 * true without them ("the Withdraw window shows it"), so a figure that has not loaded is never
 * guessed. A link to /support#<article> opens that article, for staff answering a ticket. */

/* The same server as the Discord tab. Duplicated as a constant rather than imported from
 * discord.js, which exists to mount a view and would drag a DOM module into this one for a
 * string. */
const SUPPORT_INVITE_URL = 'https://discord.gg/aHfRsUaGgx';
const ITEM = (name) => `assets/img/items/${name}.png`;

const GROUPS = [
  { id: 'start', name: 'Getting started', icon: 'name_tag' },
  { id: 'deposit', name: 'Deposits', icon: 'gold_ingot' },
  { id: 'withdraw', name: 'Withdrawals', icon: 'emerald' },
  { id: 'wager', name: 'Wagering', icon: 'hopper' },
  { id: 'rewards', name: 'Bonuses & rewards', icon: 'chest' },
  { id: 'discord', name: 'Discord & code drops', icon: 'enchanted_book' },
  { id: 'safe', name: 'Fairness & safety', icon: 'totem' },
  { id: 'fix', name: 'Something went wrong', icon: 'redstone' },
];

/* What the server says, or null while it has not (or cannot). */
const facts = { promotions: null, discord: null, withdraw: null };

const usd = (minor) => (minor == null ? null : money(Number(minor)));
const times = (n) => (n == null ? null : `${n}×`);
/* "X (the figure)" when the figure is known, plain "X" when it is not. */
const known = (text, figure) => (figure ? `${text} (${figure})` : text);

function figures() {
  const p = facts.promotions;
  const d = facts.discord;
  const w = facts.withdraw;
  return {
    depositX: times(p?.depositWagerMultiplier),
    signupBonus: usd(p?.signupBonus?.amountMinor),
    signupX: times(p?.signupBonus?.wagerMultiplier),
    inviteBonus: usd(p?.referralSignupBonus?.amountMinor),
    inviteX: times(p?.referralSignupBonus?.wagerMultiplier),
    referralBonus: usd(p?.referral?.bonusMinor),
    referralWager: usd(p?.referral?.bonusWagerMinor),
    discordJoin: usd(d?.amounts?.joinMinor),
    discordTag: usd(d?.amounts?.tagMinor),
    discordAge: d?.minAccountAgeDays ?? null,
    dropPrize: usd(d?.codeDrops?.prizeMinor),
    dropClaims: d?.codeDrops?.maxClaims ?? null,
    dropX: times(d?.codeDrops?.wagerMultiplier),
    dropEvery: d?.codeDrops?.everyMinutes
      ? d.codeDrops.everyMinutes % 60 === 0
        ? d.codeDrops.everyMinutes === 60 ? 'every hour' : `every ${d.codeDrops.everyMinutes / 60} hours`
        : `every ${d.codeDrops.everyMinutes} minutes`
      : 'every few hours',
    minWithdraw: usd(w?.minimumMinor),
    review: usd(w?.approvalThresholdMinor),
    tax: w?.payTaxBps != null ? `${w.payTaxBps / 100}%` : null,
    cooldown: w?.cooldownSeconds != null
      ? w.cooldownSeconds % 60 === 0 ? `${w.cooldownSeconds / 60} minute${w.cooldownSeconds === 60 ? '' : 's'}` : `${w.cooldownSeconds} seconds`
      : null,
  };
}

/* An article is a group, a title, and blocks: { p }, { steps: [] }, { tip }, { go: [href, label] }. */
function articles(f) {
  return [
    // ── getting started ──
    { id: 'what-is-donutluxe', group: 'start', title: 'What is DonutLuxe?', blocks: [
      { p: 'DonutLuxe is a casino played with DonutSMP money. You send in-game dollars to our payment bot, play the games here, and the bot pays your winnings back to your Minecraft account.' },
      { p: 'Your balance is DonutSMP dollars, nothing else: it is not real money, crypto or an investment. DonutLuxe is a fan-made site and is not run by or connected to DonutSMP.' },
    ] },
    { id: 'sign-in', group: 'start', title: 'How do I sign in?', blocks: [
      { steps: [
        'Press Log in at the top of the page.',
        'Type your Minecraft name exactly as it shows on DonutSMP, and tick the box.',
        'If you have linked an email, you can choose Email me a code. Otherwise the window shows a /pay command.',
        'Join DonutSMP on that account and run the command exactly as shown. The amount is what identifies you, so pay exactly that amount.',
        'The window signs you in by itself once the bot sees the payment. That small amount is added to your balance.',
      ] },
      { tip: 'There is no password. Nobody from DonutLuxe will ever ask you for a code, and you never have to pay anyone except the bot named in the window.' },
    ] },
    { id: 'bedrock', group: 'start', title: 'I play on Bedrock (phone, console or Windows 10)', blocks: [
      { p: 'Bedrock players get a dot in front of their name on DonutSMP, like .Steve. Type your name with the dot when you sign in, exactly as DonutSMP shows it in chat or on the tab list.' },
    ] },
    { id: 'email-sign-in', group: 'start', title: 'Signing in with an email code', blocks: [
      { p: 'Once you are signed in, open Profile and link an email. From then on, typing your Minecraft name at Log in offers Email me a code, so you can sign in without joining DonutSMP.' },
      { go: ['/profile', 'Open your profile'] },
    ] },
    { id: 'change-account', group: 'start', title: 'Moving to a different Minecraft account', blocks: [
      { p: 'Open Profile and press Change account on the Minecraft card. You prove the new account is yours with a small /pay from it, the same way as signing in. Your balance moves with you.' },
      { go: ['/profile', 'Open your profile'] },
    ] },
    { id: 'how-games-work', group: 'start', title: 'How do I learn a game?', blocks: [
      { p: 'Every game has a How it works button next to its name, with the rules, the odds and what each bet pays. Try small bets first: every game takes small stakes.' },
    ] },

    // ── deposits ──
    { id: 'how-to-deposit', group: 'deposit', title: 'How do I deposit?', blocks: [
      { steps: [
        'Sign in, then press Deposit at the top of the page.',
        'The window shows the payment bot’s name and a ready /pay command. Press Copy.',
        'On DonutSMP, run /pay with the bot’s name and the amount you want to deposit.',
        'Your balance goes up as soon as the bot receives it, usually within seconds.',
      ] },
      { tip: 'Deposits have a wagering requirement too, so the site cannot be used to move money between accounts. See Wagering.' },
    ] },
    { id: 'deposit-own-account', group: 'deposit', title: 'Pay from the account you signed in with', blocks: [
      { p: 'A deposit is matched to you by the Minecraft account that sent it. If you pay from a different account, the money does not reach your balance. Always pay from the account you sign in with.' },
      { p: 'Sent it from the wrong account already? Open a ticket with both names, the amount and the time.' },
    ] },
    { id: 'deposit-bot-name', group: 'deposit', title: 'Only pay the name the Deposit window shows', blocks: [
      { p: 'The payment bot’s name can change. Always copy it from the Deposit window, never from chat, a DM or a message that claims to be staff. Money sent to any other player cannot be recovered by us.' },
    ] },

    // ── withdrawals ──
    { id: 'how-to-withdraw', group: 'withdraw', title: 'How do I withdraw?', blocks: [
      { steps: [
        'Press Withdraw at the top of the page.',
        f.minWithdraw ? `Enter the amount: at least ${f.minWithdraw}.` : 'Enter the amount.',
        'Confirm. The bot pays you on DonutSMP with /pay.',
      ] },
      { p: f.tax
        ? `DonutSMP takes a ${f.tax} tax on every /pay. It comes out of your withdrawal, so you receive the amount minus ${f.tax}. The Withdraw window shows exactly what will arrive.`
        : 'DonutSMP takes a small tax on every /pay. It comes out of your withdrawal, and the Withdraw window shows exactly what will arrive.' },
      { p: f.cooldown ? `You can make one withdrawal every ${f.cooldown}.` : 'There is a short wait between withdrawals.' },
    ] },
    { id: 'payments-on', group: 'withdraw', title: 'Turn payments on in DonutSMP', blocks: [
      { p: 'If payments are switched off in your DonutSMP /settings, the bot cannot pay you. The withdrawal is cancelled and the money goes back to your balance by itself.' },
      { steps: ['On DonutSMP, run /settings.', 'Turn payments on.', 'Withdraw again.'] },
    ] },
    { id: 'offline-withdraw', group: 'withdraw', title: 'Do I need to be online on DonutSMP?', blocks: [
      { p: 'No. DonutSMP keeps a payment for a player who is offline and delivers it when you next join. You will see the "paid you" message then.' },
    ] },
    { id: 'withdraw-review', group: 'withdraw', title: 'Why is my withdrawal waiting for review?', blocks: [
      { p: `${f.review ? `Withdrawals over ${f.review}` : 'Large withdrawals'} are approved by a member of staff before the bot sends them. The money is held for you meanwhile; nothing is lost. Most are approved quickly.` },
    ] },
    { id: 'cant-withdraw-wager', group: 'withdraw', title: '"Wager $… more before withdrawing"', blocks: [
      { p: 'Your balance still has a wagering requirement on it. Every bet you place counts it down, and withdrawing unlocks the moment it reaches zero.' },
      { go: ['#what-is-wagering', 'What is a wagering requirement?'] },
    ] },

    // ── wagering ──
    { id: 'what-is-wagering', group: 'wager', title: 'What is a wagering requirement?', blocks: [
      { p: 'Money you deposit or get for free has to be played through before it can be withdrawn. The total you still have to bet is your wagering requirement. The Withdraw window shows how much is left.' },
      { p: 'It exists so free bonuses cannot be collected on spare accounts and cashed out, and so the site cannot be used to move money between Minecraft accounts without playing.' },
    ] },
    { id: 'wager-multipliers', group: 'wager', title: 'How much do I have to wager?', blocks: [
      { p: 'Each credit adds its amount, times its multiplier, to what you owe:' },
      { steps: [
        known('A deposit', f.depositX),
        known('The signup bonus', f.signupX),
        known('The bonus for joining with an invite code', f.inviteX),
        known('A code drop from the Discord', f.dropX),
        'Quest rewards, daily rewards, Discord rewards and giveaways carry a requirement too.',
      ] },
      { p: 'Example: a deposit at 1× of $10M means betting $10M in total, in any games, before that money can leave.' },
    ] },
    { id: 'what-counts', group: 'wager', title: 'What counts toward it?', blocks: [
      { p: 'Every bet you place, in every game, counts its full stake, whether it wins or loses. Player-versus-player games count too. Tips and transfers do not.' },
    ] },
    { id: 'lost-everything', group: 'wager', title: 'I lost my balance. Does the old requirement stay?', blocks: [
      { p: 'No. If your balance is under $1,000 and you have no game or bet still running, your next deposit clears whatever requirement was left, and only adds its own.' },
      { tip: 'Finish or cash out any open game first (mines, tower, blackjack, a coinflip waiting for an opponent). A bet still running keeps the old requirement in place.' },
    ] },

    // ── bonuses & rewards ──
    { id: 'signup-bonus', group: 'rewards', title: 'The signup bonus', blocks: [
      { p: f.signupBonus
        ? `New accounts get ${f.signupBonus} to start with${f.signupX ? `, to be wagered ${f.signupX} before it can be withdrawn` : ''}.`
        : 'New accounts get a starting bonus, which has to be wagered before it can be withdrawn.' },
      { p: f.inviteBonus ? `Joining with a friend’s invite code gives ${f.inviteBonus} instead${f.inviteX ? ` (wager ${f.inviteX})` : ''}.` : 'Joining with a friend’s invite code gives a bigger bonus instead.' },
    ] },
    { id: 'daily-rewards', group: 'rewards', title: 'Daily rewards and streaks', blocks: [
      { p: 'Claim a free reward on Daily Rewards each day you play. Come back on following days to build a streak, which makes the reward bigger. The page shows what to wager that day to unlock it.' },
      { go: ['/daily-rewards', 'Open Daily Rewards'] },
    ] },
    { id: 'vip-rakeback', group: 'rewards', title: 'VIP levels and rakeback', blocks: [
      { p: 'Everything you wager raises your VIP level. Each level pays rakeback: a share of the house’s edge on your bets, paid back to you. Claim it on the Rewards page whenever it builds up.' },
      { go: ['/vip', 'See the VIP levels'] },
    ] },
    { id: 'quests', group: 'rewards', title: 'Quests', blocks: [
      { p: 'The Quests page lists tasks, like playing a certain game or wagering an amount. Finish one and claim its prize there.' },
      { go: ['/quests', 'Open Quests'] },
    ] },
    { id: 'invites', group: 'rewards', title: 'Inviting friends', blocks: [
      { p: f.referralBonus
        ? `Share your invite link from the Invites page. You earn ${f.referralBonus} for each friend who joins with it${f.referralWager ? ` once they have wagered ${f.referralWager}` : ''}, plus a share of what they play.`
        : 'Share your invite link from the Invites page. You earn a reward for each friend who joins with it and plays, plus a share of what they play.' },
      { tip: 'Inviting your own spare accounts does not pay: those rewards are held and reversed.' },
      { go: ['/referrals', 'Get your invite link'] },
    ] },

    // ── discord & code drops ──
    { id: 'link-discord', group: 'discord', title: 'Linking your Discord', blocks: [
      { steps: [
        'Join the DonutLuxe Discord server.',
        'Open the Discord page here. It shows your link code.',
        'In the server, run /link with that code.',
      ] },
      { p: [
        f.discordJoin ? `Linking pays ${f.discordJoin} once.` : null,
        f.discordTag ? `Wearing the server tag pays ${f.discordTag} a day.` : null,
        f.discordAge ? `Your Discord account has to be at least ${f.discordAge} days old.` : 'Your Discord account has to be a few weeks old.',
      ].filter(Boolean).join(' ') },
      { go: ['/discord', 'Open the Discord page'] },
    ] },
    { id: 'code-drops', group: 'discord', title: 'Code drops', blocks: [
      { p: f.dropPrize
        ? `A new code is posted in the Discord ${f.dropEvery}. The first ${f.dropClaims ?? 'few'} players to redeem it get ${f.dropPrize} each${f.dropX ? `, to be wagered ${f.dropX} before withdrawing` : ''}.`
        : `A new code is posted in the Discord ${f.dropEvery}, and the first few players to redeem it win a prize.` },
      { steps: [
        'Link your Discord first. Codes are only for linked players.',
        'Tap Redeem on DonutLuxe under the code, or open your account menu and choose Redeem code.',
        'Tap Code pings under any drop to be pinged for the next one.',
      ] },
    ] },

    // ── fairness & safety ──
    { id: 'provably-fair', group: 'safe', title: 'Are the games fair?', blocks: [
      { p: 'Every result is provably fair. Before you bet you are shown a hash of our secret server seed. Your result comes from that seed, your own client seed and a counter, so we cannot change it after you bet.' },
      { p: 'On the Fairness page you can set your own client seed, reveal past seeds and check any result yourself.' },
      { go: ['/fairness', 'Open Fairness'] },
    ] },
    { id: 'account-safety', group: 'safe', title: 'Keeping your account safe', blocks: [
      { steps: [
        'Never give anyone a sign-in code or an email code. Staff will never ask for one.',
        'Only ever /pay the bot named in the Deposit or Log in window.',
        'Use donutluxe.com only. Links to look-alike sites are scams.',
        'Staff help only through tickets in our Discord, never in DMs.',
      ] },
    ] },
    { id: 'play-responsibly', group: 'safe', title: 'Playing responsibly', blocks: [
      { p: 'Casino games are random, and the house has an edge, so over time you lose more than you win. Only play with money you are happy to lose, and take breaks.' },
      { p: 'If you want your account closed, open a ticket and we will do it.' },
    ] },

    // ── something went wrong ──
    { id: 'deposit-missing', group: 'fix', title: 'My deposit has not arrived', blocks: [
      { steps: [
        'Check that you paid the exact bot name from the Deposit window, from the account you sign in with.',
        'Check DonutSMP said you paid it. If the server was restarting, the payment may not have gone through.',
        'Give it a few minutes if the bot was offline. It catches up when it is back.',
        'Still missing? Open a ticket with your name, the amount, the time and a screenshot of the payment.',
      ] },
    ] },
    { id: 'withdrawal-refunded', group: 'fix', title: 'My withdrawal was refunded', blocks: [
      { p: 'The bot could not pay you, so the money went back to your balance. The usual reason is payments being off in your DonutSMP /settings. Turn them on and withdraw again.' },
    ] },
    { id: 'withdrawal-late', group: 'fix', title: 'My withdrawal has not arrived', blocks: [
      { p: 'Check your DonutSMP chat for the "paid you" message, and remember the tax comes off the amount. If you were offline, it arrives when you next join.' },
      { p: 'DonutSMP restarts can hold payments for a few minutes. If it still has not arrived once the bot is back online, open a ticket with the amount and the time.' },
    ] },
    { id: 'bot-offline', group: 'fix', title: '"The payment bot is offline"', blocks: [
      { p: 'The bot is reconnecting, usually after a DonutSMP restart or maintenance. Your balance is safe. Deposits, withdrawals and pay sign-ins wait until it is back, normally within a few minutes.' },
    ] },
    { id: 'sign-in-failed', group: 'fix', title: 'Signing in did not work', blocks: [
      { steps: [
        'Pay exactly the amount shown. A different amount cannot identify you.',
        'Pay from the account whose name you typed, and to the bot named in the window.',
        'If the window ran out of time, start again for a new command.',
        'Linked an email? Choose Email me a code instead.',
      ] },
    ] },
  ];
}

let supportRoot = null;
let query = '';
let group = '';
const opened = new Set();

export function mountSupport(view) {
  supportRoot = view;
  bindOnce(view, 'support', () => {
    void loadFacts();
    paintSupport();
  });
  void loadFacts();
  paintSupport();
}

async function loadFacts() {
  const [promotions, discord, withdraw] = await Promise.all([
    api.get('/v1/promotions').catch(() => null),
    api.get('/v1/discord/rewards').catch(() => null),
    state.authenticated ? api.get('/v1/cash-withdrawals/info').catch(() => null) : Promise.resolve(null),
  ]);
  Object.assign(facts, { promotions, discord, withdraw });
  paintSupport();
}

/* The text an article is searched by: its title and every word in it. */
const searchable = (article) =>
  [article.title, ...article.blocks.flatMap((block) => block.steps ?? [block.p ?? block.tip ?? block.go?.[1] ?? ''])]
    .join(' ')
    .toLowerCase();

function paintBlock(block) {
  if (block.steps) {
    const list = el('ol', 'hc__steps');
    for (const step of block.steps) list.appendChild(el('li')).textContent = step;
    return list;
  }
  if (block.tip) {
    const tip = el('p', 'hc__tip');
    tip.textContent = block.tip;
    return tip;
  }
  if (block.go) {
    const [href, label] = block.go;
    const link = el('a', 'hc__go');
    link.href = href;
    link.textContent = `${label} →`;
    if (href.startsWith('#')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        openArticle(href.slice(1));
      });
    }
    return link;
  }
  const p = el('p', 'hc__p');
  p.textContent = block.p;
  return p;
}

function openArticle(id) {
  const target = document.getElementById(id);
  if (!target || target.tagName !== 'DETAILS' || !supportRoot?.contains(target)) return;
  if (target.hidden) {
    query = '';
    group = '';
    paintSupport();
    return openArticle(id);
  }
  target.open = true;
  opened.add(id);
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  target.querySelector('summary')?.focus({ preventScroll: true });
}

function ticketCard(compact) {
  const card = el('section', compact ? 'hc__ticket hc__ticket--top' : 'hc__ticket');
  const copy = el('div', 'hc__ticketcopy');
  const title = el('h2', 'hc__tickettitle');
  title.textContent = compact ? 'Talk to staff' : 'Still stuck?';
  const text = el('p', 'hc__tickettext');
  text.textContent = compact
    ? 'Open a ticket in our Discord.'
    : 'Open a ticket in our Discord and staff will sort it out. Say your Minecraft name, what happened, the amount and the time, and add a screenshot if you have one.';
  copy.append(title, text);
  const go = el('a', 'btn btn--go hc__ticketgo');
  go.href = SUPPORT_INVITE_URL;
  go.target = '_blank';
  go.rel = 'noopener noreferrer';
  go.textContent = 'Open a ticket';
  card.append(copy, go);
  return card;
}

function paintSupport() {
  if (!supportRoot?.isConnected) return;
  const root = ensureShell(supportRoot, 'Support', 'supportRoot');
  const hadFocus = document.activeElement?.id === 'hcSearch';
  const caret = hadFocus ? document.activeElement.selectionStart : null;
  root.replaceChildren();
  root.classList.add('hc');

  const list = articles(figures());
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = list.filter((article) =>
    (!group || article.group === group) && words.every((word) => searchable(article).includes(word)));

  /* Search, then the way to a person, at the top: the two things somebody lost is looking for. */
  const top = el('div', 'hc__top');
  const search = el('label', 'hc__search');
  search.setAttribute('for', 'hcSearch');
  search.innerHTML = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.08,68.08,0,0,1,44,112Z"/></svg>';
  const input = el('input', 'hc__input');
  input.id = 'hcSearch';
  input.type = 'search';
  input.placeholder = 'Search the help articles';
  input.autocomplete = 'off';
  input.value = query;
  input.setAttribute('aria-label', 'Search the help articles');
  input.addEventListener('input', () => {
    query = input.value;
    paintSupport();
  });
  search.appendChild(input);
  top.append(search, ticketCard(true));
  root.appendChild(top);

  /* The groups, as tiles that narrow the list. Pressing the chosen one again shows everything. */
  const tiles = el('div', 'hc__groups');
  tiles.setAttribute('role', 'group');
  tiles.setAttribute('aria-label', 'Help topics');
  for (const g of GROUPS) {
    const count = list.filter((article) => article.group === g.id).length;
    const tile = el('button', 'hc__group');
    tile.type = 'button';
    tile.setAttribute('aria-pressed', String(group === g.id));
    tile.innerHTML = `<span class="hc__slot"><img src="${ITEM(g.icon)}" alt="" width="28" height="28"></span>`;
    const name = el('span', 'hc__groupname');
    name.textContent = g.name;
    const n = el('span', 'hc__groupcount');
    n.textContent = `${count} articles`;
    const label = el('span', 'hc__grouptext');
    label.append(name, n);
    tile.appendChild(label);
    tile.addEventListener('click', () => {
      group = group === g.id ? '' : g.id;
      paintSupport();
    });
    tiles.appendChild(tile);
  }
  root.appendChild(tiles);

  const status = el('p', 'hc__status');
  status.setAttribute('role', 'status');
  status.textContent = words.length || group
    ? `${shown.length} article${shown.length === 1 ? '' : 's'}${group ? ` in ${GROUPS.find((g) => g.id === group).name}` : ''}${words.length ? ` matching "${query.trim()}"` : ''}`
    : `${list.length} articles`;
  root.appendChild(status);

  if (!shown.length) {
    const none = el('div', 'hc__none');
    none.textContent = 'Nothing matches that. Try another word, or ask staff below.';
    root.appendChild(none);
  }

  for (const g of GROUPS) {
    const mine = shown.filter((article) => article.group === g.id);
    if (!mine.length) continue;
    const section = el('section', 'hc__section');
    const head = el('h2', 'hc__h');
    head.innerHTML = `<img src="${ITEM(g.icon)}" alt="" width="20" height="20">`;
    head.append(g.name);
    section.appendChild(head);
    for (const article of mine) {
      const item = el('details', 'hc__item');
      item.id = article.id;
      // A search opens what it found; otherwise what the player opened stays open across repaints.
      item.open = opened.has(article.id) || (words.length > 0 && shown.length <= 3);
      item.addEventListener('toggle', () => {
        if (item.open) opened.add(article.id);
        else opened.delete(article.id);
      });
      const summary = el('summary', 'hc__q');
      summary.textContent = article.title;
      const body = el('div', 'hc__a');
      for (const block of article.blocks) body.appendChild(paintBlock(block));
      item.append(summary, body);
      section.appendChild(item);
    }
    root.appendChild(section);
  }

  root.appendChild(ticketCard(false));

  if (hadFocus) {
    const again = $('#hcSearch', root);
    again.focus();
    again.setSelectionRange(caret, caret);
  }

  // /support#<article>: open it, once, when the page is first shown.
  const wanted = location.hash.slice(1);
  if (wanted && !supportRoot.dataset.hashOpened && list.some((article) => article.id === wanted)) {
    supportRoot.dataset.hashOpened = wanted;
    requestAnimationFrame(() => openArticle(wanted));
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
    'These terms govern your use of DonutLuxe. By creating an account, depositing, playing, or claiming a reward, you agree to them.';
  document.append(effective, intro);

  const sections = [
    [
      '1. Eligibility',
      [
        'You must be legally allowed to use the service where you live.',
        'Do not use DonutLuxe from a location where this type of service is prohibited.',
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
        'To the fullest extent permitted by law, DonutLuxe is not responsible for indirect losses, lost opportunities, third-party outages, or events outside its reasonable control.',
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

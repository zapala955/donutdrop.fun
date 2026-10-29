/* crowns.js — the crowns on top of the leaderboard, and the bounties beside them.
 *
 * A crown is the best multiplier one round has paid on a house game in the last 30 days (the
 * server's lib/crowns.ts keeps them; this only reads GET /v1/crowns). A bounty is a prize staff put
 * up for the first round that reaches a multiplier. Everything here is a readout: who holds what,
 * when it falls, what the viewer would have to beat. Nothing is decided in the browser.
 *
 * Staff also get the two bounty buttons — put one up, take an open one down — and the server checks
 * that they are staff, whatever this page shows.
 */
import { api } from './api.js';
import { state, bus } from './store.js';
import { tableAvatar } from './table-avatar.js';
import { linkPlayer } from './player-link.js';
import { toast } from './ui.js';
import { el, money, parseAmount } from './util.js';

/* The crowned games, as the lobby names and draws them. */
export const CROWN_GAMES = {
  case: { name: 'Cases', route: '/crates', art: 'assets/img/items/game-crates.svg' },
  upgrader: { name: 'Upgrader', route: '/upgrader', art: 'assets/img/items/game-upgrader.svg' },
  crash: { name: 'Crash', route: '/crash', art: 'assets/img/items/game-crash.svg' },
  mines: { name: 'Mines', route: '/mines', art: 'assets/img/items/game-mines.svg' },
  tower: { name: 'Tower', route: '/tower', art: 'assets/img/items/game-tower.svg' },
  chicken: { name: 'Chicken', route: '/chicken', art: 'assets/img/items/chicken.svg' },
  plinko: { name: 'Plinko', route: '/plinko', art: 'assets/img/items/game-plinko.svg' },
  slots: { name: 'Slots', route: '/ore-rush', art: 'assets/img/items/game-ore-rush.svg' },
  dice: { name: 'Dice', route: '/dice', art: 'assets/img/items/dice.svg' },
};

export const crownGameName = (key) => CROWN_GAMES[key]?.name ?? 'a game';

/** 41250 -> "412.50x"; big ones lose the decimals: 125000 -> "1,250x". */
export function formatX(x100) {
  const value = Number(x100) / 100;
  if (!Number.isFinite(value)) return '—';
  return value >= 1000
    ? `${Math.floor(value).toLocaleString('en-US')}x`
    : `${value.toFixed(2)}x`;
}

/** "3d 4h", "5h 12m", "40m" until a moment; "now" once it has passed. */
function until(iso, now = Date.now()) {
  const left = Date.parse(iso) - now;
  if (!Number.isFinite(left) || left <= 0) return 'now';
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
}

function ago(iso, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function text(tag, cls, value) {
  const node = el(tag, cls);
  node.textContent = value;
  return node;
}

let root = null;
let board = null;
let status = 'idle'; // idle · loading · ready · error
let held = null; // the games the viewer held at the last read; null until the first one
let refetch = 0;

export function mountCrowns(container) {
  root = container;
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    /* A crown changed hands or a bounty moved (live.js). A beat later, so a burst of them is one read. */
    window.addEventListener('donut:crowns', () => {
      if (!root?.isConnected) return;
      clearTimeout(refetch);
      refetch = setTimeout(() => void load(), 400);
    });
    bus.addEventListener('change', (event) => {
      /* 'ready' and 'private': the session is restored after the page mounts, on a reload. */
      if (root?.isConnected && ['login', 'logout', 'ready', 'private'].includes(event.detail)) {
        held = null;
        void load();
      }
    });
  }
  void load();
  paint();
}

async function load() {
  if (!board) status = 'loading';
  try {
    board = await api.get('/v1/crowns');
    status = 'ready';
    announce();
  } catch (error) {
    if (!board) status = 'error';
    console.warn('[donutluxe] crowns failed', error?.code || error);
  }
  paint();
}

/* "You took the Plinko crown": only for a crown the viewer did not hold at the last read. */
function announce() {
  const mine = new Set(
    (board?.crowns ?? []).filter((crown) => crown.holder?.isViewer).map((crown) => crown.game),
  );
  if (held) {
    for (const game of mine) {
      if (held.has(game)) continue;
      const crown = board.crowns.find((entry) => entry.game === game);
      toast({
        title: `You hold the ${crownGameName(game)} crown`,
        body: `${formatX(crown?.multiplierX100)} is the best round on ${crownGameName(game)} right now.`,
        kind: 'win',
      });
    }
  }
  held = mine;
}

function paint() {
  if (!root?.isConnected) return;
  root.replaceChildren();
  if (status === 'error' && !board) return; // the boards below still work; say nothing
  if (!board) {
    root.appendChild(text('p', 'crowns__note', 'Loading the crowns…'));
    return;
  }
  if (!board.enabled) return;

  const head = el('div', 'crowns__head');
  head.append(
    text('h2', 'crowns__title', 'Crowns'),
    text(
      'p',
      'crowns__lede',
      `The best multiplier on each game in the last ${board.windowDays} days, from ` +
        `${money(Number(board.minStakeMinor))} stakes. A crown falls when its round is ` +
        `${board.windowDays} days old, so it has to be defended.`,
    ),
  );
  root.appendChild(head);

  const grid = el('div', 'crowns__grid');
  for (const crown of board.crowns) grid.appendChild(card(crown));
  root.appendChild(grid);

  const lower = el('div', 'crowns__lower');
  lower.append(bountyPanel(), recentPanel());
  root.appendChild(lower);
}

function card(crown) {
  const game = CROWN_GAMES[crown.game] ?? { name: crown.game, route: '/', art: '' };
  const node = el('article', 'crown');
  node.dataset.game = crown.game;
  if (crown.holder?.isViewer) node.dataset.you = '1';
  if (!crown.holder) node.dataset.empty = '1';

  const top = el('a', 'crown__game');
  top.href = game.route;
  const art = el('img', 'crown__art');
  art.src = game.art;
  art.alt = '';
  art.loading = 'lazy';
  top.append(art, text('span', 'crown__name', game.name));
  node.appendChild(top);

  if (!crown.holder) {
    node.append(
      text('div', 'crown__x crown__x--empty', 'Unclaimed'),
      text('div', 'crown__who', 'Win any round here to take it.'),
    );
  } else {
    node.appendChild(text('div', 'crown__x', formatX(crown.multiplierX100)));
    const who = el('div', 'crown__who');
    const avatar = tableAvatar(crown.holder.playerId);
    const name = text('span', 'crown__holder', crown.holder.isViewer ? 'You' : crown.holder.name);
    who.append(avatar, name);
    linkPlayer(crown.holder.playerId, crown.holder.name, avatar, name);
    node.appendChild(who);
    node.appendChild(
      text(
        'div',
        'crown__meta',
        `${money(Number(crown.stakeMinor))} stake · falls in ${until(crown.expiresAt)}`,
      ),
    );
  }

  if (state.authenticated && !crown.holder?.isViewer) {
    const best = crown.yourBestX100;
    const target = crown.multiplierX100 ? Number(crown.multiplierX100) + 1 : null;
    node.appendChild(
      text(
        'div',
        'crown__you',
        best
          ? `Your best: ${formatX(best)}${target ? ` · need ${formatX(target)}` : ''}`
          : target
            ? `Need ${formatX(target)} to take it`
            : 'Nobody holds it yet',
      ),
    );
  }
  return node;
}

function bountyPanel() {
  const panel = el('section', 'crowns__panel crowns__bounties');
  panel.appendChild(text('h3', 'crowns__sub', 'Bounties'));
  const open = board.bounties.filter((bounty) => bounty.status === 'open');
  const done = board.bounties.filter((bounty) => bounty.status !== 'open');
  if (!open.length && !done.length) {
    panel.appendChild(text('p', 'crowns__note', 'No bounties right now. Staff post them in chat and here.'));
  }
  for (const bounty of open) panel.appendChild(bountyRow(bounty));
  for (const bounty of done) panel.appendChild(bountyRow(bounty));
  if (state.user?.role === 'admin') panel.appendChild(bountyForm());
  return panel;
}

function bountyRow(bounty) {
  const row = el('div', 'bounty');
  row.dataset.status = bounty.status;
  const game = CROWN_GAMES[bounty.game]?.name ?? bounty.game;
  const left = el('div', 'bounty__what');
  left.append(
    text('strong', 'bounty__goal', `First to ${formatX(bounty.minMultiplierX100)} on ${game}`),
    text('span', 'bounty__rule', `at ${money(Number(bounty.minStakeMinor))} or more`),
  );
  const right = el('div', 'bounty__prize');
  right.appendChild(text('span', 'bounty__amount', money(Number(bounty.prizeMinor))));
  if (bounty.status === 'open') {
    right.appendChild(text('span', 'bounty__when', `ends in ${until(bounty.closesAt)}`));
  } else if (bounty.status === 'won' && bounty.winner) {
    right.appendChild(
      text(
        'span',
        'bounty__when',
        `${bounty.winner.isViewer ? 'You' : bounty.winner.name} hit ${formatX(bounty.winningMultiplierX100)}`,
      ),
    );
  } else {
    right.appendChild(text('span', 'bounty__when', 'Nobody reached it'));
  }
  row.append(left, right);

  if (bounty.status === 'open' && state.user?.role === 'admin') {
    const cancel = text('button', 'bounty__cancel', 'Take down');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => {
      const reason = window.prompt('Why is this bounty coming down? (for the audit log)');
      if (!reason || reason.trim().length < 3) return;
      cancel.disabled = true;
      try {
        await api.post(`/v1/crowns/bounties/${bounty.id}/cancel`, { reason: reason.trim() });
        await load();
      } catch (error) {
        cancel.disabled = false;
        toast({ title: 'Could not take it down', body: error?.message || 'Try again.', kind: 'lose' });
      }
    });
    row.appendChild(cancel);
  }
  return row;
}

function bountyForm() {
  const form = el('form', 'bounty-form');
  form.appendChild(text('h4', 'bounty-form__title', 'Post a bounty (staff)'));
  const field = (label, input) => {
    const wrap = el('label', 'bounty-form__field');
    wrap.append(text('span', '', label), input);
    return wrap;
  };
  const game = el('select', 'bounty-form__input');
  for (const [key, meta] of Object.entries(CROWN_GAMES)) {
    const option = text('option', '', meta.name);
    option.value = key;
    game.appendChild(option);
  }
  const input = (placeholder, value = '') => {
    const node = el('input', 'bounty-form__input');
    node.placeholder = placeholder;
    node.value = value;
    node.autocomplete = 'off';
    return node;
  };
  const multiplier = input('1000', '1000');
  multiplier.inputMode = 'decimal';
  const stake = input('1m', '1m');
  const prize = input('50m', '50m');
  const hours = input('48', '48');
  hours.inputMode = 'numeric';
  const reason = input('Weekend bounty');
  const submit = text('button', 'bounty-form__go', 'Post bounty');
  submit.type = 'submit';
  form.append(
    field('Game', game),
    field('Multiplier', multiplier),
    field('Min stake', stake),
    field('Prize', prize),
    field('Hours', hours),
    field('Reason', reason),
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const stakeMinor = parseAmount(stake.value);
    const prizeMinor = parseAmount(prize.value);
    const body = {
      game: game.value,
      minMultiplier: Number(multiplier.value),
      minStakeMinor: stakeMinor === null ? '' : String(Math.round(stakeMinor)),
      prizeMinor: prizeMinor === null ? '' : String(Math.round(prizeMinor)),
      hours: Number.parseInt(hours.value, 10),
      reason: reason.value.trim(),
    };
    submit.disabled = true;
    try {
      await api.post('/v1/crowns/bounties', body);
      toast({ title: 'Bounty posted', body: `First to ${body.minMultiplier}x on ${crownGameName(body.game)}`, kind: 'win' });
      await load();
    } catch (error) {
      toast({ title: 'Bounty not posted', body: error?.message || 'Check the fields.', kind: 'lose' });
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function recentPanel() {
  const panel = el('section', 'crowns__panel crowns__recent');
  panel.appendChild(text('h3', 'crowns__sub', 'Latest crowns'));
  if (!board.recent.length) {
    panel.appendChild(text('p', 'crowns__note', 'No crown has been taken yet.'));
    return panel;
  }
  const list = el('ol', 'crowns__feed');
  for (const entry of board.recent) {
    const item = el('li', 'crowns__feeditem');
    const avatar = tableAvatar(entry.playerId);
    const name = text('span', 'crowns__feedname', entry.name);
    linkPlayer(entry.playerId, entry.name, avatar, name);
    item.append(
      avatar,
      name,
      text('span', 'crowns__feedtext', ` took ${crownGameName(entry.game)} with ${formatX(entry.multiplierX100)}`),
      text('span', 'crowns__feedago', ago(entry.at)),
    );
    list.appendChild(item);
  }
  panel.appendChild(list);
  return panel;
}

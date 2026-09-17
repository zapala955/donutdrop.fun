/* creators.js — the partner dashboard and the application form.
 *
 * Three metrics and one action. The metrics are read off the referral ledger rather than counted
 * separately, because the creator programme IS the referral programme at a boosted rate — a
 * second source of truth for "volume driven" would be a second number that disagrees.
 *
 * The application is a modal rather than an inline form: it is the rarest action on the page, it
 * is filled out once, and giving it permanent residence would make a dashboard look like a form.
 */
import {
  state,
  bus,
  refreshCreator,
  applyForCreatorCode,
  withdrawCreatorApplication,
} from './store.js';
import { $, el, money } from './util.js';
import { toast, openModal, closeModal } from './ui.js';
import { playSound } from './audio-engine.js';

const PLATFORMS = [
  ['youtube', 'YouTube'],
  ['twitch', 'Twitch'],
  ['tiktok', 'TikTok'],
  ['kick', 'Kick'],
  ['x', 'X'],
];

const STATUS_LABEL = {
  pending: 'UNDER REVIEW',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  withdrawn: 'WITHDRAWN',
};

let root = null;
let busy = false;

export function mountCreators(view) {
  root = $('#creatorRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', (event) => {
      if (!root.isConnected) return;
      if (['login', 'logout', 'ready', 'private', 'creator'].includes(event.detail)) paint();
    });
  }
  if (state.authenticated) refreshCreator(false).then(paint).catch(() => undefined);
  paint();
}

function paint() {
  if (!root?.isConnected) return;
  root.innerHTML = '';

  if (!state.authenticated) {
    root.appendChild(notice('Log in to apply for a creator code.'));
    return;
  }
  const data = state.creator;
  if (!data) {
    root.appendChild(notice('The creator programme is not switched on yet.'));
    return;
  }

  root.appendChild(metrics(data));
  root.appendChild(rateCard(data));
  root.appendChild(applicationCard(data));
}

function notice(message) {
  const card = el('div', 'creator__notice');
  const line = el('p');
  line.textContent = message;
  card.appendChild(line);
  return card;
}

function metrics(data) {
  const grid = el('div', 'creator__grid');
  for (const [label, value, gold] of [
    ['Volume driven', money(Number(data.metrics.volumeDrivenMinor)), false],
    ['Earned', money(Number(data.metrics.earnedMinor)), true],
    ['Active code uses', String(data.metrics.activeCodeUses), false],
  ]) {
    const cell = el('div', 'creator__stat');
    const key = el('span', 'creator__statk');
    key.textContent = label;
    const figure = el('b', `creator__statv${gold ? ' creator__statv--gold' : ''}`);
    figure.textContent = value;
    cell.append(key, figure);
    grid.appendChild(cell);
  }
  return grid;
}

/* The current rate against the ceiling an approval can reach. Two numbers side by side make the
 * offer legible without a sentence describing it. */
function rateCard(data) {
  const card = el('section', 'creator__rate');

  const current = el('div', 'creator__ratecell');
  const currentKey = el('span', 'creator__statk');
  currentKey.textContent = 'Your rate';
  const approved =
    data.application?.status === 'approved' && data.application.grantedRevshareBps !== null
      ? data.application.grantedRevshareBps
      : data.defaultRevshareBps;
  const currentValue = el('b', 'creator__ratev mono');
  currentValue.textContent = `${(approved / 100).toFixed(1)}%`;
  current.append(currentKey, currentValue);

  const ceiling = el('div', 'creator__ratecell');
  const ceilingKey = el('span', 'creator__statk');
  ceilingKey.textContent = 'Partner ceiling';
  const ceilingValue = el('b', 'creator__ratev creator__ratev--gold mono');
  ceilingValue.textContent = `${(data.maxRevshareBps / 100).toFixed(1)}%`;
  ceiling.append(ceilingKey, ceilingValue);

  const code = el('div', 'creator__ratecell');
  const codeKey = el('span', 'creator__statk');
  codeKey.textContent = 'Your code';
  const codeValue = el('b', 'creator__ratev mono');
  codeValue.textContent = data.code ?? '—';
  code.append(codeKey, codeValue);

  card.append(current, ceiling, code);
  return card;
}

function applicationCard(data) {
  const card = el('section', 'creator__apply');
  const application = data.application;

  if (application && application.status === 'pending') {
    const row = el('div', 'creator__row');
    const label = el('span', 'creator__statk');
    label.textContent = `Application · ${application.requestedCode}`;
    const badge = el('span', 'creator__badge');
    badge.dataset.status = application.status;
    badge.textContent = STATUS_LABEL[application.status];
    row.append(label, badge);

    const withdraw = el('button', 'btn creator__go');
    withdraw.type = 'button';
    withdraw.textContent = busy ? 'WORKING…' : 'WITHDRAW';
    withdraw.disabled = busy;
    withdraw.addEventListener('click', withdraw_);
    card.append(row, withdraw);
    return card;
  }

  if (application) {
    const row = el('div', 'creator__row');
    const label = el('span', 'creator__statk');
    label.textContent = `Last application · ${application.requestedCode}`;
    const badge = el('span', 'creator__badge');
    badge.dataset.status = application.status;
    badge.textContent = STATUS_LABEL[application.status] ?? application.status;
    row.append(label, badge);
    card.appendChild(row);

    // The reviewer's own words, when there are any. Shown as given rather than summarised.
    if (application.reviewNote) {
      const note = el('p', 'creator__note');
      note.textContent = application.reviewNote;
      card.appendChild(note);
    }
  }

  const apply = el('button', 'btn btn--go creator__go');
  apply.type = 'button';
  apply.textContent = 'APPLY FOR CREATOR CODE';
  apply.disabled = busy;
  apply.addEventListener('click', () => openForm(data));
  card.appendChild(apply);
  return card;
}

function openForm(data) {
  openModal('Creator code', (body) => {
    body.innerHTML = `
      <div class="cform">
        <label class="cform__field">
          <span>Platform</span>
          <select class="cform__in" id="cPlatform">
            ${PLATFORMS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
        </label>
        <label class="cform__field">
          <span>Channel URL</span>
          <input class="cform__in mono" id="cUrl" inputmode="url" autocomplete="off"
                 spellcheck="false" placeholder="https://">
        </label>
        <label class="cform__field">
          <span>Audience size</span>
          <input class="cform__in mono" id="cAudience" inputmode="numeric" autocomplete="off"
                 value="0">
        </label>
        <label class="cform__field">
          <span>Requested code</span>
          <input class="cform__in mono" id="cCode" maxlength="16" autocomplete="off"
                 spellcheck="false" placeholder="ABC123">
        </label>
        <span class="cform__hint" id="cHint"></span>
        <button class="btn btn--go" id="cSubmit" type="button">SUBMIT</button>
      </div>`;

    const code = $('#cCode', body);
    // The server accepts uppercase alphanumerics only, so the field enforces that as it is typed
    // rather than rejecting the form after it is filled in.
    code.addEventListener('input', () => {
      code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    $('#cSubmit', body).addEventListener('click', () => submit(body, data));
  });
}

async function submit(body, data) {
  const hint = $('#cHint', body);
  const button = $('#cSubmit', body);
  const platform = $('#cPlatform', body).value;
  const channelUrl = $('#cUrl', body).value.trim();
  const audienceSize = Number($('#cAudience', body).value.trim() || '0');
  const requestedCode = $('#cCode', body).value.trim().toUpperCase();

  /* Validated here against the same rules the route enforces, so an obvious mistake is caught
   * without a round trip. The server still checks all of it — this is a convenience, not a gate. */
  if (!/^https:\/\/.+/.test(channelUrl)) {
    hint.dataset.bad = '1';
    hint.textContent = 'Channel URL must start with https://';
    return;
  }
  if (!Number.isInteger(audienceSize) || audienceSize < 0) {
    hint.dataset.bad = '1';
    hint.textContent = 'Audience size must be a whole number';
    return;
  }
  if (!/^[A-Z0-9]{3,16}$/.test(requestedCode)) {
    hint.dataset.bad = '1';
    hint.textContent = 'Code must be 3-16 letters or digits';
    return;
  }

  delete hint.dataset.bad;
  hint.textContent = '';
  button.disabled = true;
  busy = true;
  try {
    await applyForCreatorCode({ platform, channelUrl, audienceSize, requestedCode });
    playSound('coin');
    toast({ kind: 'win', title: 'Application submitted', body: requestedCode });
    closeModal();
  } catch (error) {
    button.disabled = false;
    hint.dataset.bad = '1';
    hint.textContent = error?.message || 'The server rejected the application.';
  } finally {
    busy = false;
    paint();
  }
  void data;
}

async function withdraw_() {
  if (busy) return;
  busy = true;
  paint();
  try {
    await withdrawCreatorApplication();
    toast({ kind: 'lose', title: 'Application withdrawn' });
  } catch (error) {
    toast({ kind: 'lose', title: 'Cannot withdraw', body: error?.message || '' });
  } finally {
    busy = false;
    await refreshCreator(false).catch(() => undefined);
    paint();
  }
}

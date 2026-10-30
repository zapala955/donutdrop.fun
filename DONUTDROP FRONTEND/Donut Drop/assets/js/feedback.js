/* feedback.js — "Tell us what you think": the 3D survey and a short note (routes/feedback.ts).
 *
 * One window, two questions: do you like the 3D games, yes or no, and what should we add or fix.
 * An account's first note is paid once (the figure is the server's, GET /v1/feedback), and only
 * once it has played a little; the window says which applies before anything is typed. Opened
 * from the account menu and from the feedback pop-up (popups.js).
 */
import { api } from './api.js';
import { bus, state } from './store.js';
import { $, el, money } from './util.js';
import { closeModal, openModal, toast } from './ui.js';

const MIN_CHARS = 20;
const MAX_CHARS = 1000;

/** The player's feedback status, or null when signed out or the server did not answer. */
export async function readFeedbackStatus() {
  if (!state.authenticated) return null;
  try {
    return await api.get('/v1/feedback');
  } catch {
    return null;
  }
}

export function initFeedback() {
  const row = $('#feedbackBtn');
  if (!row) return;
  row.addEventListener('click', () => void openFeedback());
  bus.addEventListener('change', (event) => {
    if (['ready', 'login', 'logout'].includes(event.detail)) void paintRow();
  });
  void paintRow();
}

/** The account-menu row: offers the reward while a note would earn it, hidden while feedback is off. */
async function paintRow() {
  const row = $('#feedbackBtn');
  if (!row) return;
  const status = await readFeedbackStatus();
  row.hidden = !status?.enabled;
  const label = $('span', row);
  if (label) label.textContent = status?.eligible ? `Feedback · get ${money(Number(status.rewardMinor))}` : 'Feedback';
}

export async function openFeedback() {
  if (!state.authenticated) {
    $('#loginBtn')?.click();
    return;
  }
  const status = await readFeedbackStatus();
  if (!status?.enabled) {
    toast({ kind: 'lose', title: 'Feedback', body: 'Feedback is closed right now' });
    return;
  }
  openModal('Tell us what you think', (body) => build(body, status), { variant: 'feedback' });
}

function build(body, status) {
  const reward = money(Number(status.rewardMinor));
  const form = el('form', 'fb');
  form.noValidate = true;
  form.innerHTML = `
    <p class="fb__lead"></p>
    <fieldset class="fb__q">
      <legend class="fb__label">Do you like the 3D games?</legend>
      <div class="fb__choices">
        <label class="fb__choice"><input type="radio" name="likes3d" value="yes"${status.likes3d === true ? ' checked' : ''}><span>Yes, keep them 3D</span></label>
        <label class="fb__choice"><input type="radio" name="likes3d" value="no"${status.likes3d === false ? ' checked' : ''}><span>No, I prefer 2D</span></label>
      </div>
    </fieldset>
    <label class="fb__q">
      <span class="fb__label">What should we add or fix?</span>
      <textarea class="fb__text" name="message" rows="5" maxlength="${MAX_CHARS}"
        placeholder="A game you want, something that bugged you, an idea…"></textarea>
      <span class="fb__count mono" aria-live="polite"></span>
    </label>
    <p class="fb__err" role="alert" hidden></p>
    <button class="btn btn--go fb__go" type="submit"></button>`;

  const lead = $('.fb__lead', form);
  lead.textContent = status.eligible
    ? `Two questions. Your first note is worth ${reward}, paid straight to your balance.`
    : status.rewarded
      ? 'Two questions. You have already had your reward; every note is still read.'
      : status.reason === 'played'
        ? `Two questions. Play ${money(Number(status.minWagerMinor))} on any game first and your first note is worth ${reward}.`
        : 'Two questions. Every note is read.';

  const text = $('.fb__text', form);
  const count = $('.fb__count', form);
  const go = $('.fb__go', form);
  const err = $('.fb__err', form);
  go.textContent = status.eligible ? `Send and get ${reward}` : 'Send feedback';

  const paint = () => {
    const length = text.value.trim().length;
    count.textContent = length < MIN_CHARS ? `${MIN_CHARS - length} more characters` : `${length}/${MAX_CHARS}`;
    const answered = Boolean(form.querySelector('input[name="likes3d"]:checked'));
    go.disabled = !answered || length < MIN_CHARS;
  };
  form.addEventListener('input', paint);
  form.addEventListener('change', paint);
  paint();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (go.disabled) return;
    const choice = form.querySelector('input[name="likes3d"]:checked');
    go.disabled = true;
    err.hidden = true;
    try {
      const result = await api.post('/v1/feedback', {
        likes3d: choice.value === 'yes',
        message: text.value.trim(),
      });
      closeModal();
      const paid = Number(result?.rewardMinor ?? 0);
      toast({
        kind: 'win',
        title: 'Thanks for the feedback',
        body: paid > 0 ? `${money(paid)} is in your balance.` : 'We read every note.',
      });
      void paintRow();
    } catch (error) {
      err.textContent = error?.message || 'That did not go through. Try again in a moment.';
      err.hidden = false;
      paint();
    }
  });

  body.appendChild(form);
  window.setTimeout(() => text.focus(), 0);
}

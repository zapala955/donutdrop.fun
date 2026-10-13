/* testmode.js — the media test-mode switch in the header.
 *
 * Approved creators and staff can put their session on a test account with play money, to record
 * clips. Everything about play money is decided on the server (services/api-gateway/src/lib/
 * media-test.ts): which games a test session may play, that its rounds stay off the live feed and
 * the boards, that the money can never leave. The games themselves are untouched -- same odds, same
 * provably-fair rolls -- so this file only offers the switch, shows which way it is set, and tops
 * the play money up.
 *
 * Switching reloads the page. Every balance, history, inventory and open game on it belongs to one
 * account or the other, and a reload is the one way to be sure none of them is left showing the
 * account the session just stopped being.
 */
import { api } from './api.js';
import { state, bus, refreshBalance } from './store.js';
import { $, money } from './util.js';
import { toast } from './ui.js';

let busy = false;

function paint() {
  const pill = $('#testModeBtn');
  const topUp = $('#testTopUpBtn');
  if (!pill || !topUp) return;
  const mode = state.authenticated ? state.user?.testMode : null;
  const active = Boolean(mode?.active);
  pill.hidden = !(active || mode?.eligible);
  topUp.hidden = !active;
  pill.dataset.on = active ? '1' : '0';
  pill.setAttribute('aria-pressed', active ? 'true' : 'false');
  const label = $('#testModeLbl');
  if (label) label.textContent = active ? 'TEST MODE' : 'TEST';
  pill.title = active
    ? 'Test mode is on: you are playing with play money. Click to go back to your real balance.'
    : 'Test mode: play with play money, for clips';
  document.body.dataset.testMode = active ? 'on' : 'off';
}

/* After a fresh sign-in the user object comes from the login response, which does not carry the
 * test-mode fields; ask for them. */
async function loadMode() {
  if (!state.authenticated || state.user?.testMode) return paint();
  try {
    const mode = await api.get('/v1/media/test-mode');
    if (state.user) state.user.testMode = { active: mode.active, eligible: mode.eligible };
  } catch {
    // Not offered is the safe reading of an answer that did not arrive.
  }
  paint();
}

async function flip() {
  if (busy) return;
  busy = true;
  const active = Boolean(state.user?.testMode?.active);
  try {
    await api.post('/v1/media/test-mode', { enabled: !active });
    location.reload();
  } catch (error) {
    busy = false;
    toast({
      title: 'Test mode',
      body: error?.message || 'Could not switch test mode',
      kind: 'lose',
    });
  }
}

async function topUp() {
  if (busy) return;
  busy = true;
  try {
    const result = await api.post('/v1/media/test-mode/topup', {});
    await refreshBalance();
    toast({
      title: 'Play money topped up',
      body: `Balance ${money(Number(result.balanceMinor))}`,
      kind: 'gold',
    });
  } catch (error) {
    toast({ title: 'Test mode', body: error?.message || 'Could not top up', kind: 'lose' });
  } finally {
    busy = false;
  }
}

export function initTestMode() {
  $('#testModeBtn')?.addEventListener('click', flip);
  $('#testTopUpBtn')?.addEventListener('click', topUp);
  bus.addEventListener('change', (event) => {
    if (event.detail === 'login') loadMode();
    else if (['ready', 'logout', 'private'].includes(event.detail)) paint();
  });
  paint();
}

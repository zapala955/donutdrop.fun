/* One cheap server-sent event stream replaces the chat, activity and roulette request loops. */
import { API_BASE_URL } from './api.js';
import { state, refreshActivity, refreshBalance, refreshChat } from './store.js';

let source;
let started = false;
const pending = new Set();

function emitStatus(connected, supported = true) {
  window.dispatchEvent(
    new CustomEvent('donut:live-status', { detail: { connected, supported, at: Date.now() } }),
  );
}

function once(key, work) {
  if (pending.has(key) || document.hidden) return;
  pending.add(key);
  Promise.resolve()
    .then(work)
    .catch(() => undefined)
    .finally(() => pending.delete(key));
}

export function initLiveEvents() {
  if (started) return;
  started = true;
  if (!('EventSource' in window)) {
    emitStatus(false, false);
    return;
  }

  source = new EventSource(`${API_BASE_URL}/v1/live`, { withCredentials: true });
  source.addEventListener('hello', () => emitStatus(true));
  source.addEventListener('heartbeat', () => emitStatus(true));
  source.addEventListener('chat', () => once('chat', () => refreshChat()));
  source.addEventListener('activity', () => once('activity', () => refreshActivity()));
  source.addEventListener('balance', () => {
    if (state.authenticated) once('balance', () => refreshBalance());
  });
  source.addEventListener('roulette', () => {
    window.dispatchEvent(new CustomEvent('donut:roulette'));
    once('activity', () => refreshActivity());
  });
  source.addEventListener('settings', () => {
    once('chat', () => refreshChat());
    window.dispatchEvent(new CustomEvent('donut:roulette'));
  });
  source.addEventListener('error', () => emitStatus(false));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    once('chat', () => refreshChat());
    once('activity', () => refreshActivity());
    if (state.authenticated) once('balance', () => refreshBalance());
    window.dispatchEvent(new CustomEvent('donut:roulette'));
  });
}

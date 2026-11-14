/* turnstile.js — Cloudflare's Turnstile script, loaded once for every window that shows the
 * challenge: the sign-in card (app.js) and the code window (redeem-code.js).
 *
 * Deliberately not in index.html: a deployment with no challenge configured should not fetch a
 * third-party script on every page load to then not use it. The promise is cached so reopening a
 * window does not add another tag, and cleared on failure so a transient network error does not
 * permanently poison it.
 */
let turnstileScript;

export function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      tag.async = true;
      tag.onload = () => resolve(window.turnstile);
      tag.onerror = () => {
        turnstileScript = undefined;
        reject(new Error('Turnstile could not be loaded'));
      };
      document.head.appendChild(tag);
    });
  }
  return turnstileScript;
}

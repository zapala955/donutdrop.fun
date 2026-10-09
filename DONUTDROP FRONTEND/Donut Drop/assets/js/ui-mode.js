/* ui-mode.js — the switch for the premium design preview.
 *
 * Visiting /test turns the preview on for this browser and nobody else; "Back to the classic
 * design" in the preview, or any URL with ?ui=classic, turns it off again. Everyone who has not
 * opted in gets the site exactly as before: this file sets nothing and loads nothing for them.
 *
 * A classic script at the end of <head>, not a module, on purpose: it has to run before the body
 * is painted, so the attribute and the stylesheet are in place before the first frame instead of
 * flashing the classic design and then repainting. Every rule in premium.css is scoped under
 * html[data-ui="premium"], so the sheet does nothing without the attribute either.
 */
(function () {
  var KEY = 'donutwin:ui';
  // /test, or ?ui=premium on any page (so a link can open one game straight in the preview).
  var onTestPage =
    location.pathname.replace(/\/+$/, '') === '/test' || /[?&]ui=premium(?:&|$)/.test(location.search);
  var mode = onTestPage ? 'premium' : null;
  try {
    if (onTestPage) localStorage.setItem(KEY, 'premium');
    if (/[?&]ui=classic(?:&|$)/.test(location.search)) localStorage.removeItem(KEY);
    else mode = localStorage.getItem(KEY) || mode;
  } catch (error) {
    // Storage blocked (private window, strict settings): the preview still shows on /test itself.
  }
  if (mode !== 'premium') return;

  document.documentElement.dataset.ui = 'premium';

  var fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href =
    'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800' +
    '&family=Geist:wght@400..700&display=swap';

  var sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = '/assets/css/premium.css';
  // Hold the first paint for it, so the preview never flashes the classic design first.
  sheet.setAttribute('blocking', 'render');

  document.head.append(fonts, sheet);
})();

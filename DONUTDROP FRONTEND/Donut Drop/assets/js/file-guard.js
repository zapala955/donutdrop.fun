/* file-guard.js — the one script that must run as a classic script, not a module.
 *
 * Opening index.html straight off the disk gives a blank page: browsers refuse to load ES modules
 * over file://, so app.js never runs and nothing explains why. This replaces the blank page with
 * an instruction.
 *
 * It lives in its own file rather than inline so the Content-Security-Policy can forbid inline
 * scripts entirely, which is the single most valuable thing a CSP does.
 */
(function fileProtocolGuard() {
  if (location.protocol !== 'file:') return;
  document.addEventListener('DOMContentLoaded', function onReady() {
    var panel = document.createElement('div');
    panel.style.cssText =
      'min-height:100vh;display:grid;place-items:center;background:#0a0a0c;color:#e8e4d8;' +
      'font:15px/1.6 system-ui,sans-serif;padding:24px;text-align:center';

    var inner = document.createElement('div');
    inner.style.maxWidth = '440px';

    var heading = document.createElement('h1');
    heading.style.cssText = 'font-size:26px;margin:0 0 10px';
    heading.textContent = "Serve it, don't open it";

    var copy = document.createElement('p');
    copy.style.cssText = 'color:#9a8f7a;margin:0 0 14px';
    copy.textContent =
      'Donut Drop uses JavaScript modules, which browsers block on file:// URLs. Run a static ' +
      'server from this folder and open the address it prints.';

    var commands = document.createElement('p');
    commands.style.cssText = 'font-family:ui-monospace,monospace;color:#ffaa00;margin:0';
    commands.textContent = 'npx serve   ·   python -m http.server';

    inner.append(heading, copy, commands);
    panel.appendChild(inner);
    document.body.replaceChildren(panel);
  });
})();

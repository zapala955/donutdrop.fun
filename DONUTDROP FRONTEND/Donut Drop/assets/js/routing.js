/* routing.js — clean-path navigation shared by the shell and feature modules. */

const NAVIGATION_EVENT = 'donutdrop:navigate';

export function routeSegments() {
  return location.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

export function currentRouteName() {
  return routeSegments()[0] || 'home';
}

/**
 * Move inside the single-page app without putting route state in a URL fragment.
 * The custom event is for programmatic moves; browser Back/Forward uses popstate instead.
 */
export function navigate(path, { replace = false } = {}) {
  const target = new URL(path, location.origin);
  if (target.origin !== location.origin) throw new Error('Cannot navigate to another origin');
  history[replace ? 'replaceState' : 'pushState'](null, '', target.pathname + target.search);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function onNavigate(listener) {
  window.addEventListener(NAVIGATION_EVENT, listener);
  window.addEventListener('popstate', listener);
}

/**
 * Old links are already in chats, bookmarks and Discord messages. Convert them once, in place,
 * so they continue to work without leaving the obsolete #/ route visible in the address bar.
 */
export function migrateLegacyHashRoute() {
  if (!location.hash.startsWith('#/')) return;

  const legacy = location.hash.slice(2);
  const queryAt = legacy.indexOf('?');
  const rawPath = queryAt >= 0 ? legacy.slice(0, queryAt) : legacy;
  const rawQuery = queryAt >= 0 ? legacy.slice(queryAt + 1) : '';
  const parts = rawPath.split('/').filter(Boolean);
  const query = new URLSearchParams(rawQuery || location.search);

  /* Battle invites were the only nested fragment route. Keep every old invite usable while the
   * clean router deliberately stays on single-segment paths so relative assets resolve at root. */
  if (parts[0] === 'battles' && /^[A-Z0-9]{6,12}$/.test(parts[1] || '')) {
    query.set('code', parts[1]);
    parts.splice(1);
  }

  const cleanPath = !parts.length || parts[0] === 'home' ? '/' : `/${parts.join('/')}`;
  const encodedQuery = query.toString();
  const cleanQuery = encodedQuery ? `?${encodedQuery}` : '';
  history.replaceState(null, '', cleanPath + cleanQuery);
}

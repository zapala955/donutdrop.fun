/* routing.js — clean-path navigation shared by the shell and feature modules. */

const NAVIGATION_EVENT = 'donutdrop:navigate';

/* The redesign preview is served from /test (test.html), with every route kept under it: /test,
 * /test/crash, /test/vip. The live site has no prefix and every function here behaves exactly as
 * it did before. Read once: the prefix a page was loaded under never changes while it is open.
 * Outside a browser (seo.js is imported by Node: its test, and the nginx map generator) there is
 * no location, and no prefix. */
export const BASE = typeof location !== 'undefined' && /^\/test(?:\/|$)/.test(location.pathname)
  ? '/test'
  : '';

/** A pathname with the preview prefix taken off, so the app always sees /crash, never /test/crash. */
export function appPath(pathname) {
  if (!BASE) return pathname;
  if (pathname === BASE) return '/';
  return pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : pathname;
}

/** The app path as the address bar should show it: under the preview prefix when there is one. */
export function fullPath(path) {
  if (!BASE) return path;
  return path === '/' ? BASE : `${BASE}${path}`;
}

export function routeSegments() {
  return appPath(location.pathname).split('/').filter(Boolean).map((part) => decodeURIComponent(part));
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
  history[replace ? 'replaceState' : 'pushState'](
    null,
    '',
    fullPath(appPath(target.pathname)) + target.search,
  );
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
  history.replaceState(null, '', fullPath(cleanPath) + cleanQuery);
}

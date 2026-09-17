/* api.js — the only browser-to-backend transport. */

const metaBase = document.querySelector('meta[name="api-base-url"]')?.content?.trim();
export const API_BASE_URL = (window.DONUTDROP_API_URL || metaBase || 'http://localhost:3001')
  .replace(/\/$/, '');

let inMemoryCsrf = '';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.details = details;
  }
}

export function setCsrfToken(value) {
  inMemoryCsrf = typeof value === 'string' ? value : '';
}

function cookie(name) {
  const prefix = name + '=';
  const found = document.cookie.split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : '';
}

function csrfToken() {
  return inMemoryCsrf || cookie('__Host-du_csrf') || cookie('du_csrf');
}

async function request(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response;
  try {
    response = await fetch(API_BASE_URL + path, {
      method,
      headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Donut Drop server', error);
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = payload.error || {};
    throw new ApiError(response.status, problem.code, problem.message, problem.details);
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body, options) => request('POST', path, body, options),
  put: (path, body, options) => request('PUT', path, body, options),
  patch: (path, body, options) => request('PATCH', path, body, options),
  delete: (path, options) => request('DELETE', path, undefined, options),
};

export function idempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return clientSeed() + '-' + Date.now().toString(36);
}

export function clientSeed() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

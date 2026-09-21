/* table-avatar.js — the shared player head used by public leaderboard rows. */
import { API_BASE_URL } from './api.js';
import { el } from './util.js';

/**
 * Load a Minecraft head without putting the player's name in a browser-visible URL. The empty
 * span is intentional: its CSS draws a neutral silhouette if the account has no available skin.
 */
export function tableAvatar(playerId) {
  const avatar = el('span', 'dtable__avatar');
  avatar.setAttribute('aria-hidden', 'true');
  if (!playerId) return avatar;

  const art = document.createElement('img');
  art.alt = '';
  art.loading = 'lazy';
  art.src = `${API_BASE_URL}/v1/avatars/${encodeURIComponent(playerId)}?s=22`;
  art.addEventListener('error', () => art.remove());
  avatar.appendChild(art);
  return avatar;
}

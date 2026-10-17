/* player-link.js — any player's head or name on the site opens their card.
 *
 * The card (stats, never profit or loss, and a tip) used to open only from chat. The live feed,
 * the leaderboards, the race, the roulette table, Crash's players and the big-win cards all draw
 * the same heads, and a head that does nothing where it does something in chat reads as broken.
 *
 * Chat's pattern, everywhere: the head opens the card for a pointer, the name is the one stop for
 * the keyboard (a role=button with the masked name in its label), so a row is not two tab stops for
 * one person. A row without an id -- a bot seat, an old row -- is left alone.
 */
import { openPlayerCard } from './chat.js';
import { censorName } from './profanity.js';

export function linkPlayer(userId, name, head, label = null) {
  if (!userId) return;
  const shown = censorName(name) || 'this player';
  const open = (event) => {
    event?.stopPropagation();
    openPlayerCard(userId, name);
  };
  if (head) {
    head.classList.add('plink__head');
    head.addEventListener('click', open);
  }
  const stop = label ?? head;
  if (!stop) return;
  stop.classList.add('plink');
  stop.tabIndex = 0;
  stop.setAttribute('role', 'button');
  stop.setAttribute('aria-label', `View ${shown}`);
  if (stop === head) stop.removeAttribute('aria-hidden');
  if (stop !== head) stop.addEventListener('click', open);
  stop.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open(event);
  });
}

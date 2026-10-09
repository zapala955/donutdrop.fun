# Design — DonutWin (premium)

The locked design system for the premium DonutWin design, previewed at `/test` (`assets/js/ui-mode.js`
switches it on per browser; `assets/css/premium.css` and `assets/js/premium.js` implement it). Every
page in the premium design follows this file. Extend or amend it here; do not override it per page.

Agreed with the operator on 2026-10-09: a premium casino in the spirit of Stake, dark navy with a
single gold accent, every game tile the same colour.

## Audience, use, tone
- Audience: DonutSMP players, on desktop and phone, who play with in-game money.
- The one action: get into a game fast; then deposit.
- Tone: premium casino — dark, dense, polished, quiet. Gold is used sparingly so it reads as value.

## Genre
modern-minimal, dark. Sans throughout, pill and soft-radius controls, no ornament, no gradient text,
no glassmorphism.

## Macrostructure family
- Lobby (`/`): Ecosystem Index — promo cards, game search, category tabs, the game grid, latest bets.
- Game pages: Workbench — a control panel on the left (bet amount with ½ and 2×, the game's options,
  one full-width gold primary action), the board on the right. Same layout for every game. On phones
  the board sits above the controls.
- Content pages (VIP, rewards, terms, support): the page header plus the existing content, restyled.

## Theme (custom, OKLCH, anchor hue 258)
- `--p-paper`     oklch(17.5% 0.028 258) — the page
- `--p-paper-2`   oklch(20.5% 0.031 258) — sidebar and top bar
- `--p-surface`   oklch(24% 0.034 258) — cards and panels
- `--p-surface-2` oklch(28% 0.036 258) — hovered, raised
- `--p-surface-3` oklch(32.5% 0.037 258) — pressed, current
- `--p-sunk`      oklch(14.5% 0.026 258) — inputs and wells
- `--p-rule`      oklch(31% 0.03 258) · `--p-rule-2` oklch(38% 0.032 258)
- `--p-ink`       oklch(95.5% 0.008 258) · `--p-ink-2` oklch(77% 0.026 258) · `--p-ink-3` oklch(67% 0.028 258)
- `--p-gold`      oklch(84% 0.155 84) — the one accent; `--p-gold-ink` oklch(23% 0.05 70) is text on it
- `--p-win`       oklch(79% 0.19 150) · `--p-loss` oklch(68% 0.19 25) — always paired with a word or icon
- Game tiles: one two-tone navy for every game, `--p-tile-top` oklch(33% 0.06 262) to
  `--p-tile-bot` oklch(23.5% 0.045 262), with the game's Minecraft item as its art.

Gold goes on: primary buttons (Bet, Deposit, Log in when signed out), the current page's marker in the
sidebar and phone bar, focus rings, and a tile's border on hover. Nowhere else.

## Typography
- Display: Bricolage Grotesque 800 — page titles, section titles, tile names (uppercase on tiles only).
- Body and UI: Geist 400–700 — everything else; money uses tabular figures.
- Two families. No mono face in the premium design.

## Spacing, radius, motion
- 4-point scale: `--p-space-1` 4px … `--p-space-10` 40px.
- Radius: 6px small controls, 8px buttons and inputs, 12px cards and panels, 999px segmented tabs.
- Easings: `--p-ease-out` cubic-bezier(0.16, 1, 0.3, 1), `--p-ease-in`, `--p-ease-in-out`. 140–200ms.
- Motion is hover lift on tiles and cards and the drawers sliding in. No scroll reveals. Reduced motion
  drops the movement.

## Navigation
- ≥1280px: a 244px left sidebar (brand, grouped links with icons, "back to classic").
- 1081–1279px: the same sidebar as a 76px icon rail.
- ≤1080px: no sidebar; a five-item phone bar (Menu, Lobby, Cases, Chat, Wallet) and the sidebar as a
  drawer from Menu.
- Chat is a right-hand drawer at every width.
- The classic tab bar never shows in the premium design: one navigation pattern per level.

## Honest content
No invented figures. Tiles show no "playing now" counts because the server has none. Latest bets come
from `/v1/activity/recent`, names masked as the server masks them.

## Exports

### tokens.css
```css
html[data-ui="premium"] {
  --p-paper: oklch(17.5% 0.028 258);  --p-paper-2: oklch(20.5% 0.031 258);
  --p-surface: oklch(24% 0.034 258);  --p-surface-2: oklch(28% 0.036 258);
  --p-surface-3: oklch(32.5% 0.037 258); --p-sunk: oklch(14.5% 0.026 258);
  --p-rule: oklch(31% 0.03 258);      --p-rule-2: oklch(38% 0.032 258);
  --p-ink: oklch(95.5% 0.008 258);    --p-ink-2: oklch(77% 0.026 258); --p-ink-3: oklch(67% 0.028 258);
  --p-gold: oklch(84% 0.155 84);      --p-gold-ink: oklch(23% 0.05 70);
  --p-win: oklch(79% 0.19 150);       --p-loss: oklch(68% 0.19 25);
  --p-font-display: "Bricolage Grotesque", "Geist", system-ui, sans-serif;
  --p-font-body: "Geist", system-ui, sans-serif;
  --p-radius-s: 6px; --p-radius: 8px; --p-radius-l: 12px;
  --p-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```
The live token block is the top of `assets/css/premium.css`, which also re-points the classic tokens
(`--bg`, `--panel`, `--gold-*`, `--text`, …) at these so every existing page repaints.

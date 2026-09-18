# Donut Drop frontend

Static HTML/CSS/JavaScript frontend for the Donut Drop cases and item upgrader API. Identity,
balance, catalog values, inventory, case pools, drops, upgrade outcomes, sales, withdrawals, and
recent activity all come from the backend. The browser does not persist or calculate economic
state.

## Run locally

Start the backend from the repository root with `APP_ORIGIN=http://localhost:3000` and its normal
PostgreSQL, Redis, and bot configuration. Apply migrations first:

```text
npm run db:migrate
npm run dev
```

Then serve this directory on port 3000:

```text
python -m http.server 3000
```

Open `http://localhost:3000`. ES modules do not run over `file://`.

The API base URL is read from the `api-base-url` meta tag in `index.html` and defaults to
`http://localhost:3001`. A deployment may set `window.DONUTDROP_API_URL` before `app.js` loads to
override it. The backend origin and cookie settings must match the deployed frontend exactly.

## Connected surfaces

- Minecraft account linking, cookie session, CSRF token, and logout.
- Cash deposits through an exact DonutSMP `/pay` challenge and API-verified bot balance delta.
- Public server-configured case catalog and published integer-weight odds.
- Atomic case opening with a backend-returned result driving the existing reel/cutscene.
- Custody inventory with server-quoted sell and separately gated physical withdrawal actions.
- Item-to-item upgrader using owned inventory, server stock, locked values, and backend RNG.
- Header balance and account/profile views backed by API snapshots.
- Recent case/upgrader activity feed polled from the public endpoint.
- Backend fairness commitment and completed-round proof data.

The former Arena, rewards/referral, rain, editable chat, keys, and XP demos are not connected to a
server economy. Their routes are deliberately replaced with an unavailable state, and the legacy
store exports are no-ops, so those prototypes cannot mint or consume authoritative balance.

## Operational prerequisites

The backend intentionally starts with no catalog or cases. An administrator must:

1. Add exact observed item fingerprints and fixed values through `/v1/admin/catalog-items`.
2. Allocate reconciled bot inventory through `/v1/admin/stock`.
3. Create and enable weighted pools through `/v1/admin/cases`.
4. Use a reviewed transfer-capable bot adapter before enabling deposits, withdrawals, cases, or
   upgrades against physical inventory.

Case opening fails closed unless every published outcome in that case is currently backed by enough
fresh, reconciled, transfer-capable house stock.

## Important files

```text
index.html             routed shell and API base URL
assets/js/api.js       credentialed fetch client, CSRF and idempotency headers
assets/js/store.js     API-backed shared state and economic actions
assets/js/app.js       routing, account linking, cases, inventory, activity
assets/js/upgrader.js  inventory/target selection and server-result animation
assets/js/reel.js      case reel driven by the returned server item
assets/js/reveal.js    upgrader result animation
assets/css/            existing responsive visual system
```

Minecraft art and sounds are Mojang Studios property. This is an unofficial fan project; replace
those assets before commercial use.

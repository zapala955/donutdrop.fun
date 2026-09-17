# Product

## Platform

Responsive static web frontend backed by the Donut Drop Fastify/PostgreSQL API.

## Core loop

- Players link a Minecraft account without entering Mojang or Microsoft credentials.
- Deposited custody items can be sold at the server-configured rate to fund site balance.
- Cases deduct server balance and award a server-selected, custody-backed item.
- The Upgrader consumes one owned item and awards the selected higher-value item on success.
- Inventory lots can be sold or queued for in-game withdrawal.

## Trust boundary

The frontend is a display and interaction layer. It submits identifiers, quantities, quote bindings,
an idempotency key, and a client seed. The backend validates ownership and stock, reads prices and
weights from PostgreSQL, calculates probabilities, performs committed HMAC-SHA256 RNG, and commits
balance plus inventory movements atomically. A browser response never determines an outcome.

## Current launch constraints

The catalog and case configuration ship empty. Physical transfer operations remain fail-closed until
the separate Mineflayer transfer adapter is reviewed and marked transfer-capable. Unsupported mock
economy features are disabled in the connected frontend.

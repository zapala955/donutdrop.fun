# Bot reconciliation and ambiguous transfer runbook

## Reconciliation mismatch

1. Leave the bot in `degraded` state. Do not manually mark it matched or enable its inventory.
2. Stop transfers for that bot and capture the latest physical inventory plus the last matched
   snapshot ID.
3. Compare current custody allocations, confirmed deposit events, completed withdrawals, and
   upgrader movements by fingerprint.
4. Correct records only with a separately approved, audited recovery migration. Never edit
   append-only movement or round tables.
5. Submit a fresh physical snapshot. Resume only when it matches exactly.

## Expired withdrawal lease

An expired lease is intentionally moved to `manual_review`; it is never executed automatically
again. Determine whether the exact fingerprint and quantity left the bot inventory and whether the
linked player received it. If delivery occurred, complete custody with a reviewed recovery command.
If it did not, return the reserved lots to the user. Record evidence and two-person approval in the
audit trail.

## Deposit authorization lease

The bot must obtain a one-time database authorization lease before opening any deposit transfer
interaction. The lease is bound to the deposit, bot, authorization event, and a secret capability
token. It is never renewed or reassigned: an expired, cancelled, or uncertain attempt requires a
new deposit intent. A `deposit_confirmed` receipt is accepted only with the same lease ID and token
and before the absolute lease deadline.

The worker acquires its local transfer mutex before requesting a lease, refuses leases without a
safe execution window, and gives the adapter an abort signal plus an earlier safety deadline. It
validates the adapter's confirmed fingerprint/quantity list before sending the receipt and always
forces a physical inventory snapshot afterward.

## Ambiguous deposit

An adapter exception, malformed adapter result, disconnect, deadline crossing, explicit
`ambiguous` result, or failed confirmation after the adapter started is potentially a completed
physical handoff. Never tell the player that it failed, never reuse the code or lease, and never
automatically start another transfer. Leave the intent to enter `manual_review`, stop transfers for
the bot, preserve logs, compare the forced inventory snapshot with custody, and resolve it using a
separately reviewed recovery procedure.

A live DonutSMP adapter must distinguish `confirmed`, `cancelled` (known no custody change), and
`ambiguous` outcomes. Before enabling it in production, also deploy a per-bot singleton/fencing
mechanism so two worker processes cannot control the same Minecraft account, and verify fencing and
reconciliation behavior during crash/failover tests.

## Bot credentials

If the Microsoft authentication cache or internal webhook key may be exposed, stop the worker,
revoke sessions at the provider, rotate the webhook key in both services, inspect the inbound event
journal, reconcile all inventory, and only then reconnect.

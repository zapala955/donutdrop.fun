# Provably fair specification (HMAC-SHA256-v1)

1. The server generates 32 cryptographically random bytes and represents them as 64 lowercase hex
   characters.
2. Before the request, `GET /v1/fairness/current` returns `SHA256(serverSeed)` and nonce `0`. The
   plaintext seed is AES-256-GCM encrypted in PostgreSQL.
3. The player submits that exact commitment with a 1–128 byte UTF-8 client seed. The transaction
   rejects a stale or different commitment.
4. The digest is `HMAC-SHA256(key=serverSeed, message=clientSeed + ":" + nonce)`.
5. The first 13 digest hex characters form an exact 52-bit integer. Divide by `2^52`, multiply by
   1,000,000, and floor to obtain `rollPpm` from 0 through 999,999.
6. `chancePpm = floor(stakeValue * (10000-houseEdgeBps) * 1000000 /
(targetValue * 10000))`, capped by `MAX_WIN_CHANCE_PPM`.
7. The player wins exactly when `rollPpm < chancePpm`.
8. The resolved round reveals the server seed and full digest, consumes that commitment, and creates
   a new commitment in the same transaction.

`POST /v1/fairness/verify` implements the public verification calculation. All odds math uses
integers; floating point is used only to return the human-readable roll fraction.

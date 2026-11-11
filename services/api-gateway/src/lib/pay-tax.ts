/**
 * DonutSMP's tax on /pay, and taking it out of a player's withdrawal.
 *
 * Since 2026-11-11 (first seen 04:33 UTC) every /pay costs the payer a tax on top of the amount,
 * and the receipt says so: "You paid Mond0o5 $ 6.2M (+$ 124K tax)". The teller's /bal fell by
 * exactly 6,230,900 + 124,618 for that one, and by 50,978,551 + 1,019,572 for the next: 2%, with a
 * fraction of a dollar rounded UP (1,019,571.02 cost 1,019,572).
 *
 * The owner's call, the same day: the player's withdrawal pays the tax. The wallet is still
 * debited the amount asked for, W. The bot /pays the largest P whose tax fits inside it, so the
 * player receives P and the teller's money falls by P + tax(P), never more than W. That W is
 * exactly what the books take off the teller (bookPayoutLeg), and what the /bal auto-settle looks
 * for (lib/unconfirmed-payouts.ts), so both keep agreeing with the account.
 *
 * Rounding the tax up here is the safe side: if DonutSMP rounds down, the teller keeps a dollar.
 */
export function payTaxMinor(amountMinor: bigint, taxBps: number): bigint {
  if (taxBps <= 0 || amountMinor <= 0n) return 0n;
  return (amountMinor * BigInt(taxBps) + 9_999n) / 10_000n;
}

/** What the player receives from a withdrawal of `grossMinor`: the most that, with its tax, fits. */
export function payoutAfterTax(grossMinor: bigint, taxBps: number): bigint {
  if (grossMinor <= 0n) return 0n;
  if (taxBps <= 0) return grossMinor;
  const fits = (net: bigint) => net + payTaxMinor(net, taxBps) <= grossMinor;
  // The exact answer is within a dollar of gross / (1 + rate); the loops settle the rounding.
  let net = (grossMinor * 10_000n) / (10_000n + BigInt(taxBps));
  while (net > 0n && !fits(net)) net -= 1n;
  while (fits(net + 1n)) net += 1n;
  return net;
}

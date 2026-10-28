/**
 * How long a payment receipt keeps trying to reach the gateway: about nine minutes in all.
 *
 * The signed POST underneath already retries three times, but inside a second, so a gateway that
 * was briefly unreachable -- a restart, a stalled database -- used to cost the receipt for good.
 * The money was on the account all the same, so the next /bal booked it as a nameless "donutsmp"
 * adjustment and the payer had to report it by hand. Minutes of retrying cover every outage short
 * of a real one, and receipts behind this one wait in order rather than overtaking it.
 */
export const REPORT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

/* A gateway that answered and refused (400, 401, 403, 404, 409, ...) will refuse the same request
 * again, so waiting minutes on it would only hold up the receipts queued behind it. A timeout or a
 * rate limit is a "not now", and so is anything that never got an answer at all. */
function isDefiniteRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const status = /^API (\d{3})\b/.exec(message)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `task` until it succeeds, waiting out each delay between attempts; rethrows the last error. */
export async function retryReport(
  task: () => Promise<void>,
  onRetry: (error: unknown, attempt: number, delayMs: number) => void,
  delaysMs: readonly number[] = REPORT_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      const delayMs = delaysMs[attempt - 1];
      if (delayMs === undefined || isDefiniteRefusal(error)) throw error;
      onRetry(error, attempt, delayMs);
      await wait(delayMs);
    }
  }
}

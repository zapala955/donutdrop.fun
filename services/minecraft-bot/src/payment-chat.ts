// Bedrock players reach DonutSMP through Floodgate, which gives them a dotted name (`.Gamertag`)
// truncated to Minecraft's 16-character ceiling. Refusing the dot here would silently drop every
// Bedrock payment on the floor — the receipt would parse as "not a payment" and never be reported.
const USERNAME_PATTERN = /^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/;
const PAID_YOU_PATTERN = /^(\.?[A-Za-z0-9_]{2,16}) paid you $/;
const YOU_PAID_PATTERN = /^You paid (\.?[A-Za-z0-9_]{2,16}) $/;
// Only an unabbreviated amount is accepted. DonutSMP renders a thousand and above as "1K" or
// "1.2K", which cannot be mapped back to the exact figure, so such a message is not evidence of
// any particular amount and is refused rather than guessed at.
const EXACT_AMOUNT_PATTERN = /^([1-9]\d{0,2})$/;
const CURRENCY_COLOR = '#00ff00';
const TEXT_COLOR = 'white';
const CURRENCY_TEXT = '$ ';

export interface ObservedPayment {
  readonly payer: string;
  readonly amount: number;
}

export interface OutgoingPayment {
  readonly payee: string;
  readonly displayedAmount: string;
}

export interface PaymentNotice {
  readonly payer: string;
  readonly displayedAmount: string;
}

/**
 * Recognizes DonutSMP's "<player> paid you $ <amount>" message.
 *
 * This is system chat: the server composes it and, unlike player chat, it is not attributed to a
 * player sender. Ordinary deposits trust this structured server receipt, so this parser matches
 * its component shape and formatting strictly.
 *
 * Precision is why the whole component structure is matched rather than the rendered string. The
 * real message is exactly three parts, and the currency part carries the server's own bright
 * green. Player chat reaches the bot wrapped in the chat plugin's formatting, so it cannot present
 * this shape without the server choosing to emit it.
 */
export function parsePaymentNotice(packet: unknown): PaymentNotice | undefined {
  if (packet === null || typeof packet !== 'object') return undefined;
  const record = packet as Record<string, unknown>;
  // An action bar message is a different channel and never carries a payment receipt.
  if (unwrap(record['isActionBar']) === true) return undefined;

  const segments = componentSegments(record['content'] ?? record['message']);
  if (!segments || segments.length !== 3) return undefined;

  const [sender, currency, amount] = segments;
  if (!sender || !currency || !amount) return undefined;

  if (colorOf(sender) !== TEXT_COLOR || colorOf(amount) !== TEXT_COLOR) return undefined;
  if (colorOf(currency) !== CURRENCY_COLOR) return undefined;
  if (textOf(currency) !== CURRENCY_TEXT) return undefined;

  const senderText = textOf(sender);
  const amountText = textOf(amount);
  if (senderText === undefined || amountText === undefined) return undefined;

  const payer = PAID_YOU_PATTERN.exec(senderText)?.[1];
  if (!payer || !USERNAME_PATTERN.test(payer) || !/^[1-9]\d*(?:\.\d+)?[KMBT]?$/.test(amountText)) {
    return undefined;
  }

  return { payer, displayedAmount: amountText };
}

/**
 * Recognizes the server's own confirmation that THIS bot paid someone: "You paid <player> $ <n>".
 *
 * Structurally identical to the receipt a recipient sees, and matched just as strictly, because it
 * is the only evidence a payout actually happened. Without it the bot fires /pay and assumes,
 * which marks a withdrawal paid whether or not the bot had the money.
 */
export function parseOutgoingPayment(packet: unknown): OutgoingPayment | undefined {
  if (packet === null || typeof packet !== 'object') return undefined;
  const record = packet as Record<string, unknown>;
  if (unwrap(record['isActionBar']) === true) return undefined;

  const segments = componentSegments(record['content'] ?? record['message']);
  if (!segments || segments.length !== 3) return undefined;

  const [lead, currency, amount] = segments;
  if (!lead || !currency || !amount) return undefined;
  if (colorOf(lead) !== TEXT_COLOR || colorOf(amount) !== TEXT_COLOR) return undefined;
  if (colorOf(currency) !== CURRENCY_COLOR) return undefined;
  if (textOf(currency) !== CURRENCY_TEXT) return undefined;

  const leadText = textOf(lead);
  const amountText = textOf(amount);
  if (leadText === undefined || amountText === undefined) return undefined;

  const payee = YOU_PAID_PATTERN.exec(leadText)?.[1];
  if (!payee || !USERNAME_PATTERN.test(payee)) return undefined;
  if (!/^[1-9]\d*(?:\.\d+)?[KMBT]?$/.test(amountText)) return undefined;

  return { payee, displayedAmount: amountText };
}

/**
 * The interval of true values an abbreviated display can stand for: [low, low + step).
 *
 * "383K" is not 383000 exactly — it is anything from 383000 up to but not including 384000, and
 * "1.2K" narrows that to a hundred. Knowing the interval is what lets a payout be confirmed
 * without inventing a rounding rule: a bot that could only afford part of the amount reports a
 * smaller figure, whose interval will not contain what was asked for.
 */
export function displayedAmountBounds(
  displayed: string,
): { readonly low: bigint; readonly step: bigint } | undefined {
  const match = /^([1-9]\d*)(?:\.(\d+))?([KMBT])?$/.exec(displayed);
  if (!match) return undefined;
  const scales: Record<string, bigint> = {
    '': 1n,
    K: 1_000n,
    M: 1_000_000n,
    B: 1_000_000_000n,
    T: 1_000_000_000_000n,
  };
  const unit = scales[match[3] ?? ''];
  if (unit === undefined) return undefined;
  const fraction = match[2] ?? '';
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${match[1]}${fraction}`) * unit;
  if (numerator % denominator !== 0n) return undefined;
  const step = unit / denominator;
  // A display finer than one whole unit cannot bound anything usefully.
  if (step < 1n) return undefined;
  return { low: numerator / denominator, step };
}

export function parsePaymentMessage(packet: unknown): ObservedPayment | undefined {
  const notice = parsePaymentNotice(packet);
  if (!notice) return undefined;
  const exact = EXACT_AMOUNT_PATTERN.exec(notice.displayedAmount)?.[1];
  if (!exact) return undefined;

  return { payer: notice.payer, amount: Number(exact) };
}

/**
 * Chat components arrive NBT-tagged on current versions ({ type, value }) and plain on older
 * ones. Both are unwrapped so the matcher above reads the same either way.
 */
function unwrap(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  const record = node as Record<string, unknown>;
  if (typeof record['type'] === 'string' && 'value' in record) return record['value'];
  return node;
}

function componentSegments(content: unknown): readonly unknown[] | undefined {
  const root = unwrap(content);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return undefined;
  const extra = unwrap((root as Record<string, unknown>)['extra']);
  const list = unwrap(extra);
  return Array.isArray(list) ? (list as readonly unknown[]) : undefined;
}

function fieldText(segment: unknown, field: string): string | undefined {
  const node = unwrap(segment);
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const value = unwrap((node as Record<string, unknown>)[field]);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Flattens a system chat packet into one line a human can read in a log.
 *
 * This exists because a payout currently cannot be confirmed: the bot fires `/pay` and assumes it
 * worked, so a bot with insufficient funds marks a withdrawal paid while the player receives
 * nothing. Confirming it needs a parser as strict as the deposit one, and a strict parser has to
 * match the component structure — which is what this prints, colour by colour, so the real wording
 * can be captured from a live server instead of guessed at.
 */
export function describeSystemChat(packet: unknown): string | undefined {
  if (packet === null || typeof packet !== 'object') return undefined;
  const record = packet as Record<string, unknown>;
  if (unwrap(record['isActionBar']) === true) return undefined;
  const segments = componentSegments(record['content'] ?? record['message']);
  if (!segments || segments.length === 0) return undefined;
  return segments
    .map((segment) => `${colorOf(segment) ?? 'none'}:${JSON.stringify(textOf(segment) ?? '')}`)
    .join(' | ')
    .slice(0, 500);
}

function textOf(segment: unknown): string | undefined {
  return fieldText(segment, 'text');
}

function colorOf(segment: unknown): string | undefined {
  return fieldText(segment, 'color')?.toLowerCase();
}

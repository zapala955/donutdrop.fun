const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const PAID_YOU_PATTERN = /^([A-Za-z0-9_]{3,16}) paid you $/;
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

function textOf(segment: unknown): string | undefined {
  return fieldText(segment, 'text');
}

function colorOf(segment: unknown): string | undefined {
  return fieldText(segment, 'color')?.toLowerCase();
}

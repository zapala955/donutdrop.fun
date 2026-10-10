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

/* What DonutSMP answers, in red, when a /pay asks for more than the payer holds. Captured from the
 * live server: every "unconfirmed" payout between 2026-09-28 and 2026-09-30 but one was this. */
const INSUFFICIENT_FUNDS_TEXT = "you don't have enough funds to do this";

export type PayoutRefusal = 'insufficient_funds';

/**
 * Recognizes the server refusing this bot's /pay. A refusal is a definite answer -- no money
 * moved -- where silence is not, so it must not be mistaken for an unconfirmed payout.
 *
 * Matched strictly: the whole message, every visible part in the server's own red. Player chat
 * arrives with the chat plugin's formatting and a name in front of it, so it cannot take this
 * shape. Only consulted in the seconds after the bot's own /pay.
 */
export function parsePayoutRefusal(packet: unknown): PayoutRefusal | undefined {
  return serverErrorText(packet) === INSUFFICIENT_FUNDS_TEXT ? 'insufficient_funds' : undefined;
}

/* What DonutSMP answers, in red, to a command sent too soon after the bot's previous one. Logged
 * from the live server on 2026-10-10 as red:"You need to wait another 0.25 seconds to execute a
 * command", a moment after a /pay that the idle /bal had just preceded. The command did not run. */
const COMMAND_COOLDOWN_PATTERN = /^you need to wait another \d+(?:\.\d+)? seconds? to execute a command$/;

/**
 * Recognizes the server refusing a command for the cooldown between commands. Matched exactly as
 * strictly as a refusal for funds -- the whole message, all of it in the server's red -- and only
 * consulted while the bot's own /pay is waiting for its answer.
 */
export function parseCommandCooldown(packet: unknown): boolean {
  const text = serverErrorText(packet);
  return text !== undefined && COMMAND_COOLDOWN_PATTERN.test(text);
}

/**
 * The text of a message the server itself sent as an error: every visible part red, nothing in
 * front of it. Normalised (curly apostrophes, runs of spaces, case, one trailing full stop) so the
 * callers can compare it with a single literal. Player chat cannot take this shape, because it
 * arrives with the chat plugin's formatting and a name in front of it.
 */
function serverErrorText(packet: unknown): string | undefined {
  if (packet === null || typeof packet !== 'object') return undefined;
  const record = packet as Record<string, unknown>;
  const content = unwrap(record['content'] ?? record['message']);
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const parts = [content, ...(componentSegments(content) ?? [])].filter(
    (part) => (textOf(part) ?? '') !== '',
  );
  if (parts.length === 0 || parts.some((part) => colorOf(part) !== 'red')) return undefined;
  return parts
    .map((part) => textOf(part) ?? '')
    .join('')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.!]$/, '');
}

/** What the bot's own /bal said: the figure as shown, and the interval of balances it stands for. */
export interface BalanceReading {
  readonly displayed: string;
  /** The least the account can hold, in whole dollars. */
  readonly low: bigint;
  /** How wide the figure is: the true balance is in [low, low + step). 1 for an exact figure. */
  readonly step: bigint;
}

const BALANCE_SCALES: Record<string, bigint> = {
  '': 1n,
  K: 1_000n,
  M: 1_000_000n,
  B: 1_000_000_000n,
  T: 1_000_000_000_000n,
};

/**
 * Reads the server's answer to this bot's own /bal.
 *
 * DonutSMP's stats API was switched off, and /bal is now the only way a bot can learn what it
 * holds. Its exact wording has not been captured from the live server, so this reads the reply by
 * what any balance line must contain rather than by one guessed sentence: a mention of a balance
 * and exactly one dollar figure. It is only consulted in the seconds after the bot sent /bal
 * itself, and every reply in that window is logged verbatim, so the real wording can be read off
 * the logs. Anything ambiguous -- two figures, a payment, an error -- is refused, not guessed at.
 *
 * DonutSMP abbreviates large figures ("1.97M") and truncates them, so a reading is an interval:
 * "1.97M" is anything from 1,970,000 up to 1,980,000. An exact figure has its cents dropped, since
 * every amount on this platform is a whole dollar.
 */
export function parseBalanceReply(packet: unknown): BalanceReading | undefined {
  if (packet === null || typeof packet !== 'object') return undefined;
  const record = packet as Record<string, unknown>;
  const text = flattenText(record['content'] ?? record['message'])
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 200) return undefined;
  // A payment receipt or a refusal is never a balance, whatever figures it carries.
  if (/\bpaid\b|enough funds|not enough|cannot|can't|unknown command/i.test(text)) return undefined;
  if (!/\bbal(ance)?\b|\byou have\b|\bmoney\b/i.test(text)) return undefined;

  const figures = [...text.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*([KMBT])?(?![A-Za-z0-9])/gi)];
  if (figures.length !== 1) return undefined;
  const [, digits, suffix] = figures[0]!;
  const unit = BALANCE_SCALES[(suffix ?? '').toUpperCase()];
  if (!digits || unit === undefined) return undefined;
  const [whole = '', fraction = ''] = digits.replace(/,/g, '').split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return undefined;

  if (unit === 1n) {
    return { displayed: figures[0]![0].replace(/\s+/g, ''), low: BigInt(whole), step: 1n };
  }
  const denominator = 10n ** BigInt(fraction.length);
  const step = unit / denominator;
  return {
    displayed: figures[0]![0].replace(/\s+/g, ''),
    low: (BigInt(whole + fraction) * unit) / denominator,
    step: step >= 1n ? step : 1n,
  };
}

/** All the text in a chat component, in order, whatever its nesting and NBT wrapping. */
function flattenText(node: unknown, depth = 0): string {
  if (depth > 8) return '';
  let value = node;
  for (let i = 0; i < 4; i += 1) {
    const next = unwrap(value);
    if (next === value) break;
    value = next;
  }
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map((part) => flattenText(part, depth + 1)).join('');
  const own = fieldText(value, 'text') ?? '';
  const extra = (value as Record<string, unknown>)['extra'];
  return own + (extra === undefined ? '' : flattenText(extra, depth + 1));
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
/* Every shape a server message can take, for the log written after a payout.
 *
 * This used to describe only multi-part messages on the chat line, so a one-part reply ("You do not
 * have enough money") or anything on the action bar was dropped -- and an unconfirmed payout logged
 * nothing at all about what the server actually said. It is a diagnostic, so it errs towards
 * showing too much: the root's own text, every `extra` part, and which line it arrived on. */
export function describeSystemChat(packet: unknown): string | undefined {
  if (packet === null || typeof packet !== 'object') return undefined;
  const record = packet as Record<string, unknown>;
  const line = unwrap(record['isActionBar']) === true ? 'actionbar ' : '';
  const content = unwrap(record['content'] ?? record['message']);
  if (typeof content === 'string') {
    return content.trim() ? `${line}${JSON.stringify(content)}`.slice(0, 500) : undefined;
  }
  const parts = [content, ...(componentSegments(content) ?? [])]
    .filter((part) => (textOf(part) ?? '') !== '')
    .map((part) => `${colorOf(part) ?? 'none'}:${JSON.stringify(textOf(part) ?? '')}`);
  if (parts.length === 0) return undefined;
  return `${line}${parts.join(' | ')}`.slice(0, 500);
}

function textOf(segment: unknown): string | undefined {
  return fieldText(segment, 'text');
}

function colorOf(segment: unknown): string | undefined {
  return fieldText(segment, 'color')?.toLowerCase();
}

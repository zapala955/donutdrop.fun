/**
 * Temporary diagnostic. Records every chat packet DonutSMP sends so the exact /pay confirmation
 * wording, and whether it arrives as signed player chat or as spoofable system chat, can be read
 * off real traffic instead of guessed. A payment parser built on a guess is the bug that credits
 * money nobody sent, so this exists to remove the guess.
 *
 * Talks to no API and no database. It only connects, listens, and writes a log.
 *
 * Usage:
 *   npx tsx services/minecraft-bot/scripts/capture-chat.ts
 *
 * Reads MINECRAFT_HOST, MINECRAFT_PORT, MINECRAFT_VERSION, MINECRAFT_AUTH, MINECRAFT_USERNAME,
 * MINECRAFT_EXPECTED_USERNAME and MINECRAFT_PROFILES_FOLDER from the environment, and writes
 * CAPTURE_FILE (default chat-capture.jsonl). Lines typed on stdin are sent to the server as chat,
 * so `/bal` can be probed interactively.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';
import mineflayer from 'mineflayer';

const CHAT_PACKETS = new Set([
  'chat',
  'player_chat',
  'system_chat',
  'profileless_chat',
  'disguised_chat',
]);
const COLOR_CODES = /§[0-9a-fk-or]/gi;
const outputFile = process.env['CAPTURE_FILE'] ?? 'chat-capture.jsonl';

interface RawPacketClient {
  on(event: 'packet', listener: (data: unknown, meta: unknown) => void): void;
}

let sequence = 0;

function summarize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<deep>';
  if (Buffer.isBuffer(value)) return `<buffer:${value.length}>`;
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry: unknown) => summarize(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[key] = summarize(inner, depth + 1);
    }
    return result;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function packetName(meta: unknown): string {
  if (meta === null || typeof meta !== 'object') return 'unknown';
  const name = (meta as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : 'unknown';
}

/** True only when the server itself signed the sender's identity into the packet. */
function isVerified(data: unknown): boolean {
  return (
    data !== null && typeof data === 'object' && (data as Record<string, unknown>)['verified'] === true
  );
}

function record(source: string, name: string, text: string, detail: unknown): void {
  sequence += 1;
  const entry = {
    sequence,
    at: new Date().toISOString(),
    source,
    packet: name,
    verified: isVerified(detail),
    text,
    textWithoutColors: text.replace(COLOR_CODES, ''),
    detail: summarize(detail),
  };
  appendFileSync(outputFile, JSON.stringify(entry) + '\n');
  const flag = entry.verified ? 'SIGNED' : 'system';
  process.stdout.write(`[${sequence}] ${name} (${flag}) ${JSON.stringify(entry.textWithoutColors)}\n`);
}

const host = process.env['MINECRAFT_HOST'] ?? 'donutsmp.net';
const port = Number(process.env['MINECRAFT_PORT'] ?? '25565');
const version = process.env['MINECRAFT_VERSION'];
const auth = process.env['MINECRAFT_AUTH'] === 'offline' ? 'offline' : 'microsoft';
const username = process.env['MINECRAFT_USERNAME'];
const profilesFolder = process.env['MINECRAFT_PROFILES_FOLDER'];
const expectedUsername = process.env['MINECRAFT_EXPECTED_USERNAME'];

if (!username) throw new Error('MINECRAFT_USERNAME is required');

process.stdout.write(`Connecting to ${host}:${port} as ${username} (${auth})\n`);
process.stdout.write(`Writing ${outputFile}\n`);

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth,
  ...(version && version !== 'false' ? { version } : {}),
  ...(profilesFolder ? { profilesFolder } : {}),
  hideErrors: false,
  checkTimeoutInterval: 30_000,
  // The point of this capture is the server's raw wording. Mineflayer's built-in patterns would
  // reinterpret it before it is ever recorded.
  defaultChatPatterns: false,
});

bot.once('spawn', () => {
  process.stdout.write(`Spawned as ${bot.username} (expected ${expectedUsername ?? 'unset'})\n`);
  process.stdout.write('Have someone /pay the bot now. Type a line to send it as chat. Ctrl+C to stop.\n');
});

(bot._client as unknown as RawPacketClient).on('packet', (data: unknown, meta: unknown) => {
  const name = packetName(meta);
  if (!CHAT_PACKETS.has(name)) return;
  let text = '';
  if (data !== null && typeof data === 'object') {
    const fields = data as Record<string, unknown>;
    for (const key of ['plainMessage', 'message', 'content', 'unsignedContent']) {
      const candidate = fields[key];
      if (typeof candidate === 'string' && candidate) {
        text = candidate;
        break;
      }
      if (candidate !== undefined && candidate !== null && typeof candidate === 'object') {
        text = JSON.stringify(summarize(candidate));
        break;
      }
    }
  }
  record('packet', name, text, data);
});

// Mineflayer's rendered form, which is what a human reads in game.
bot.on('message', (message: { toString(): string }) => {
  record('rendered', 'message', message.toString(), null);
});

bot.on('kicked', (reason: unknown) => {
  process.stdout.write('KICKED: ' + JSON.stringify(summarize(reason)) + '\n');
  appendFileSync(outputFile, JSON.stringify({ event: 'kicked', reason: summarize(reason) }) + '\n');
});
bot.on('error', (error: unknown) => {
  process.stdout.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
});
bot.on('end', (reason) => {
  process.stdout.write(`ENDED: ${String(reason)}\n`);
  process.exit(0);
});

const stdin = createInterface({ input: process.stdin });
stdin.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  process.stdout.write(`> sending: ${trimmed}\n`);
  bot.chat(trimmed);
});

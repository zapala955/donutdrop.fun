import { AppError } from './errors.js';
import {
  MINECRAFT_USERNAME_PATTERN,
  bedrockIdentityFor,
  isBedrockUsername,
} from './minecraft-username.js';

/**
 * Resolves a Minecraft username to its canonical account UUID.
 *
 * The chat-code login learns the payer's UUID from the signed chat packet itself. A payment
 * receipt is system chat and carries only a name, so the account behind that name has to be
 * resolved separately. Mojang is the authority for that mapping.
 *
 * Names are reassignable, which is why the UUID is what gets stored: it survives a rename, and a
 * recycled name resolves to a different account rather than silently inheriting the old one's.
 */

const UUID_PATTERN = /^[a-f0-9]{32}$/;
const REQUEST_TIMEOUT_MS = 8_000;
const PROFILE_URL = 'https://api.mojang.com/users/profiles/minecraft/';

export interface MinecraftAccount {
  /** `mc:<32 hex>`, matching the identity format the rest of the schema stores. */
  readonly identity: string;
  /** Mojang's canonical casing for the name, which may differ from what was typed. */
  readonly username: string;
}

export async function resolveMinecraftAccount(
  username: string,
): Promise<MinecraftAccount | undefined> {
  if (!MINECRAFT_USERNAME_PATTERN.test(username)) {
    throw new AppError(400, 'INVALID_USERNAME', 'Invalid Minecraft username');
  }

  // Bedrock names have no Mojang profile to resolve. Asking anyway would 404 and read as "no such
  // account", turning every Bedrock login into a dead end.
  if (isBedrockUsername(username)) {
    return { identity: bedrockIdentityFor(username), username };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(PROFILE_URL + encodeURIComponent(username), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw new AppError(
      503,
      'MOJANG_UNREACHABLE',
      'Could not verify the Minecraft account right now',
      undefined,
      { cause: error instanceof Error ? error.message : 'unknown' },
    );
  } finally {
    clearTimeout(timeout);
  }

  // A name nobody owns is a legitimate answer, not a failure.
  if (response.status === 404 || response.status === 204) return undefined;
  if (!response.ok) {
    throw new AppError(503, 'MOJANG_FAILED', 'Could not verify the Minecraft account right now', {
      status: response.status,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(503, 'MOJANG_FAILED', 'Mojang returned an unreadable profile');
  }
  if (payload === null || typeof payload !== 'object') return undefined;

  const record = payload as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'].toLowerCase() : undefined;
  const name = typeof record['name'] === 'string' ? record['name'] : undefined;
  if (!id || !name || !UUID_PATTERN.test(id) || !MINECRAFT_USERNAME_PATTERN.test(name))
    return undefined;

  return { identity: `mc:${id}`, username: name };
}

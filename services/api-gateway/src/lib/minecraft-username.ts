/**
 * The shape of a name this server will accept, and the identity namespace behind it.
 *
 * DonutSMP accepts Bedrock players through a Geyser/Floodgate bridge, which gives every one of
 * them a Java-visible name carrying a leading dot: `.Gamertag`. That dot is the whole reason this
 * module exists, because it changes what the name IS, not just how it looks.
 *
 * A Java name maps to a Mojang account UUID, which survives a rename. A Bedrock name does not —
 * there is no Mojang profile to ask, and the Floodgate UUID is only visible inside a signed chat
 * packet, which the payment receipt is not. So the two platforms get two identity namespaces:
 *
 *   `mc:<32 hex>`        a Mojang account, resolved and rename-proof
 *   `bedrock:<name>`     a Floodgate name, trusted as far as the payment proves it
 *
 * The weaker guarantee on the Bedrock side is deliberate and bounded. Ownership is still proven
 * the same way it is for Java — the player pays the bot an exact nonce from that account in game,
 * which nobody else can do. What is lost is only rename-survival: if an Xbox gamertag is released
 * and re-registered by somebody else, that person would inherit the account. Accepting that is the
 * price of Bedrock support, and it is the reason the namespaces are kept separate rather than
 * being allowed to collide.
 */

/**
 * Java allows 3–16 of `[A-Za-z0-9_]`. Floodgate prepends a dot and truncates so the result still
 * fits Minecraft's 16-character ceiling, which is also what `varchar(16)` in the schema holds — so
 * the dotted branch is capped at 15 body characters rather than 16.
 */
export const MINECRAFT_USERNAME_PATTERN = /^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/;

/** The same rule as a Zod-ready source string, for schemas that inline their own regex. */
export const MINECRAFT_USERNAME_SOURCE = MINECRAFT_USERNAME_PATTERN.source;

export function isBedrockUsername(username: string): boolean {
  return username.startsWith('.');
}

/**
 * The identity a Bedrock name resolves to.
 *
 * Lower-cased because `normalized_username` is, and the two must agree: an account found by name
 * and an account found by identity have to be the same row or a player gets two of them.
 */
export function bedrockIdentityFor(username: string): string {
  return `bedrock:${username.toLowerCase()}`;
}

/**
 * Chooses the namespace for a name whose Java UUID is already known from a signed chat packet.
 *
 * The chat-code and deposit flows learn a real Floodgate UUID this way, and could store it. They
 * must not: the payment flow cannot see that UUID, so storing it here would give one Bedrock
 * player two identities and therefore two accounts. The name wins on both paths instead.
 */
export function platformIdentityFor(username: string, signedIdentity: string): string {
  return isBedrockUsername(username) ? bedrockIdentityFor(username) : signedIdentity;
}

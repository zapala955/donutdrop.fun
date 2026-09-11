const MINECRAFT_UUID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_PLAYER_COMMAND_BYTES = 128;

export interface VerifiedPlayerChat {
  identity: string;
  message: string;
  normalizedUuid: string;
}

/**
 * Accept only content whose sender UUID was authenticated by
 * minecraft-protocol's secure-chat verifier. Formatted/system chat is never an
 * identity signal because servers and other players can spoof its text.
 */
export function parseVerifiedPlayerChat(packet: unknown): VerifiedPlayerChat | undefined {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return undefined;
  const record = packet as Record<string, unknown>;
  if (record['verified'] !== true) return undefined;
  if (typeof record['plainMessage'] !== 'string' || typeof record['sender'] !== 'string') {
    return undefined;
  }
  if (
    record['plainMessage'].includes('\0') ||
    Buffer.byteLength(record['plainMessage'], 'utf8') > MAX_PLAYER_COMMAND_BYTES
  ) {
    return undefined;
  }
  const normalizedUuid = record['sender'].toLowerCase().replaceAll('-', '');
  if (!MINECRAFT_UUID_PATTERN.test(normalizedUuid)) return undefined;
  return {
    identity: `mc:${normalizedUuid}`,
    message: record['plainMessage'],
    normalizedUuid,
  };
}

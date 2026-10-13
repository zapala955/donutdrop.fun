import 'fastify';
import type { AuthenticatedBot } from '../lib/bot-auth.js';

export interface AuthUser {
  id: string;
  sessionId: string;
  minecraftIdentity: string;
  minecraftUsername: string;
  role: 'player' | 'admin';
  status: 'active' | 'suspended' | 'closed';
  csrfHash: Buffer;
  /** Set when the session is in media test mode: `id` is then the test twin, and this is the real
   * account behind it. See lib/media-test.ts. */
  demoOf?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    /** Set once a bot signature is verified, so error replies can be signed for that bot. */
    authenticatedBot?: AuthenticatedBot;
  }
}

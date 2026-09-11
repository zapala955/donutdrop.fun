import 'fastify';
import type { AuthenticatedBot } from '../lib/bot-auth.js';

export interface AuthUser {
  id: string;
  sessionId: string;
  minecraftIdentity: string;
  minecraftUsername: string;
  role: 'player' | 'admin';
  status: 'pending_compliance' | 'active' | 'suspended' | 'self_excluded' | 'closed';
  csrfHash: Buffer;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    /** Set once a bot signature is verified, so error replies can be signed for that bot. */
    authenticatedBot?: AuthenticatedBot;
  }
}

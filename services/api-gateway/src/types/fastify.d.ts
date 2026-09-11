import 'fastify';

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
  }
}

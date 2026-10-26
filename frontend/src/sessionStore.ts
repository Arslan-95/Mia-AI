import type { Session } from './types';

type SecretStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export function createSessionStore(secrets: SecretStore) {
  const key = 'mia.session';
  return {
    async read(): Promise<Session | null> {
      const serialized = await secrets.get(key);
      if (!serialized) return null;
      try {
        const session = JSON.parse(serialized) as Session;
        if (typeof session.token === 'string' && session.user?.id && typeof session.user.phoneNumber === 'string' && typeof session.user.profileComplete === 'boolean' && Date.parse(session.expiresAt) > Date.now()) return session;
      } catch { /* Remove damaged persisted credentials instead of restoring them. */ }
      await secrets.remove(key);
      return null;
    },
    async write(session: Session | null) {
      if (session) await secrets.set(key, JSON.stringify(session));
      else await secrets.remove(key);
    },
  };
}

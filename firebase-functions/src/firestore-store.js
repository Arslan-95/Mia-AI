import { Timestamp } from 'firebase-admin/firestore';

export function firestoreStore(database) {
  return {
    transaction: operation => database.runTransaction(async firestoreTransaction => {
      let refs;
      return operation({
        read: async keys => {
          refs = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, database.collection('sms_limits').doc(key)]));
          const snapshots = await firestoreTransaction.getAll(refs.ip, refs.phone, refs.global, refs.event);
          return Object.fromEntries(['ip', 'phone', 'global', 'event'].map((name, index) => {
            const data = snapshots[index].data();
            return [name, data ? { attempts: data.attempts, expiresAt: data.expiresAt?.toMillis() } : undefined];
          }));
        },
        write: (_keys, states, expiresAt) => {
          const expiry = Timestamp.fromMillis(expiresAt);
          for (const name of ['ip', 'phone', 'global']) firestoreTransaction.set(refs[name], { attempts: states[name], expiresAt: expiry });
          firestoreTransaction.set(refs.event, { expiresAt: expiry });
        },
      });
    }, { maxAttempts: 3 }),
  };
}

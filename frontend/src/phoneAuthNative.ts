import { getAuth, signInWithPhoneNumber, signOut } from '@react-native-firebase/auth';
import type { PhoneAuthDriver } from './phoneAuth';

export function nativePhoneAuth(): PhoneAuthDriver {
  const auth = getAuth();
  auth.languageCode = 'en';
  return {
    sendCode: async phoneNumber => {
      const confirmation = await signInWithPhoneNumber(auth, phoneNumber);
      return { verificationId: confirmation.verificationId,
        confirm: async code => (await confirmation.confirm(code))?.user ?? null };
    },
    signOut: async () => {
      try { await signOut(auth); }
      catch (error) {
        // RNFirebase iOS rejects signOut on a clean installation. There is
        // nothing to clear in that case; other native failures still matter.
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'auth/no-current-user') throw error;
      }
    },
  };
}

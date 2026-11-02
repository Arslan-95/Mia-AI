import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { AppError } from './errors.js';

export type FirebasePhoneIdentity = { phoneNumber: string; uid: string; expiresAt: Date };
export type FirebasePhoneVerifier = (idToken: string) => Promise<FirebasePhoneIdentity>;
const invalid = () => new AppError(401, 'INVALID_PHONE_CREDENTIAL', 'Request a new code and sign in again.');

// Only a recent phone sign-in may create a Mia session. A Google sign-in in the
// same Firebase project, or an old persisted Firebase session, is not sufficient.
export function phoneIdentity(token: DecodedIdToken, projectId: string, now = Date.now()): FirebasePhoneIdentity {
  const seconds = Math.floor(now / 1000);
  if (token.aud !== projectId || token.iss !== `https://securetoken.google.com/${projectId}` ||
      !token.uid || token.sub !== token.uid || token.firebase?.sign_in_provider !== 'phone' ||
      typeof token.phone_number !== 'string' || !/^\+[1-9]\d{6,14}$/.test(token.phone_number) ||
      !Number.isFinite(token.auth_time) || token.auth_time > seconds + 30 || seconds - token.auth_time > 300 ||
      !Number.isFinite(token.exp) || token.exp <= seconds) throw invalid();
  return { phoneNumber: token.phone_number, uid: token.uid, expiresAt: new Date(token.exp * 1000) };
}

export function firebasePhoneVerifier(projectId: string): FirebasePhoneVerifier {
  return async idToken => {
    // Emulator tokens have no signature. Never accept them on this endpoint.
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new AppError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is unavailable.');
    try {
      const name = `mia-phone-${projectId}`;
      const app = getApps().find(app => app.name === name) ?? initializeApp({ projectId }, name);
      // Verifies signature, expiry, issuer and audience with Google's public
      // certificates. No downloadable service-account private key is needed.
      return phoneIdentity(await getAuth(app).verifyIdToken(idToken), projectId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'auth/internal-error' || code.startsWith('app/')) {
        throw new AppError(503, 'PHONE_AUTH_UNAVAILABLE', 'Phone verification is temporarily unavailable.');
      }
      throw invalid();
    }
  };
}

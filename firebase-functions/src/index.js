import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { beforeSmsSent, HttpsError } from 'firebase-functions/v2/identity';
import { guardSms } from './sms-limits.js';
import { firestoreStore } from './firestore-store.js';

initializeApp();
const hashKey = defineSecret('SMS_RATE_LIMIT_HASH_KEY');

// This is an AUTH blocking trigger, not a public client preflight endpoint.
// The Firebase wrapper verifies the provider-signed event before invoking us.
export const miaBeforeSmsSent = beforeSmsSent({
  region: 'us-central1',
  timeoutSeconds: 7,
  minInstances: 0,
  maxInstances: 2,
  memory: '256MiB',
  // This identity can access only the dedicated counter database and secret.
  serviceAccount: 'mia-sms-guard@jobhunter-ai-90df3.iam.gserviceaccount.com',
  secrets: [hashKey],
}, async event => {
  try {
    const allowed = await guardSms(firestoreStore(getFirestore('mia-auth-limits')), hashKey.value(), {
      id: event.eventId,
      ipAddress: event.ipAddress,
      additionalUserInfo: event.additionalUserInfo,
    });
    if (!allowed) throw new HttpsError('resource-exhausted', 'OTP_RATE_LIMIT');
    // Do not return recaptchaActionOverride: ALLOW, which could override
    // Google's existing anti-abuse verdict. Accepted requests retain it.
    return {};
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    // Missing identity, unavailable storage or invalid state fail closed.
    // Never log IPs, numbers, tokens, or the HMAC key.
    throw new HttpsError('unavailable', 'PHONE_AUTH_UNAVAILABLE');
  }
});

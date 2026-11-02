# Phone authentication

The iPhone client uses native Firebase Phone Authentication. Firebase sends and
verifies the SMS code; the backend validates the resulting ID token and creates
a Mia session. Existing accounts, contacts and chats retain their IDs because
the verified international phone number remains the account identity.

## Configure

1. Create or choose a Firebase project, enable billing and enable the Phone
   sign-in provider. Configure the SMS region policy for supported countries.
2. Register the Apple app with bundle ID `app.mia.messenger`. Download its
   `GoogleService-Info.plist` into `frontend/GoogleService-Info.plist`.
3. Set `FIREBASE_PROJECT_ID` in the backend environment to that project's ID.
   Apply migrations with `npm run db:migrate`, then restart the backend.
4. App verification currently uses Firebase's supported reCAPTCHA flow. The
   native auth plugin registers its callback URL schemes. Silent APNs verification
   can be added after configuring an APNs key in Firebase and regenerating the
   Apple signing profile with Push Notifications capability. Keep that private
   key outside the repository. The current app does not require a push entitlement.
5. Create a new iOS development or release build. Adding Firebase requires a
   native rebuild; an older Mia binary or Expo Go cannot load these modules.
   Development builds use the EAS `development` environment. Set its
   `EXPO_PUBLIC_API_URL` to a server reachable by the phone. A LAN server requires
   the phone and computer to be on the same network. Public releases require
   the deployed HTTPS API URL.

The Firebase project used by the native config and the backend must match.
Setting `FIREBASE_PROJECT_ID` disables both legacy fixed-code endpoints, even
when `DEV_OTP_CODE` or `TEST_PHONE_NUMBERS` remain set. An empty Firebase project
ID retains the explicitly configured legacy test flow for backend tests; the
iPhone client uses Firebase only.

## Session and credential handling

- The backend accepts recent phone sign-ins only. Tokens from another Firebase
  project, other sign-in providers, old Firebase sessions, or unsigned emulator
  credentials cannot create Mia sessions.
- Each exchanged Firebase ID token is consumed once. Only its SHA-256 digest
  and expiration are stored; expired digests are removed on subsequent logins.
- The server derives the phone number from the verified token, never from a
  client-supplied phone number. Account creation and session issuance are atomic.
- The client clears its Firebase sign-in after successful exchange and keeps
  the Mia session in the device Keychain. Firebase persistence never silently
  creates a new Mia session after logout.
- The client persists its request timestamps in Keychain: 60-second cooldown,
  five attempts per rolling 15 minutes and ten per rolling 24 hours, shared
  across phone numbers and app restarts. Firebase's native app verification
  and abuse controls also apply. A client cooldown is not a server spending cap.
- The provider-side blocking trigger and its deployment requirements are
  documented in [firebase-functions/README.md](firebase-functions/README.md).
  It was deployed and registered in `jobhunter-ai-90df3` on 2026-11-02 and
  enforces IP/phone/global limits before Firebase sends SMS. IP and phone
  limits are one attempt per minute, five per rolling 15 minutes and ten per
  rolling 24 hours. The whole project allows ten reservations per rolling day.
  Devices behind the same public IP share its allowance; IPv6 uses a /64 bucket.
  The function and trigger must also be deployed when moving to another project.

## Public repository

The Firebase Apple configuration contains public app identifiers and a client
API key. It does not contain a service-account private key and is not an admin
credential. It is distributed with the app, but this repository keeps the real
configuration ignored so a public checkout does not select a live Firebase
project by default. `frontend/.easignore` includes the local config in private
native build uploads while excluding environment files and signing keys.
Keep API restrictions on the
Firebase client key and use separate credentials for unrelated Google Cloud
APIs. Do not add application restrictions that break the iOS reCAPTCHA fallback.

Never commit server `.env` files, Apple `.p8`/`.p12` files, signing profiles or
Firebase Admin service-account JSON files. The repository ignores those common
credential paths. No service-account private key is required for this backend's
ID-token signature verification.

SMS is billed according to the Firebase project's current terms and destination
countries. Billing budget alerts notify account administrators; they do not
stop spending. Review Firebase quotas and abuse controls before public launch.

## Validation

Backend tests cover account continuity, token replay, concurrent exchange,
disabled fixed-code bypasses, input validation, project/provider/freshness checks,
and rejection by the real Admin SDK of unsigned and foreign-project credentials.
Client tests cover wrong codes, cooldown, expiry, cancellation, phone mismatch,
and retry after an interrupted backend exchange.

References: [Apple phone authentication](https://firebase.google.com/docs/auth/ios/phone-auth),
[ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[Firebase API keys](https://firebase.google.com/docs/projects/api-keys),
[React Native Firebase](https://rnfirebase.io/auth/phone-auth).

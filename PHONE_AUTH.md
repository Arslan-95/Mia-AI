# Test phone sign-in

Mia uses fixed phone/code pairs configured on its backend. No SMS is sent, and
the mobile app does not use Firebase Authentication or its native modules.

Set these backend environment variables to JSON arrays of strings:

```dotenv
TEST_PHONE_NUMBERS='["+12025550101","+12025550102"]'
TEST_OTP_CODES='["012345","654321"]'
DEV_OTP_CODE=
```

Entries are paired by index. Both arrays must have the same length, phone
numbers must be unique and international, and codes must have exactly six
digits. Strings preserve leading zeros. Use your own pairs in the private
backend `.env`; never put codes in the mobile bundle or public repository.
Restart the backend after changing its environment.

With `DEV_OTP_CODE` empty, only listed numbers can sign in. Configured pairs work
in every environment, including production. For local development only, an
explicit `DEV_OTP_CODE` also permits unlisted numbers; it is never a production
fallback. Empty arrays with no development code disable sign-in.

The app calls `POST /v1/auth/otp/request`, then `POST /v1/auth/otp/verify` with
the assigned code. The backend issues a five-minute, single-use challenge and
stores its code hash, never returning the code to the client. Five incorrect
codes lock a challenge; five requests per number in fifteen minutes and HTTP
rate limits still apply. A new challenge replaces an older one.

Existing accounts, names, contacts, chats and Mia sessions keep their identity:
sign-in still looks up the same international phone number. The app stores
the resulting Mia session in Keychain.

Old `FIREBASE_PROJECT_ID` environment values no longer affect authentication.
The `/v1/auth/firebase` endpoint has been removed. Historical database migrations
remain so existing databases can still migrate safely. Firebase resources in
the shared cloud project are not managed by the app's sign-in flow.

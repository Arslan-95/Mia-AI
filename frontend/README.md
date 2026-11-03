# Run the Mia mobile app

Run the commands below from the `frontend` directory. The currently implemented mobile version runs on iPhone. For the product overview, see the [main README](../README.md).

## Requirements

- Node.js 24 or later and npm.
- A running [Mia backend](../backend/README.md) with configured phone sign-in and model/speech access.
- A native iOS development build containing Mia's audio module. Expo Go does not include that module.
- For local native compilation: macOS, Xcode, and appropriate device signing. EAS cloud builds are an alternative with Expo access and Apple signing/device provisioning.

## 1. Install dependencies

```sh
npm ci
```

This installs the versions recorded in `package-lock.json` and replaces an existing `node_modules` directory.

## 2. Set the backend address

Copy [`.env.example`](.env.example) to `.env.local` if you do not already have one. Keep existing local values when updating a checkout.

For a physical iPhone, use your development computer's reachable Wi-Fi address, for example:

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.1.42:8082
```

Replace the example IP with your computer's address. On the backend, set `HOST=0.0.0.0` and restart it. Use the same trusted network and allow access to the API port. Open the backend's `/health` URL from the iPhone to check reachability.

For an iOS Simulator with the backend on the same Mac, use:

```dotenv
EXPO_PUBLIC_API_URL=http://127.0.0.1:8082
```

On a physical iPhone, `127.0.0.1` points to the phone itself. The API URL must match the actual backend port. `EXPO_PUBLIC_*` values are included in the app; keep API keys and sign-in codes on the backend.

## 3. Install a native development build

### Local build on macOS

With Xcode and signing configured, connect the iPhone and run:

```sh
npm run ios -- --device
```

Select the connected device when prompted. For a simulator build, use `npm run ios` instead. Physical voice behavior needs testing on an actual iPhone.

### EAS cloud build

The checked-in [`eas.json`](eas.json) includes a `development` profile. Configure an Expo project and Apple signing/device registration you are authorized to use, then build with EAS:

```sh
npx eas-cli build --platform ios --profile development
```

Install the resulting build on the registered iPhone. The current [`app.json`](app.json) points to the author's Expo project; a separate developer needs their own project/signing setup or authorized access. See [Expo's development-build guide](https://docs.expo.dev/develop/development-builds/introduction/).

## 4. Start Metro and open the app

With a compatible development build installed:

```sh
npm start -- --dev-client
```

Open the installed development client and connect using the QR code or development-server address shown by Expo. Keep Metro and the backend running. If the native build command already started Metro, use that server rather than starting another one.

Restart Metro after changing `.env.local`. A distributed binary with an embedded API address needs a new build to change it. Native module changes also require a new native build. See [using an Expo development build](https://docs.expo.dev/develop/development-builds/use-development-builds/).

## 5. Sign in and enable voice mode

1. Enter a phone number configured on your backend and its corresponding six-digit code. No SMS is sent.
2. Complete the display name on first sign-in. Create a second controlled account if you want to exchange messages; the app does not seed demo contacts automatically.
3. Open **Settings → Mia voice mode**, confirm activation, and grant microphone access when prompted.

## If the app cannot start or connect

- **Missing native audio module:** install a development build that includes `modules/mia-voice`; Expo Go cannot supply it.
- **Backend unreachable:** check the computer IP, API port, backend bind address, firewall, and Wi-Fi connectivity.
- **Development server unreachable:** check that Metro is running and the phone can reach its displayed address.
- **Sign-in rejected:** check the allowed phone/code pairs on your backend.
- **Microphone unavailable:** check Mia's microphone permission in iPhone settings. Voice interaction runs while the app is in the foreground.

## Source layout

```text
src/
  app/                  App entry, navigation, and application coordination
  features/
    auth/               Phone sign-in and profile UI
    chats/              Chats, messages, drafts, and voice messages
    contacts/           People search, contact details, and contact forms
    assistant/          Agent interaction, voice conversation, and source cards
    settings/           Settings screen
  shared/
    api/                HTTP and WebSocket clients
    audio/              Capture, playback, PCM, echo handling, and media cache
    hooks/              Shared React hooks
    storage/            Session and preference storage
    ui/                 Shared components, appearance, and motion
    errors.ts           Shared error types and presentation
    phone.ts            Shared phone-number normalization
    types.ts            Existing cross-feature data contracts
modules/
  mia-voice/            Native iOS audio module
tests/                  Frontend regression tests and native test substitutes
```

Feature UI lives under `ui/`; feature helpers and state-related types live under `model/` where needed. `src/app/useMia.ts` retains the existing application coordination. This organization groups existing code without changing its runtime logic or splitting that coordinator.

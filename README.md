# Mia AI

**An AI-based messenger designed for communication without looking at the screen.**

Mia is an AI-based messenger built around natural conversation. Its integrated AI agent, powered by Meta's models, understands the user's intent and conversational context, remembers useful preferences, and takes action within the messenger. It chooses the next steps, delegates to messaging and contacts specialists when helpful, and adapts to real results and the user's changing requests, asking for clarification or approval when needed.

For people who cannot rely on visual navigation, this makes conversation a way to use the messenger: find the right person, understand a conversation, work out a reply together, and send the agreed message. The user expresses what they want to achieve; Mia handles the steps within its available tools and permissions.

The current implementation includes a mobile app for iPhone.

Built for the **Meta Global AI Developer Hackathon 2026** · **Build for Your World**.

**Three-minute demo video:** the public video link will be added before submission.

## What you can do

- Use direct chats, saved contacts, text messages, and original voice notes in Mia's own messenger.
- Ask Mia to find a person, open their conversation, and read messages aloud.
- Compose and revise a reply conversationally. Agent-managed sends require approval of the specific recipient and message version.
- Play an original voice note and interrupt spoken output to continue the conversation.
- Record your own voice note with a hold-and-release gesture.
- Retain useful preferences and contact relationships in account memory, then recall, correct, or forget them. Automatic learning can be paused.

For example, after a controlled demo account sends a message about a meeting:

> “Open Anna's chat and read her latest message.”
>
> “Reply that six works for me.”
>
> “Make it a little warmer.”
>
> After hearing the final recipient and text: “Yes, send it.”

The result is a message stored and delivered by the messaging backend. Phone actions such as navigation and playback return execution feedback to the agent, so a requested action and a completed action have distinct states.

## Work built during the hackathon

Mia's application implementation began on October 27, 2026. The first repository commit is `b4bfe2f`. The event-built work includes:

- The React Native/Expo mobile app for iPhone and the messenger's Fastify/PostgreSQL backend.
- A conversational coordinator, scoped messaging and contacts specialists, and the Meta Responses API tool loop.
- Meta realtime speech recognition and recorded-audio transcription.
- A native Swift/Objective-C audio module for capture, playback, voice processing, and audio-graph recovery, with application-level echo handling and interruption.
- Versioned drafts, semantic approval review, retry-safe sending, cancellation, and acknowledged phone actions.
- Persistent account memory with semantic review, correction, forgetting, and learning controls.

The project uses existing frameworks, SDKs, and model services. Apple's voice-processing sample informed parts of the native audio approach; see [Attribution](#attribution). Memory stores application data and does not train or fine-tune model weights.

## How Meta models are used

| Component | Model / API | Role in Mia |
| --- | --- | --- |
| Coordinator and specialists | Muse Spark 1.3 (`muse-spark-1.3`), `POST /v1/responses` | Interpret the conversation, select tools, delegate bounded work, and use real results to decide the next step. Specialists use separate instructions and tool scopes with the same configured model. |
| Semantic reviewers | Muse Spark 1.3 through Responses | Review send intent, memory mutations, contact renaming, and voice-mode exit consent against the relevant user request. |
| Live speech recognition | Muse Voice Transcribe (`muse-voice-transcribe-1.0`), `/v1/asr/realtime` over WebSocket | Turn microphone audio into transcripts, with endpointed speech used for conversational turns. |
| Recorded-audio transcription | Muse Voice Transcribe, `POST /v1/asr/transcribe` | Transcribe authorized recordings separately from executing assistant commands. |

The model chooses tools and delegation from the conversation. TypeScript services enforce account ownership, valid arguments, draft versions, cancellation, and idempotency. Only the coordinator can complete an approved agent-managed send; specialists can help prepare the work.

The Responses adapter uses `store: false` and replays encrypted reasoning items during the tool loop. Application conversation, memory, and action state are stored in PostgreSQL. This setting is not an end-to-end encryption claim for messenger content.

Spoken output comes from **Google Cloud Text-to-Speech**, with support for Gemini 3.1 Flash TTS Preview and standard voices. Meta supplies agent reasoning and speech recognition. See [speech configuration](backend/docs/SPEECH.md).

## Architecture

```text
iPhone microphone
    │
    ▼
Native audio module → authenticated backend → Meta Voice Transcribe
    ▲                                              │
    │                                              ▼
    │                                    Mia coordinator (Muse Spark)
    │                                       │                 │
    │                               messaging specialist   contacts specialist
    │                                       └────────┬────────┘
    │                                                ▼
    │                                  scoped tools / PostgreSQL / media
    │                                                │
    └──── PCM playback ← Google TTS ← confirmed results and spoken response

Phone navigation/playback requests → device execution → feedback to the agent
```

| Location | Responsibility |
| --- | --- |
| [`frontend/src`](frontend/src) | Messenger screens, application state, realtime client, gestures, and audio coordination. |
| [`frontend/modules/mia-voice`](frontend/modules/mia-voice) | Native iOS capture/playback, AVFoundation voice processing, PCM conversion, and lifecycle handling. |
| [`backend/src/agents`](backend/src/agents) | Coordinator/specialist runtime, prompts, tools, draft approval, and account memory. |
| [`backend/src/speech`](backend/src/speech) | Meta ASR, Google synthesis, interruption decisions, and audio delivery. |
| [`backend/src/routes`](backend/src/routes) | Authenticated messaging, assistant, and speech HTTP routes. |
| [`backend/migrations`](backend/migrations) | PostgreSQL schema migrations. |

REST and authenticated WebSocket connections connect the app and backend. PostgreSQL persists users, chats, messages, drafts, memory, and action/event state. Voice-message media is stored under the backend's configured `MEDIA_DIRECTORY` and served through authorized routes.

## Run locally

### Prerequisites

- Node.js **24 or later** and npm.
- Docker with Docker Compose for the included PostgreSQL 18 service, or a compatible PostgreSQL instance.
- Meta Model API access and a server-side API key with access to the configured reasoning and transcription models.
- Google Cloud speech-synthesis access, configured as described below.
- An iPhone for physical voice testing. Local iOS compilation requires macOS and Xcode; EAS is an alternative cloud-build route with appropriate Expo access and Apple signing/device provisioning.

The app includes a custom native audio module and needs a native development build. Expo Go does not contain that module. See Expo's [development-build guide](https://docs.expo.dev/develop/development-builds/introduction/) and [local iOS build instructions](https://docs.expo.dev/guides/local-app-development/).

### 1. Install dependencies and configure the backend

Clone the repository, then install from the backend directory:

```sh
git clone https://github.com/Arslan-95/Mia-AI.git
cd Mia-AI/backend
npm ci
```

Copy [`backend/.env.example`](backend/.env.example) to `backend/.env` **only if the destination does not already exist**. Retain existing local values when updating a checkout.

Set `META_API_KEY` on the backend. The default models in the template are:

```dotenv
META_BASE_URL=https://api.meta.ai/v1
META_MODEL=muse-spark-1.3
META_ASR_MODEL=muse-voice-transcribe-1.0
```

Configure at least two phone/code pairs if you want to demonstrate messages between two accounts. The following values are examples for a new local setup, not credentials for an existing hosted service:

```dotenv
TEST_PHONE_NUMBERS='["+12025550101","+12025550102"]'
TEST_OTP_CODES='["012345","654321"]'
```

The arrays must have matching lengths, unique international phone numbers, and six-digit codes. The backend creates an account at first successful sign-in; complete the display name in the app. These configured pairs remain enabled even in production mode, so they are a prototype sign-in mechanism rather than proof of phone ownership. No SMS is sent. The optional `DEV_OTP_CODE` fallback works only outside production; leave it empty when using the explicit pairs.

The environment template selects **Gemini TTS with Application Default Credentials**. Configure its project, API access, and identity using [the speech guide](backend/docs/SPEECH.md). Alternatively, for a standard Google voice, replace the TTS selections in your local `.env` with:

```dotenv
GOOGLE_TTS_MODEL=standard
GOOGLE_TTS_AUTH=api-key
GOOGLE_TTS_VOICE=en-US-Neural2-F
GOOGLE_TTS_STYLE=none
GOOGLE_TTS_API_KEY=your_server_side_google_cloud_key
```

That route requires Cloud Text-to-Speech and billing enabled for the key's project. Keep provider keys, configured sign-in codes, and credential files on the backend. The frontend receives only the API address.

### 2. Start PostgreSQL and the API

From `backend`:

```sh
docker compose up -d --wait postgres
npm run db:migrate
npm run dev
```

The supplied local configuration uses PostgreSQL on `127.0.0.1:54329` and the API on port `8082`. Apply migrations before starting the server. If you change the database credentials or port, update `DATABASE_URL` accordingly.

`GET /health` checks the HTTP service. `GET /health/ready` checks the database and reports configured authentication/model/speech capabilities; it does not make a real provider request. `npm run speech:check` performs a real Google synthesis check and consumes provider usage.

### 3. Configure the iPhone connection

In a second terminal, from the repository root:

```sh
cd frontend
npm ci
```

Copy [`frontend/.env.example`](frontend/.env.example) to `frontend/.env.local` only if it does not exist. For a physical iPhone, set the API address to your development computer's reachable Wi-Fi address, for example:

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.1.42:8082
```

Use your actual computer address. Set `HOST=0.0.0.0` in `backend/.env`, restart the backend, and allow the API port on the trusted local network. The iPhone and computer must be able to reach each other; `127.0.0.1` on the phone refers to the phone itself.

`EXPO_PUBLIC_*` values are included in the app. Do not put credentials there. Restart Metro after editing frontend environment configuration; a distributed binary built with an embedded API address needs a new build to change that address.

### 4. Build and open the iPhone client

On macOS with Xcode and device signing configured, from `frontend`:

```sh
npm run ios -- --device
```

This runs Expo's native iOS build command and lets you select a device. For cloud builds, [`frontend/eas.json`](frontend/eas.json) includes a `development` profile. Use an Expo project and signing setup you are authorized to build; the checked-in app configuration points to the author's project. See [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/) for the cloud workflow.

For an already installed compatible development build, start Metro from `frontend`:

```sh
npm start -- --dev-client
```

Open the development client and connect it to Metro, using the displayed QR code or development-server address. Native module changes require a new native build. Details: [using a development build](https://docs.expo.dev/develop/development-builds/use-development-builds/).

## Try the communication workflow

1. Sign in with one of your configured phone/code pairs and complete its display name. Sign in to the second account on another client and complete that profile too.
2. Find the second account by its full international phone number, save it as a contact if desired, and exchange a message. The app has no automatic demo-data seed step.
3. Open **Settings → Mia voice mode** and confirm activation. Grant microphone access when prompted.
4. Ask Mia to open the contact's chat, read the actual message, and help prepare a reply. Revise the text, hear the final version and recipient, and approve sending.
5. Verify the sent message in the chat and on the receiving client. Then try playing a voice note or correcting a remembered preference.

In voice mode, the upper 60% of the screen controls assistance: tap to mute/unmute microphone input, or hold continuously for five seconds to exit. In a chat, hold the lower 40% to record your own voice note and release to send. Move away until the cancel indicator fills, then release to delete instead. This recording gesture directly sends the captured recording; it is separate from the agent-managed draft approval workflow. Input mute and audio playback are separate controls.

See [voice controls](backend/docs/VOICE_CONTROLS.md) and [device-action feedback](backend/docs/DEVICE_ACTIONS.md) for the detailed behavior.

## Checks and tests

Backend, from `backend`:

```sh
npm run check
npm test
npm run build
```

Without `TEST_DATABASE_URL`, the backend tests use isolated PGlite databases. To exercise PostgreSQL, start the included database and run:

```sh
npm run test:postgres
```

The PostgreSQL test helper creates and removes dedicated `mia_test_*` schemas. `TEST_DATABASE_URL` can select a dedicated test database; the runner otherwise uses the local Compose database defaults.

Frontend, from `frontend`:

```sh
npm run check
npm test
npm run build:ios
```

`build:ios` produces an iOS JavaScript/Hermes export. It is not native compilation or physical-device verification. Automated tests cover application behavior with provider/native substitutes where appropriate; acoustic echo handling and accessibility also require real-device evaluation.

Opt-in backend scripts such as `test:memory:live`, `test:voice:live`, `test:conversation:live`, `test:approval:live`, and `test:delivery:live` exercise real providers and consume API usage. Some simulate device acknowledgements. They are separate from the default suite; inspect their setup before running them. See [`backend/package.json`](backend/package.json) for all commands.

## Scope and limitations

- The currently implemented mobile version runs on **iPhone**, supports **English**, and operates in the foreground. There is no background wake word or continuous listening while the app is locked.
- Communication happens within Mia's messenger. External messenger, email, and calendar integrations are not implemented.
- Sign-in uses operator-configured codes, not SMS verification. A fresh checkout needs its own accounts, keys, network configuration, and native build; this repository does not supply public hosted demo credentials.
- The local backend stores message media on disk. A production deployment needs an appropriate persistent-storage, hosting, authentication, and operational setup.
- VoiceOver semantics and screen-free workflows are part of the design. A comprehensive VoiceOver audit and broader blind/low-vision user study have not been established. Physical device checks cover specific tested workflows, not all acoustic conditions.
- Model decisions can be wrong. The runtime uses separate semantic reviewers and application checks, but this is not a guarantee of error-free interpretation.

## Further documentation

- [Account memory, correction, and forgetting](backend/docs/MEMORY.md)
- [Speech synthesis and delivery preferences](backend/docs/SPEECH.md)
- [Voice mode, input mute, and exit](backend/docs/VOICE_CONTROLS.md)
- [Phone action execution and feedback](backend/docs/DEVICE_ACTIONS.md)
- [Spoken progress narration](backend/docs/PROGRESS_NARRATION.md)

## Attribution

Mia uses Meta Model API for Muse Spark reasoning and Muse Voice Transcribe, Google Cloud for speech synthesis, and React Native, Expo, Fastify, PostgreSQL, and their dependencies for the application stack.

The native audio implementation was informed by Apple's [Using Voice Processing / AVEchoTouch sample](https://developer.apple.com/documentation/avfaudio/using-voice-processing), particularly voice-processing setup and resuming an existing audio engine after configuration changes. Acoustic echo cancellation is supplied by Apple's AVFoundation voice processing; Mia adds its own application lifecycle, transport, and interruption handling around it.

**Built by Arslan Sarakaev.**

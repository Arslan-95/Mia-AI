# Run the Mia backend

Run the commands below from the `backend` directory. For the product overview, see the [main README](../README.md).

## Requirements

- Node.js 24 or later and npm.
- Docker with Docker Compose for the included PostgreSQL service, or an existing PostgreSQL instance.
- Meta Model API access for agents and transcription, and Google Cloud speech-synthesis access for spoken responses.

## 1. Install dependencies

```sh
npm ci
```

This installs the versions recorded in `package-lock.json` and replaces an existing `node_modules` directory.

## 2. Configure the environment

Copy [`.env.example`](.env.example) to `.env` if you do not already have one. Keep existing local values when updating a checkout.

For the included database and an iPhone on your trusted local network:

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=8082
DATABASE_URL=postgresql://mia:mia_local_password@localhost:54329/mia
META_API_KEY=your_meta_model_api_key
META_BASE_URL=https://api.meta.ai/v1
META_MODEL=muse-spark-1.3
META_ASR_MODEL=muse-voice-transcribe-1.0
```

Use `HOST=127.0.0.1` if only clients on the same computer need access. When using another database or changing its credentials, update `DATABASE_URL` to match.

### Phone sign-in

Set allowed phone/code pairs in `.env`. These are examples for your own local setup:

```dotenv
TEST_PHONE_NUMBERS='["+12025550101","+12025550102"]'
TEST_OTP_CODES='["012345","654321"]'
```

Both arrays must have the same length. Numbers must be unique and include the country code; codes must contain six digits. Sign in with the corresponding code and complete the display name in the app. No SMS is sent. These pairs also work in production mode and are intended for controlled prototype accounts. The optional `DEV_OTP_CODE` fallback is disabled in production.

### Spoken responses

Choose one Google TTS configuration:

- **Gemini TTS:** the template selects `gemini-3.1-flash-tts-preview`, voice `Kore`, and `GOOGLE_TTS_AUTH=adc`. Set `GOOGLE_TTS_PROJECT` and configure Application Default Credentials and the required API permissions using the [speech setup guide](docs/SPEECH.md).
- **Standard voice with an API key:** enable Google Cloud Text-to-Speech and billing, then replace the template's TTS selections with:

```dotenv
GOOGLE_TTS_MODEL=standard
GOOGLE_TTS_AUTH=api-key
GOOGLE_TTS_VOICE=en-US-Neural2-F
GOOGLE_TTS_STYLE=none
GOOGLE_TTS_API_KEY=your_google_cloud_api_key
```

Keep `.env`, sign-in codes, and provider credentials on the backend. The frontend only needs the API URL.

## 3. Start PostgreSQL and apply migrations

```sh
docker compose up -d --wait postgres
npm run db:migrate
```

The included database uses port `54329` and a persistent Docker volume. If you use an existing database, skip the Compose command and run migrations against your configured `DATABASE_URL`.

## 4. Start the server

```sh
npm run dev
```

With the example configuration, the local API is at [http://127.0.0.1:8082](http://127.0.0.1:8082). Open [the health endpoint](http://127.0.0.1:8082/health) or [readiness endpoint](http://127.0.0.1:8082/health/ready). Readiness checks the database and reports configured capabilities; it does not verify a live model call.

For compiled execution instead of the development watcher:

```sh
npm run build
npm start
```

Restart the server after editing `.env`. To connect the mobile app, follow the [frontend launch instructions](../frontend/README.md).

## If startup fails

- **Database error:** check that PostgreSQL is running, `DATABASE_URL` matches it, and migrations have been applied.
- **Sign-in unavailable:** configure a phone/code pair, or a development-only fallback code.
- **Agent or recognition unavailable:** check `META_API_KEY` and access to the configured models.
- **No spoken response:** verify the chosen Google TTS configuration. `npm run speech:check` makes a real synthesis request and consumes provider usage.
- **Phone cannot connect:** use `HOST=0.0.0.0`, allow the API port on the trusted network, and configure the frontend with the computer's reachable address.

# Speech synthesis

Mia supports Google Cloud Text-to-Speech with Gemini 3.1 Flash TTS Preview or standard voices such as Neural2. Both return validated mono 24 kHz PCM through the existing interruptible phone playback transport.

## Gemini 3.1 Flash TTS Preview

Set these server environment variables:

```dotenv
GOOGLE_TTS_MODEL=gemini-3.1-flash-tts-preview
GOOGLE_TTS_VOICE=Kore
GOOGLE_TTS_PROMPT="Speak calmly and naturally, with restrained warmth and clear everyday conversational delivery."
GOOGLE_TTS_AUTH=adc
GOOGLE_TTS_PROJECT=your-google-cloud-project-id
```

Enable Cloud Text-to-Speech, Vertex AI and billing in that project. The authenticated identity needs `aiplatform.endpoints.predict`, included in `roles/aiplatform.user`. Enabling the API alone does not grant this permission. An ordinary API key that works for Neural2 is not proof of access to Gemini.

Authorization uses Google's Application Default Credentials (ADC), with automatic short-lived token refresh. For local development, an installed Google Cloud CLI can create ADC with `gcloud auth application-default login`. For a backend with an attached service account, ADC uses that identity. A service-account credential file can also be referenced by `GOOGLE_APPLICATION_CREDENTIALS`; keep the file outside this repository and never send its contents to the frontend or commit it. Use a credential with access to the selected project.

Run `npm run speech:check` after configuring access. This performs a real synthesis and validates the audio. Restart the backend after changing environment variables. No iPhone binary rebuild is required for this backend-only change.

Gemini receives the delivery prompt separately from the spoken text; the Neural2 SSML style is not applied to it. Each input text and prompt fits within 4,000 UTF-8 bytes. Long speech is split near sentence boundaries. Responses are bounded and validated; cancellation prevents later chunks or credential completion from starting stale audio. Provider failures are reported instead of silently switching voices or models.

## Context and personal preferences

Every turn starts with calm tone, steady pace and reserved warmth. The coordinator can select a small adjustment using `set_speech_delivery`: calm/gentle/light tone, steady/unhurried pace, reserved/friendly warmth. The choice comes from semantic model reasoning over the current conversation and supported memory, rather than phrase or keyword classifiers. Routine neutral replies need no extra tool call. Text generation follows the same understated manner; an ordinary greeting does not require an excited welcome or an offer to help.

Delivery is validated and persisted in `assistant_turns.speech_delivery` (migration 011), independently from the spoken text. A new turn resets it; a restart preserves a completed answer's delivery. Final speech uses the server-owned choice. A `show_message` narration can snapshot its own optional delivery, so a later change cannot alter an earlier source's narration. Quoted messages are read faithfully without impersonating the author. Clients cannot submit a delivery prompt or substitute narration text.

The existing account memory tools retain supported lasting voice and conversation preferences, including ordinary corrections. The agent updates a matching memory rather than accumulating paraphrases. A temporary request changes the current answer only. The memory reviewer rejects inferred personality, relationship scores and unsupported preferences; time and conversation count do not automatically increase familiarity. Current instructions take priority over saved preferences. Paused learning and forgotten memory slots remain respected. This is prompt/tool-based adaptation using saved preferences, not model weight training.

Run `npm run test:delivery:live` for real-model decisions, corrections, temporary overrides, persistence beyond recent history, paused learning and forgetting in an isolated local schema. `npm run speech:samples` creates four generic WAVs under the ignored `.data/voice-samples/` directory and transcribes them through the real recognizer to check their words. Those checks cannot establish subjective naturalness; listen to the samples and a real conversation. Delivery remains restrained, but Gemini Preview can vary between requests.

## Neural2 rollback

```dotenv
GOOGLE_TTS_MODEL=standard
GOOGLE_TTS_AUTH=api-key
GOOGLE_TTS_VOICE=en-US-Neural2-F
GOOGLE_TTS_STYLE=none
GOOGLE_TTS_API_KEY=your-server-api-key
```

`calm`, `empathetic`, `lively`, `firm` and `apologetic` are also supported for Neural2-F/J through escaped SSML. Other standard voices use plain text. If the new model's authorization check fails, keep the existing working configuration until access is configured.

References: [Gemini-TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts), [Google Cloud authentication](https://docs.cloud.google.com/text-to-speech/docs/authentication), [Neural2 styles](https://docs.cloud.google.com/text-to-speech/docs/ssml#styles).

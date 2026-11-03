# Hands-free mode and input mute

The client reports optional `context.voice = {enabled, microphoneMuted, revision}`
with each request. Legacy clients without it have unknown state. Navigation
revision and voice-control revision are separate: muting input does not revoke
a still-current messaging task.

Coordinator tools:

- `get_voice_mode`: the current request snapshot, or the most recent confirmed
  control result in the same turn. It never invents a default mode.
- `set_voice_mode(false)`: starts an exit confirmation; applies an exit only
  after a separate later user answer passes semantic consent review.
  `enabled=true` is rejected: activation belongs to Settings only.
- `set_microphone_muted`: a phone action that changes input only.
- `stop_audio`: stops playback; it does not exit the mode.

Mode intent is interpreted by the model, not a keyword router. Questions about
modes and quoted instructions do not authorize a switch. Mutations wait briefly
for device feedback; pending/failed is not confirmed success. Migration007 adds
the action kinds. Migration008 persists short-lived exit requests. A success acknowledgement must contain the actual matching
voice state. Existing account, generation, navigation and expiry fences apply.

On API3 clients, input mute retains both the application WebSocket and the
recognition session. Native PCM is dropped before decoding or buffering; the
shared audio graph and current speaker output remain available. This is an
input-transmission mute, not a claim the iOS audio hardware is powered off.
Unmute discards held input, retains the echo reference and resumes the same
recognizer without a new handshake or Connecting phase.

The client sends `voice.mute {requestId, muted, revision}` immediately, scoped
to the current recognition request. The backend gates microphone frames and
generates real-time 24 kHz PCM silence while muted. Meta requires continued PCM
input to avoid its idle/pacing cutoff; simply leaving the WebSocket open is
insufficient ([provider lifecycle](https://dev.meta.ai/docs/speech-to-text)).
Silence is processed audio and therefore counts toward ASR usage. Muted sessions
still rotate at the existing five-minute limit, and close on exit, background,
logout or transport failure. `voice.end` stops silence before ending input.

Mute edges cancel pending recognition work and stable-word timers, discard
unfinished utterances, and retain the provider audio clock. Input revision tags
fence queued interruption frames after rapid toggles. Tagged committed turns
still receive their replies even when delivery crosses mute or natural rotation;
explicit cancellation revokes this allowance. Provider audio progress is not an
exact onset timestamp, so a very short mute cannot guarantee splitting an
utterance that the model has not detected yet.

Deploy the backend protocol update before the frontend that sends `voice.mute`.
Older frontends can continue using `voice.cancel`/`voice.start` unchanged.
In the file-recorder fallback, capture
and transcription have an independently cancellable input signal; ongoing agent
work and playback use the conversation signal and are preserved by mute.

Speech delivery splits provider output into at most 12,000-byte PCM writes and
awaits each WebSocket write callback. A long answer must not overflow the shared
socket's 1 MB guard and disconnect the client (1013), which also tears down its
audio graph. Writes have a 15-second deadline and respond to speech cancellation
even while blocked; muting recognition does not cancel speech delivery.

The internal stop-reply operation cancels current work/output while preserving
the enabled mode and rebuilding recognition without replacing the native graph.
Voice mode does not display a Stop reply button.
The dock has no assistant launcher. Settings activation takes two deliberate
steps. Manual exit (the main orb or the dedicated Exit control) requires an
unbroken 5-second hold, then vibrates and stops the whole conversation. Release,
backgrounding or unmount cancels the hold. The native long-press recognizer
separates holds from taps at 500 ms, so releasing a cancelled hold cannot mute
the microphone. The destructive exit still requires the full five seconds.
A short Exit tap or accessibility
escape only announces instructions; neither disables assistance. VoiceOver
users can double tap and hold, or ask the agent to leave and confirm by voice.

The first agent-requested exit only records an expiring request and asks a
natural explicit question; no phone action is created. Same-turn retries cannot
bypass confirmation. Consent must follow the immediately preceding completed
question turn (including a natural repetition), match the unchanged voice revision, be unexpired/unconsumed and
pass an independent semantic review of the latest answer. Refusals, ambiguity,
quoted words and unrelated approvals keep assistance active. Invalid or missing
review results fail closed. The original request remains the expiring consent
scope, but the reviewer receives the latest completed reply, never an older
question after the conversation changed topic. No keyword matching decides consent.

A confirmed exit applies/reports/persists the off state first, stops input,
and allows only the originating reply to finish before releasing the graph.
Late exit events after the reply ended release immediately. Manual controls
invalidate older voice actions. Multiple confirmed actions in one agent turn
can chain only while no newer manual choice has changed the voice revision.

Verification: frontend hook/native-boundary tests, backend voice-control tests,
and opt-in `npm run test:voice:live` (real Meta/PostgreSQL with simulated device
acknowledgements, no owner account data). Physical iPhone audio acceptance is
separate. These are JS/backend changes and do not require a new native build.

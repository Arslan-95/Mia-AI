# Spoken progress

In hands-free voice mode, Mia can briefly explain what she is doing while her
tools continue working. Wording comes from the coordinator model's public
assistant text alongside its tool calls. There are no per-tool phrase templates
and no extra model request solely to produce a status update.

The coordinator is instructed to introduce meaningful steps, stay silent during
repeated checks, ground success in confirmed results, and avoid repeating its
updates in the final reply. Specialist output remains internal. The runtime
accepts at most three distinct updates of up to 280 characters per turn and
suppresses them beside source narration and audio/voice controls.

Updates are persisted as `speak_progress` device actions. The tool loop does not
wait for their synthesis or playback. Speech requests use only the persisted,
owned action text; the client cannot provide replacement text. Requests are
single-use, expire, and require the current running turn. Audio still being
generated when the turn finishes is discarded. Only phone-confirmed complete
playback enters later conversation history.

The phone lets one short progress update finish, drops additional updates while
it is busy, and never builds a backlog. Opening a chat can proceed during that
speech. Source readings, original recordings and final replies take priority;
interruption, manual navigation and backgrounding cancel obsolete speech.
Failure of optional progress does not fail the task. Playback feedback includes
the speech request ID so the end of one segment cannot stop echo protection for
another segment in the same turn. Older clients can still report turn-only
playback feedback.

Apply database migrations, restart the backend, and reload the updated frontend
before trying this on a phone. This change adds no native module.

Validation:

```sh
npm run check
npm test
npm run test:progress:live
```

The live test uses the configured Meta model and Google TTS with isolated
fictional users and simulated phone acknowledgements. It verifies an unsent
draft and writes `.data/progress-narration-live.json` plus
`.data/progress-narration-sample.wav`. The WAV joins completed generated segments
with short gaps for listening; it does not reproduce the original timing or
prove playback on a physical phone.

# Device action execution and feedback

The agent interprets the user's utterance and selects tools. The backend and
phone validate ownership, request generation, navigation context and expiry,
execute the selected operation, and report its result. These checks do not
interpret user phrases or choose the next conversational action.

Navigation context equality compares route, navigation revision, previous route,
and reference chat/message/revision/excerpt values. It must not depend on JSON
property order: PostgreSQL JSONB can reorder the nested reference object.
Voice controls keep their separate voice-revision validation. Returning to the
same route never makes a revoked lease or an older request current again.

Device result fields `code`, `stage` and `presentationConfirmed` are optional for
compatibility with older clients. New clients report sanitized failure codes and
the failure stage: validation, execution, presentation, narration or confirmation.
The result also includes the current context/reference. Unknown native/provider
error details are not copied into the result.

For `show_message`, `presentationConfirmed=true` means the phone acknowledged
the card's presentation. If narration then fails, the overall action is failed
but the confirmed card can remain visible. A presentation timeout means the
appearance was unconfirmed, not that the card was proved absent. The agent
receives these facts and explains the outcome naturally; code does not write its
conversational reply or retry a failed command automatically.

Verification:

- `npm run test:postgres`: backend checks, including actual JSONB round-trip,
  duplicate request acceptance, the real frontend equality guard, account access
  and authenticated feedback persistence.
- Frontend `npm test`: real React hook/card lifecycle with substituted native
  audio and transport, retained cards across new requests, reordered context,
  same-card reuse, replacement, another chat and narration failure.
- `npm run test:presentation:live`: real model with fictional accounts in a
  disposable local schema and simulated device feedback. The two failure cases
  also receive a separate semantic assessment of the final explanation.

The fix changes JavaScript/backend code only. Reload the development client to
load the updated action validator; no new native iPhone build is required.

In agent mode, original voice-message playback presents its verified chat/source
in the same passive center card before starting audio, even if no earlier
`show_message` action was issued. A voice card shows a schematic voice waveform,
device-reported elapsed/total time and preparing/buffering/playing/stopped/
finished/failed state, instead of the message transcript. It has no buttons.
The ordinary playback footer is hidden throughout agent mode independently of
the conversation phase, so reconnecting cannot expose a stray Stop audio panel.
Input mute is separate from playback state. Stopping is not reported as pausing;
the existing original-recording transport does not yet support resumable pause.

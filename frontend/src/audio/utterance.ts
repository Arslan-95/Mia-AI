// Metering only locates an utterance boundary. Recognition still runs on the
// original recording, including its beginning; silence is never sent as a turn.
export class UtteranceDetector {
  private candidateAt: number | null = null;
  private lastVoiceAt = 0;
  private speech = false;
  constructor(private startedAt: number) {}

  update(now: number, decibels: number): 'continue' | 'speech' | 'silence' {
    if (decibels >= -42) {
      this.candidateAt ??= now;
      this.lastVoiceAt = now;
      if (now - this.candidateAt >= 100) this.speech = true;
    } else if (!this.speech) this.candidateAt = null;

    if (this.speech && (now - this.lastVoiceAt >= 1100 || now - this.startedAt >= 25000)) return 'speech';
    if (!this.speech && now - this.startedAt >= 8000) return 'silence';
    return 'continue';
  }
}

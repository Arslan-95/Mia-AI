import { CancelledError } from './errors';
import type { Recording } from './audio/types';

export type VoicePhase = 'off' | 'waiting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'paused' | 'error';
export function checkVoice(signal: AbortSignal) { if (signal.aborted) throw new CancelledError(); }
export function voiceDelay(ms: number, signal: AbortSignal) {
  checkVoice(signal);
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new CancelledError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export type VoiceRuntime = {
  ready(): boolean;
  phase(phase: VoicePhase): void;
  capture(signal: AbortSignal): Promise<Recording | null>;
  transcribe(recording: Recording, signal: AbortSignal): Promise<string>;
  discard(recording: Recording): Promise<void>;
  respond(text: string, signal: AbortSignal): Promise<void>;
};

// One conversation owns the microphone from capture through the end of the
// spoken reply. Restarts wait for cancellation and file cleanup to finish.
export class VoiceConversation {
  private controller?: AbortController;
  private settled = Promise.resolve();
  get stopped() { return this.controller?.signal.aborted ?? true; }

  start(runtime: VoiceRuntime) {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const { signal } = controller;
    const task = this.settled.then(async () => {
      while (!signal.aborted) {
        if (!runtime.ready()) {
          runtime.phase('paused');
          await voiceDelay(200, signal);
          continue;
        }
        runtime.phase('listening');
        const recording = await runtime.capture(signal);
        if (!recording) continue;
        let text: string;
        try {
          checkVoice(signal);
          runtime.phase('transcribing');
          text = await runtime.transcribe(recording, signal);
          checkVoice(signal);
        } finally { await runtime.discard(recording); }
        if (!text.trim()) continue;
        checkVoice(signal);
        runtime.phase('thinking');
        await runtime.respond(text, signal);
        // Let the speaker's acoustic tail finish before opening the microphone.
        await voiceDelay(450, signal);
      }
    });
    this.settled = task.catch(() => {});
    return task;
  }

  stop() { this.controller?.abort(); return this.settled; }
}

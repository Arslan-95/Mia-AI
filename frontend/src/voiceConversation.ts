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
  private inputMuted = false;
  private inputController?: AbortController;
  get stopped() { return this.controller?.signal.aborted ?? true; }

  start(runtime: VoiceRuntime) {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const { signal } = controller;
    const task = this.settled.then(async () => {
      while (!signal.aborted) {
        if (this.inputMuted || !runtime.ready()) {
          runtime.phase('paused');
          await voiceDelay(200, signal);
          continue;
        }
        const input = this.inputController = new AbortController();
        const cancelInput = () => input.abort();
        signal.addEventListener('abort', cancelInput, { once: true });
        if (signal.aborted) input.abort();
        const inputSignal = input.signal;
        let recording: Recording | null = null;
        let text: string;
        try {
          runtime.phase('listening');
          recording = await runtime.capture(inputSignal);
          if (!recording) continue;
          checkVoice(inputSignal);
          runtime.phase('transcribing');
          text = await runtime.transcribe(recording, inputSignal);
          checkVoice(inputSignal);
        } catch (error) {
          if (input.signal.aborted && !signal.aborted) continue;
          throw error;
        } finally {
          signal.removeEventListener('abort', cancelInput);
          if (this.inputController === input) this.inputController = undefined;
          if (recording) await runtime.discard(recording);
        }
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
  setInputMuted(muted: boolean) { this.inputMuted = muted; if (muted) this.inputController?.abort(); }
}

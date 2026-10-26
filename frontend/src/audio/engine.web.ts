import type { AudioEngine, Recording } from './types';
import { concatBytes, floatToPcm, pcmWav } from './wav';
import { AudioOwnership } from './ownership';
export class Engine implements AudioEngine {
  private context?: AudioContext; private stream?: MediaStream; private node?: AudioWorkletNode;
  private samples: Uint8Array[] = []; private started = 0; private player?: HTMLAudioElement;
  private rejectPlayback?: (error: Error) => void; private urls = new Set<string>(); private owner = new AudioOwnership();
  async start() {
    await this.owner.transition(async current => {
    await this.cleanup(); if (!current()) throw new Error('Recording was cancelled.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!current()) { stream.getTracks().forEach(track => track.stop()); throw new Error('Recording was cancelled.'); }
    this.stream = stream;
    try {
      const context = this.context = new AudioContext({ sampleRate: 24000 });
      const sourceCode = `class MiaRecorder extends AudioWorkletProcessor { process(inputs) { const channel = inputs[0]?.[0]; if(channel) this.port.postMessage(channel.slice()); return true; } } registerProcessor('mia-recorder', MiaRecorder);`;
      const url = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (!current()) throw new Error('Recording was cancelled.');
      this.samples = []; this.started = Date.now();
      const node = this.node = new AudioWorkletNode(context, 'mia-recorder');
      node.port.onmessage = event => { if (Date.now() - this.started < 119000) this.samples.push(floatToPcm(event.data)); };
      context.createMediaStreamSource(stream).connect(node);
      const mute = context.createGain(); mute.gain.value = 0; node.connect(mute).connect(context.destination);
      await context.resume();
    } catch (error) { await this.cleanup(); throw error; }
    });
  }
  async finish(): Promise<Recording> {
    let result: Recording | undefined;
    await this.owner.transition(async current => {
    if (!this.context) throw new Error('No recording is active.');
    const rate = this.context.sampleRate; const pcm = concatBytes(this.samples);
    await this.cleanup(); if (!current()) throw new Error('Recording was cancelled.');
    if (!pcm.length) throw new Error('The recording is empty. Try again.');
    const blob = new Blob([pcmWav(pcm, rate).buffer as ArrayBuffer], { type: 'audio/wav' });
    const uri = URL.createObjectURL(blob); this.urls.add(uri);
    result = { uri, blob, durationMs: Math.ceil(pcm.length / rate / 2 * 1000) };
    });
    return result!;
  }
  async stop() { await this.owner.transition(async () => this.cleanup()); }
  private async cleanup() {
    this.rejectPlayback?.(new Error('Playback stopped.')); this.rejectPlayback = undefined;
    if (this.player) { this.player.pause(); this.player.removeAttribute('src'); this.player.load(); this.player = undefined; }
    this.node?.disconnect(); this.node = undefined;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    const context = this.context; this.context = undefined;
    if (context && context.state !== 'closed') await context.close();
  }
  async play(uri: string, headers?: Record<string, string>, onStarted?: () => void) {
    let temporary: string | undefined; let completion: Promise<void> | undefined;
    await this.owner.transition(async current => {
    await this.cleanup(); if (!current()) throw new Error('Playback was cancelled.');
    if (headers) {
      const response = await fetch(uri, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('This recording could not be loaded.');
      const blob = await response.blob();
      if (!current()) throw new Error('Playback was cancelled.');
      uri = temporary = URL.createObjectURL(blob);
    }
      completion = new Promise<void>((resolve, reject) => {
        const player = this.player = new Audio(uri);
        this.rejectPlayback = reject;
        player.onended = () => { this.rejectPlayback = undefined; resolve(); };
        player.onerror = () => reject(new Error('This recording could not be played.'));
        void player.play().then(() => { if (current()) onStarted?.(); else reject(new Error('Playback was cancelled.')); }).catch(reject);
      });
    });
    try { await completion; } finally { if (temporary) URL.revokeObjectURL(temporary); }
  }
  async playPcm(bytes: Uint8Array) {
    const uri = URL.createObjectURL(new Blob([pcmWav(bytes).buffer as ArrayBuffer], { type: 'audio/wav' }));
    try { await this.play(uri); } finally { URL.revokeObjectURL(uri); }
  }
  async disposeRecording(recording: Recording) { URL.revokeObjectURL(recording.uri); this.urls.delete(recording.uri); }
}

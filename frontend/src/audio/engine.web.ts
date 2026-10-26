import type { AudioEngine, Recording } from './types';
import { concatBytes, floatToPcm, pcmWav } from './wav';
export class Engine implements AudioEngine {
  private context?: AudioContext; private stream?: MediaStream; private node?: AudioWorkletNode;
  private samples: Uint8Array[] = []; private started = 0; private player?: HTMLAudioElement;
  private rejectPlayback?: (error: Error) => void; private urls = new Set<string>();
  async start() {
    await this.stop();
    const stream = this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    try {
      const context = this.context = new AudioContext({ sampleRate: 24000 });
      const sourceCode = `class MiaRecorder extends AudioWorkletProcessor { process(inputs) { const channel = inputs[0]?.[0]; if(channel) this.port.postMessage(channel.slice()); return true; } } registerProcessor('mia-recorder', MiaRecorder);`;
      const url = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      this.samples = []; this.started = Date.now();
      const node = this.node = new AudioWorkletNode(context, 'mia-recorder');
      node.port.onmessage = event => { if (Date.now() - this.started < 119000) this.samples.push(floatToPcm(event.data)); };
      context.createMediaStreamSource(stream).connect(node);
      const mute = context.createGain(); mute.gain.value = 0; node.connect(mute).connect(context.destination);
      await context.resume();
    } catch (error) { await this.stop(); throw error; }
  }
  async finish(): Promise<Recording> {
    if (!this.context) throw new Error('No recording is active.');
    const rate = this.context.sampleRate; const pcm = concatBytes(this.samples);
    await this.stop();
    if (!pcm.length) throw new Error('The recording is empty. Try again.');
    const blob = new Blob([pcmWav(pcm, rate).buffer as ArrayBuffer], { type: 'audio/wav' });
    const uri = URL.createObjectURL(blob); this.urls.add(uri);
    return { uri, blob, durationMs: Math.ceil(pcm.length / rate / 2 * 1000) };
  }
  async stop() {
    this.rejectPlayback?.(new Error('Playback stopped.')); this.rejectPlayback = undefined;
    if (this.player) { this.player.pause(); this.player.removeAttribute('src'); this.player.load(); this.player = undefined; }
    this.node?.disconnect(); this.node = undefined;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    if (this.context) await this.context.close(); this.context = undefined;
  }
  async play(uri: string, headers?: Record<string, string>) {
    await this.stop(); let temporary: string | undefined;
    if (headers) {
      const response = await fetch(uri, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('This recording could not be loaded.');
      uri = temporary = URL.createObjectURL(await response.blob());
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const player = this.player = new Audio(uri);
        this.rejectPlayback = reject;
        player.onended = () => { this.rejectPlayback = undefined; resolve(); };
        player.onerror = () => reject(new Error('This recording could not be played.'));
        void player.play().catch(reject);
      });
    } finally { if (temporary) URL.revokeObjectURL(temporary); }
  }
  async playPcm(bytes: Uint8Array) {
    const uri = URL.createObjectURL(new Blob([pcmWav(bytes).buffer as ArrayBuffer], { type: 'audio/wav' }));
    try { await this.play(uri); } finally { URL.revokeObjectURL(uri); }
  }
  async disposeRecording(recording: Recording) { URL.revokeObjectURL(recording.uri); this.urls.delete(recording.uri); }
}

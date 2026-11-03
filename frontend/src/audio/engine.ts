import { AudioModule, AudioQuality, IOSOutputFormat, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type { AudioEngine, Recording, PlaybackProgress } from './types';
import { pcmWav, playbackPcm } from './wav';
import { AudioOwnership } from './ownership';
import { CancelledError, UserFacingError } from '../errors';
import { UtteranceDetector } from './utterance';
import { checkVoice, voiceDelay } from '../voiceConversation';
export class Engine implements AudioEngine {
  private recorder?: AudioRecorder; private player?: AudioPlayer; private startedAt = 0;
  private rejectPlayback?: (error: Error) => void; private owner = new AudioOwnership();
  private playbackPaused = false;
  private playbackLoad?: AbortController;
  async start(signal?: AbortSignal) {
    this.playbackLoad?.abort();
    await this.owner.transition(async current => {
    const valid = current;
    current = () => valid() && !signal?.aborted;
    await this.cleanup(); if (!current()) throw new CancelledError();
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new UserFacingError('Microphone access is off. Enable it in your iPhone settings to record.');
    if (!current()) throw new CancelledError();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (!current()) throw new CancelledError();
    const recorder = new AudioModule.AudioRecorder({ extension: '.wav', sampleRate: 24000, numberOfChannels: 1, bitRate: 384000, isMeteringEnabled: true, ios: { extension: '.wav', outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.MAX, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false } });
    this.recorder = recorder;
    try {
      await recorder.prepareToRecordAsync();
      if (!current()) throw new CancelledError();
      recorder.record({ forDuration: 119 }); this.startedAt = Date.now();
    } catch (error) { if (this.recorder === recorder) this.recorder = undefined; recorder.release(); throw error; }
    });
  }
  async captureCommand(signal: AbortSignal, onLevel?: (level: number) => void, onReady?: () => void): Promise<Recording | null> {
    checkVoice(signal);
    const cancel = () => { void this.stop(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.start();
      checkVoice(signal);
      const detector = new UtteranceDetector(Date.now());
      let ready = false;
      for (;;) {
        await voiceDelay(50, signal);
        const status = this.recorder?.getStatus();
        if (!status?.isRecording || status.mediaServicesDidReset) throw new UserFacingError('Listening was interrupted. Tap Mia to try again.');
        if (status.metering === undefined) throw new UserFacingError('Mia could not access the microphone level. Tap Mia to try again.');
        if (!ready) { ready = true; onReady?.(); }
        onLevel?.(Math.min(1, Math.pow(10, status.metering / 20) * 3));
        const result = detector.update(Date.now(), status.metering);
        if (result === 'speech') {
          const recording = await this.finish();
          if (signal.aborted) { await this.disposeRecording(recording); throw new CancelledError(); }
          return recording;
        }
        if (result === 'silence') { await this.stop(); return null; }
      }
    } catch (error) { await this.stop(); throw error; }
    finally { signal.removeEventListener('abort', cancel); }
  }
  async finish(): Promise<Recording> {
    let result: Recording | undefined;
    await this.owner.transition(async current => {
    const recorder = this.recorder; if (!recorder) throw new Error('No recording is active.');
    let durationMs = Math.min(119000, Date.now() - this.startedAt);
    let uri: string | null = null;
    try {
      const status = recorder.getStatus();
      if (status.durationMillis > 0) durationMs = Math.min(119000, status.durationMillis);
      await recorder.stop(); uri = recorder.uri;
    }
    finally { this.recorder = undefined; recorder.release(); await setAudioModeAsync({ allowsRecording: false }); }
    if (!uri) throw new UserFacingError('The recording could not be saved. Please try again.');
    if (!current()) { const file = new File(uri); if (file.exists) file.delete(); throw new CancelledError(); }
    result = { uri, durationMs };
    });
    return result!;
  }
  async stop() { this.playbackLoad?.abort(); await this.owner.transition(async () => this.cleanup()); }
  private async cleanup() {
    this.playbackPaused = false;
    this.rejectPlayback?.(new CancelledError()); this.rejectPlayback = undefined;
    if (this.player) { this.player.pause(); this.player.release(); this.player = undefined; }
    const recorder = this.recorder; this.recorder = undefined;
    if (recorder) { try { await recorder.stop(); } finally { const uri = recorder.uri; recorder.release(); if (uri) { const file = new File(uri); if (file.exists) file.delete(); } } }
    await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
  }
  async play(uri: string, headers?: Record<string, string>, onStarted?: () => void, onProgress?: (progress: PlaybackProgress) => void) {
    this.playbackLoad?.abort();
    const controller = this.playbackLoad = new AbortController();
    let cached: File | undefined;
    let completion: Promise<void> | undefined;
    try {
    await this.owner.transition(async current => {
    const valid = () => current() && !controller.signal.aborted;
    await this.cleanup(); if (!valid()) throw new CancelledError();
    // The authenticated media endpoint returns a complete WAV, not an AVPlayer
    // byte-range stream. Download it explicitly, then play the local file.
    if (/^https?:/i.test(uri)) {
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
      try {
        const response = await fetch(uri, { headers, signal: controller.signal });
        if (!valid()) throw new CancelledError();
        if (!response.ok || Number(response.headers.get('content-length')) > 12_000_000) throw new UserFacingError('The voice message could not be loaded. Please try again.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!valid()) throw new CancelledError();
        try { playbackPcm(bytes); } catch { throw new UserFacingError('The voice message could not be played. Please try again.'); }
        cached = new File(Paths.cache, `mia-playback-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
        cached.write(bytes); uri = cached.uri;
      } catch (error) {
        if (timedOut) throw new UserFacingError('Loading the voice message took too long. Please try again.');
        if (!valid()) throw new CancelledError();
        if (error instanceof UserFacingError) throw error;
        throw new UserFacingError('The voice message could not be loaded. Check your connection and try again.');
      } finally { clearTimeout(timeout); }
    }
    if (!valid()) throw new CancelledError();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (!valid()) throw new CancelledError();
    completion = new Promise<void>((resolve, reject) => {
      const player = this.player = createAudioPlayer({ uri }, { updateInterval: 100 });
      let settled = false;
      let listener: { remove(): void } | undefined;
      let timeout: ReturnType<typeof setInterval> | undefined;
      let stalledAt: number | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearInterval(timeout); listener?.remove();
        this.rejectPlayback = undefined;
        if (this.player === player) { this.player = undefined; player.release(); }
        if (error) reject(error); else resolve();
      };
      this.rejectPlayback = error => finish(error);
      let remaining = 125000, measuredAt = Date.now();
      timeout = setInterval(() => {
        const now = Date.now(); if (!this.playbackPaused) remaining -= now - measuredAt; measuredAt = now;
        if (this.playbackPaused) stalledAt = undefined;
        if (stalledAt !== undefined && now - stalledAt > 3000) finish(new UserFacingError('Playback was interrupted. Please try again.'));
        else if (!started && now - loadingAt > 15000) finish(new UserFacingError('The voice message could not start. Please try again.'));
        else if (remaining <= 0) finish(new UserFacingError('Playback did not finish. Please try again.'));
      }, 1000);
      let started = false; const loadingAt = Date.now();
      try {
      listener = player.addListener('playbackStatusUpdate', status => {
        if (settled) return;
        if (status.playbackState === 'failed' || status.mediaServicesDidReset) { finish(new UserFacingError('The voice message could not be played. Please try again.')); return; }
        if (Number.isFinite(status.currentTime)) onProgress?.({ positionMs: Math.max(0, status.currentTime * 1000),
          ...(Number.isFinite(status.duration) && status.duration > 0 ? { durationMs: status.duration * 1000 } : {}),
          playing: status.playing, buffering: status.isBuffering });
        if (status.playing && !started) { started = true; onStarted?.(); }
        if (started && !this.playbackPaused && !status.playing && !status.isBuffering && !status.didJustFinish) stalledAt ??= Date.now();
        else stalledAt = undefined;
        if (status.didJustFinish) finish();
      });
      if (settled) listener.remove(); else player.play();
      } catch { finish(new UserFacingError('The voice message could not be played. Please try again.')); }
    });
    void completion.catch(() => {});
    });
    await completion;
    } finally {
      if (this.playbackLoad === controller) this.playbackLoad = undefined;
      try { if (cached?.exists) cached.delete(); } catch { /* Cache cleanup cannot undo completed playback. */ }
    }
  }
  async pausePlayback() { if (this.player) { this.playbackPaused = true; this.player.pause(); } }
  resumePlayback() { if (this.player) { this.playbackPaused = false; this.player.play(); } }
  async playPcm(bytes: Uint8Array) {
    const file = new File(Paths.cache, `mia-speech-${Date.now()}.wav`); file.write(pcmWav(bytes));
    try { await this.play(file.uri); } finally { if (file.exists) file.delete(); }
  }
  async disposeRecording(recording: Recording) { const file = new File(recording.uri); if (file.exists) file.delete(); }
  async savePcm(pcm: Uint8Array): Promise<Recording> {
    const file = new File(Paths.cache, `mia-note-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    file.write(pcmWav(pcm));
    return { uri: file.uri, durationMs: Math.ceil(pcm.length / 48) };
  }
  async readPcm(uri: string, headers?: Record<string, string>, signal?: AbortSignal) {
    let bytes: Uint8Array;
    if (uri.startsWith('file:')) bytes = await new File(uri).bytes();
    else {
      const response = await fetch(uri, { headers, signal });
      if (!response.ok || Number(response.headers.get('content-length')) > 12_000_000) throw new UserFacingError('The voice recording could not be loaded.');
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (signal) checkVoice(signal);
    try { return playbackPcm(bytes); }
    catch { throw new UserFacingError('The voice recording could not be played.'); }
  }
}

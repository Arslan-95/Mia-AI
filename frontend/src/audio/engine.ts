import { AudioModule, AudioQuality, IOSOutputFormat, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type { AudioEngine, Recording, PlaybackProgress } from './types';
import { pcmWav } from './wav';
import { AudioOwnership } from './ownership';
import { CancelledError, UserFacingError } from '../errors';
import { UtteranceDetector } from './utterance';
import { checkVoice, voiceDelay } from '../voiceConversation';
export class Engine implements AudioEngine {
  private recorder?: AudioRecorder; private player?: AudioPlayer; private startedAt = 0;
  private rejectPlayback?: (error: Error) => void; private owner = new AudioOwnership();
  async start() {
    await this.owner.transition(async current => {
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
  async captureCommand(signal: AbortSignal, onLevel?: (level: number) => void): Promise<Recording | null> {
    checkVoice(signal);
    const cancel = () => { void this.stop(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.start();
      checkVoice(signal);
      const detector = new UtteranceDetector(Date.now());
      for (;;) {
        await voiceDelay(50, signal);
        const status = this.recorder?.getStatus();
        if (!status?.isRecording || status.mediaServicesDidReset) throw new UserFacingError('Listening was interrupted. Tap Mia to try again.');
        if (status.metering === undefined) throw new UserFacingError('Mia could not access the microphone level. Tap Mia to try again.');
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
    await recorder.stop(); const uri = recorder.uri; const durationMs = Math.min(119000, Date.now() - this.startedAt);
    this.recorder = undefined; recorder.release(); await setAudioModeAsync({ allowsRecording: false });
    if (!uri) throw new UserFacingError('The recording could not be saved. Please try again.');
    if (!current()) { const file = new File(uri); if (file.exists) file.delete(); throw new CancelledError(); }
    result = { uri, durationMs };
    });
    return result!;
  }
  async stop() { await this.owner.transition(async () => this.cleanup()); }
  private async cleanup() {
    this.rejectPlayback?.(new CancelledError()); this.rejectPlayback = undefined;
    if (this.player) { this.player.pause(); this.player.release(); this.player = undefined; }
    const recorder = this.recorder; this.recorder = undefined;
    if (recorder) { try { await recorder.stop(); } finally { const uri = recorder.uri; recorder.release(); if (uri) { const file = new File(uri); if (file.exists) file.delete(); } } }
    await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
  }
  async play(uri: string, headers?: Record<string, string>, onStarted?: () => void, onProgress?: (progress: PlaybackProgress) => void) {
    let completion: Promise<void> | undefined;
    await this.owner.transition(async current => {
    await this.cleanup(); if (!current()) throw new CancelledError();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (!current()) throw new CancelledError();
    completion = new Promise<void>((resolve, reject) => {
      const player = this.player = createAudioPlayer({ uri, headers }, { updateInterval: 100 });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); listener.remove();
        this.rejectPlayback = undefined;
        if (this.player === player) { this.player = undefined; player.release(); }
        if (error) reject(error); else resolve();
      };
      this.rejectPlayback = error => finish(error);
      const timeout = setTimeout(() => finish(new UserFacingError('Playback did not finish. Please try again.')), 125000);
      let started = false;
      const listener = player.addListener('playbackStatusUpdate', status => {
        if (settled) return;
        if (Number.isFinite(status.currentTime)) onProgress?.({ positionMs: Math.max(0, status.currentTime * 1000),
          ...(Number.isFinite(status.duration) && status.duration > 0 ? { durationMs: status.duration * 1000 } : {}),
          playing: status.playing, buffering: status.isBuffering });
        if (status.playing && !started) { started = true; onStarted?.(); }
        if (status.didJustFinish) finish();
        else if (!status.playing && status.isLoaded && status.currentTime > 0 && !status.isBuffering) finish(new UserFacingError('Playback was interrupted. Please try again.'));
      });
      player.play();
    });
    });
    await completion;
  }
  async playPcm(bytes: Uint8Array) {
    const file = new File(Paths.cache, `mia-speech-${Date.now()}.wav`); file.write(pcmWav(bytes));
    try { await this.play(file.uri); } finally { if (file.exists) file.delete(); }
  }
  async disposeRecording(recording: Recording) { const file = new File(recording.uri); if (file.exists) file.delete(); }
}

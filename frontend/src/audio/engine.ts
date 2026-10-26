import { AudioModule, AudioQuality, IOSOutputFormat, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type { AudioEngine, Recording } from './types';
import { pcmWav } from './wav';
import { AudioOwnership } from './ownership';
export class Engine implements AudioEngine {
  private recorder?: AudioRecorder; private player?: AudioPlayer; private startedAt = 0;
  private rejectPlayback?: (error: Error) => void; private owner = new AudioOwnership();
  async start() {
    await this.owner.transition(async current => {
    await this.cleanup(); if (!current()) throw new Error('Recording was cancelled.');
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error('Microphone access is off. Enable it in your device settings to record.');
    if (!current()) throw new Error('Recording was cancelled.');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (!current()) throw new Error('Recording was cancelled.');
    const recorder = new AudioModule.AudioRecorder({ extension: '.wav', sampleRate: 24000, numberOfChannels: 1, bitRate: 384000, ios: { extension: '.wav', outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.MAX, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false } });
    this.recorder = recorder;
    try {
      await recorder.prepareToRecordAsync();
      if (!current()) throw new Error('Recording was cancelled.');
      recorder.record({ forDuration: 119 }); this.startedAt = Date.now();
    } catch (error) { if (this.recorder === recorder) this.recorder = undefined; recorder.release(); throw error; }
    });
  }
  async finish(): Promise<Recording> {
    let result: Recording | undefined;
    await this.owner.transition(async current => {
    const recorder = this.recorder; if (!recorder) throw new Error('No recording is active.');
    await recorder.stop(); const uri = recorder.uri; const durationMs = Math.min(119000, Date.now() - this.startedAt);
    this.recorder = undefined; recorder.release(); await setAudioModeAsync({ allowsRecording: false });
    if (!uri) throw new Error('The recording could not be saved.');
    if (!current()) { const file = new File(uri); if (file.exists) file.delete(); throw new Error('Recording was cancelled.'); }
    result = { uri, durationMs };
    });
    return result!;
  }
  async stop() { await this.owner.transition(async () => this.cleanup()); }
  private async cleanup() {
    this.rejectPlayback?.(new Error('Playback stopped.')); this.rejectPlayback = undefined;
    if (this.player) { this.player.pause(); this.player.release(); this.player = undefined; }
    const recorder = this.recorder; this.recorder = undefined;
    if (recorder) { try { await recorder.stop(); } finally { const uri = recorder.uri; recorder.release(); if (uri) { const file = new File(uri); if (file.exists) file.delete(); } } }
    await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
  }
  async play(uri: string, headers?: Record<string, string>, onStarted?: () => void) {
    let completion: Promise<void> | undefined;
    await this.owner.transition(async current => {
    await this.cleanup(); if (!current()) throw new Error('Playback was cancelled.');
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (!current()) throw new Error('Playback was cancelled.');
    completion = new Promise<void>((resolve, reject) => {
      const player = this.player = createAudioPlayer({ uri, headers }, { updateInterval: 100 });
      this.rejectPlayback = reject;
      const timeout = setTimeout(() => reject(new Error('Playback did not finish. Please try again.')), 125000);
      let started = false;
      const listener = player.addListener('playbackStatusUpdate', status => {
        if (status.playing && !started) { started = true; onStarted?.(); }
        if (status.didJustFinish) { clearTimeout(timeout); listener.remove(); this.rejectPlayback = undefined; resolve(); }
        else if (!status.playing && status.isLoaded && status.currentTime > 0 && !status.isBuffering) { clearTimeout(timeout); listener.remove(); reject(new Error('Playback was interrupted.')); }
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

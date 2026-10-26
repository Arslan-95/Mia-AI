import { Platform } from 'react-native';
import { AudioModule, AudioQuality, IOSOutputFormat, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type { AudioEngine, Recording } from './types';
import { pcmWav } from './wav';
export class Engine implements AudioEngine {
  private recorder?: AudioRecorder; private player?: AudioPlayer;
  private rejectPlayback?: (error: Error) => void; private epoch = 0;
  async start() {
    if (Platform.OS !== 'ios') throw new Error('PCM recording currently requires iOS or the web preview. Android voice recording is not supported yet.');
    await this.stop(); const epoch = this.epoch;
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error('Microphone access is off. Enable it in your device settings to record.');
    if (epoch !== this.epoch) throw new Error('Recording was cancelled.');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (epoch !== this.epoch) throw new Error('Recording was cancelled.');
    const recorder = new AudioModule.AudioRecorder({ extension: '.wav', sampleRate: 24000, numberOfChannels: 1, bitRate: 384000, ios: { extension: '.wav', outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.MAX, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false }, android: { outputFormat: 'default', audioEncoder: 'default' }, web: {} });
    this.recorder = recorder;
    try {
      await recorder.prepareToRecordAsync();
      if (epoch !== this.epoch) { recorder.release(); throw new Error('Recording was cancelled.'); }
      recorder.record({ forDuration: 119 });
    } catch (error) { if (this.recorder === recorder) this.recorder = undefined; recorder.release(); throw error; }
  }
  async finish(): Promise<Recording> {
    const recorder = this.recorder; if (!recorder) throw new Error('No recording is active.');
    await recorder.stop(); const uri = recorder.uri; const durationMs = recorder.currentTime * 1000;
    this.recorder = undefined; recorder.release(); await setAudioModeAsync({ allowsRecording: false });
    if (!uri) throw new Error('The recording could not be saved.');
    return { uri, durationMs };
  }
  async stop() {
    this.epoch++;
    this.rejectPlayback?.(new Error('Playback stopped.')); this.rejectPlayback = undefined;
    if (this.player) { this.player.pause(); this.player.release(); this.player = undefined; }
    const recorder = this.recorder; this.recorder = undefined;
    if (recorder) { try { await recorder.stop(); } finally { const uri = recorder.uri; recorder.release(); if (uri) { const file = new File(uri); if (file.exists) file.delete(); } } }
    await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
  }
  async play(uri: string, headers?: Record<string, string>) {
    await this.stop(); const epoch = this.epoch;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: 'doNotMix' });
    if (epoch !== this.epoch) throw new Error('Playback was cancelled.');
    await new Promise<void>((resolve, reject) => {
      const player = this.player = createAudioPlayer({ uri, headers }, { updateInterval: 100 });
      this.rejectPlayback = reject;
      const timeout = setTimeout(() => reject(new Error('Playback did not finish. Please try again.')), 125000);
      const listener = player.addListener('playbackStatusUpdate', status => {
        if (status.didJustFinish) { clearTimeout(timeout); listener.remove(); this.rejectPlayback = undefined; resolve(); }
        else if (!status.playing && status.isLoaded && status.currentTime > 0 && !status.isBuffering) { clearTimeout(timeout); listener.remove(); reject(new Error('Playback was interrupted.')); }
      });
      player.play();
    });
  }
  async playPcm(bytes: Uint8Array) {
    const file = new File(Paths.cache, `mia-speech-${Date.now()}.wav`); file.write(pcmWav(bytes));
    try { await this.play(file.uri); } finally { if (file.exists) file.delete(); }
  }
  async disposeRecording(recording: Recording) { const file = new File(recording.uri); if (file.exists) file.delete(); }
}

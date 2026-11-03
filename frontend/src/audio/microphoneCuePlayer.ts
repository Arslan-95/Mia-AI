import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { microphoneCuePcm, type MicrophoneCueOutput } from './microphoneFeedback';
import { pcmWav } from './wav';

// A separate short player leaves the shared microphone graph and spoken reply
// untouched. Never change AVAudioSession's category or deactivate it here.
export class MicrophoneCuePlayer implements MicrophoneCueOutput {
  private player?: AudioPlayer;
  private listener?: { remove(): void };
  private timeout?: ReturnType<typeof setTimeout>;
  private reference?: string;
  private serial = 0;
  constructor(private beginReference: (pcm: Uint8Array, id: string) => void,
    private endReference: (id: string) => void) {}
  play(enabled: boolean) {
    this.stop();
    try {
      const pcm = microphoneCuePcm(enabled);
      const file = new File(Paths.cache, `mia-microphone-${enabled ? 'on' : 'off'}-v2.wav`);
      if (!file.exists) file.write(pcmWav(pcm));
      const player = this.player = createAudioPlayer({ uri: file.uri }, { updateInterval: 25, keepAudioSessionActive: true });
      const id = `microphone-cue-${++this.serial}`;
      this.listener = player.addListener('playbackStatusUpdate', status => {
        if (this.player !== player) return;
        if (status.playing && !this.reference) { this.reference = id; this.beginReference(pcm, id); }
        if (status.didJustFinish || status.playbackState === 'failed' || status.mediaServicesDidReset) this.stop();
      });
      // A feedback sound that failed to start promptly is no longer useful.
      this.timeout = setTimeout(() => this.stop(), 1500);
      player.play();
    } catch { this.stop(); }
  }
  stop() {
    clearTimeout(this.timeout); this.timeout = undefined;
    this.listener?.remove(); this.listener = undefined;
    const player = this.player; this.player = undefined;
    // release() stops this player without pausing/deactivating the mic session.
    try { player?.release(); } catch { /* An OS interruption may already release it. */ }
    if (this.reference) { this.endReference(this.reference); this.reference = undefined; }
  }
}

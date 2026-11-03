import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { pcmWav } from './wav';

// Short feedback uses its own player without changing the shared mic session.
export class LocalCuePlayer {
  private player?: AudioPlayer;
  private listener?: { remove(): void };
  private timeout?: ReturnType<typeof setTimeout>;
  private reference?: string;
  private serial = 0;
  constructor(private beginReference: (pcm: Uint8Array, id: string) => void,
    private endReference: (id: string) => void) {}
  play(pcm: Uint8Array, name: string) {
    this.stop();
    try {
      const file = new File(Paths.cache, `mia-${name}.wav`);
      if (!file.exists) file.write(pcmWav(pcm));
      const player = this.player = createAudioPlayer({ uri: file.uri }, { updateInterval: 25, keepAudioSessionActive: true });
      const id = `${name}-${++this.serial}`;
      this.listener = player.addListener('playbackStatusUpdate', status => {
        if (this.player !== player) return;
        if (status.playing && !this.reference) { this.reference = id; this.beginReference(pcm, id); }
        if (status.didJustFinish || status.playbackState === 'failed' || status.mediaServicesDidReset) this.stop();
      });
      this.timeout = setTimeout(() => this.stop(), 1500);
      player.play();
    } catch { this.stop(); }
  }
  stop() {
    clearTimeout(this.timeout); this.timeout = undefined;
    this.listener?.remove(); this.listener = undefined;
    const player = this.player; this.player = undefined;
    try { player?.release(); } catch { /* The OS may already have released it. */ }
    if (this.reference) { this.endReference(this.reference); this.reference = undefined; }
  }
}

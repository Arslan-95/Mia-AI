import { LocalCuePlayer } from './localCuePlayer';
import { microphoneCuePcm, type MicrophoneCueOutput } from './microphoneFeedback';

// A separate short player leaves the shared microphone graph and spoken reply
// untouched. Never change AVAudioSession's category or deactivate it here.
export class MicrophoneCuePlayer implements MicrophoneCueOutput {
  private player: LocalCuePlayer;
  constructor(beginReference: (pcm: Uint8Array, id: string) => void,
    endReference: (id: string) => void) { this.player = new LocalCuePlayer(beginReference, endReference); }
  play(enabled: boolean) {
    this.player.play(microphoneCuePcm(enabled), `microphone-${enabled ? 'on' : 'off'}-v2`);
  }
  stop() { this.player.stop(); }
}

import MiaVoice from '../../modules/mia-voice';
import { CancelledError, UserFacingError, VoiceCaptureUnavailable } from '../errors';
import { ResidualEchoGuard } from './echo';

export class DuplexAudio {
  readonly available = Boolean(MiaVoice && MiaVoice.apiVersion >= 3);
  active = false;
  hasInput = false;
  ownsSession = false;
  private revision = 0;
  private stopBarrier: Promise<void> = Promise.resolve();
  private subscriptions: { remove(): void }[] = [];
  private inputWatchdog?: ReturnType<typeof setTimeout>;
  private echo = new ResidualEchoGuard();
  constructor(private prepareSession: () => Promise<void> = async () => {}) {}
  async start(onPCM: (bytes: Uint8Array) => void, onInterrupted: () => void, onFailure: (error: unknown) => void) {
    if (!MiaVoice || !this.available) throw new UserFacingError('Update Mia to use voice interruption.');
    const previousStop = this.ownsSession ? this.stop() : this.stopBarrier;
    const revision = ++this.revision;
    this.ownsSession = true;
    this.active = false;
    this.hasInput = false;
    this.removeListeners();
    let lastInput = 0;
    this.subscriptions = [
      MiaVoice.addListener('pcm', ({ audio }) => {
        if (this.active && revision === this.revision && audio.length) {
          lastInput = Date.now(); this.hasInput = true;
          const bytes = Uint8Array.from(atob(audio), char => char.charCodeAt(0));
          for (const part of this.echo.process(bytes)) onPCM(part);
        }
      }),
      MiaVoice.addListener('interrupted', () => { if (revision === this.revision) onInterrupted(); }),
      MiaVoice.addListener('failure', () => { if (revision === this.revision) onFailure(new UserFacingError('Mia could not hear you. Try turning voice mode off and on again.')); }),
    ];
    let previousGraphStopped = false;
    try {
      await previousStop;
      previousGraphStopped = true;
      if (revision !== this.revision) throw new CancelledError();
      // Finish queued Expo operations before the native engine touches the
      // shared AVAudioSession. Ownership is reserved throughout this handoff.
      await this.prepareSession();
      if (revision !== this.revision) throw new CancelledError();
      await MiaVoice.start();
      if (revision !== this.revision) throw new CancelledError();
      this.active = true;
      // Count delivered buffers, including silence. Start this deadline only
      // after native startup, so reading the permission dialog has no timeout.
      lastInput = Date.now();
      const checkInput = () => {
        if (revision !== this.revision || !this.active) return;
        const remaining = 8000 - (Date.now() - lastInput);
        if (remaining > 0) this.inputWatchdog = setTimeout(checkInput, remaining);
        else {
          this.inputWatchdog = undefined;
          onFailure(new VoiceCaptureUnavailable('Mia lost microphone input. Reconnecting…'));
        }
      };
      this.inputWatchdog = setTimeout(checkInput, 8000);
    } catch (error) {
      if (revision !== this.revision) throw new CancelledError();
      if (previousGraphStopped) this.ownsSession = false;
      this.removeListeners();
      // Only a matching JS stop makes cancellation intentional. An iOS
      // lifecycle cancellation can arrive before AppState, so let the owner
      // recover rather than silently remaining in Connecting forever.
      if ((error as { code?: string }).code === 'CANCELLED') throw new VoiceCaptureUnavailable('Mia’s microphone was interrupted. Reconnecting…');
      if ((error as { code?: string }).code === 'MICROPHONE_DENIED') throw new UserFacingError('Microphone access is off. Enable it in your iPhone settings to talk to Mia.');
      throw new UserFacingError('Mia could not start listening. Try turning voice mode off and on again.');
    }
  }
  async playPcm(bytes: Uint8Array, requestId: string) {
    if (!MiaVoice || !this.active) throw new CancelledError();
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    this.echo.begin(bytes, requestId);
    try { await MiaVoice.play(btoa(binary), requestId); }
    catch (error) {
      if ((error as { code?: string }).code === 'CANCELLED') throw new CancelledError();
      throw new UserFacingError('Mia could not play that response. Please try again.');
    }
    finally { this.echo.end(requestId); }
  }
  async stopPlayback() { if (MiaVoice) await MiaVoice.stopPlayback(); }
  async stop() {
    const revision = ++this.revision; this.active = false; this.hasInput = false; this.removeListeners(); this.echo.reset();
    const stopped = MiaVoice ? MiaVoice.stop() : Promise.resolve();
    this.stopBarrier = stopped;
    await stopped;
    if (this.revision === revision) this.ownsSession = false;
  }
  private removeListeners() {
    clearTimeout(this.inputWatchdog); this.inputWatchdog = undefined;
    this.subscriptions.forEach(subscription => subscription.remove()); this.subscriptions = [];
  }
}

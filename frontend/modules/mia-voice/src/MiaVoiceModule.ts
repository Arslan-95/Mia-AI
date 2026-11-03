import { NativeModule, requireOptionalNativeModule } from 'expo';
type Events = {
  pcm: (event: { audio: string }) => void;
  interrupted: (event: { code: string }) => void;
  failure: (event: { code: string }) => void;
};
declare class MiaVoiceModule extends NativeModule<Events> {
  apiVersion: number;
  diagnostics(): Promise<{ apiVersion: number; events: Record<string, unknown>[] }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  stopPlayback(): Promise<void>;
  play(audio: string, requestId: string): Promise<void>;
}
export default requireOptionalNativeModule<MiaVoiceModule>('MiaVoice');

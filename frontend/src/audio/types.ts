export type Recording = { uri: string; durationMs: number };
export interface AudioEngine {
  start(): Promise<void>;
  finish(): Promise<Recording>;
  stop(): Promise<void>;
  play(uri: string, headers?: Record<string, string>, onStarted?: () => void): Promise<void>;
  playPcm(bytes: Uint8Array): Promise<void>;
  disposeRecording(recording: Recording): Promise<void>;
}

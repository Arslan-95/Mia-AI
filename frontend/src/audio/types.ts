export type Recording = { uri: string; durationMs: number };
export type PlaybackProgress = { positionMs: number; durationMs?: number; playing: boolean; buffering: boolean };
export interface AudioEngine {
  start(signal?: AbortSignal): Promise<void>;
  finish(): Promise<Recording>;
  stop(): Promise<void>;
  play(uri: string, headers?: Record<string, string>, onStarted?: () => void, onProgress?: (progress: PlaybackProgress) => void): Promise<void>;
  playPcm(bytes: Uint8Array): Promise<void>;
  disposeRecording(recording: Recording): Promise<void>;
}

export type RecordingGesture = { active: boolean; cancelReady: boolean };
export type VoiceNoteStage = 'idle' | 'starting' | 'recording' | 'saving' | 'sending' | 'sent' | 'discarded' | 'failed';

// The gesture threshold and the visible outer circle share the same radius.
export function recordingGeometry(height: number, fontScale: number) {
  const compact = height < 670 || fontScale > 1.4;
  return { diameter: compact ? 62 : 74, radius: compact ? 66 : 78 };
}

export function recordingCancelProgress(dx: number, dy: number, radius: number) {
  return Math.min(1, Math.hypot(dx, dy) / radius);
}

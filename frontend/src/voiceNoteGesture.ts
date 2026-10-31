export type RecordingGesture = { active: boolean; cancelReady: boolean };
export type VoiceNoteStage = 'idle' | 'starting' | 'recording' | 'saving' | 'sending' | 'sent' | 'discarded' | 'failed';

// The gesture threshold and the visible outer circle share the same radius.
export function recordingGeometry(height: number, fontScale: number) {
  const compact = height < 670 || fontScale > 1.4;
  return { diameter: compact ? 62 : 74, radius: compact ? 66 : 78 };
}

// Both the viewport overlay and its page clearance use the same dock geometry.
export function agentDockGeometry(height: number, fontScale: number, bottomInset: number, active: boolean, showTimer: boolean) {
  const { diameter, radius } = recordingGeometry(height, fontScale);
  const centreY = diameter / 2 - 10;
  const headroom = active ? radius - centreY + 8 : 12;
  const bodyHeight = diameter - 10 + Math.max(bottomInset, 10) + (showTimer ? 24 : 0);
  return { diameter, radius, centreY, headroom, bodyHeight, totalHeight: headroom + bodyHeight };
}

export function recordingCancelProgress(dx: number, dy: number, radius: number) {
  return Math.min(1, Math.hypot(dx, dy) / radius);
}

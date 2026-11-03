import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Message, OriginalPlayback } from '../../../shared/types';
import { Icon, useUi } from '../../../shared/ui/ui';

export const audioTime = (ms?: number | null) => ms == null || !Number.isFinite(ms) ? '—:—' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function VoiceNoteBubble({ message, playback, onToggle, passive = false }: {
  message: Message; playback: OriginalPlayback | null; onToggle(): void; passive?: boolean;
}) {
  const { colors } = useUi();
  const current = playback?.mediaId === message.mediaId ? playback : null;
  const playing = current?.state === 'playing', loading = current?.state === 'preparing' || current?.state === 'buffering';
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  useEffect(() => {
    setWaitingFor(null);
    if (!loading || !current) return;
    const timer = setTimeout(() => setWaitingFor(current.operationId), 180);
    return () => clearTimeout(timer);
  }, [loading, current?.operationId]);
  // Local audio preparation takes a few frames; avoid flashing a download
  // spinner unless the user is actually waiting for a file or buffering.
  const showLoading = loading && waitingFor === current?.operationId;
  const duration = current?.durationMs ?? message.durationMs;
  const position = current?.positionMs ?? 0;
  const progress = duration ? Math.min(1, position / duration) : 0;
  const label = loading ? showLoading ? 'Loading voice message' : 'Starting voice message' : playing ? 'Pause voice message' : current?.state === 'paused' ? 'Resume voice message' : 'Play voice message';
  return <View testID="voice-note-bubble" style={styles.row}>
    <Pressable testID={`voice-toggle-${message.id}`} accessibilityRole="button" accessibilityLabel={label}
      disabled={passive || loading} onPress={onToggle} style={({ pressed }) => [styles.control, { backgroundColor: colors.accentLight, opacity: pressed ? .7 : 1 }]}>
      {showLoading ? <ActivityIndicator size="small" color={colors.background} /> : <Icon name={playing || current?.state === 'buffering' ? 'pause' : 'play'} size={21} color={colors.background} />}
    </Pressable>
    <View style={styles.trackArea}><View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: duration ?? 1, now: position }} style={[styles.track, { backgroundColor: colors.line }]}>
      <View style={[styles.fill, { backgroundColor: colors.accentLight, width: `${progress * 100}%` }]} />
    </View><View style={styles.metadata}><Text style={[styles.time, { color: colors.ink }]}>{audioTime(current && !['finished', 'stopped', 'failed'].includes(current.state) ? position : duration)}</Text>
      <Text style={[styles.label, { color: colors.muted }]}>{showLoading ? 'Loading…' : current?.state === 'paused' ? 'Paused' : playing ? 'Playing' : current?.state === 'failed' ? 'Tap to retry' : 'Voice message'}</Text>
    </View></View>
  </View>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 180, width: 230, maxWidth: '100%', paddingVertical: 2 },
  control: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  trackArea: { flex: 1, gap: 9, minWidth: 50 }, track: { height: 3, borderRadius: 2, overflow: 'hidden' }, fill: { height: '100%', borderRadius: 2 },
  metadata: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }, time: { fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] }, label: { fontSize: 11, lineHeight: 17 },
});

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { OriginalPlayback } from '../types';
import { Icon } from '../ui';

const passive = { pointerEvents: 'none' as const, accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
const labels = { preparing: 'Preparing', buffering: 'Buffering', playing: 'Playing', paused: 'Paused', finished: 'Finished', stopped: 'Stopped', failed: "Couldn't play" };
const time = (ms?: number) => ms === undefined || !Number.isFinite(ms) ? '—:—' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function VoiceMessageContent({ playback, reduced }: { playback: OriginalPlayback | null; reduced: boolean }) {
  const active = playback?.state === 'playing';
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    pulse.setValue(1);
    if (!active || reduced) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: .45, duration: 1000, useNativeDriver: true, isInteraction: false }),
      Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true, isInteraction: false }),
    ]));
    animation.start(); return () => { animation.stop(); pulse.setValue(1); };
  }, [active, reduced]);
  const duration = playback?.durationMs, position = Math.max(0, playback?.positionMs ?? 0);
  const progress = duration ? Math.min(1, position / duration) : 0;
  return <View {...passive} testID="voice-message-content" style={styles.content}>
    <View {...passive} style={styles.heading}><Text {...passive} style={styles.title}>Voice message</Text>
      <View {...passive} style={styles.badge}><Animated.View {...passive} style={[styles.dot, { opacity: active ? pulse : .65 }]} />
        <Text {...passive} testID="voice-message-status" style={styles.status}>{playback ? labels[playback.state] : 'Ready'}</Text></View>
    </View>
    <View {...passive} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}><View testID="reference-playback-icon" {...passive} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#443059' }}><Icon name={active ? 'pause' : 'play'} size={24} color="#EBD9FF" /></View>
    <View {...passive} testID="voice-message-progress" style={styles.track}><View {...passive} style={[styles.fill, { width: `${progress * 100}%` }]} /></View>
    </View>
    <View {...passive} style={styles.times}><Text {...passive} testID="voice-message-position" style={styles.elapsed}>{time(position)}</Text>
      <Text {...passive} testID="voice-message-duration" style={styles.duration}>{time(duration)}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  content: { gap: 20, paddingVertical: 8 }, heading: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  title: { fontSize: 19, lineHeight: 27, color: '#F5F1FA', fontWeight: '500', flexShrink: 1 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#CDA9FF' },
  status: { color: '#D6C9E3', fontSize: 12, lineHeight: 18 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: '#655675', overflow: 'hidden' }, fill: { height: '100%', borderRadius: 2, backgroundColor: '#D4B4FF' },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  elapsed: { fontSize: 14, lineHeight: 20, color: '#F5F1FA', fontVariant: ['tabular-nums'] },
  duration: { fontSize: 14, lineHeight: 20, color: '#B4A5C4', fontVariant: ['tabular-nums'] },
});

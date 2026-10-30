import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { MessageReference, OriginalPlayback } from '../types';
import { useReducedMotion } from '../motion';
import { referenceDate, referenceDirection, referenceKey, sourceExcerpt } from '../messageReference';

const passive = { pointerEvents: 'none' as const, accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
const backdropOpacity = .68;
/** Passive sibling under the sole AgentInteraction touch and accessibility target. */
export function MessageReferenceCard({ source, userId, playback, dismissalRevision, onPresented }: {
  source: MessageReference | null; userId: string; playback: OriginalPlayback | null;
  dismissalRevision?: number; onPresented(revision: number, success?: boolean, focus?: { start: number; end: number }): void;
}) {
  const reduced = useReducedMotion();
  const { fontScale } = useWindowDimensions();
  const [region, setRegion] = useState({ width: 0, height: 0 });
  const [rendered, setRendered] = useState<MessageReference | null>(null);
  const [budget, setBudget] = useState(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(12)).current;
  const scale = useRef(new Animated.Value(.98)).current;
  const token = useRef(0);
  const visibleKey = useRef<string | null>(null);
  const entered = useRef(false);
  const fitted = useRef(false);
  const actualFocus = useRef<{ start: number; end: number } | undefined>(undefined);
  const callback = useRef(onPresented); callback.current = onPresented;
  const width = Math.min(420, region.width - (region.width <= 320 ? 24 : 32));
  const available = region.height - 24;
  const padding = region.width <= 320 ? 16 : 20;
  useEffect(() => {
    const operation = ++token.current;
    opacity.stopAnimation(); scrim.stopAnimation(); y.stopAnimation(); scale.stopAnimation();
    const animate = (value: Animated.Value, toValue: number, ms: number, complete?: () => void) => {
      Animated.timing(value, { toValue, duration: reduced ? Math.min(80, ms) : ms, useNativeDriver: true }).start(({ finished }) => {
        if (finished && operation === token.current) complete?.();
      });
    };
    if (!source) {
      animate(y, reduced ? 0 : 6, 180); animate(opacity, 0, 180);
      animate(scrim, 0, 220, () => { setRendered(null); visibleKey.current = null; if (dismissalRevision !== undefined) callback.current(dismissalRevision); });
      return () => { token.current++; };
    }
    if (!region.height || width <= 0) return;
    const key = referenceKey(source);
    if (visibleKey.current === key) {
      setRendered(source);
      if (available < 130 * fontScale) { callback.current(source.revision, false); return; }
      const fittingBudget = Math.max(0, Math.floor(((available - (source.source.kind === 'voice' ? 210 : 155) * fontScale) / (25 * fontScale)) * ((width - padding * 2) / (10 * fontScale))));
      if (fittingBudget < budget) { fitted.current = false; setBudget(fittingBudget); }
      if (!entered.current) {
        animate(scrim, backdropOpacity, 80); animate(y, 0, 80); animate(scale, 1, 80);
        animate(opacity, 1, 80, () => { entered.current = true; if (fitted.current) callback.current(source.revision, true, actualFocus.current); });
      } else if (fitted.current) callback.current(source.revision, true, actualFocus.current);
      return;
    }
    const swap = () => {
      setBudget(Math.max(0, Math.floor(((available - (source.source.kind === 'voice' ? 210 : 155) * fontScale) / (25 * fontScale)) * ((width - padding * 2) / (10 * fontScale)))));
      setRendered(source); visibleKey.current = key;
      entered.current = false; fitted.current = false;
      opacity.setValue(0); y.setValue(reduced ? 0 : 12); scale.setValue(reduced ? 1 : .98);
      animate(y, 0, rendered ? 220 : 260); animate(scale, 1, rendered ? 220 : 260);
      animate(opacity, 1, rendered ? 220 : 260, () => {
        entered.current = true;
        if (fitted.current) callback.current(source.revision, true, actualFocus.current);
        else if (available < 130 * fontScale) callback.current(source.revision, false);
      });
    };
    animate(scrim, backdropOpacity, 220);
    if (rendered && !reduced) { animate(y, -6, 120); animate(opacity, 0, 120, swap); } else swap();
    return () => { token.current++; opacity.stopAnimation(); scrim.stopAnimation(); y.stopAnimation(); scale.stopAnimation(); };
  }, [source, dismissalRevision, region.width, region.height, fontScale, reduced]);
  const excerpt = rendered ? sourceExcerpt(rendered.source.text ?? '', rendered.focus, budget) : null;
  const sent = rendered?.source.senderId === userId;
  const associated = rendered?.source.mediaId && playback?.mediaId === rendered.source.mediaId ? playback.state : null;
  const status = associated ? { preparing: 'Preparing audio…', playing: 'Playing original', finished: 'Finished', stopped: 'Stopped', failed: "Couldn't play audio" }[associated] : 'Original audio';
  return <View {...passive} testID="message-reference-region" style={styles.region} onLayout={event => {
    const { width, height } = event.nativeEvent.layout;
    setRegion(previous => previous.width === width && previous.height === height ? previous : { width, height });
  }}>
    <Animated.View {...passive} testID="message-reference-scrim" style={[styles.scrim, { opacity: scrim }]} />
    {rendered && excerpt && <Animated.View key={`${referenceKey(rendered)}/${budget}`} {...passive} testID="message-reference-card" onLayout={event => {
      if (event.nativeEvent.layout.height > available && budget > 0) { fitted.current = false; setBudget(value => Math.max(0, Math.floor(value * .7))); }
      else if (event.nativeEvent.layout.height > available || (rendered.source.text && !excerpt.text)) callback.current(rendered.revision, false);
      else {
        fitted.current = true; actualFocus.current = excerpt.partial ? { start: excerpt.start, end: excerpt.end } : undefined;
        if (entered.current) callback.current(rendered.revision, true, actualFocus.current);
      }
    }} style={[styles.card, { width, paddingHorizontal: padding, backgroundColor: sent ? '#2A1E40' : '#172A35', borderColor: sent ? '#725395' : '#3E6175', opacity, transform: [{ translateY: y }, { scale }] }]}>
      <View {...passive} style={styles.metadata}><Text {...passive} style={[styles.direction, { color: sent ? '#D8C4F4' : '#B7DAE9' }]}>{referenceDirection(rendered, userId)}</Text></View>
      {rendered.source.kind === 'voice' && <View {...passive} style={styles.metadata}><Text {...passive} style={styles.voice}>◉  Voice message</Text><Text {...passive} style={styles.date}>{status}</Text>{!!rendered.source.text && <Text {...passive} style={styles.date}>Transcript</Text>}</View>}
      {!!rendered.source.text && <View {...passive}>{excerpt.partial && <Text {...passive} style={styles.partial}>Excerpt · {excerpt.end - excerpt.start} of {excerpt.total} characters</Text>}{excerpt.start > 0 && <Text {...passive} style={styles.date}>…</Text>}<Text {...passive} style={styles.body}>{excerpt.text}</Text>{excerpt.end < excerpt.total && <Text {...passive} style={styles.date}>…</Text>}{excerpt.partial && <Text {...passive} style={styles.hint}>Ask Mia for another part</Text>}</View>}
      <Text {...passive} style={styles.date}>{referenceDate(rendered.source.createdAt)}</Text>
    </Animated.View>}
  </View>;
}
const styles = StyleSheet.create({
  region: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center' },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000000' },
  card: { borderRadius: 24, borderWidth: 1, paddingVertical: 18, gap: 12, shadowColor: '#000000', shadowOpacity: .22, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  metadata: { gap: 3 }, direction: { fontSize: 13, lineHeight: 19, fontWeight: '600' }, date: { fontSize: 12, lineHeight: 18, color: '#C9C0D2' },
  voice: { fontSize: 17, lineHeight: 25, color: '#F5F1FA' }, body: { fontSize: 17, lineHeight: 25, color: '#F5F1FA', fontWeight: '400' },
  partial: { fontSize: 12, lineHeight: 18, color: '#C9C0D2', marginBottom: 6 }, hint: { fontSize: 12, lineHeight: 18, color: '#C9C0D2', marginTop: 8 },
});

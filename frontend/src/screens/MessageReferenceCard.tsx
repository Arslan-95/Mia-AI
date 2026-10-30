import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { MessageReference, OriginalPlayback } from '../types';
import { useReducedMotion } from '../motion';
import { referenceDate, referenceDirection, referenceKey, sourceExcerpt } from '../messageReference';
import { ShutterCard, type ShutterPhase } from './ShutterCard';

const passive = { pointerEvents: 'none' as const, accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
const backdropOpacity = .68;
type Display = { reference: MessageReference; budget: number; phase: ShutterPhase; serial: number };
type Fit = { serial: number; budget: number; focus?: { start: number; end: number } };
const sameSource = (a: MessageReference | null, b: MessageReference | null) => referenceKey(a) === referenceKey(b) && a?.source.text === b?.source.text;

/** Passive sibling under the sole AgentInteraction touch and accessibility target. */
export function MessageReferenceCard({ source, userId, playback, dismissalRevision, onPresented }: {
  source: MessageReference | null; userId: string; playback: OriginalPlayback | null;
  dismissalRevision?: number; onPresented(revision: number, success?: boolean, focus?: { start: number; end: number }): void;
}) {
  const reduced = useReducedMotion();
  const { fontScale } = useWindowDimensions();
  const [region, setRegion] = useState({ width: 0, height: 0 });
  const [display, setDisplay] = useState<Display | null>(null);
  const current = useRef<Display | null>(null);
  const fitted = useRef<Fit | null>(null);
  const serial = useRef(0);
  const scrim = useRef(new Animated.Value(0)).current;
  const backdrop = useRef<Animated.CompositeAnimation | null>(null);
  const backdropToken = useRef(0);
  const width = Math.max(0, Math.min(420, region.width - (region.width <= 320 ? 24 : 32)));
  const available = region.height - 24;
  const padding = region.width <= 320 ? 16 : 20;
  const latest = useRef({ source, dismissalRevision, onPresented, width, available, padding, fontScale, reduced });
  latest.current = { source, dismissalRevision, onPresented, width, available, padding, fontScale, reduced };

  function commit(next: Display | null) { current.current = next; setDisplay(next); }
  function fadeBackdrop(toValue: number, duration: number, done?: () => void) {
    const operation = ++backdropToken.current;
    backdrop.current?.stop();
    backdrop.current = Animated.timing(scrim, { toValue, duration: latest.current.reduced ? 80 : duration, useNativeDriver: true, isInteraction: false });
    backdrop.current.start(({ finished }) => { if (finished && operation === backdropToken.current) done?.(); });
  }
  function notifyIfReady() {
    const view = current.current, fit = fitted.current, request = latest.current;
    if (view?.phase === 'shown' && fit?.serial === view.serial && fit.budget === view.budget && sameSource(request.source, view.reference)) {
      request.onPresented(view.reference.revision, true, fit.focus);
    }
  }
  function fittingBudget(value: MessageReference) {
    const { available, fontScale, width, padding } = latest.current;
    return Math.max(0, Math.floor(((available - (value.source.kind === 'voice' ? 210 : 155) * fontScale) / (25 * fontScale)) * ((width - padding * 2) / (10 * fontScale))));
  }
  function dismiss() {
    const revision = latest.current.dismissalRevision;
    fadeBackdrop(0, 220, () => {
      const request = latest.current;
      if (!request.source && !current.current && revision !== undefined && request.dismissalRevision === revision) request.onPresented(revision);
    });
  }
  function present() {
    const request = latest.current;
    if (!request.source || request.width <= 0) return;
    if (request.available < 130 * request.fontScale) { request.onPresented(request.source.revision, false); return; }
    fitted.current = null;
    commit({ reference: request.source, budget: fittingBudget(request.source), phase: 'enter', serial: ++serial.current });
    fadeBackdrop(backdropOpacity, 260);
  }
  useEffect(() => {
    const view = current.current;
    if (!source) {
      if (view) { if (view.phase !== 'exit') commit({ ...view, phase: 'exit' }); }
      else dismiss();
      return;
    }
    if (!region.height || width <= 0) return;
    if (available < 130 * fontScale) { onPresented(source.revision, false); return; }
    // Keep the outgoing snapshot intact, even if several newer requests arrive.
    if (view?.phase === 'exit') return;
    if (!view) { present(); return; }
    if (!sameSource(view.reference, source)) { commit({ ...view, phase: 'exit' }); return; }
    const budget = Math.min(view.budget, fittingBudget(source));
    if (budget !== view.budget) fitted.current = null;
    if (view.reference !== source || view.budget !== budget) commit({ ...view, reference: source, budget });
    notifyIfReady();
  }, [source, dismissalRevision, region.width, region.height, fontScale]);
  useEffect(() => () => { backdropToken.current++; backdrop.current?.stop(); current.current = null; }, []);

  const rendered = display?.reference;
  const excerpt = rendered && display ? sourceExcerpt(rendered.source.text ?? '', rendered.focus, display.budget) : null;
  const sent = rendered?.source.senderId === userId;
  const associated = rendered?.source.mediaId && playback?.mediaId === rendered.source.mediaId ? playback.state : null;
  const status = associated ? { preparing: 'Preparing audio…', playing: 'Playing original', finished: 'Finished', stopped: 'Stopped', failed: "Couldn't play audio" }[associated] : 'Original audio';
  return <View {...passive} testID="message-reference-region" style={styles.region} onLayout={event => {
    const { width, height } = event.nativeEvent.layout;
    setRegion(previous => previous.width === width && previous.height === height ? previous : { width, height });
  }}>
    <Animated.View {...passive} testID="message-reference-scrim" style={[styles.scrim, { opacity: scrim }]} />
    {display && rendered && excerpt && <ShutterCard key={`${display.serial}/${display.budget}`} width={width} phase={display.phase} reduced={reduced}
      style={[styles.card, { paddingHorizontal: padding, backgroundColor: sent ? '#2A1E40' : '#211D2B' }]}
      onLayout={event => {
        const view = current.current;
        if (!view || view.serial !== display.serial || view.budget !== display.budget || view.phase === 'exit') return;
        const available = latest.current.available;
        if (event.nativeEvent.layout.height > available && view.budget > 0) {
          fitted.current = null; commit({ ...view, budget: Math.max(0, Math.floor(view.budget * .7)) });
        } else if (event.nativeEvent.layout.height > available || (rendered.source.text && !excerpt.text)) latest.current.onPresented(view.reference.revision, false);
        else {
          fitted.current = { serial: view.serial, budget: view.budget, focus: excerpt.partial ? { start: excerpt.start, end: excerpt.end } : undefined };
          notifyIfReady();
        }
      }}
      onEntered={() => {
        const view = current.current;
        if (view?.serial !== display.serial || view.budget !== display.budget || view.phase !== 'enter') return;
        commit({ ...view, phase: 'shown' }); notifyIfReady();
      }}
      onExited={() => {
        const view = current.current;
        if (view?.serial !== display.serial || view.phase !== 'exit') return;
        fitted.current = null;
        commit(null);
        if (latest.current.source) present(); else dismiss();
      }}>
      <View {...passive} style={styles.metadata}><Text {...passive} style={[styles.direction, { color: sent ? '#D8C4F4' : '#D3C5E5' }]}>{referenceDirection(rendered, userId)}</Text></View>
      {rendered.source.kind === 'voice' && <View {...passive} style={styles.metadata}><Text {...passive} style={styles.voice}>◉  Voice message</Text><Text {...passive} style={styles.date}>{status}</Text>{!!rendered.source.text && <Text {...passive} style={styles.date}>Transcript</Text>}</View>}
      {!!rendered.source.text && <View {...passive}>{excerpt.partial && <Text {...passive} style={styles.partial}>Excerpt · {excerpt.end - excerpt.start} of {excerpt.total} characters</Text>}{excerpt.start > 0 && <Text {...passive} style={styles.date}>…</Text>}<Text {...passive} style={styles.body}>{excerpt.text}</Text>{excerpt.end < excerpt.total && <Text {...passive} style={styles.date}>…</Text>}{excerpt.partial && <Text {...passive} style={styles.hint}>Ask Mia for another part</Text>}</View>}
      <Text {...passive} style={styles.date}>{referenceDate(rendered.source.createdAt)}</Text>
    </ShutterCard>}
  </View>;
}
const styles = StyleSheet.create({
  region: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, alignItems: 'center', justifyContent: 'center' },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#000000' },
  card: { borderRadius: 24, borderWidth: 1, borderColor: '#684A82', paddingVertical: 18, gap: 12, overflow: 'hidden' },
  metadata: { gap: 3 }, direction: { fontSize: 13, lineHeight: 19, fontWeight: '600' }, date: { fontSize: 12, lineHeight: 18, color: '#C9C0D2' },
  voice: { fontSize: 17, lineHeight: 25, color: '#F5F1FA' }, body: { fontSize: 17, lineHeight: 25, color: '#F5F1FA', fontWeight: '400' },
  partial: { fontSize: 12, lineHeight: 18, color: '#C9C0D2', marginBottom: 6 }, hint: { fontSize: 12, lineHeight: 18, color: '#C9C0D2', marginTop: 8 },
});

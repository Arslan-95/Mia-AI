import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, AppState, Pressable, StyleSheet, Vibration } from 'react-native';
import type { Mia } from '../useMia';
import { referenceDate, referenceDirection } from '../messageReference';

const holdThreshold = 500;
const exitDelay = 5000;

/** The only touch/accessibility target while the agent controls the visible UI. */
export function AgentInteraction({ mia, onHoldingChange }: { mia: Mia; onHoldingChange(holding: boolean): void }) {
  const current = useRef({ mia, onHoldingChange });
  current.current = { mia, onHoldingChange };
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef<{ timestamp: number; x: number; y: number } | null>(null);
  const suppressTap = useRef(false);
  const cancelHold = () => {
    held.current = false;
    clearTimeout(timer.current); timer.current = undefined;
    current.current.onHoldingChange(false);
  };
  const cancelGesture = () => { suppressTap.current = true; cancelHold(); };
  const beginHold = () => {
    cancelHold();
    held.current = true;
    timer.current = setTimeout(() => {
      const latest = current.current;
      if (!held.current || AppState.currentState !== 'active' || !latest.mia.aiMode) return;
      suppressTap.current = true;
      cancelHold(); Vibration.vibrate();
      void latest.mia.saveAiMode(false).catch(latest.mia.fail);
    }, exitDelay);
  };
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') cancelGesture(); });
    return () => { held.current = false; clearTimeout(timer.current); subscription.remove(); };
  }, []);
  const explainExit = () => AccessibilityInfo.announceForAccessibility('Tap anywhere to mute or unmute. To leave voice mode, hold anywhere for five seconds until it vibrates, or ask Mia and confirm.');
  const reference = mia.messageReference;
  const referenceContext = reference ? ` Showing ${referenceDirection(reference, mia.session!.user.id)}, ${referenceDate(reference.source.createdAt)}${reference.source.kind === 'voice' ? `, voice message, ${mia.originalPlayback?.mediaId === reference.source.mediaId ? mia.originalPlayback.state : 'ready'}` : ''}${reference.displayFocus ? ', focused excerpt' : ''}.` : '';
  const status = { off: 'Ready', waiting: 'Connecting', listening: 'Listening', transcribing: 'Understanding', thinking: 'Thinking', speaking: 'Speaking', paused: 'On standby', error: 'Connection needs attention' }[mia.voicePhase];
  return <Pressable testID="agent-interaction-layer" style={styles.layer} accessible accessibilityViewIsModal
    accessibilityRole="switch" accessibilityLabel={`Mia voice mode.${referenceContext} ${status}. ${mia.microphoneMuted ? 'Microphone muted' : 'Microphone on'}. Tap anywhere to ${mia.microphoneMuted ? 'unmute' : 'mute'} microphone.`}
    accessibilityHint={`${mia.voicePhase === 'error' ? 'Mute, then unmute to reconnect. ' : ''}Double tap anywhere to mute or unmute input. Mia can keep speaking. Double tap and hold for five seconds until it vibrates to exit. Pages are controlled by Mia.`}
    accessibilityState={{ checked: !mia.microphoneMuted }} onAccessibilityEscape={explainExit}
    onTouchStart={event => {
      const native = event.nativeEvent;
      if (native.touches.length !== 1) { cancelGesture(); return; }
      suppressTap.current = false;
      touch.current = { timestamp: native.timestamp, x: native.pageX, y: native.pageY };
      // Native RN grants Pressability's responder before bubbling touch-start.
      // Starting here initializes every genuine gesture once, and cannot restart
      // an aborted hold when Pressability re-enters the screen's press region.
      beginHold();
    }}
    onTouchMove={event => {
      const native = event.nativeEvent;
      if (native.touches.length !== 1 || touch.current && Math.hypot(native.pageX - touch.current.x, native.pageY - touch.current.y) > 12) cancelGesture();
    }}
    onTouchCancel={cancelGesture}
    onPressOut={cancelHold}
    onLongPress={() => { suppressTap.current = true; if (held.current) current.current.onHoldingChange(true); }} delayLongPress={holdThreshold}
    onPress={event => {
      const physical = !!event?.nativeEvent.changedTouches?.length;
      if (AppState.currentState !== 'active' || !current.current.mia.aiMode) return;
      if (physical && (suppressTap.current || touch.current && event.nativeEvent.timestamp - touch.current.timestamp >= holdThreshold)) return;
      void current.current.mia.toggleMicrophone().catch(current.current.mia.fail);
    }} />;
}

const styles = StyleSheet.create({ layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 30, backgroundColor: 'transparent' } });

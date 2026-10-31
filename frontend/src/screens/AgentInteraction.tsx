import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, AppState, Pressable, StyleSheet, Vibration, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import { referenceDate, referenceDirection } from '../messageReference';

const holdThreshold = 500;
const exitDelay = 5000;

/** The only touch/accessibility target while the agent controls the visible UI. */
export function AgentInteraction({ mia, onHoldingChange }: { mia: Mia; onHoldingChange(holding: boolean): void }) {
  const current = useRef({ mia, onHoldingChange });
  current.current = { mia, onHoldingChange };
  const held = useRef(false);
  const { height } = useWindowDimensions();
  const zone = useRef<'agent' | 'action'>('agent');
  const recordingGesture = useRef(false);
  const actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef<{ timestamp: number; x: number; y: number } | null>(null);
  const suppressTap = useRef(false);
  const cancelHold = () => {
    held.current = false;
    clearTimeout(timer.current); timer.current = undefined;
    clearTimeout(actionTimer.current); actionTimer.current = undefined;
    current.current.onHoldingChange(false);
  };
  const endRecording = (cancel = false) => {
    if (!recordingGesture.current) return;
    recordingGesture.current = false;
    void current.current.mia.endHeldRecording(cancel).catch(current.current.mia.fail);
  };
  const cancelGesture = () => { suppressTap.current = true; cancelHold(); endRecording(true); };
  const beginAction = () => {
    if (!held.current || zone.current !== 'action' || recordingGesture.current) return;
    suppressTap.current = true;
    const latest = current.current.mia;
    if (!latest.activeChatId || latest.tab !== 'chats') return;
    recordingGesture.current = true;
    void latest.beginHeldRecording().catch(latest.fail);
  };
  const beginHold = () => {
    cancelHold();
    held.current = true;
    if (zone.current === 'action') {
      actionTimer.current = setTimeout(beginAction, holdThreshold);
      return;
    }
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
    return () => { held.current = false; clearTimeout(timer.current); clearTimeout(actionTimer.current); endRecording(true); subscription.remove(); };
  }, []);
  useEffect(() => { cancelGesture(); }, [height, mia.tab, mia.activeChatId]);
  const explainExit = () => AccessibilityInfo.announceForAccessibility('Tap the upper sixty percent to mute or unmute Mia. Hold there for five seconds to exit. In a chat, hold the lower forty percent to record a voice note and release to finish. Tap the lower area to stop playback.');
  const reference = mia.messageReference;
  const referenceContext = reference ? ` Showing ${referenceDirection(reference, mia.session!.user.id)}, ${referenceDate(reference.source.createdAt)}${reference.source.kind === 'voice' ? `, voice message, ${mia.originalPlayback?.mediaId === reference.source.mediaId ? mia.originalPlayback.state : 'ready'}` : ''}${reference.displayFocus ? ', focused excerpt' : ''}.` : '';
  const status = { off: 'Ready', waiting: 'Connecting', listening: 'Listening', transcribing: 'Understanding', thinking: 'Thinking', speaking: 'Speaking', paused: 'On standby', error: 'Connection needs attention' }[mia.voicePhase];
  return <Pressable testID="agent-interaction-layer" style={styles.layer} accessible accessibilityViewIsModal
    accessibilityRole="switch" accessibilityLabel={`Mia voice mode.${referenceContext} ${status}. ${mia.microphoneMuted ? 'Microphone muted' : 'Microphone on'}. Tap upper area to ${mia.microphoneMuted ? 'unmute' : 'mute'} Mia's microphone.`}
    accessibilityHint="Upper sixty percent: tap for Mia's microphone, hold five seconds to exit. Lower forty percent: hold to record in the open chat, release to finish; tap to stop playback. Recording actions are also available in accessibility actions."
    accessibilityActions={[{ name: 'record', label: 'Start voice note in this chat' }, { name: 'finish', label: 'Finish voice note' }, { name: 'preview', label: 'Preview voice note' }, { name: 'send', label: 'Send voice note' }, { name: 'discard', label: 'Discard voice note' }, { name: 'stop', label: 'Stop playback' }]}
    onAccessibilityAction={event => {
      const latest = current.current.mia;
      const action = { record: latest.beginHeldRecording, finish: () => latest.endHeldRecording(), preview: latest.preview, send: latest.useRecording, discard: latest.discardRecording, stop: latest.stopAudio }[event.nativeEvent.actionName];
      if (action) void action().catch(latest.fail);
    }}
    accessibilityState={{ checked: !mia.microphoneMuted }} onAccessibilityEscape={explainExit}
    onTouchStart={event => {
      const native = event.nativeEvent;
      if (native.touches.length !== 1) { cancelGesture(); return; }
      suppressTap.current = false;
      zone.current = native.pageY < height * .6 ? 'agent' : 'action';
      touch.current = { timestamp: native.timestamp, x: native.pageX, y: native.pageY };
      // Native RN grants Pressability's responder before bubbling touch-start.
      // Starting here initializes every genuine gesture once, and cannot restart
      // an aborted hold when Pressability re-enters the screen's press region.
      beginHold();
    }}
    onTouchMove={event => {
      const native = event.nativeEvent;
      if (native.touches.length !== 1 || !recordingGesture.current && touch.current && Math.hypot(native.pageX - touch.current.x, native.pageY - touch.current.y) > 12) cancelGesture();
    }}
    onTouchCancel={cancelGesture}
    onTouchEnd={() => { cancelHold(); endRecording(); }}
    onPressOut={cancelHold}
    onLongPress={() => { suppressTap.current = true; if (zone.current === 'action') beginAction(); else if (held.current) current.current.onHoldingChange(true); }} delayLongPress={holdThreshold}
    onPress={event => {
      const physical = !!event?.nativeEvent.changedTouches?.length;
      if (AppState.currentState !== 'active' || !current.current.mia.aiMode) return;
      if (physical && (suppressTap.current || touch.current && event.nativeEvent.timestamp - touch.current.timestamp >= holdThreshold)) return;
      if (physical && zone.current === 'action') {
        const latest = current.current.mia;
        if (latest.audioState === 'playing' || latest.audioState === 'loading') void latest.stopAudio().catch(latest.fail);
        else if (latest.recording) void latest.preview().catch(latest.fail);
        return;
      }
      void current.current.mia.toggleMicrophone().catch(current.current.mia.fail);
    }} />;
}

const styles = StyleSheet.create({ layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 30, backgroundColor: 'transparent' } });

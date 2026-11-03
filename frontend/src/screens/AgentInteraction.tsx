import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Pressable, StyleSheet, Vibration, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import { referenceDate, referenceDirection } from '../messageReference';
import { contactFormStatus } from '../contactForm';
import { recordingCancelProgress, recordingGeometry, type RecordingGesture } from '../voiceNoteGesture';

const holdThreshold = 500;
const exitDelay = 5000;

/** The only touch/accessibility target while the agent controls the visible UI. */
export function AgentInteraction({ mia, onHoldingChange, onRecordingGestureChange, recordingProgress, exitProgress }: {
  mia: Mia; onHoldingChange(holding: boolean): void;
  onRecordingGestureChange(gesture: RecordingGesture): void; recordingProgress: Animated.Value; exitProgress: Animated.Value;
}) {
  const current = useRef({ mia, onHoldingChange, onRecordingGestureChange });
  current.current = { mia, onHoldingChange, onRecordingGestureChange };
  const held = useRef(false);
  const { height, width, fontScale } = useWindowDimensions();
  const { radius } = recordingGeometry(height, fontScale);
  const zone = useRef<'agent' | 'action'>('agent');
  const recordingGesture = useRef(false);
  const cancelReady = useRef(false);
  const resetRecordingGesture = () => {
    cancelReady.current = false;
    recordingProgress.setValue(0);
    current.current.onRecordingGestureChange({ active: false, cancelReady: false });
  };
  const actionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = useRef<{ timestamp: number; x: number; y: number } | null>(null);
  const suppressTap = useRef(false);
  const exitAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const cancelHold = () => {
    held.current = false;
    clearTimeout(timer.current); timer.current = undefined;
    clearTimeout(actionTimer.current); actionTimer.current = undefined;
    exitAnimation.current?.stop(); exitAnimation.current = null;
    exitProgress.setValue(0);
    current.current.onHoldingChange(false);
  };
  const endRecording = (cancel = false) => {
    if (!recordingGesture.current) return;
    recordingGesture.current = false;
    resetRecordingGesture();
    void current.current.mia.endHeldRecording(cancel).catch(current.current.mia.fail);
  };
  const cancelGesture = () => { suppressTap.current = true; cancelHold(); endRecording(true); };
  const beginAction = () => {
    if (!held.current || zone.current !== 'action' || recordingGesture.current) return;
    suppressTap.current = true;
    const latest = current.current.mia;
    if (latest.contactForm || !latest.activeChatId || latest.tab !== 'chats' || latest.voiceNoteStage === 'sending' || latest.voiceNoteStage === 'saving') return;
    recordingGesture.current = true;
    cancelReady.current = false;
    recordingProgress.setValue(0);
    current.current.onRecordingGestureChange({ active: true, cancelReady: false });
    void latest.beginHeldRecording().catch(reason => { recordingGesture.current = false; resetRecordingGesture(); latest.fail(reason); });
  };
  const beginHold = () => {
    cancelHold();
    held.current = true;
    if (zone.current === 'action') {
      actionTimer.current = setTimeout(beginAction, holdThreshold);
      return;
    }
    exitAnimation.current = Animated.timing(exitProgress, { toValue: 1, duration: exitDelay, easing: Easing.linear, useNativeDriver: true, isInteraction: false });
    exitAnimation.current.start();
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
    return () => { held.current = false; clearTimeout(timer.current); clearTimeout(actionTimer.current); exitAnimation.current?.stop(); exitProgress.setValue(0); endRecording(true); subscription.remove(); };
  }, []);
  useEffect(() => { cancelGesture(); }, [height, width, fontScale, mia.tab, mia.activeChatId]);
  useEffect(() => {
    if (!mia.error) return;
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(enabled => { if (active && enabled) AccessibilityInfo.announceForAccessibility(mia.error); });
    return () => { active = false; };
  }, [mia.error, mia.errorRevision]);
  const explainExit = () => AccessibilityInfo.announceForAccessibility('Tap the upper sixty percent to mute or unmute Mia. Hold there for five seconds to exit. In a chat, hold the lower forty percent to record and release to send. Move away until the red background reaches the outer circle, then release to delete. Move back to keep recording. Tap the lower area to stop playback or retry an unsent voice note.');
  const reference = mia.messageReference;
  const contactContext = mia.contactForm ? ` ${mia.contactForm.operation === 'rename' ? 'Edit contact' : 'New contact'}. Name: ${mia.contactForm.name || 'not provided'}. Phone number: ${mia.contactForm.identifier || 'not provided'}. ${contactFormStatus[mia.contactForm.status]}.` : '';
  const referenceContext = reference ? ` Showing ${referenceDirection(reference, mia.session!.user.id)}, ${referenceDate(reference.source.createdAt)}${reference.source.kind === 'voice' ? `, voice message, ${mia.originalPlayback?.mediaId === reference.source.mediaId ? mia.originalPlayback.state : 'ready'}` : ''}${reference.displayFocus ? ', focused excerpt' : ''}.` : '';
  const status = { off: 'Ready', waiting: 'Connecting', listening: 'Listening', transcribing: 'Understanding', thinking: 'Thinking', speaking: 'Speaking', paused: 'On standby', error: 'Connection needs attention' }[mia.voicePhase];
  const draft = mia.tab === 'chats' ? mia.drafts.find(item => item.recipientId === mia.chats.find(chat => chat.id === mia.activeChatId)?.recipient.id) : undefined;
  const feedback = mia.error ? ` ${mia.error}` : draft ? ' Draft available in this chat.' : '';
  return <Pressable testID="agent-interaction-layer" style={styles.layer} accessible accessibilityViewIsModal
    accessibilityRole="switch" accessibilityLabel={`Mia voice mode.${referenceContext}${contactContext}${feedback} ${status}. ${mia.microphoneMuted ? 'Microphone muted' : 'Microphone on'}. Tap upper area to ${mia.microphoneMuted ? 'unmute' : 'mute'} Mia's microphone.`}
    accessibilityHint="Upper sixty percent: tap for Mia's microphone, hold five seconds to exit. Lower forty percent: hold to record, release to send. Move away to fill the red circle, then release to delete; move back to continue. Tap to stop playback or retry an unsent voice note. Accessibility actions also allow starting a recording, finishing and sending it, cancelling it, or retrying a failed send."
    accessibilityActions={[{ name: 'record', label: 'Start voice note in this chat' }, { name: 'finish', label: 'Finish and send voice note' }, { name: 'send', label: 'Retry sending voice note' }, { name: 'discard', label: 'Cancel voice note' }, { name: 'stop', label: 'Stop playback' }]}
    onAccessibilityAction={event => {
      const latest = current.current.mia;
      if (latest.contactForm && event.nativeEvent.actionName === 'record') return;
      const action = { record: latest.beginHeldRecording, finish: () => latest.endHeldRecording(), send: latest.useRecording, discard: () => latest.audioState === 'recording' || latest.voiceNoteStage === 'starting' ? latest.endHeldRecording(true) : latest.discardRecording(), stop: latest.stopAudio }[event.nativeEvent.actionName];
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
      if (native.touches.length !== 1) { cancelGesture(); return; }
      if (!touch.current) return;
      const dx = native.pageX - touch.current.x, dy = native.pageY - touch.current.y;
      if (!recordingGesture.current) { if (Math.hypot(dx, dy) > 12) cancelGesture(); return; }
      const progress = recordingCancelProgress(dx, dy, radius);
      recordingProgress.setValue(progress);
      const outside = progress >= 1;
      if (outside !== cancelReady.current) {
        cancelReady.current = outside;
        current.current.onRecordingGestureChange({ active: true, cancelReady: outside });
        Vibration.vibrate(15);
      }
    }}
    onTouchCancel={cancelGesture}
    onTouchEnd={event => {
      const point = event.nativeEvent.changedTouches[0];
      const cancel = recordingGesture.current && point && touch.current
        ? recordingCancelProgress(point.pageX - touch.current.x, point.pageY - touch.current.y, radius) >= 1
        : cancelReady.current;
      cancelHold(); endRecording(cancel);
    }}
    onPressOut={cancelHold}
    onLongPress={() => { suppressTap.current = true; if (zone.current === 'action') beginAction(); else if (held.current) current.current.onHoldingChange(true); }} delayLongPress={holdThreshold}
    onPress={event => {
      const physical = !!event?.nativeEvent.changedTouches?.length;
      if (AppState.currentState !== 'active' || !current.current.mia.aiMode) return;
      if (physical && (suppressTap.current || touch.current && event.nativeEvent.timestamp - touch.current.timestamp >= holdThreshold)) return;
      if (physical && zone.current === 'action') {
        const latest = current.current.mia;
        if (latest.originalPlayback && ['playing', 'paused', 'buffering', 'preparing'].includes(latest.originalPlayback.state)) void latest.toggleMediaPlayback(latest.originalPlayback.mediaId).catch(latest.fail);
        else if (latest.audioState === 'playing' || latest.audioState === 'loading') void latest.stopAudio().catch(latest.fail);
        else if (latest.recording) void latest.useRecording().catch(latest.fail);
        return;
      }
      void current.current.mia.toggleMicrophone().catch(current.current.mia.fail);
    }} />;
}

const styles = StyleSheet.create({ layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 30, backgroundColor: 'transparent' } });

import React, { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import { Button, useUi } from '../ui';
import { recordingCancelProgress } from '../voiceNoteGesture';
import { ComposerVoiceAction } from './ComposerVoiceAction';

const radius = 44, holdDelay = 500;

/** One composer action: text send, or original client-owned hold-to-record. */
export function ChatComposer({ mia, chatId, recipient, bottomInset }: {
  mia: Mia; chatId: string; recipient: string; bottomInset: number;
}) {
  const { colors } = useUi();
  const { fontScale } = useWindowDimensions();
  const composer = mia.composers[chatId] ?? '';
  const [gesture, setGesture] = useState({ active: false, cancelReady: false });
  const [elapsed, setElapsed] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const current = useRef({ mia, composer }); current.current = { mia, composer };
  const held = useRef(false), suppressTap = useRef(false), mounted = useRef(true);
  const revision = useRef(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recording = mia.audioState === 'recording';
  const sending = mia.voiceNoteStage === 'sending' || mia.voiceNoteStage === 'saving';
  const active = gesture.active || recording || mia.voiceNoteStage === 'starting';
  const retained = !!mia.recording;
  const reset = (render = true) => {
    clearTimeout(timer.current); timer.current = undefined; origin.current = null;
    progress.setValue(0);
    if (render && mounted.current) setGesture({ active: false, cancelReady: false });
  };
  const finish = (cancel: boolean, render = true) => {
    revision.current++;
    const owns = held.current; held.current = false; reset(render);
    if (owns) void current.current.mia.endHeldRecording(cancel).catch(current.current.mia.fail);
  };
  const begin = () => {
    const latest = current.current;
    if (held.current || latest.mia.recording || latest.composer.trim() || latest.mia.aiMode || latest.mia.activeChatId !== chatId
      || ['sending', 'saving'].includes(latest.mia.voiceNoteStage)) return;
    clearTimeout(timer.current); timer.current = undefined;
    const token = ++revision.current;
    held.current = true; suppressTap.current = true;
    setGesture({ active: true, cancelReady: false }); progress.setValue(0);
    void latest.mia.beginHeldRecording().catch(reason => {
      if (mounted.current && revision.current === token) { held.current = false; reset(); latest.mia.fail(reason); }
    });
  };
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') finish(true); });
    return () => { mounted.current = false; finish(true, false); subscription.remove(); };
  }, []);
  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const started = Date.now();
    const interval = setInterval(() => setElapsed(Math.min(119, Math.floor((Date.now() - started) / 1000))), 250);
    return () => clearInterval(interval);
  }, [recording]);
  useEffect(() => { if (composer.trim() && !held.current) reset(); }, [!!composer.trim()]);
  const cancelReady = gesture.cancelReady;
  const duration = recording ? elapsed : Math.floor((mia.recording?.durationMs ?? 0) / 1000);
  const time = `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
  const label = sending ? 'Sending voice note' : active ? 'Finish and send voice note' : retained ? 'Retry voice note' : composer.trim() ? 'Send' : 'Record voice note';
  const showStatus = active || sending || retained;
  return <View testID="message-composer-area" style={[styles.area, { paddingBottom: Math.max(bottomInset, 8) }]}>
    <View style={[styles.composer, { backgroundColor: colors.paper, borderColor: cancelReady ? colors.red : colors.line }]}>
      <View style={[styles.inputArea, showStatus && { minHeight: Math.max(44, Math.ceil(44 * fontScale)) }]}>
        <TextInput accessibilityLabel={`Message ${recipient}`} placeholder="Message…" placeholderTextColor={colors.muted} keyboardAppearance="dark" selectionColor={colors.accentLight} multiline maxLength={8000} value={composer} onChangeText={mia.setComposer}
          pointerEvents={showStatus ? 'none' : 'auto'} accessibilityElementsHidden={showStatus} importantForAccessibility={showStatus ? 'no-hide-descendants' : 'auto'}
          style={[styles.input, { color: colors.ink, opacity: showStatus ? 0 : 1 }]} />
        {showStatus && <View testID="composer-recording-status" accessibilityLiveRegion="polite" style={styles.recordingInfo}>
          {retained && !sending && !active && <Button quiet iconOnly label="Discard recording" icon="close" onPress={() => void mia.discardRecording().catch(mia.fail)} style={styles.discard} />}
          <View style={[styles.dot, { backgroundColor: cancelReady ? colors.red : colors.accentLight }]} />
          <Text testID="composer-recording-time" style={[styles.time, { color: colors.ink }]}>{time}</Text>
          <Text numberOfLines={2} style={[styles.hint, { color: cancelReady ? colors.red : colors.muted }]}>{cancelReady ? 'Release to delete' : sending ? 'Sending…' : retained && !active ? `Not sent · ${mia.recordingRecipient?.displayName ?? recipient}` : mia.voiceNoteStage === 'starting' ? 'Getting ready…' : 'Move away to cancel'}</Text>
        </View>}
      </View>
      <View style={styles.actionSlot}>
        <Pressable testID="composer-action" accessibilityRole="button" accessibilityLabel={label}
          accessibilityHint={composer.trim() ? 'Send your text message.' : 'Hold to record. Release to send; move away until the red circle fills, then release to delete. With a screen reader, activate to start and activate again to send.'}
          accessibilityState={{ disabled: sending, busy: sending || mia.voiceNoteStage === 'starting' }} disabled={sending} style={({ pressed }) => [styles.action, pressed && !active && { opacity: .8 }, sending && { opacity: .6 }]}
          hitSlop={6} pressRetentionOffset={radius}
          accessibilityActions={[{ name: 'record', label: 'Start voice note' }, { name: 'finish', label: 'Finish and send voice note' }, { name: 'discard', label: 'Cancel voice note' }]}
          onAccessibilityAction={event => {
            if (event.nativeEvent.actionName === 'record') begin();
            else if (event.nativeEvent.actionName === 'finish') finish(false);
            else if (event.nativeEvent.actionName === 'discard') {
              if (held.current) finish(true); else void current.current.mia.discardRecording().catch(current.current.mia.fail);
            }
          }}
          onTouchStart={event => {
            if (event.nativeEvent.touches.length !== 1) { suppressTap.current = true; finish(true); return; }
            suppressTap.current = false;
            if (current.current.composer.trim() || current.current.mia.recording || ['sending', 'saving'].includes(current.current.mia.voiceNoteStage)) return;
            origin.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
            timer.current = setTimeout(begin, holdDelay);
          }}
          onTouchMove={event => {
            if (event.nativeEvent.touches.length !== 1) { suppressTap.current = true; finish(true); return; }
            if (!origin.current) return;
            const distance = recordingCancelProgress(event.nativeEvent.pageX - origin.current.x, event.nativeEvent.pageY - origin.current.y, radius);
            if (!held.current) { if (distance > 12 / radius) { suppressTap.current = true; reset(); } return; }
            progress.setValue(distance); setGesture({ active: true, cancelReady: distance >= 1 });
          }}
          onTouchEnd={event => {
            const point = event.nativeEvent.changedTouches[0];
            const cancel = origin.current && point ? recordingCancelProgress(point.pageX - origin.current.x, point.pageY - origin.current.y, radius) >= 1 : cancelReady;
            finish(!!cancel);
          }}
          onTouchCancel={() => { suppressTap.current = true; finish(true); }}
          onPress={event => {
            const physical = !!event?.nativeEvent.changedTouches?.length;
            if (suppressTap.current && physical) return;
            const latest = current.current;
            if (['sending', 'saving'].includes(latest.mia.voiceNoteStage)) return;
            if (!physical && held.current) finish(false);
            else if (latest.mia.recording) void latest.mia.useRecording().catch(latest.mia.fail);
            else if (latest.composer.trim()) { void latest.mia.sendText(); }
            else if (!physical) begin();
          }}>
          <ComposerVoiceAction active={active} cancelReady={cancelReady} busy={sending || mia.voiceNoteStage === 'starting'} send={retained || !!composer.trim()} progress={progress} />
        </Pressable>
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  area: { paddingHorizontal: 16, paddingTop: 6 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderRadius: 26, borderWidth: 1, padding: 3, paddingRight: 10 },
  inputArea: { flex: 1, minWidth: 0 },
  input: { minWidth: 0, minHeight: 44, maxHeight: 120, paddingVertical: 12, paddingHorizontal: 12, fontSize: 15, lineHeight: 20 },
  actionSlot: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  recordingInfo: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 30 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  time: { fontSize: 13, fontVariant: ['tabular-nums'] },
  hint: { fontSize: 11, lineHeight: 16, flex: 1 },
  discard: { width: 36, minHeight: 44, paddingHorizontal: 0, paddingVertical: 0 },
});

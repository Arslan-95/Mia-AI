import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Modal, PanResponder, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Profile } from '../../../shared/types';
import { userErrorMessage } from '../../../shared/errors';
import { Avatar, Button, Field, Notice, useUi } from '../../../shared/ui/ui';
import { useReducedMotion } from '../../../shared/ui/motion';

export function ContactDetails({ profile, savedName, onSave, onClose }: {
  profile: Profile; savedName?: string; onSave(name: string): Promise<void>; onClose(): void;
}) {
  const { colors, s } = useUi();
  const reduced = useReducedMotion();
  const { height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [available, setAvailable] = useState(height - insets.top - insets.bottom - 32);
  const compact = available < 440 * Math.min(fontScale, 1.4);
  const offset = useRef(new Animated.Value(height)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const dragging = useRef(false), closing = useRef(false);
  const [name, setName] = useState(savedName ?? profile.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false), mounted = useRef(true);
  const current = useRef({ height, reduced, onClose }); current.current = { height, reduced, onClose };
  useEffect(() => {
    mounted.current = true;
    animation.current = Animated.timing(offset, { toValue: 0, duration: current.current.reduced ? 0 : 220, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    animation.current.start();
    return () => { mounted.current = false; dragging.current = false; animation.current?.stop(); };
  }, [offset]);
  const close = () => {
    if (pending.current || closing.current) return;
    closing.current = true; dragging.current = false; animation.current?.stop();
    animation.current = Animated.timing(offset, { toValue: current.current.height, duration: current.current.reduced ? 0 : 180, useNativeDriver: true });
    animation.current.start(({ finished }) => { if (finished && mounted.current) current.current.onClose(); });
  };
  const restore = () => {
    dragging.current = false;
    if (closing.current) return;
    animation.current?.stop();
    if (current.current.reduced) { offset.setValue(0); return; }
    animation.current = Animated.spring(offset, { toValue: 0, bounciness: 0, useNativeDriver: true });
    animation.current.start();
  };
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => !pending.current && !closing.current && gesture.numberActiveTouches === 1
      && gesture.dy > 10 && gesture.dy > Math.abs(gesture.dx) * 1.5,
    onPanResponderGrant: () => {
      if (pending.current || closing.current) return;
      animation.current?.stop(); offset.stopAnimation(); dragging.current = true;
    },
    onPanResponderMove: (_event, gesture) => {
      if (!dragging.current) return;
      if (gesture.numberActiveTouches !== 1) { restore(); return; }
      offset.setValue(Math.max(0, Math.min(gesture.dy, current.current.height)));
    },
    onPanResponderStart: (_event, gesture) => { if (dragging.current && gesture.numberActiveTouches !== 1) restore(); },
    onPanResponderRelease: (_event, gesture) => {
      if (!dragging.current) return;
      if (!pending.current && (gesture.dy >= 90 || gesture.dy >= 24 && gesture.vy > .7)) close(); else restore();
    },
    onPanResponderTerminate: restore,
    onPanResponderTerminationRequest: () => true,
  }), [offset]);
  async function save() {
    if (pending.current || dragging.current || closing.current || !name.trim() || savedName !== undefined && name.trim() === savedName) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await onSave(name.trim());
      pending.current = false;
      if (mounted.current) close();
    } catch (reason) {
      if (mounted.current) setError(userErrorMessage(reason) ?? 'Unable to save the contact. Please try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <Modal visible transparent animationType="none" onRequestClose={close}>
    <SafeAreaView style={styles.backdrop}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: '#00000099', opacity: offset.interpolate({ inputRange: [0, Math.min(height, 400)], outputRange: [1, 0], extrapolate: 'clamp' }) }]} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.position}>
        <View testID="contact-details-viewport" style={styles.viewport} onLayout={event => setAvailable(Math.max(0, event.nativeEvent.layout.height - 32))}>
        <Animated.View testID="contact-details" {...responder.panHandlers} accessibilityViewIsModal onAccessibilityEscape={close}
          style={[styles.card, { backgroundColor: colors.paper, borderColor: colors.line, transform: [{ translateY: offset }] }]}>
          <View style={[styles.content, compact && styles.compactContent]}>
            <View testID="contact-details-drag-handle" accessible={false} style={[styles.handle, { backgroundColor: colors.muted }]} />
            <View style={styles.heading}>{!compact && <Avatar name={savedName ?? profile.displayName} size={44} round />}
              <Text accessibilityRole="header" style={s.sectionTitle}>Contact details</Text>
            </View>
            <Field label="Contact name" value={name} onChangeText={setName} maxLength={80} editable={!busy} autoCapitalize="words" autoComplete="name" textContentType="name" returnKeyType="done" onSubmitEditing={() => void save()} style={compact ? styles.compactInput : undefined} />
            <View style={[styles.phone, compact && styles.compactPhone]}><Text style={s.label}>Phone number</Text><Text selectable style={s.body}>{profile.phoneNumber || 'Phone number unavailable'}</Text></View>
            {!compact && <Text style={s.small}>This name is only for your contacts.</Text>}
            {!!error && <Notice error>{error}</Notice>}
            <View style={styles.actions}>
              <Button label={savedName !== undefined ? 'Save name' : 'Save contact'} loading={busy} disabled={!name.trim() || savedName !== undefined && name.trim() === savedName} onPress={() => void save()} style={styles.action} />
              <Button secondary label="Cancel" disabled={busy} onPress={close} style={styles.action} />
            </View>
          </View>
        </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  position: { flex: 1 },
  viewport: { flex: 1, justifyContent: 'flex-end', padding: 16, alignItems: 'center' },
  card: { width: '100%', maxWidth: 460, maxHeight: '100%', borderRadius: 26, borderWidth: 1, overflow: 'hidden' },
  content: { padding: 20, gap: 16 }, compactContent: { padding: 12, gap: 8 },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', opacity: .6 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  compactInput: { minHeight: 44, paddingVertical: 10 },
  phone: { gap: 6 }, compactPhone: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 10 }, action: { flex: 1, paddingHorizontal: 8 },
});

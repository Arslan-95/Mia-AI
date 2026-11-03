import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Keyboard, PanResponder, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUi } from '../../../shared/ui/ui';
import { useReducedMotion } from '../../../shared/ui/motion';

export function ChatBackGesture({ chatId, navigationRevision, enabled, onBack, children, renderBackScreen }: {
  chatId: string; navigationRevision: number; enabled: boolean; onBack(): void; children: React.ReactNode; renderBackScreen?(): React.ReactNode;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const { left, right } = useSafeAreaInsets();
  const width = Math.max(1, windowWidth - left - right);
  const { colors } = useUi();
  const reduced = useReducedMotion();
  const [revealing, setRevealing] = useState(false);
  const offset = useRef(new Animated.Value(0)).current;
  const current = useRef({ chatId, navigationRevision, enabled, onBack, width, left, reduced });
  current.current = { chatId, navigationRevision, enabled, onBack, width, left, reduced };
  const dragging = useRef<{ chatId: string; navigationRevision: number } | null>(null);
  const revision = useRef(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const reset = () => {
    // A late terminate/release after a successful pop must never return the
    // departed native view to its starting position while React removes it.
    if (!dragging.current) return;
    const token = ++revision.current;
    dragging.current = null;
    animation.current?.stop();
    if (current.current.reduced) { offset.setValue(0); setRevealing(false); return; }
    animation.current = Animated.spring(offset, { toValue: 0, bounciness: 0, useNativeDriver: true });
    animation.current.start(({ finished }) => {
      if (finished && revision.current === token) setRevealing(false);
    });
  };
  const responder = useMemo(() => PanResponder.create({
    // x0 is set only after responder grant; before that, recover the origin
    // from the current centroid and displacement so middle-of-screen drags
    // cannot capture the chat's scrolling or text selection.
    onMoveShouldSetPanResponderCapture: (_event, gesture) => current.current.enabled && gesture.numberActiveTouches === 1
      && gesture.moveX - gesture.dx <= current.current.left + 24 && gesture.dx > 12 && gesture.dx > Math.abs(gesture.dy) * 1.5,
    onPanResponderGrant: () => {
      if (!current.current.enabled) return;
      revision.current++; animation.current?.stop();
      dragging.current = { chatId: current.current.chatId, navigationRevision: current.current.navigationRevision };
      setRevealing(true);
      offset.stopAnimation(); Keyboard.dismiss();
    },
    onPanResponderMove: (_event, gesture) => {
      if (dragging.current) offset.setValue(Math.max(0, Math.min(gesture.dx, current.current.width)));
    },
    onPanResponderRelease: (_event, gesture) => {
      const id = dragging.current;
      if (!id || !current.current.enabled || current.current.chatId !== id.chatId || current.current.navigationRevision !== id.navigationRevision
        || !(gesture.dx >= Math.min(current.current.width * .3, 100) || gesture.dx >= 35 && gesture.vx > .5)) { reset(); return; }
      const token = ++revision.current;
      animation.current = Animated.timing(offset, { toValue: current.current.width, duration: current.current.reduced ? 0 : 180, useNativeDriver: true });
      animation.current.start(({ finished }) => {
        if (finished && revision.current === token && dragging.current === id && current.current.enabled && current.current.chatId === id.chatId && current.current.navigationRevision === id.navigationRevision) {
          dragging.current = null; current.current.onBack();
        }
      });
    },
    onPanResponderTerminate: reset,
    onPanResponderTerminationRequest: () => true,
  }), [offset]);
  useLayoutEffect(() => {
    revision.current++; dragging.current = null; animation.current?.stop(); offset.stopAnimation(); offset.setValue(0); setRevealing(false);
    return () => { revision.current++; dragging.current = null; animation.current?.stop(); offset.stopAnimation(); };
  }, [chatId, navigationRevision, enabled, width, left, reduced, offset]);
  return <View style={[p.stack, { backgroundColor: colors.background }]}>
    {revealing && enabled && <Animated.View testID="chat-back-destination" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[p.destination, { backgroundColor: colors.background, transform: [{ translateX: reduced ? 0 : offset.interpolate({ inputRange: [0, width], outputRange: [-width * .25, 0], extrapolate: 'clamp' }) }] }]}>
      {renderBackScreen?.()}
      <Animated.View pointerEvents="none" style={[p.scrim, { opacity: offset.interpolate({ inputRange: [0, width], outputRange: [.2, 0], extrapolate: 'clamp' }) }]} />
    </Animated.View>}
    <Animated.View testID="chat-screen" {...responder.panHandlers} onAccessibilityEscape={() => { if (enabled) onBack(); }}
      style={[p.screen, { backgroundColor: colors.background, transform: [{ translateX: offset }] }]}>{children}</Animated.View>
  </View>;
}
const p = StyleSheet.create({
  stack: { flex: 1, overflow: 'hidden' },
  destination: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  scrim: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: '#000' },
  screen: { flex: 1, shadowColor: '#000', shadowOffset: { width: -4, height: 0 }, shadowOpacity: .35, shadowRadius: 14, elevation: 8 },
});

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Keyboard, PanResponder, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../ui';

export function ChatBackGesture({ chatId, enabled, onBack, children }: {
  chatId: string; enabled: boolean; onBack(): void; children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const { left } = useSafeAreaInsets();
  const offset = useRef(new Animated.Value(0)).current;
  const current = useRef({ chatId, enabled, onBack, width, left });
  current.current = { chatId, enabled, onBack, width, left };
  const dragging = useRef<string | null>(null);
  const reset = () => {
    dragging.current = null;
    Animated.spring(offset, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
  };
  const responder = useMemo(() => PanResponder.create({
    // x0 is set only after responder grant; before that, recover the origin
    // from the current centroid and displacement so middle-of-screen drags
    // cannot capture the chat's scrolling or text selection.
    onMoveShouldSetPanResponderCapture: (_event, gesture) => current.current.enabled && gesture.numberActiveTouches === 1
      && gesture.moveX - gesture.dx <= current.current.left + 24 && gesture.dx > 12 && gesture.dx > Math.abs(gesture.dy) * 1.5,
    onPanResponderGrant: () => {
      dragging.current = current.current.chatId;
      offset.stopAnimation(); Keyboard.dismiss();
    },
    onPanResponderMove: (_event, gesture) => {
      if (dragging.current) offset.setValue(Math.max(0, Math.min(gesture.dx, current.current.width)));
    },
    onPanResponderRelease: (_event, gesture) => {
      const id = dragging.current;
      if (!id || !current.current.enabled || current.current.chatId !== id
        || !(gesture.dx >= Math.min(current.current.width * .3, 100) || gesture.dx >= 35 && gesture.vx > .5)) { reset(); return; }
      Animated.timing(offset, { toValue: current.current.width, duration: 160, useNativeDriver: true }).start(({ finished }) => {
        if (finished && dragging.current === id && current.current.enabled && current.current.chatId === id) {
          dragging.current = null; current.current.onBack();
        }
      });
    },
    onPanResponderTerminate: reset,
    onPanResponderTerminationRequest: () => true,
  }), [offset]);
  useEffect(() => {
    dragging.current = null; offset.stopAnimation(); offset.setValue(0);
    return () => { dragging.current = null; offset.stopAnimation(); };
  }, [chatId, enabled, offset]);
  return <Animated.View testID="chat-screen" {...responder.panHandlers} onAccessibilityEscape={() => { if (enabled) onBack(); }}
    style={[p.screen, { transform: [{ translateX: offset }] }]}>{children}</Animated.View>;
}
const p = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background } });

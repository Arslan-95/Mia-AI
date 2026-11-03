import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, type StyleProp, type ViewStyle } from 'react-native';
import { useAgentAppearance } from './appearance';

// One native subscription for all page/button consumers. Stay static until the
// device preference is known; late queries cannot override a newer OS event.
let reduced = true;
let revision = 0;
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | undefined;
const listeners = new Set<() => void>();
const snapshot = () => reduced;
function publish(value: boolean) { reduced = value; for (const listener of listeners) listener(); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const request = ++revision;
    subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { revision++; publish(value); });
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (revision === request && listeners.size) publish(value); }).catch(() => {});
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { subscription?.remove(); subscription = undefined; revision++; reduced = true; }
  };
}
export function useReducedMotion() { return useSyncExternalStore(subscribe, snapshot, () => true); }

export function Reveal({ children, identity, style }: { children: React.ReactNode; identity?: unknown; style?: StyleProp<ViewStyle> }) {
  const reducedMotion = useReducedMotion();
  const agent = useAgentAppearance();
  const reduced = reducedMotion || !agent;
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    opacity.stopAnimation();
    if (reduced) { opacity.setValue(1); return; }
    opacity.setValue(.72);
    const animation = Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [identity, opacity, reduced]);
  return <Animated.View style={[style, { opacity: reduced ? 1 : opacity }]}>{children}</Animated.View>;
}

export function usePressOpacity() {
  const reducedMotion = useReducedMotion();
  const agent = useAgentAppearance();
  const reduced = reducedMotion || !agent;
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => () => opacity.stopAnimation(), [opacity]);
  useEffect(() => { if (reduced) { opacity.stopAnimation(); opacity.setValue(1); } }, [opacity, reduced]);
  function change(toValue: number) {
    opacity.stopAnimation();
    if (reduced) { opacity.setValue(1); return; }
    Animated.timing(opacity, { toValue, duration: toValue === 1 ? 120 : 80, useNativeDriver: true }).start();
  }
  return { opacity: reduced ? 1 : opacity, onPressIn: () => change(.78), onPressOut: () => change(1) };
}

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';

const transitionMs = 400;

export function useOrbBlend(target: number, reduced: boolean, duration = transitionMs) {
  const value = useRef(new Animated.Value(target)).current;
  useEffect(() => {
    const animation = Animated.timing(value, {
      toValue: target, duration: reduced ? 0 : duration,
      easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [target, reduced, duration, value]);
  return value;
}

/** Keep fading decorations mounted until their exit finishes, including interrupted exits. */
export function useOrbPresence(shown: boolean, reduced: boolean) {
  const [visible, setVisible] = useState(shown);
  const opacity = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    let current = true;
    if (shown) setVisible(true);
    const animation = Animated.timing(opacity, {
      toValue: shown ? 1 : 0, duration: reduced ? 0 : transitionMs,
      easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false,
    });
    animation.start(({ finished }) => { if (current && finished && !shown) setVisible(false); });
    return () => { current = false; animation.stop(); };
  }, [shown, reduced, opacity]);
  return { visible, opacity };
}

/** Native rotation in turns/ms. Retarget from the actual on-screen angle and velocity. */
export function useOrbRotation(speed: number, reduced: boolean) {
  const rotation = useRef(new Animated.Value(0)).current;
  const motion = useRef({ startedAt: 0, from: 0, to: 0 });
  useEffect(() => {
    let current = true;
    let animation: Animated.CompositeAnimation | undefined;
    // stopAnimation reads the native angle; the JS value can lag behind the display.
    rotation.stopAnimation(angle => {
      if (!current) return;
      const previous = motion.current;
      const t = Math.min(1, Math.max(0, (Date.now() - previous.startedAt) / transitionMs));
      const from = previous.from + (previous.to - previous.from) * t * t * (3 - 2 * t);
      const to = reduced ? 0 : speed;
      motion.current = { startedAt: Date.now(), from: reduced ? 0 : from, to };
      if (reduced || (from === 0 && to === 0)) return;

      // Integrating a smooth velocity ramp avoids a sudden stop or speed change.
      const distance = (from + to) * transitionMs / 2;
      animation = Animated.timing(rotation, {
        toValue: angle + distance, duration: transitionMs,
        easing: t => (from * t + (to - from) * (t ** 3 - t ** 4 / 2)) / ((from + to) / 2),
        useNativeDriver: true, isInteraction: false,
      });
      animation.start(({ finished }) => {
        if (!current || !finished || to === 0) return;
        // Native iterations wrap by exactly one turn, so the seam is invisible.
        // No JS reset: that would send the sphere back to its original angle.
        animation = Animated.loop(Animated.timing(rotation, {
          toValue: angle + distance + Math.sign(to), duration: Math.abs(1 / to),
          easing: Easing.linear, useNativeDriver: true, isInteraction: false,
        }));
        animation.start();
      });
    });
    return () => { current = false; animation?.stop(); rotation.stopAnimation(); };
  }, [speed, reduced, rotation]);
  return rotation;
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

const strips = 6;
const passive = { pointerEvents: 'none' as const, accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
export type ShutterPhase = 'enter' | 'shown' | 'exit';

/** Clip full-size copies instead of scaling text or animating layout on the JS thread. */
export function ShutterCard({ children, width, phase, reduced, style, onLayout, onEntered, onExited }: {
  children: React.ReactNode; width: number; phase: ShutterPhase; reduced: boolean; style: StyleProp<ViewStyle>;
  onLayout(event: LayoutChangeEvent): void; onEntered(): void; onExited(): void;
}) {
  const [height, setHeight] = useState(0);
  const bands = useRef(Array.from({ length: strips }, () => new Animated.Value(0))).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const orbit = useRef(new Animated.Value(0)).current;
  const callbacks = useRef({ onEntered, onExited }); callbacks.current = { onEntered, onExited };
  const path = useMemo(() => contourPath(width, height), [width, height]);

  useEffect(() => {
    if (phase === 'shown') { bands.forEach(value => value.setValue(1)); opacity.setValue(1); return; }
    if (!height) { if (phase === 'exit') callbacks.current.onExited(); return; }
    let active = true;
    const entering = phase === 'enter';
    const finish = () => { if (active) (entering ? callbacks.current.onEntered : callbacks.current.onExited)(); };
    const motions = reduced ? [Animated.timing(opacity, { toValue: entering ? 1 : 0, duration: 80, useNativeDriver: true, isInteraction: false })]
      : bands.map((value, index) => Animated.timing(value, {
        toValue: entering ? 1 : 0, duration: entering ? 650 : 420, delay: (entering ? index : strips - 1 - index) * 55,
        easing: entering ? Easing.bezier(.22, 1, .36, 1) : Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false,
      }));
    let remaining = motions.length;
    for (const motion of motions) motion.start(({ finished }) => { if (finished && --remaining === 0) finish(); });
    return () => { active = false; motions.forEach(motion => motion.stop()); };
  }, [phase, height, reduced, bands, opacity]);

  useEffect(() => {
    orbit.setValue(0);
    if (reduced) return;
    const animation = Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 10000, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
    animation.start(); return () => animation.stop();
  }, [reduced, orbit]);

  const surface = <>{children}{height > 0 && <View {...passive} style={styles.contour}>
    <Animated.View {...passive} style={[styles.highlight, { opacity: reduced ? 0 : .75, transform: [
      { translateX: orbit.interpolate({ inputRange: path.stops, outputRange: path.x }) },
      { translateY: orbit.interpolate({ inputRange: path.stops, outputRange: path.y }) },
      { rotate: orbit.interpolate({ inputRange: path.stops, outputRange: path.angle }) },
    ] }]} />
  </View>}</>;
  return <View {...passive} testID="message-reference-shutter" style={{ width }}>
    <Animated.View {...passive} testID="message-reference-card" style={[style, { width, opacity: phase === 'shown' ? 1 : reduced ? opacity : 0 }]} onLayout={event => {
      const next = event.nativeEvent.layout.height;
      if (next > 0) setHeight(previous => previous === next ? previous : next);
      onLayout(event);
    }}>{surface}</Animated.View>
    {!reduced && phase !== 'shown' && height > 0 && bands.map((value, index) => {
      const top = height * index / strips;
      const bottom = height * (index + 1) / strips;
      return <Animated.View key={index} {...passive} testID={`message-reference-strip-${index}`} style={[styles.strip, {
        top, width, height: bottom - top, opacity: value,
        transform: [{ translateX: value.interpolate({ inputRange: [0, 1], outputRange: [(index % 2 ? 1 : -1) * 30, 0] }) }],
      }]}>
        <View {...passive} style={[style, { position: 'absolute', top: -top, left: 0, width, height }]}>{surface}</View>
      </Animated.View>;
    })}
  </View>;
}

/** Constant-distance samples of the rounded border; only transforms animate. */
function contourPath(width: number, height: number) {
  const inset = .75, radius = Math.min(23.25, Math.max(0, width / 2 - inset), Math.max(0, height / 2 - inset));
  const horizontal = Math.max(0, width - 2 * (radius + inset));
  const vertical = Math.max(0, height - 2 * (radius + inset));
  const arc = Math.PI * radius / 2;
  const lengths = [horizontal, arc, vertical, arc, horizontal, arc, vertical, arc];
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  const stops: number[] = [], x: number[] = [], y: number[] = [], angle: string[] = [];
  for (let index = 0; index <= 80; index++) {
    const t = index / 80;
    let distance = t * perimeter, segment = 0;
    while (segment < 7 && distance > lengths[segment]!) distance -= lengths[segment++]!;
    let px: number, py: number, rotation: number;
    if (segment % 2) {
      const corner = (segment - 1) / 2;
      const theta = -Math.PI / 2 + corner * Math.PI / 2 + (radius ? distance / radius : 0);
      const cx = corner < 2 ? width - radius - inset : radius + inset;
      const cy = corner === 0 || corner === 3 ? radius + inset : height - radius - inset;
      px = cx + radius * Math.cos(theta); py = cy + radius * Math.sin(theta); rotation = theta * 180 / Math.PI + 90;
    } else {
      const edge = segment / 2;
      px = edge === 0 ? radius + inset + distance : edge === 1 ? width - inset : edge === 2 ? width - radius - inset - distance : inset;
      py = edge === 0 ? inset : edge === 1 ? radius + inset + distance : edge === 2 ? height - inset : height - radius - inset - distance;
      rotation = edge * 90;
    }
    stops.push(t); x.push(px - 9); y.push(py - .75); angle.push(`${rotation}deg`);
  }
  return { stops, x, y, angle };
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', left: 0, overflow: 'hidden' },
  contour: { ...StyleSheet.absoluteFillObject, borderRadius: 24, overflow: 'hidden' },
  highlight: { position: 'absolute', top: 0, left: 0, width: 18, height: 1.5, borderRadius: 1, backgroundColor: '#D2ACF3' },
});

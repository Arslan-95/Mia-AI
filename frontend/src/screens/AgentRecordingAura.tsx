import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useReducedMotion } from '../motion';
import { Icon } from '../ui';

/** The core stays anchored. Only the concentric red background grows with drag distance. */
export function AgentRecordingAura({ active, cancelReady, progress, diameter, radius, children }: {
  active: boolean; cancelReady: boolean; progress: Animated.Value; diameter: number; radius: number; children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const reveal = useRef(new Animated.Value(active ? 1 : 0)).current;
  const ready = useRef(new Animated.Value(cancelReady ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { reveal.setValue(active ? 1 : 0); return; }
    const animation = Animated.timing(reveal, { toValue: active ? 1 : 0, duration: active ? 180 : 160, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false });
    animation.start(); return () => animation.stop();
  }, [active, reduced, reveal]);
  useEffect(() => {
    if (reduced) { ready.setValue(cancelReady ? 1 : 0); return; }
    const animation = Animated.timing(ready, { toValue: cancelReady ? 1 : 0, duration: 120, useNativeDriver: true, isInteraction: false });
    animation.start(); return () => animation.stop();
  }, [cancelReady, ready, reduced]);
  const size = radius * 2;
  return <View testID="agent-recording-aura" pointerEvents="none" accessible={false} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Animated.View testID="agent-recording-boundary" style={[styles.boundary, { width: size, height: size, borderRadius: radius, opacity: reveal }]}>
      <Animated.View testID="agent-recording-cancel-fill" style={[styles.fill, { borderRadius: radius,
        opacity: progress.interpolate({ inputRange: [0, .15, 1], outputRange: [0, .45, .8], extrapolate: 'clamp' }),
        transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [diameter / size, 1], extrapolate: 'clamp' }) }],
      }]} />
      <Animated.View style={[styles.readyBoundary, { borderRadius: radius, opacity: ready }]} />
    </Animated.View>
    {children}
    <Animated.View style={[styles.coreTint, { width: diameter, height: diameter, borderRadius: diameter / 2, opacity: ready }]} />
    <Animated.View testID="agent-recording-mic" style={[styles.symbol, { opacity: Animated.multiply(reveal, ready.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })) }]}><Icon name="mic" size={22} color="#F5E9FF" /></Animated.View>
    <Animated.View testID="agent-recording-delete" style={[styles.symbol, { opacity: ready, transform: [{ scale: ready.interpolate({ inputRange: [0, 1], outputRange: [.7, 1] }) }] }]}><Icon name="trash-outline" size={25} color="#FFE3ED" /></Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  boundary: { position: 'absolute', borderWidth: 1, borderStyle: 'dashed', borderColor: '#A785D34D', backgroundColor: '#A184EE06', alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', inset: 0, backgroundColor: '#B95579', shadowColor: '#E1779D', shadowOpacity: .22, shadowRadius: 13, shadowOffset: { width: 0, height: 0 } },
  readyBoundary: { position: 'absolute', inset: -1, borderWidth: 1, borderColor: '#F19BB5' },
  coreTint: { position: 'absolute', backgroundColor: '#8D335BCC', borderWidth: 1, borderColor: '#FFC3D5A0' },
  symbol: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});

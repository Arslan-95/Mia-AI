import React from 'react';
import { Animated, StyleSheet, View } from 'react-native';

/** Two clipped semicircles draw a clockwise arc on the native animation thread. */
export function AgentExitProgress({ progress, diameter }: { progress: Animated.Value; diameter: number }) {
  const size = diameter * 1.48;
  const half = size / 2;
  return <View testID="agent-exit-progress" pointerEvents="none" accessible={false} style={[styles.container, { width: size, height: size }]}>
    <View style={[styles.track, { width: size, height: size, borderRadius: half }]} />
    {(['right', 'left'] as const).map((side, index) => <View key={side} style={{ position: 'absolute', top: 0, left: index ? 0 : half, width: half, height: size, overflow: 'hidden' }}>
      <Animated.View testID={`agent-exit-progress-${side}`} style={{ width: size, height: size, position: 'absolute', left: index ? 0 : -half,
        transform: [{ rotate: progress.interpolate({ inputRange: index ? [.5, 1] : [0, .5], outputRange: ['-180deg', '0deg'], extrapolate: 'clamp' }) }],
      }}>
        <View style={{ position: 'absolute', left: index ? 0 : half, width: half, height: size, overflow: 'hidden' }}>
          <View style={[styles.arc, { left: index ? 0 : -half, width: size, height: size, borderRadius: half }]} />
        </View>
      </Animated.View>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  container: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', borderWidth: 3, borderColor: '#DAC7FF25' },
  arc: { position: 'absolute', borderWidth: 3, borderColor: '#E7D6FF' },
});

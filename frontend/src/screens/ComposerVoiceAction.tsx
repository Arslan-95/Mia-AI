import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View } from 'react-native';
import { useReducedMotion } from '../motion';
import { Icon, useUi } from '../ui';

/** One anchored touch target: only its decoration scales during a recording. */
export function ComposerVoiceAction({ active, cancelReady, busy, send, progress }: {
  active: boolean; cancelReady: boolean; busy: boolean; send: boolean; progress: Animated.Value;
}) {
  const { colors } = useUi();
  const reduced = useReducedMotion();
  const expansion = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { expansion.setValue(active ? 1 : 0); return; }
    const motion = Animated.timing(expansion, { toValue: active ? 1 : 0, duration: 160, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    motion.start(); return () => motion.stop();
  }, [active, reduced, expansion]);
  return <View testID="composer-voice-visual" pointerEvents="none" accessible={false} style={styles.visual}>
    <Animated.View testID="composer-cancel-boundary" style={[styles.boundary, { opacity: expansion, borderColor: cancelReady ? colors.red : colors.accentLight }]}>
      <Animated.View style={[styles.cancelFill, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, .65] }),
        transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [.5, 1] }) }] }]} />
    </Animated.View>
    <Animated.View testID="composer-action-core" style={[styles.core, { backgroundColor: cancelReady ? '#A13A61' : colors.accent,
      transform: [{ scale: expansion.interpolate({ inputRange: [0, 1], outputRange: [1, 1.16] }) }] }]} />
    {busy && !cancelReady ? <ActivityIndicator color={colors.white} size="small" /> : <>
      <Animated.View style={[styles.symbol, { opacity: expansion.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}><Icon name={send ? 'arrow-up' : 'mic'} size={21} color={colors.white} /></Animated.View>
      <Animated.View style={[styles.symbol, { opacity: expansion }]}>{cancelReady ? <Icon name="trash-outline" size={23} color={colors.white} /> : <View testID="composer-recording-stop" style={[styles.stop, { backgroundColor: colors.white }]} />}</Animated.View>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  visual: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  core: { position: 'absolute', width: 44, height: 44, borderRadius: 22 },
  boundary: { position: 'absolute', width: 88, height: 88, borderRadius: 44, borderWidth: 1, overflow: 'hidden' },
  cancelFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 44, backgroundColor: '#B95579' },
  symbol: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  stop: { width: 14, height: 14, borderRadius: 4 },
});

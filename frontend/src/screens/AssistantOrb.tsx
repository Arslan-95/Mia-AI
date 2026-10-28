import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Mia } from '../useMia';
import type { VoicePhase } from '../voiceConversation';
import { Icon, colors, s } from '../ui';

const labels: Record<VoicePhase, string> = {
  off: 'Ready when you are', waiting: 'Connecting', listening: 'Listening',
  transcribing: 'Understanding', thinking: 'Thinking', speaking: 'Speaking',
  paused: 'On standby', error: 'Let’s try again',
};

export function MiaCore({ phase = 'off', compact = false, level = 0 }: { phase?: VoicePhase; compact?: boolean; level?: number }) {
  const energy = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const rotation = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const animation = Animated.timing(energy, { toValue: reduceMotion ? 0 : level, duration: 90, useNativeDriver: true });
    animation.start(); return () => animation.stop();
  }, [level, energy, reduceMotion]);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    pulse.setValue(0); rotation.setValue(0);
    if (reduceMotion || phase === 'paused' || phase === 'error') return;
    const speaking = phase === 'speaking';
    const breathing = Animated.loop(Animated.sequence(
      (speaking ? [1, .25, .8, 0] : [1, 0]).map(toValue => Animated.timing(pulse, {
        toValue, duration: speaking ? 260 : phase === 'listening' ? 1300 : 2100,
        easing: Easing.inOut(Easing.sin), useNativeDriver: true,
      })),
    ));
    const orbit = Animated.loop(Animated.timing(rotation, { toValue: 1, duration: phase === 'thinking' ? 5000 : 18000, easing: Easing.linear, useNativeDriver: true }));
    breathing.start(); orbit.start();
    return () => { breathing.stop(); orbit.stop(); };
  }, [phase, reduceMotion, pulse, rotation]);
  const size = compact ? 48 : 192;
  return <View accessible={false} pointerEvents="none" style={{ width: size * 1.5, height: size * 1.5, alignItems: 'center', justifyContent: 'center' }}>
    <Animated.View style={[orb.halo, { width: size * 1.26, height: size * 1.26, borderRadius: size, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [.22, .6] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, phase === 'speaking' ? 1.16 : 1.06] }) }] }]} />
    {!compact && <Animated.View style={[orb.outerOrbit, { transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}><View style={orb.satellite} /></Animated.View>}
    <Animated.View style={[orb.sphere, { width: size, height: size, borderRadius: size / 2, opacity: phase === 'paused' ? .55 : 1, transform: [{ scale: Animated.add(pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] }), energy.interpolate({ inputRange: [0, 1], outputRange: [0, .13] })) }] }]}>
      <View style={[orb.innerLight, { width: size * .88, height: size * .88, borderRadius: size }]} />
      <View style={[orb.reflection, { width: size * .58, height: size * .58, borderRadius: size }]} />
      <View style={[orb.sphereContour, { borderRadius: size, inset: compact ? 4 : 12 }]} />
      <Text style={[orb.monogram, { fontSize: compact ? 12 : 38, letterSpacing: compact ? 2 : 8, marginLeft: compact ? 2 : 8 }]}>MIA</Text>
    </Animated.View>
  </View>;
}

export function AssistantOrb({ mia }: { mia: Mia }) {
  return <Pressable accessibilityRole="switch" accessibilityLabel="Mia voice mode" accessibilityState={{ checked: mia.aiMode }}
    accessibilityHint="Enter voice mode. Tap anywhere to mute, hold anywhere to exit."
    onPress={() => void mia.saveAiMode(true).catch(mia.fail)}
    style={({ pressed }) => [orb.launcher, { opacity: pressed ? .7 : 1 }]}>
    <MiaCore compact />
  </Pressable>;
}

export function VoiceMode({ mia }: { mia: Mia }) {
  const phase = mia.microphoneMuted ? 'paused' : mia.voicePhase;
  const chat = mia.chats.find(item => item.id === mia.activeChatId);
  const context = chat && mia.tab === 'chats' ? chat.recipient.displayName : mia.tab === 'people' ? 'People' : mia.tab === 'settings' ? 'Settings' : 'Chats';
  const status = mia.microphoneMuted ? 'Microphone off' : labels[phase];
  const exit = () => void mia.saveAiMode(false).catch(mia.fail);
  return <Pressable style={orb.screen} accessibilityRole="switch"
    accessibilityLabel={`Mia voice mode. ${status}. Tap to ${mia.microphoneMuted ? 'unmute' : 'mute'} microphone.`}
    accessibilityHint="Double tap to toggle microphone. Long press to exit voice mode."
    accessibilityState={{ checked: !mia.microphoneMuted }}
    accessibilityViewIsModal
    accessibilityActions={[{ name: 'deactivate', label: 'Exit voice mode' }]}
    onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'deactivate') exit(); }}
    onAccessibilityEscape={exit}
    onPress={() => void mia.toggleMicrophone().catch(mia.fail)}
    onLongPress={exit} delayLongPress={650}>
    <SafeAreaView pointerEvents="none" style={orb.safe}>
      <View style={orb.top}><Text style={orb.brand}>mia<Text style={{ color: colors.accent }}>.</Text></Text><View style={orb.modeBadge}><View style={orb.statusDot} /><Text style={orb.modeText}>VOICE MODE</Text></View></View>
      <View style={orb.center}>
        <View style={orb.ambient} />
        <MiaCore phase={phase} level={mia.microphoneMuted ? 0 : mia.voiceLevel} />
        <View style={orb.status}>
          <Text style={orb.statusTitle}>{status}<Text style={{ color: colors.accent }}>{['thinking', 'transcribing', 'waiting'].includes(phase) ? '…' : '.'}</Text></Text>
          <Text style={[s.body, { textAlign: 'center' }]}>{mia.microphoneMuted ? 'A moment of quiet. Take your time.' : phase === 'listening' ? 'Go ahead. I’m here.' : phase === 'speaking' ? 'Just a conversation. Naturally.' : phase === 'error' ? 'Mute and unmute to reconnect.' : 'One moment. Stay with me.'}</Text>
        </View>
        {!!mia.error && <Text style={orb.error}>{mia.error}</Text>}
        {!!mia.devicePrompt && <Text style={orb.error}>Hold to exit voice mode and review the recording request.</Text>}
      </View>
      <View style={orb.footer}>
        <View style={orb.context}><Icon name={chat ? 'chatbubble-outline' : 'layers-outline'} size={14} color={colors.muted} /><Text numberOfLines={1} style={s.small}>{context}</Text></View>
        <View style={orb.tapHint}><Icon name={mia.microphoneMuted ? 'mic-off-outline' : 'mic-outline'} size={20} color={colors.accentLight} /><Text style={orb.hint}>Tap anywhere to {mia.microphoneMuted ? 'unmute' : 'mute'}</Text></View>
        <Text style={orb.exitHint}>Hold anywhere to exit voice mode</Text>
      </View>
    </SafeAreaView>
  </Pressable>;
}

const orb = StyleSheet.create({
  launcher: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center', marginTop: -24, borderRadius: 38, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.line },
  halo: { position: 'absolute', backgroundColor: '#6D3DD0', borderWidth: 1, borderColor: '#9972EC', shadowColor: '#9864FF', shadowOpacity: .7, shadowRadius: 36, shadowOffset: { width: 0, height: 0 } },
  sphere: { backgroundColor: '#452983', borderWidth: 1, borderColor: '#B297F3', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', shadowColor: '#AB82FF', shadowOpacity: .65, shadowRadius: 24, shadowOffset: { width: 0, height: 0 } },
  innerLight: { position: 'absolute', top: '-14%', left: '-9%', backgroundColor: '#8761C5', opacity: .68 },
  reflection: { position: 'absolute', top: '-21%', left: '9%', backgroundColor: '#D2C1F1', opacity: .3 },
  sphereContour: { position: 'absolute', borderWidth: 1, borderColor: '#E4CDFF24' },
  monogram: { color: '#F5ECFF', fontWeight: '500' },
  outerOrbit: { position: 'absolute', width: 278, height: 278, borderRadius: 139, borderWidth: 1, borderColor: '#9471F729', borderLeftColor: '#B99AF580', borderBottomColor: '#B99AF552' },
  satellite: { position: 'absolute', width: 5, height: 5, borderRadius: 3, backgroundColor: '#DAC7FF', top: 37, right: 37 },
  screen: { ...StyleSheet.absoluteFillObject, zIndex: 20, backgroundColor: colors.background },
  safe: { flex: 1, paddingHorizontal: 28 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 18 },
  brand: { color: colors.ink, fontSize: 30, fontWeight: '600', letterSpacing: -2 },
  modeBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: '#3A2B53', backgroundColor: '#1D162B', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 },
  statusDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accentLight },
  modeText: { color: colors.accentLight, fontSize: 9, letterSpacing: 1.8, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 350 },
  ambient: { position: 'absolute', width: 330, height: 330, borderRadius: 165, backgroundColor: '#151020', shadowColor: '#6635B0', shadowOpacity: .24, shadowRadius: 90, shadowOffset: { width: 0, height: 0 } },
  status: { gap: 10, alignItems: 'center', marginTop: 30, minHeight: 84 },
  statusTitle: { fontSize: 29, fontWeight: '500', letterSpacing: -1, color: colors.ink, textAlign: 'center' },
  error: { color: colors.red, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 330, marginTop: 12 },
  footer: { alignItems: 'center', paddingBottom: 26, gap: 18 },
  context: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '90%', marginBottom: 16, paddingVertical: 7, paddingHorizontal: 13, borderRadius: 20, borderWidth: 1, borderColor: colors.line },
  tapHint: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hint: { color: '#D8CDEC', fontSize: 14 }, exitHint: { color: colors.muted, fontSize: 12 },
});

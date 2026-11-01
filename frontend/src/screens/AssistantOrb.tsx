import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import type { VoicePhase } from '../voiceConversation';
import { Icon, agentColors as colors } from '../ui';
import { agentDockGeometry, type RecordingGesture } from '../voiceNoteGesture';
import { AgentRecordingAura } from './AgentRecordingAura';
import { AgentExitProgress } from './AgentExitProgress';
import { ConversationStatus } from './ConversationStatus';
import { useReducedMotion } from '../motion';
import { useOrbBlend, useOrbPresence, useOrbRotation } from './orbMotion';

const labels: Record<VoicePhase, string> = {
  off: 'Ready when you are', waiting: 'Connecting', listening: 'Listening to you',
  transcribing: 'Understanding', thinking: 'Thinking it through', speaking: 'Mia is speaking',
  paused: 'On standby', error: 'Let’s reconnect',
};
function voiceStatus(mia: Mia): { phase: VoicePhase; status: string } {
  if (!mia.voiceFault && mia.audioState === 'playing' && mia.originalPlayback) {
    if (mia.originalPlayback.state === 'paused') return { phase: mia.microphoneMuted ? 'paused' as VoicePhase : mia.voicePhase,
      status: mia.microphoneMuted ? 'Voice message paused · Microphone muted' : mia.voicePhase === 'listening' ? 'Listening · Voice message paused' : 'Voice message paused' };
    if (mia.originalPlayback.state === 'playing') return { phase: 'speaking' as VoicePhase, status: 'Playing voice message' };
    if (mia.originalPlayback.state === 'preparing' || mia.originalPlayback.state === 'buffering') return { phase: 'thinking' as VoicePhase,
      status: mia.originalPlayback.state === 'buffering' ? 'Buffering voice message' : 'Preparing voice message' };
  }
  const working = mia.voicePhase === 'thinking' || mia.voicePhase === 'speaking';
  const phase = mia.voicePhase === 'waiting' ? 'waiting' : mia.microphoneMuted && !working ? 'paused' : mia.voicePhase;
  return { phase, status: mia.microphoneMuted && !working ? 'Microphone muted' : labels[phase] };
}

/** Layered native shapes keep the core sharp at every size, without image assets. */
export function MiaCore({ phase = 'off', compact = false, level = 0, diameter, error = false, recording = false, microphoneMuted = false }: { phase?: VoicePhase; compact?: boolean; level?: number; diameter?: number; error?: boolean; recording?: boolean; microphoneMuted?: boolean }) {
  const reduceMotion = useReducedMotion();
  const paused = phase === 'paused';
  const speaking = phase === 'speaking';
  const still = paused || phase === 'error';
  const warmth = useOrbBlend(error || phase === 'error' ? .48 : 0, reduceMotion);
  const energy = useOrbBlend(reduceMotion || still ? 0 : Math.min(1, Math.max(0, level)), reduceMotion, 90);
  // Input mute stays visible while output is speaking, thinking or connecting.
  const standby = useOrbBlend(paused || microphoneMuted ? 1 : 0, reduceMotion);
  const speech = useOrbBlend(speaking ? 1 : 0, reduceMotion);
  const rotation = useOrbRotation(still ? 0 : 1 / (phase === 'thinking' ? 4200 : 16000), reduceMotion);
  const connection = useOrbRotation(phase === 'waiting' ? -1 / 1800 : 0, reduceMotion);
  const connecting = useOrbPresence(phase === 'waiting', reduceMotion);
  const microphone = useOrbPresence(recording, reduceMotion);
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion || still) {
      const settle = Animated.timing(pulse, { toValue: 0, duration: reduceMotion ? 0 : 400, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false });
      settle.start();
      return () => settle.stop();
    }
    const breathing = Animated.loop(Animated.sequence(
      (speaking ? [1, .25, .8, 0] : [1, 0]).map(toValue => Animated.timing(pulse, {
        toValue, duration: speaking ? 260 : phase === 'listening' ? 1300 : 2100,
        easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false,
      })),
    ), { resetBeforeIteration: false });
    breathing.start();
    return () => breathing.stop();
  }, [phase, speaking, still, reduceMotion, pulse]);
  const size = diameter ?? (compact ? 48 : 192);
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ width: size * 1.42, height: size * 1.42, alignItems: 'center', justifyContent: 'center' }}>
    <Animated.View style={[orb.halo, { width: size * 1.24, height: size * 1.24, borderRadius: size, opacity: Animated.add(standby.interpolate({ inputRange: [0, 1], outputRange: [.2, .08] }), pulse.interpolate({ inputRange: [0, 1], outputRange: [0, .26] })), transform: [{ scale: Animated.add(1, Animated.multiply(pulse, speech.interpolate({ inputRange: [0, 1], outputRange: [.05, .14] }))) }] }]} />
    <Animated.View style={[orb.outerOrbit, { width: size * 1.34, height: size * 1.34, borderRadius: size, transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}><View style={[orb.satellite, { top: '12%', right: '12%' }]} /></Animated.View>
    {connecting.visible && <Animated.View testID="mia-connecting-orbit" style={{ position: 'absolute', width: size * 1.13, height: size * 1.13, borderRadius: size, borderWidth: 2, borderColor: '#9471F720', borderTopColor: '#DAC7FF', borderRightColor: '#AA81E990', opacity: connecting.opacity, transform: [{ rotate: connection.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }} />}
    <Animated.View style={[orb.sphere, { width: size, height: size, borderRadius: size / 2, backgroundColor: standby.interpolate({ inputRange: [0, 1], outputRange: ['#49258B', '#322B49'] }), opacity: standby.interpolate({ inputRange: [0, 1], outputRange: [1, .65] }), transform: [{ scale: Animated.add(pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] }), energy.interpolate({ inputRange: [0, 1], outputRange: [0, .13] })) }] }]}>
      <Animated.View style={[orb.lowerLight, { width: size * .94, height: size * .8, borderRadius: size, backgroundColor: speech.interpolate({ inputRange: [0, 1], outputRange: ['#6E87E5', '#D5A2EA'] }) }]} />
      <Animated.View style={[orb.flow, { width: size * 1.14, height: size * .65, borderRadius: size, transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['-35deg', '325deg'] }) }] }]} />
      <View style={[orb.innerLight, { width: size * .82, height: size * .7, borderRadius: size }]} />
      <View style={[orb.reflection, { width: size * .56, height: size * .24, borderRadius: size }]} />
      <View style={[orb.sphereContour, { borderRadius: size, inset: size * .07 }]} />
      <View style={[orb.seed, { width: size * .22, height: size * .22, borderRadius: size }]} />
      <Animated.View testID="mia-error-tint" style={{ position: 'absolute', inset: 0, backgroundColor: '#AA426E', opacity: warmth, borderRadius: size / 2 }} />
      {microphone.visible && <Animated.View style={{ position: 'absolute', inset: 0, opacity: microphone.opacity, transform: [{ scale: microphone.opacity.interpolate({ inputRange: [0, 1], outputRange: [.85, 1] }) }] }}><View testID="mia-recording-microphone" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Icon name="mic" size={size * .34} color="#F2E6FF" /></View></Animated.View>}
    </Animated.View>
  </View>;
}

/** The dock stays visible while the full-screen interaction layer owns gestures. */
export function VoiceMode({ mia, bottomInset = 0, holding = false, exitProgress, elapsed = 0, recordingGesture, recordingProgress }: {
  mia: Mia; bottomInset?: number; holding?: boolean; elapsed?: number;
  recordingGesture: RecordingGesture; recordingProgress: Animated.Value; exitProgress?: Animated.Value;
}) {
  const [errorWarmth, setErrorWarmth] = useState(false);
  useEffect(() => {
    if (!mia.error) { setErrorWarmth(false); return; }
    setErrorWarmth(true);
    const timer = setTimeout(() => { setErrorWarmth(false); if (!mia.voiceFault && !mia.recording) mia.setError(''); }, 3000);
    return () => clearTimeout(timer);
  }, [mia.error, mia.errorRevision, mia.voiceFault, !!mia.recording]);
  const { height, fontScale } = useWindowDimensions();
  const { phase } = voiceStatus(mia);
  const chat = mia.tab === 'chats' ? mia.chats.find(item => item.id === mia.activeChatId) : undefined;
  const recording = mia.audioState === 'recording';
  const sending = mia.voiceNoteStage === 'sending' || mia.voiceNoteStage === 'saving';
  const active = recordingGesture.active || recording;
  const cancelling = active && recordingGesture.cancelReady;
  const sent = mia.voiceNoteStage === 'sent';
  const discarded = mia.voiceNoteStage === 'discarded';
  const reduced = useReducedMotion();
  const sentResult = useOrbPresence(sent, reduced);
  const discardedResult = useOrbPresence(discarded, reduced);
  const draft = chat ? mia.drafts.find(item => item.recipientId === chat.recipient.id) : undefined;
  const showTimer = active || sending || !!mia.recording;
  const { diameter, radius, centreY, headroom, bodyHeight } = agentDockGeometry(height, fontScale, bottomInset, active, showTimer);
  return <>
    {(!!mia.error || !!draft) && <View testID="agent-feedback" pointerEvents="none" style={orb.feedback}>
      <ConversationStatus error={mia.error} draft={draft} passive />
    </View>}
    <View testID="agent-dock" style={[orb.dock, { marginTop: headroom, height: bodyHeight }]}>
      <View pointerEvents="none" style={[orb.rails, { top: centreY }]}><View style={orb.rail} /><View style={{ width: diameter * 1.6 }} /><View style={orb.rail} /></View>
      <View style={[orb.coreControl, { top: centreY - radius, width: radius * 2, height: radius * 2 }]}><AgentRecordingAura active={active} cancelReady={cancelling} progress={recordingProgress} diameter={diameter} radius={radius}>
        <MiaCore phase={sending ? 'thinking' : active ? 'listening' : phase} microphoneMuted={mia.microphoneMuted} diameter={diameter} level={active || phase === 'paused' ? 0 : mia.voiceLevel} error={errorWarmth} recording={recording} />
      </AgentRecordingAura>
      {holding && exitProgress && <AgentExitProgress progress={exitProgress} diameter={diameter} />}
      {sentResult.visible && <Animated.View testID="agent-recording-sent" style={[orb.resultSymbol, { opacity: sentResult.opacity, transform: [{ scale: sentResult.opacity.interpolate({ inputRange: [0, 1], outputRange: [.85, 1] }) }] }]}><Icon name="checkmark" size={24} color="#EADFFF" /></Animated.View>}
      {discardedResult.visible && <Animated.View testID="agent-recording-discarded" style={[orb.resultSymbol, { opacity: discardedResult.opacity, transform: [{ scale: discardedResult.opacity.interpolate({ inputRange: [0, 1], outputRange: [.85, 1] }) }] }]}><Icon name="trash-outline" size={22} color={colors.red} /></Animated.View>}
      {showTimer && <Text testID="agent-recording-timer" style={[orb.recordingTime, { bottom: radius - diameter / 2 - 24 }, cancelling && orb.cancelText]}>{`${Math.floor((recording ? elapsed : (mia.recording?.durationMs ?? 0) / 1000) / 60)}:${String(Math.floor(recording ? elapsed : (mia.recording?.durationMs ?? 0) / 1000) % 60).padStart(2, '0')}`}{recording ? ' / 2:00' : ''}</Text>}
      </View>
    </View>
  </>;
}

const orb = StyleSheet.create({
  halo: { position: 'absolute', backgroundColor: '#6734BB', borderWidth: 1, borderColor: '#9972EC', shadowColor: '#9864FF', shadowOpacity: .6, shadowRadius: 24, shadowOffset: { width: 0, height: 0 } },
  sphere: { borderWidth: 1, borderColor: '#C6AEFF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', shadowColor: '#A885FF', shadowOpacity: .7, shadowRadius: 18, shadowOffset: { width: 0, height: 0 } },
  lowerLight: { position: 'absolute', bottom: '-23%', right: '-18%', opacity: .82 },
  flow: { position: 'absolute', borderWidth: 7, borderColor: '#A58AFF', borderTopColor: '#E7CFFF', backgroundColor: '#8452CB', opacity: .65 },
  innerLight: { position: 'absolute', top: '-29%', left: '-10%', backgroundColor: '#C09CEE', opacity: .7 },
  reflection: { position: 'absolute', top: '11%', left: '10%', backgroundColor: '#F8E8FF', opacity: .38, transform: [{ rotate: '-33deg' }] },
  seed: { position: 'absolute', backgroundColor: '#F1DEFF', opacity: .28, top: '35%', left: '29%' },
  sphereContour: { position: 'absolute', borderWidth: 1, borderColor: '#E4CDFF32' },
  outerOrbit: { position: 'absolute', borderWidth: 1, borderColor: '#9471F71A', borderLeftColor: '#B99AF580', borderBottomColor: '#B99AF552' },
  satellite: { position: 'absolute', width: 3, height: 3, borderRadius: 2, backgroundColor: '#DAC7FF' },
  dock: { flexShrink: 0, backgroundColor: 'transparent', marginTop: 12, overflow: 'visible' },
  rails: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', alignItems: 'center' },
  rail: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: '#A48BC5', opacity: .4 },
  feedback: { flexShrink: 0, paddingHorizontal: 16, paddingTop: 8 },
  coreControl: { position: 'absolute', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', borderRadius: 80 },
  recordingTime: { color: '#D4C0FF', fontSize: 12, lineHeight: 18, fontVariant: ['tabular-nums'], textAlign: 'center', position: 'absolute' },
  cancelText: { color: colors.red },
  resultSymbol: { position: 'absolute', width: 44, height: 44, borderRadius: 22, backgroundColor: '#322044E8', alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: .6 },
});

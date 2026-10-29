import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import type { VoicePhase } from '../voiceConversation';
import { Icon, colors, s } from '../ui';

const labels: Record<VoicePhase, string> = {
  off: 'Ready when you are', waiting: 'Connecting', listening: 'Listening to you',
  transcribing: 'Understanding', thinking: 'Thinking it through', speaking: 'Mia is speaking',
  paused: 'On standby', error: 'Let’s reconnect',
};
function voiceStatus(mia: Mia) {
  const working = mia.voicePhase === 'thinking' || mia.voicePhase === 'speaking';
  const phase = mia.microphoneMuted && !working ? 'paused' : mia.voicePhase;
  return { phase, status: mia.microphoneMuted && !working ? 'Microphone muted' : labels[phase] };
}

/** Layered native shapes keep the core sharp at every size, without image assets. */
export function MiaCore({ phase = 'off', compact = false, level = 0, diameter }: { phase?: VoicePhase; compact?: boolean; level?: number; diameter?: number }) {
  const energy = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const rotation = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const animation = Animated.timing(energy, { toValue: reduceMotion ? 0 : Math.min(1, Math.max(0, level)), duration: 90, useNativeDriver: true });
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
    const orbit = Animated.loop(Animated.timing(rotation, { toValue: 1, duration: phase === 'thinking' ? 4200 : 16000, easing: Easing.linear, useNativeDriver: true }));
    breathing.start(); orbit.start();
    return () => { breathing.stop(); orbit.stop(); };
  }, [phase, reduceMotion, pulse, rotation]);
  const size = diameter ?? (compact ? 48 : 192);
  const paused = phase === 'paused';
  const speaking = phase === 'speaking';
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ width: size * 1.42, height: size * 1.42, alignItems: 'center', justifyContent: 'center' }}>
    <Animated.View style={[orb.halo, { width: size * 1.24, height: size * 1.24, borderRadius: size, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [paused ? .08 : .2, .46] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, speaking ? 1.14 : 1.05] }) }] }]} />
    <Animated.View style={[orb.outerOrbit, { width: size * 1.34, height: size * 1.34, borderRadius: size, transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}><View style={[orb.satellite, { top: '12%', right: '12%' }]} /></Animated.View>
    <Animated.View style={[orb.sphere, { width: size, height: size, borderRadius: size / 2, backgroundColor: paused ? '#322B49' : '#49258B', opacity: paused ? .65 : 1, transform: [{ scale: Animated.add(pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.025] }), energy.interpolate({ inputRange: [0, 1], outputRange: [0, .13] })) }] }]}>
      <View style={[orb.lowerLight, { width: size * .94, height: size * .8, borderRadius: size, backgroundColor: speaking ? '#D5A2EA' : '#6E87E5' }]} />
      <Animated.View style={[orb.flow, { width: size * 1.14, height: size * .65, borderRadius: size, transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['-35deg', '325deg'] }) }] }]} />
      <View style={[orb.innerLight, { width: size * .82, height: size * .7, borderRadius: size }]} />
      <View style={[orb.reflection, { width: size * .56, height: size * .24, borderRadius: size }]} />
      <View style={[orb.sphereContour, { borderRadius: size, inset: size * .07 }]} />
      <View style={[orb.seed, { width: size * .22, height: size * .22, borderRadius: size }]} />
    </Animated.View>
  </View>;
}

export function AgentHome({ mia }: { mia: Mia }) {
  const { status, phase } = voiceStatus(mia);
  const latest = mia.turns[0];
  const unread = mia.chats.reduce((sum, chat) => sum + chat.unreadCount, 0);
  return <ScrollView testID="agent-home" contentContainerStyle={home.content} keyboardShouldPersistTaps="handled">
    <View style={home.header}><Text style={home.brand}>mia<Text style={{ color: colors.accent }}>.</Text></Text><View style={home.headerActions}><View style={home.badge}><View style={home.dot} /><Text style={home.badgeText}>AGENT MODE</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Open agent settings" onPress={() => void mia.navigate('settings')} style={({ pressed }) => [home.settings, pressed && orb.pressed]}><Icon name="options-outline" size={20} color={colors.accentLight} /></Pressable></View></View>
    <View style={home.intro}>
      <Text style={home.eyebrow}>A LITTLE LESS EFFORT</Text>
      <Text accessibilityRole="header" style={home.title}>Here with you.</Text>
      <Text style={home.subtitle}>Your people. Your conversations.{ '\n' }Just say what’s on your mind.</Text>
    </View>
    <View style={home.liveCard}>
      <View style={home.liveHeader}><View style={home.liveIcon}><Icon name={phase === 'error' ? 'refresh-outline' : mia.microphoneMuted ? 'mic-off-outline' : 'sparkles-outline'} size={19} color={colors.accentLight} /></View><View style={home.liveText}><Text style={home.liveTitle}>{status}</Text><Text style={s.small}>{mia.microphoneMuted ? 'Tap anywhere whenever you’re ready.' : phase === 'listening' ? 'Ask me to open a chat or help with a reply.' : phase === 'error' ? 'Mute, then unmute to try again.' : 'I’ll keep the right screen open as we go.'}</Text></View></View>
      <View style={home.cardRule} />
      <Text style={home.example}>Try saying</Text>
      <Text style={home.prompt}>“Show me my unread messages.”</Text>
    </View>
    <View style={home.sectionHeader}><Text style={home.sectionTitle}>Your space</Text><Text style={s.small}>Always within reach</Text></View>
    <View style={home.shortcuts}>
      <HomeLink icon="chatbubbles-outline" title="Conversations" detail={unread ? `${unread} unread ${unread === 1 ? 'message' : 'messages'}` : `${mia.chats.length} ${mia.chats.length === 1 ? 'chat' : 'chats'}`} onPress={() => void mia.navigate('chats')} />
      <HomeLink icon="people-outline" title="Your people" detail={`${mia.contacts.length} ${mia.contacts.length === 1 ? 'contact' : 'contacts'}`} onPress={() => void mia.navigate('people')} />
      <HomeLink icon="bookmark-outline" title="Saved messages" detail={mia.drafts.length ? `${mia.drafts.length} to review` : 'Nothing waiting for review'} onPress={() => void mia.navigate('drafts')} />
    </View>
    {latest && <View style={home.conversation}>
      <Text style={home.eyebrow}>LATEST CONVERSATION</Text>
      <Text selectable style={home.userText}>{latest.userText}</Text>
      {latest.assistantText ? <Text selectable style={s.body}>{latest.assistantText}</Text> : <Text style={s.small}>{latest.status === 'failed' ? 'That request couldn’t be completed.' : latest.status === 'interrupted' ? 'Conversation interrupted.' : 'Working on your request…'}</Text>}
    </View>}
    <View style={home.privacy}><Icon name="mic-outline" size={14} color={colors.muted} /><Text style={home.privacyText}>You’re in control. Tap anywhere to mute your microphone.</Text></View>
  </ScrollView>;
}
function HomeLink({ icon, title, detail, onPress }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; detail: string; onPress(): void }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => [home.link, pressed && { backgroundColor: colors.soft }, focused && s.focus]}>
    <View style={home.linkIcon}><Icon name={icon} size={21} color={colors.accentLight} /></View><View style={home.liveText}><Text style={home.linkTitle}>{title}</Text><Text style={s.small}>{detail}</Text></View><Icon name="chevron-forward" size={15} color="#777087" />
  </Pressable>;
}

/** The dock stays visible while the full-screen interaction layer owns gestures. */
export function VoiceMode({ mia, bottomInset = 0, holding = false }: { mia: Mia; bottomInset?: number; holding?: boolean }) {
  const { height, fontScale } = useWindowDimensions();
  const { phase, status } = voiceStatus(mia);
  const chat = mia.chats.find(item => item.id === mia.activeChatId);
  const context = chat && mia.tab === 'chats' ? chat.recipient.displayName : mia.tab === 'people' ? 'Contacts' : mia.tab === 'settings' ? 'Settings' : mia.tab === 'drafts' ? 'Saved messages' : mia.tab === 'assistant' ? 'Your assistant' : 'Chats';
  const small = height < 670 || fontScale > 1.4;
  return <View testID="agent-dock" style={[orb.dock, { paddingBottom: Math.max(bottomInset, 10) }]}>
    <View pointerEvents="none" style={orb.dockShine} />
    <View style={orb.dockHeading}><View style={[home.dot, phase === 'error' && { backgroundColor: colors.red }, phase === 'paused' && { backgroundColor: colors.muted }]} /><Text style={orb.statusText}>{status}</Text><Text numberOfLines={1} style={orb.contextText}>· {context}</Text></View>
    <View style={orb.controls}>
      <View style={orb.sideControl}>
        <View style={[orb.controlIcon, mia.microphoneMuted && orb.selectedIcon]}><Icon name={mia.microphoneMuted ? 'mic-off-outline' : 'mic-outline'} size={20} color={colors.accentLight} /></View><Text style={orb.controlLabel}>Tap anywhere</Text>
      </View>
      <View style={orb.coreControl}><MiaCore phase={phase} diameter={small ? 62 : 74} level={phase === 'paused' ? 0 : mia.voiceLevel} /></View>
      <View style={orb.sideControl}>
        <View style={[orb.controlIcon, holding && orb.selectedIcon]}><Icon name={holding ? 'hourglass-outline' : 'power-outline'} size={20} color={holding ? colors.ink : colors.muted} /></View><Text style={orb.controlLabel}>{holding ? 'Hold…' : 'Hold 5s to exit'}</Text>
      </View>
    </View>
    <Text style={orb.hint}>{holding ? 'Keep holding for 5 seconds to leave' : mia.devicePrompt ? 'Hold anywhere for 5 seconds to use recording controls' : phase === 'error' ? 'Mute, then unmute to reconnect' : mia.microphoneMuted ? 'Tap anywhere to unmute' : 'Tap anywhere to mute'}</Text>
  </View>;
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
  dock: { flexShrink: 0, borderTopWidth: 1, borderTopColor: '#382B50', backgroundColor: '#110E1C', paddingHorizontal: 20, paddingTop: 12 },
  dockShine: { position: 'absolute', top: 0, left: '29%', right: '29%', height: 1, backgroundColor: '#B79CEB', opacity: .65 },
  dockHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', columnGap: 6, rowGap: 3 },
  statusText: { color: '#E2D6F6', fontSize: 12, fontWeight: '600' },
  contextText: { color: '#A59BB7', fontSize: 11, flexShrink: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 },
  sideControl: { flex: 1, minWidth: 44, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 16, paddingVertical: 5 },
  controlIcon: { minWidth: 44, height: 34, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  selectedIcon: { backgroundColor: '#2B2040' },
  controlLabel: { color: '#ACA1BE', fontSize: 10, textAlign: 'center' },
  coreControl: { alignItems: 'center', justifyContent: 'center', borderRadius: 60, minWidth: 88, minHeight: 88 },
  hint: { color: '#A99ABF', fontSize: 10, textAlign: 'center', paddingTop: 1, paddingBottom: 2 },
  pressed: { opacity: .6 },
});
const home = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 28, gap: 18, width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  settings: { minWidth: 44, minHeight: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#191224' },
  brand: { color: colors.ink, fontSize: 32, fontWeight: '600', letterSpacing: -2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: '#3B2C50', backgroundColor: '#191224', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 7 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#BD9CFB' },
  badgeText: { color: '#C7B0E9', fontSize: 9, letterSpacing: 1.4, fontWeight: '600' },
  intro: { paddingTop: 13, gap: 11 },
  eyebrow: { color: '#AF98CF', fontSize: 9, letterSpacing: 1.7, fontWeight: '600' },
  title: { color: '#F4EEFF', fontSize: 36, fontWeight: '500', letterSpacing: -1.5 },
  subtitle: { color: '#ACA2BD', fontSize: 14, lineHeight: 22 },
  liveCard: { backgroundColor: '#1B1429', borderColor: '#3A2B50', borderWidth: 1, borderRadius: 22, padding: 17, gap: 13, overflow: 'hidden' },
  liveHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  liveIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: '#352448', alignItems: 'center', justifyContent: 'center' },
  liveText: { flex: 1, minWidth: 0, gap: 4 },
  liveTitle: { color: '#EADFFA', fontWeight: '600', fontSize: 14 },
  cardRule: { height: 1, backgroundColor: '#3A2B4B' },
  example: { color: '#AC99C4', fontSize: 10 },
  prompt: { color: '#E5D9F6', fontSize: 15, lineHeight: 23 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', paddingTop: 5 },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: colors.ink, letterSpacing: -.3 },
  shortcuts: { backgroundColor: '#121019', borderColor: '#292232', borderWidth: 1, borderRadius: 20, overflow: 'hidden', gap: 2, padding: 4 },
  link: { flexDirection: 'row', alignItems: 'center', minHeight: 71, padding: 11, gap: 12, borderRadius: 16 },
  linkIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#20192D' },
  linkTitle: { fontSize: 13, fontWeight: '500', color: '#E1D8EE' },
  conversation: { borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 18, gap: 13, backgroundColor: '#111017' },
  userText: { color: '#E7DAF7', fontSize: 15, lineHeight: 23 },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 4 },
  privacyText: { color: '#8F859E', flex: 1, fontSize: 11, lineHeight: 17 },
});

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StatusBar, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMia, type Mia, type Tab } from './useMia';
import { Auth, CompleteProfile } from './screens/Auth';
import { Chats } from './screens/Chats';
import { VoiceMode } from './screens/AssistantOrb';
import { AgentInteraction } from './screens/AgentInteraction';
import { MessageReferenceCard } from './screens/MessageReferenceCard';
import { ChatTransitionOverlay, useChatTransition } from './screens/ChatTransition';
import { MessageDrafts } from './screens/MessageDrafts';
import { ConversationStatus } from './screens/ConversationStatus';
import { People } from './screens/People';
import { Settings } from './screens/Settings';
import { useKeyboardVisible } from './useKeyboardVisible';
import { Button, Empty, Icon, ScreenHeader, ScreenAtmosphere, UiProvider, useUi, agentColors, agentStyles, colors, s } from './ui';
import { usePressOpacity } from './motion';
import { agentDockGeometry, type RecordingGesture } from './voiceNoteGesture';

const tabs: { id: Tab; label: string; icon: React.ComponentProps<typeof Icon>['name']; activeIcon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { id: 'people', label: 'Contacts', icon: 'people-outline', activeIcon: 'people' },
  { id: 'chats', label: 'Chats', icon: 'chatbubbles-outline', activeIcon: 'chatbubbles' },
  { id: 'settings', label: 'Settings', icon: 'options-outline', activeIcon: 'options' },
];

function Application() {
  const transition = useChatTransition(useMia());
  const mia = transition.mia;
  const insets = useSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  const [agentOverlayHeight, setAgentOverlayHeight] = useState(0);
  const keyboardVisible = useKeyboardVisible();
  const bottomInset = keyboardVisible ? 0 : insets.bottom;
  const [elapsed, setElapsed] = useState(0);
  const [agentHolding, setAgentHolding] = useState(false);
  const [recordingGesture, setRecordingGesture] = useState<RecordingGesture>({ active: false, cancelReady: false });
  const recordingProgress = useRef(new Animated.Value(0)).current;
  const voiceMode = !!(mia.aiMode && mia.session?.user.profileComplete && !mia.booting);
  const ui = { colors: voiceMode ? agentColors : colors, s: voiceMode ? agentStyles : s };
  const chatOpen = mia.tab === 'chats' && mia.chats.some(chat => chat.id === mia.activeChatId);
  const fallbackFooterHeight = agentDockGeometry(height, fontScale, insets.bottom,
    recordingGesture.active || mia.audioState === 'recording',
    recordingGesture.active || mia.audioState === 'recording' || ['sending', 'saving'].includes(mia.voiceNoteStage) || !!mia.recording).totalHeight;
  const agentFooterClearance = voiceMode ? agentOverlayHeight || fallbackFooterHeight : 0;
  useEffect(() => { if (voiceMode) Keyboard.dismiss(); else setAgentHolding(false); }, [voiceMode]);
  useEffect(() => {
    if (mia.audioState !== 'recording') { setElapsed(0); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      setElapsed(Math.min(119, seconds));
      // The recorder caps audio at 119 seconds. A held note still needs the
      // user's release/cancel gesture; reaching the cap never sends it.
      if (seconds >= 119) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [mia.audioState]);

  return <UiProvider agent={voiceMode}><View style={ui.s.page}>
    <StatusBar barStyle="light-content" />
    <View style={app.fill} pointerEvents={transition.transitioning ? 'none' : 'auto'} accessibilityElementsHidden={transition.transitioning} importantForAccessibility={transition.transitioning ? 'no-hide-descendants' : 'auto'}>
    {voiceMode && !chatOpen && <ScreenAtmosphere />}
    <SafeAreaView style={app.fill} edges={mia.session?.user.profileComplete && !mia.booting ? ['top', 'left', 'right'] : ['top', 'bottom', 'left', 'right']}
      pointerEvents={voiceMode ? 'none' : 'auto'} accessibilityElementsHidden={voiceMode} importantForAccessibility={voiceMode ? 'no-hide-descendants' : 'auto'}>
      <KeyboardAvoidingView style={app.fill} behavior="padding">
        {mia.booting ? <View testID="app-startup" style={app.loading}><ActivityIndicator accessibilityLabel="Opening Mia" color={ui.colors.muted} /></View>
          : !mia.session ? <Auth mia={mia} />
          : !mia.session.user.profileComplete ? <CompleteProfile mia={mia} />
          : <Workspace mia={mia} bottomInset={bottomInset} overlayInset={agentFooterClearance} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
    {voiceMode && chatOpen && <MessageReferenceCard key={mia.activeChatId} source={mia.messageReference?.chatId === mia.activeChatId ? mia.messageReference : null} userId={mia.session!.user.id} playback={mia.originalPlayback} bottomClearance={agentFooterClearance} contentInsets={insets} dismissalRevision={mia.referenceDismissalRevision} onPresented={mia.referencePresented} />}
    {voiceMode && <View testID="agent-viewport-footer" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[app.agentOverlay, { left: insets.left, right: insets.right }]}
      onLayout={event => {
        const measured = event.nativeEvent.layout.height;
        if (Number.isFinite(measured) && measured > 0) setAgentOverlayHeight(previous => previous === measured ? previous : measured);
      }}>
      <VoiceMode mia={mia} bottomInset={insets.bottom} holding={agentHolding} elapsed={elapsed} recordingGesture={recordingGesture} recordingProgress={recordingProgress} />
    </View>}
    {voiceMode && <AgentInteraction mia={mia} onHoldingChange={setAgentHolding} onRecordingGestureChange={setRecordingGesture} recordingProgress={recordingProgress} />}
    </View>
    <ChatTransitionOverlay opacity={transition.opacity} transitioning={transition.transitioning} />
  </View></UiProvider>;
}

/** The same complete page is used for the active route and the back-swipe destination. */
function Workspace({ mia, bottomInset, overlayInset, preview = false }: {
  mia: Mia; bottomInset: number; overlayInset: number; preview?: boolean;
}) {
  const ui = useUi();
  const voiceMode = mia.aiMode;
  const chatOpen = mia.tab === 'chats' && mia.chats.some(chat => chat.id === mia.activeChatId);
  return <View style={app.fill}>
    <View style={app.fill}>{mia.tab === 'people' ? <People mia={mia} overlayInset={overlayInset} /> : mia.tab === 'settings' ? <Settings mia={mia} overlayInset={overlayInset} /> : mia.tab === 'drafts' ? <ScrollView contentContainerStyle={[ui.s.content, { paddingBottom: 20 + overlayInset }]} keyboardShouldPersistTaps="handled"><ScreenHeader title="Saved messages" />{mia.drafts.length ? voiceMode ? <Text style={ui.s.small}>{mia.drafts.length} saved {mia.drafts.length === 1 ? 'message' : 'messages'}. Ask Mia to review or open a saved message.</Text> : <MessageDrafts mia={mia} drafts={mia.drafts} /> : <Empty icon="bookmark-outline" title="All clear" text="Messages you prepare with Mia appear here for review." />}</ScrollView> : <Chats mia={mia} bottomInset={voiceMode ? 0 : bottomInset} overlayInset={overlayInset} preview={preview}
      renderBackScreen={() => <Workspace mia={{ ...mia, tab: mia.backView.view, activeChatId: mia.backView.chatId }} bottomInset={bottomInset} overlayInset={overlayInset} preview />} />}</View>
    {!voiceMode && !chatOpen && !!mia.error && <View style={{ paddingHorizontal: 16 }}><ConversationStatus error={mia.error} onDismiss={() => mia.setError('')} /></View>}
    {!voiceMode && !chatOpen && <View style={[app.dock, { paddingBottom: Math.max(bottomInset, 12) }]}>
      <Nav item={tabs[0]!} selected={mia.tab === 'people'} onPress={() => void mia.navigate('people')} count={0} />
      <Nav item={tabs[1]!} selected={mia.tab === 'chats' || mia.tab === 'drafts'} onPress={() => void mia.navigate('chats')} count={mia.chats.reduce((sum, chat) => sum + chat.unreadCount, 0)} />
      <Nav item={tabs[2]!} selected={mia.tab === 'settings'} onPress={() => void mia.navigate('settings')} count={0} />
    </View>}
  </View>;
}

function Nav({ item, selected, onPress, count }: { item: typeof tabs[number]; selected: boolean; onPress: () => void; count: number }) {
  const { colors, s } = useUi();
  const [focused, setFocused] = useState(false);
  const motion = usePressOpacity();
  return <Pressable accessibilityRole="tab" accessibilityLabel={`${item.label}${count ? `, ${count} unread messages` : ''}`} accessibilityState={{ selected }} onPress={onPress}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPressIn={motion.onPressIn} onPressOut={motion.onPressOut}
    style={({ pressed }) => [app.nav, pressed && { opacity: .6 }, focused && s.focus]}>
    <Animated.View style={[app.navIcon, selected && app.navIconSelected, { opacity: motion.opacity }]}><Icon name={selected ? item.activeIcon : item.icon} color={selected ? colors.accentLight : colors.muted} size={22} />{count > 0 && <View style={app.unread}><Text style={app.unreadText}>{count > 99 ? '99+' : count}</Text></View>}</Animated.View>
    <Text style={[app.navLabel, { color: selected ? colors.ink : colors.muted }]}>{item.label}</Text>
  </Pressable>;
}
export default function App() { return <SafeAreaProvider><Application /></SafeAreaProvider>; }
const app = StyleSheet.create({
  agentOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 40, elevation: 40, overflow: 'visible' },
  fill: { flex: 1, minWidth: 0 }, loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  error: { paddingHorizontal: 24, paddingTop: 10 },
  dock: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingHorizontal: 20, paddingTop: 8, backgroundColor: colors.paper },
  nav: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 54, paddingVertical: 4, borderRadius: 16 },
  navIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  navIconSelected: { backgroundColor: colors.soft },
  navLabel: { fontSize: 11, lineHeight: 16, fontWeight: '600', textAlign: 'center' },
  unread: { position: 'absolute', right: 3, top: -2, minWidth: 16, minHeight: 16, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  unreadText: { fontSize: 9, lineHeight: 14, fontWeight: '700', color: colors.background },
});

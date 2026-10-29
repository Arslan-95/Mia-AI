import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMia, type Tab } from './useMia';
import { Auth, CompleteProfile } from './screens/Auth';
import { Chats } from './screens/Chats';
import { AgentHome, VoiceMode } from './screens/AssistantOrb';
import { MessageDrafts } from './screens/MessageDrafts';
import { People } from './screens/People';
import { Settings } from './screens/Settings';
import { AudioControls, hasAudioControls } from './screens/AudioControls';
import { useKeyboardVisible } from './useKeyboardVisible';
import { Button, Empty, Icon, Notice, ScreenHeader, colors, s } from './ui';

const tabs: { id: Tab; label: string; icon: React.ComponentProps<typeof Icon>['name']; activeIcon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { id: 'people', label: 'Contacts', icon: 'people-outline', activeIcon: 'people' },
  { id: 'chats', label: 'Chats', icon: 'chatbubbles-outline', activeIcon: 'chatbubbles' },
  { id: 'settings', label: 'Settings', icon: 'options-outline', activeIcon: 'options' },
];

function Application() {
  const mia = useMia();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const bottomInset = keyboardVisible ? 0 : insets.bottom;
  const [elapsed, setElapsed] = useState(0);
  const voiceMode = !!(mia.aiMode && mia.session?.user.profileComplete && !mia.booting);
  const chatOpen = mia.tab === 'chats' && mia.chats.some(chat => chat.id === mia.activeChatId);
  useEffect(() => { if (voiceMode) Keyboard.dismiss(); }, [voiceMode]);
  useEffect(() => {
    if (mia.audioState !== 'recording') { setElapsed(0); return; }
    const start = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      setElapsed(seconds);
      if (seconds >= 118) void mia.finishRecording().catch(mia.fail);
    }, 1000);
    return () => clearInterval(timer);
  }, [mia.audioState]);

  return <View style={s.page}>
    <StatusBar barStyle="light-content" />
    <SafeAreaView style={app.fill} edges={mia.session?.user.profileComplete && !mia.booting ? ['top', 'left', 'right'] : ['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView style={app.fill} behavior="padding">
        {mia.booting ? <View testID="app-startup" style={app.loading}><ActivityIndicator accessibilityLabel="Opening Mia" color={colors.muted} /></View>
          : !mia.session ? <Auth mia={mia} />
          : !mia.session.user.profileComplete ? <CompleteProfile mia={mia} />
          : <View style={app.fill}>
            {!!mia.error && <View style={app.error}><Notice error>{mia.error}</Notice><Button quiet label="Dismiss message" onPress={() => mia.setError('')} /></View>}
            <View style={app.fill}>{mia.tab === 'assistant' ? <AgentHome mia={mia} /> : mia.tab === 'people' ? <People mia={mia} /> : mia.tab === 'settings' ? <Settings mia={mia} /> : mia.tab === 'drafts' ? <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled"><ScreenHeader title="Saved messages" />{mia.drafts.length ? <MessageDrafts mia={mia} drafts={mia.drafts} /> : <Empty icon="bookmark-outline" title="All clear" text="Messages you prepare with Mia appear here for review." />}</ScrollView> : <Chats mia={mia} bottomInset={hasAudioControls(mia) || voiceMode ? 0 : bottomInset} />}</View>
            {voiceMode ? <>
              {hasAudioControls(mia) && <ScrollView style={app.voiceAudio} keyboardShouldPersistTaps="handled"><AudioControls mia={mia} elapsed={elapsed} /></ScrollView>}
              <VoiceMode mia={mia} bottomInset={bottomInset} />
            </> : <AudioControls mia={mia} elapsed={elapsed} bottomInset={chatOpen ? bottomInset : 0} />}
            {!voiceMode && !chatOpen && <View style={[app.dock, { paddingBottom: Math.max(bottomInset, 12) }]}>
              <Nav item={tabs[0]!} selected={mia.tab === 'people'} onPress={() => void mia.navigate('people')} count={0} />
              <Nav item={tabs[1]!} selected={mia.tab === 'chats' || mia.tab === 'drafts'} onPress={() => void mia.navigate('chats')} count={mia.chats.reduce((sum, chat) => sum + chat.unreadCount, 0)} />
              <Nav item={tabs[2]!} selected={mia.tab === 'settings'} onPress={() => void mia.navigate('settings')} count={0} />
            </View>}
          </View>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </View>;
}

function Nav({ item, selected, onPress, count }: { item: typeof tabs[number]; selected: boolean; onPress: () => void; count: number }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="tab" accessibilityLabel={`${item.label}${count ? `, ${count} unread messages` : ''}`} accessibilityState={{ selected }} onPress={onPress}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [app.nav, { opacity: pressed ? .6 : 1 }, focused && s.focus]}>
    <View style={[app.navIcon, selected && app.navIconSelected]}><Icon name={selected ? item.activeIcon : item.icon} color={selected ? colors.accentLight : colors.muted} size={22} />{count > 0 && <View style={app.unread}><Text style={app.unreadText}>{count > 99 ? '99+' : count}</Text></View>}</View>
    <Text style={[app.navLabel, { color: selected ? colors.ink : colors.muted }]}>{item.label}</Text>
  </Pressable>;
}
export default function App() { return <SafeAreaProvider><Application /></SafeAreaProvider>; }
const app = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 }, loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  error: { paddingHorizontal: 24, paddingTop: 10 },
  voiceAudio: { flexGrow: 0, maxHeight: '42%' },
  dock: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingHorizontal: 20, paddingTop: 8, backgroundColor: colors.paper },
  nav: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 54, paddingVertical: 4, borderRadius: 16 },
  navIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  navIconSelected: { backgroundColor: colors.soft },
  navLabel: { fontSize: 11, fontWeight: '600', textAlign: 'center' },
  unread: { position: 'absolute', right: 3, top: -2, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  unreadText: { fontSize: 9, fontWeight: '700', color: colors.background },
});

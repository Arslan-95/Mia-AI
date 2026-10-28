import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMia, type Tab } from './useMia';
import { Auth, CompleteProfile } from './screens/Auth';
import { Chats } from './screens/Chats';
import { AssistantOrb, VoiceMode, MiaCore } from './screens/AssistantOrb';
import { People } from './screens/People';
import { Settings } from './screens/Settings';
import { AudioControls } from './screens/AudioControls';
import { Button, Icon, Notice, colors, s } from './ui';

const tabs: { id: Tab; label: string; icon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { id: 'chats', label: 'Chats', icon: 'chatbubbles-outline' },
  { id: 'people', label: 'People', icon: 'people-outline' },
  { id: 'settings', label: 'Settings', icon: 'options-outline' },
];

function Application() {
  const mia = useMia();
  const [elapsed, setElapsed] = useState(0);
  const voiceMode = !!(mia.aiMode && mia.session?.user.profileComplete && !mia.booting);
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
    <SafeAreaView style={app.fill} pointerEvents={voiceMode ? 'none' : 'auto'} accessibilityElementsHidden={voiceMode} importantForAccessibility={voiceMode ? 'no-hide-descendants' : 'auto'}>
      <KeyboardAvoidingView style={app.fill} behavior="padding">
        {mia.booting ? <View style={app.loading}><MiaCore /><ActivityIndicator color={colors.accent} /><Text style={s.small}>Opening Mia…</Text></View>
          : !mia.session ? <Auth mia={mia} />
          : !mia.session.user.profileComplete ? <CompleteProfile mia={mia} />
          : <View style={app.fill}>
            {!!mia.error && <View style={app.error}><Notice error>{mia.error}</Notice><Button quiet label="Dismiss message" onPress={() => mia.setError('')} /></View>}
            <View style={app.fill}>{mia.tab === 'people' ? <People mia={mia} /> : mia.tab === 'settings' ? <Settings mia={mia} /> : <Chats mia={mia} />}</View>
            <AudioControls mia={mia} elapsed={elapsed} />
            <View style={app.dock}>
              <Nav item={tabs[0]!} selected={mia.tab === 'chats' || mia.tab === 'drafts'} onPress={() => void mia.navigate('chats')} count={mia.chats.reduce((sum, chat) => sum + chat.unreadCount, 0)} />
              <Nav item={tabs[1]!} selected={mia.tab === 'people'} onPress={() => void mia.navigate('people')} count={0} />
              <View style={app.miaSlot}><AssistantOrb mia={mia} /><Text style={app.miaLabel}>MIA</Text></View>
              <Nav item={tabs[2]!} selected={mia.tab === 'settings'} onPress={() => void mia.navigate('settings')} count={0} />
            </View>
          </View>}
      </KeyboardAvoidingView>
    </SafeAreaView>
    {voiceMode && <VoiceMode mia={mia} />}
  </View>;
}

function Nav({ item, selected, onPress, count }: { item: typeof tabs[number]; selected: boolean; onPress: () => void; count: number }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="tab" accessibilityLabel={`${item.label}${count ? `, ${count} unread messages` : ''}`} accessibilityState={{ selected }} onPress={onPress}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [app.nav, { opacity: pressed ? .6 : 1 }, focused && s.focus]}>
    <View><Icon name={item.icon} color={selected ? colors.accentLight : colors.muted} size={23} />{count > 0 && <View style={app.unread} />}</View>
    <Text style={[app.navLabel, { color: selected ? colors.ink : colors.muted }]}>{item.label}</Text>
    {selected && <View style={app.selectedDot} />}
  </Pressable>;
}
export default function App() { return <SafeAreaProvider><Application /></SafeAreaProvider>; }
const app = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 }, loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20 },
  error: { paddingHorizontal: 24, paddingTop: 10 },
  dock: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 5, backgroundColor: '#0E0D16' },
  nav: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 65, paddingVertical: 8, borderRadius: 16 },
  navLabel: { fontSize: 10, fontWeight: '500', textAlign: 'center' }, selectedDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.accent, position: 'absolute', bottom: 0 },
  unread: { position: 'absolute', right: -4, top: 0, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accentLight },
  miaSlot: { flex: 1.15, alignItems: 'center', gap: 3 }, miaLabel: { fontSize: 9, letterSpacing: 2, color: colors.accentLight, marginLeft: 2, marginBottom: 6 },
});

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useMia, type Tab } from './useMia';
import { Auth, CompleteProfile } from './screens/Auth';
import { Chats } from './screens/Chats';
import { Assistant } from './screens/Assistant';
import { People } from './screens/People';
import { Drafts } from './screens/Drafts';
import { Settings } from './screens/Settings';
import { AudioControls } from './screens/AudioControls';
import { Button, Icon, Notice, colors, s } from './ui';

const tabs: { id: Tab; label: string; icon: React.ComponentProps<typeof Icon>['name'] }[] = [
  { id: 'chats', label: 'Chats', icon: 'chatbubbles-outline' },
  { id: 'mia', label: 'Mia', icon: 'sparkles-outline' },
  { id: 'people', label: 'People', icon: 'people-outline' },
  { id: 'drafts', label: 'Drafts', icon: 'document-text-outline' },
  { id: 'settings', label: 'Settings', icon: 'options-outline' },
];

function Application() {
  const mia = useMia();
  const [elapsed, setElapsed] = useState(0);

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

  return (
    <SafeAreaView style={s.page}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView style={app.fill} behavior="padding">
        {mia.booting ? (
          <View style={app.loading}>
            <ActivityIndicator color={colors.green} />
            <Text style={s.body}>Opening Mia…</Text>
          </View>
        ) : !mia.session ? <Auth key={mia.address} mia={mia} /> : !mia.session.user.profileComplete ? <CompleteProfile mia={mia} /> : (
          <View style={app.fill}>
            <View style={app.connection}>
              <View style={[app.statusDot, { backgroundColor: mia.connection === 'Connected' ? colors.green : '#A66C28' }]} />
              <Text style={[s.small, app.statusText]}>{mia.connection === 'Connected' ? 'Connected to your people' : mia.connection}</Text>
              <Text style={app.wordmark}>mia</Text>
            </View>

            {!!mia.error && (
              <View style={app.error}>
                <Notice error>{mia.error}</Notice>
                <Button quiet label="Dismiss message" onPress={() => mia.setError('')} />
              </View>
            )}

            <View style={app.fill}>
              {mia.tab === 'chats' ? <Chats mia={mia} />
                : mia.tab === 'mia' ? <Assistant mia={mia} />
                : mia.tab === 'people' ? <People mia={mia} />
                : mia.tab === 'drafts' ? <Drafts mia={mia} />
                : <Settings mia={mia} />}
            </View>

            <AudioControls mia={mia} elapsed={elapsed} />

            <View style={app.tabs}>
              {tabs.map(item => (
                <Nav
                  key={item.id}
                  item={item}
                  selected={mia.tab === item.id}
                  onPress={() => void mia.navigate(item.id)}
                  count={item.id === 'drafts' ? mia.drafts.length : item.id === 'chats' ? mia.chats.reduce((total, chat) => total + chat.unreadCount, 0) : 0}
                />
              ))}
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Nav({ item, selected, onPress, count }: {
  item: typeof tabs[number]; selected: boolean; onPress: () => void; count: number;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`${item.label}${count ? `, ${count} ${item.id === 'chats' ? 'unread messages' : 'saved drafts'}` : ''}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [app.nav, selected && app.selectedNav, { opacity: pressed ? .65 : 1 }, focused && s.focus]}
    >
      <Icon name={item.icon} color={selected ? colors.green : colors.muted} />
      <Text style={[app.navLabel, { color: selected ? colors.green : colors.muted, fontWeight: selected ? '700' : '500' }]}>{item.label}</Text>
    </Pressable>
  );
}

export default function App() {
  return <SafeAreaProvider><Application /></SafeAreaProvider>;
}

const app = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  connection: { paddingHorizontal: 24, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: 'row', gap: 8, alignItems: 'center' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { flex: 1 },
  wordmark: { color: colors.green, fontWeight: '700', fontSize: 19 },
  error: { paddingHorizontal: 20, paddingTop: 10 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: colors.background },
  nav: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 58, paddingVertical: 8, borderRadius: 12 },
  selectedNav: { backgroundColor: colors.soft },
  navLabel: { fontSize: 12, textAlign: 'center' },
});

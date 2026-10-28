import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, Button, Icon, s, colors } from '../ui';
export function Settings({ mia }: { mia: Mia }) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  return <ScrollView contentContainerStyle={s.content}>
    <Text accessibilityRole="header" style={s.heading}>Settings</Text>
    <View style={[s.card, s.row]}><Avatar name={mia.session!.user.displayName} size={64} /><View style={{ flex: 1, gap: 5 }}><Text style={s.sectionTitle}>{mia.session!.user.displayName}</Text><Text style={s.small}>@{mia.session!.user.username}</Text><Text style={s.small}>{mia.session!.user.phoneNumber}</Text></View></View>
    <Text style={p.groupTitle}>YOUR ASSISTANT</Text>
    <View style={s.card}>
      <View style={s.between}><View style={[s.row, { flex: 1 }]}><View style={p.icon}><Icon name="sparkles-outline" color={colors.accentLight} /></View><View style={{ flex: 1, gap: 5 }}><Text style={s.label}>Mia voice mode</Text><Text style={s.small}>Less tapping. More talking.</Text></View></View><Switch accessibilityLabel="Mia hands-free voice mode" value={mia.aiMode} onValueChange={value => void mia.saveAiMode(value).catch(mia.fail)} trackColor={{ false: colors.line, true: '#7852DB' }} thumbColor={colors.ink} /></View>
      <View style={s.divider} />
      <Text style={s.small}>Ask Mia to open chats, read messages or prepare a reply. Messages are sent after you confirm.</Text>
      <View style={p.instructions}><Icon name="finger-print-outline" size={18} color={colors.accentLight} /><Text style={[s.small, { flex: 1 }]}>In voice mode, tap anywhere to mute or unmute. Hold anywhere to return to the app.</Text></View>
    </View>
    <Text style={p.groupTitle}>PERMISSIONS</Text>
    <View style={s.card}><View style={s.row}><View style={p.icon}><Icon name="mic-outline" color={colors.accentLight} /></View><Text style={s.label}>Microphone access</Text></View><Text style={s.small}>Manage access in your iPhone settings. Voice notes can be previewed before sending.</Text><Button secondary label="Open iPhone settings" icon="open-outline" onPress={() => void Linking.openSettings().catch(mia.fail)} /></View>
    {confirmLogout ? <View style={s.card}><Text style={s.sectionTitle}>Sign out?</Text><Text style={s.small}>Saved messages stay in your account. Unsent messages and recordings on this iPhone will be removed.</Text><Button label="Sign out now" onPress={() => void mia.logout().catch(mia.fail)} /><Button quiet label="Keep me signed in" onPress={() => setConfirmLogout(false)} /></View> : <Button quiet label="Sign out" icon="log-out-outline" onPress={() => setConfirmLogout(true)} />}
    <View style={p.footer}><Text style={p.wordmark}>mia<Text style={{ color: colors.accent }}>.</Text></Text><Text style={s.small}>Space to connect.</Text></View>
  </ScrollView>;
}
const p = StyleSheet.create({
  groupTitle: { color: colors.muted, fontSize: 10, letterSpacing: 2, fontWeight: '600', marginTop: 6 },
  icon: { width: 42, height: 42, borderRadius: 15, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  instructions: { flexDirection: 'row', gap: 10, padding: 14, backgroundColor: colors.background, borderRadius: 14 },
  footer: { alignItems: 'center', gap: 5, paddingVertical: 10 }, wordmark: { fontSize: 28, color: colors.ink, fontWeight: '600', letterSpacing: -2 },
});

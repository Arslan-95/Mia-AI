import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, Button, Icon, s, colors } from '../ui';
export function Settings({ mia }: { mia: Mia }) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmVoice, setConfirmVoice] = useState(false);
  return <ScrollView contentContainerStyle={s.content}>
    <Text accessibilityRole="header" style={s.heading}>Settings</Text>
    <View style={[s.card, s.row]}><Avatar name={mia.session!.user.displayName} size={48} /><View style={{ flex: 1, gap: 3 }}><Text style={s.sectionTitle}>{mia.session!.user.displayName}</Text><Text style={s.small}>@{mia.session!.user.username}</Text><Text style={s.small}>{mia.session!.user.phoneNumber}</Text></View></View>
    <Text style={p.groupTitle}>YOUR ASSISTANT</Text>
    <View style={s.card}>
      <View style={s.row}><View style={p.icon}><Icon name="sparkles-outline" color={colors.accentLight} /></View><View style={{ flex: 1, gap: 5 }}><Text style={s.label}>Mia voice mode</Text><Text style={s.small}>Less tapping. More talking.</Text></View></View>
      {confirmVoice ? <View style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={s.sectionTitle}>Enable hands-free voice mode?</Text>
        <Text style={s.small}>Mia will listen while this mode is active. To leave, hold the exit control for 5 seconds until it vibrates, or ask Mia and confirm when she checks.</Text>
        <Button label="Enable voice mode now" onPress={() => { setConfirmVoice(false); void mia.saveAiMode(true).catch(mia.fail); }} />
        <Button quiet label="Keep voice mode off" onPress={() => setConfirmVoice(false)} />
      </View> : <Button secondary label="Enable voice mode" icon="mic-outline" onPress={() => setConfirmVoice(true)} />}
      <View style={s.divider} />
      <Text style={s.small}>Ask Mia to open chats, read messages or prepare a reply. Messages are sent after you confirm.</Text>
      <View style={p.instructions}><Icon name="finger-print-outline" size={18} color={colors.accentLight} /><Text style={[s.small, { flex: 1 }]}>Tap Mia to mute or unmute your microphone. Mia can keep speaking. Exiting requires a 5-second hold or a separate voice confirmation.</Text></View>
    </View>
    <Text style={p.groupTitle}>PERMISSIONS</Text>
    <View style={s.card}><View style={s.row}><View style={p.icon}><Icon name="mic-outline" color={colors.accentLight} /></View><Text style={s.label}>Microphone access</Text></View><Text style={s.small}>Manage access in your iPhone settings. Voice notes can be previewed before sending.</Text><Button secondary label="Open iPhone settings" icon="open-outline" onPress={() => void Linking.openSettings().catch(mia.fail)} /></View>
    {confirmLogout ? <View style={s.card}><Text style={s.sectionTitle}>Sign out?</Text><Text style={s.small}>Saved messages stay in your account. Unsent messages and recordings on this iPhone will be removed.</Text><Button label="Sign out now" onPress={() => void mia.logout().catch(mia.fail)} /><Button quiet label="Keep me signed in" onPress={() => setConfirmLogout(false)} /></View> : <Button quiet label="Sign out" icon="log-out-outline" onPress={() => setConfirmLogout(true)} />}
  </ScrollView>;
}
const p = StyleSheet.create({
  groupTitle: { color: colors.muted, fontSize: 10, letterSpacing: 2, fontWeight: '600', marginTop: 6 },
  icon: { width: 42, height: 42, borderRadius: 15, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  instructions: { flexDirection: 'row', gap: 10, padding: 14, backgroundColor: colors.background, borderRadius: 14 },
});

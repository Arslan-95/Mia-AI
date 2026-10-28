import React, { useState } from 'react';
import { Linking, ScrollView, Switch, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, Button, s, colors } from '../ui';
export function Settings({ mia }: { mia: Mia }) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  return <ScrollView contentContainerStyle={s.content}><Text style={s.eyebrow}>MAKE YOURSELF COMFORTABLE</Text><Text accessibilityRole="header" style={s.heading}>Your preferences</Text><View style={[s.card, s.row]}><Avatar name={mia.session!.user.displayName} size={60} /><View style={{ flex: 1, gap: 4 }}><Text style={s.sectionTitle}>{mia.session!.user.displayName}</Text><Text style={s.small}>@{mia.session!.user.username}</Text><Text style={s.small}>{mia.session!.user.phoneNumber}</Text></View></View>
    <View style={s.card}><View style={s.between}><View style={{ flex: 1, gap: 7 }}><Text style={s.label}>Mia voice mode</Text><Text style={s.small}>Talk to Mia to open conversations, read messages and prepare replies. Mia listens again after every answer, wherever you are in the app.</Text></View><Switch accessibilityLabel="Mia hands-free voice mode" value={mia.aiMode} onValueChange={value => void mia.saveAiMode(value).catch(mia.fail)} trackColor={{ true: colors.green }} /></View><View style={s.divider} /><Text style={s.small}>Use the circle at the bottom to turn Mia on or off. Messages are sent after you confirm. Mia follows your iPhone's text size and VoiceOver settings.</Text></View>
    <Text style={s.sectionTitle}>Microphone</Text><View style={s.card}><Text style={s.body}>Manage microphone access in your iPhone settings. You can listen to a recording before sending it.</Text><Button quiet label="Open iPhone settings" icon="open-outline" onPress={() => void Linking.openSettings().catch(mia.fail)} /></View>
    {confirmLogout ? <View style={s.card}><Text style={s.body}>Sign out of this device? Saved drafts stay in your account. Unsent messages and recordings on this iPhone will be removed.</Text><Button label="Sign out now" onPress={() => void mia.logout().catch(mia.fail)} /><Button quiet label="Keep me signed in" onPress={() => setConfirmLogout(false)} /></View> : <Button secondary label="Sign out" icon="log-out-outline" onPress={() => setConfirmLogout(true)} />}
    <Text style={[s.small, { textAlign: 'center', padding: 10 }]}>Mia · A little closer</Text>
  </ScrollView>;
}

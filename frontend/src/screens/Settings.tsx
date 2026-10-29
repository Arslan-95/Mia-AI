import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, HeaderAction, Icon, ScreenHeader, s, colors } from '../ui';
import { ConfirmationDialog } from './ConfirmationDialog';

export function Settings({ mia }: { mia: Mia }) {
  const [confirmation, setConfirmation] = useState<'voice' | 'logout' | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const pending = useRef(false);
  const cancel = () => { if (!busy) setConfirmation(null); };
  async function confirm() {
    if (pending.current || !confirmation) return;
    const action = confirmation;
    pending.current = true;
    setBusy(true);
    // Mode state changes before persistence completes. Dismiss the native
    // modal first, so neither success nor a storage failure masks active Mia.
    setConfirmation(null);
    try {
      if (action === 'voice') await mia.saveAiMode(true);
      else await mia.logout();
    } catch (reason) { mia.fail(reason); }
    finally { pending.current = false; setBusy(false); }
  }
  return <>
    <ScrollView contentContainerStyle={s.content}>
      <ScreenHeader title="Settings" action={<HeaderAction label="Sign out" icon="log-out-outline" onPress={() => setConfirmation('logout')} />} />
      <View style={[s.card, s.row]}><Avatar name={mia.session!.user.displayName} size={48} /><View style={{ flex: 1, gap: 3 }}><Text style={s.sectionTitle}>{mia.session!.user.displayName}</Text><Text style={s.small}>@{mia.session!.user.username}</Text><Text style={s.small}>{mia.session!.user.phoneNumber}</Text></View></View>
      <Text style={p.groupTitle}>YOUR ASSISTANT</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Mia voice mode" accessibilityHint={mia.aiMode ? 'Hands-free assistance is on. Opens Mia home.' : 'Opens a confirmation before enabling hands-free assistance.'}
        onPress={() => { if (mia.aiMode) void mia.navigate('assistant'); else setConfirmation('voice'); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [s.card, s.row, { opacity: pressed ? .7 : 1 }, focused && s.focus]}>
        <View style={p.icon}><Icon name="sparkles-outline" color={colors.accentLight} /></View>
        <View style={p.description}><Text style={s.label}>Mia voice mode{mia.aiMode ? ' · On' : ''}</Text><Text style={s.small}>{mia.aiMode ? 'Mia is with you. Return to your assistant.' : 'Open chats, hear messages and reply hands-free.'}</Text></View>
        <Icon name="chevron-forward" size={18} color={colors.muted} />
      </Pressable>
    </ScrollView>
    <ConfirmationDialog visible={confirmation !== null} busy={busy} onCancel={cancel} onConfirm={() => void confirm()}
      title={confirmation === 'voice' ? 'Enable hands-free voice mode?' : 'Sign out?'}
      description={confirmation === 'voice'
        ? 'Mia will listen while voice mode is active. Tap Mia to mute your microphone. To leave, hold for 5 seconds until it vibrates, or ask Mia and confirm when she checks.'
        : 'Saved messages stay in your account. Unsent messages and recordings on this iPhone will be removed.'}
      confirmLabel={confirmation === 'voice' ? 'Enable voice mode now' : 'Sign out now'}
      cancelLabel={confirmation === 'voice' ? 'Keep voice mode off' : 'Keep me signed in'} />
  </>;
}
const p = StyleSheet.create({
  groupTitle: { color: colors.muted, fontSize: 10, letterSpacing: 2, fontWeight: '600', marginTop: 6 },
  icon: { width: 42, height: 42, borderRadius: 15, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  description: { flex: 1, gap: 4 },
});

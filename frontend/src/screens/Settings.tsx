import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, HeaderAction, Icon, ScreenAtmosphere, ScreenHeader, SectionCaption, agentColors, classicColors, useUi } from '../ui';
import { Reveal } from '../motion';
import { ConfirmationDialog } from './ConfirmationDialog';

export function Settings({ mia }: { mia: Mia }) {
  const { agent, colors, s } = useUi();
  const p = agent ? agentStyles : classicStyles;
  const { width, fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.6;
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
    <View style={{ flex: 1 }}>{agent && <ScreenAtmosphere />}<Reveal style={{ flex: 1 }}><ScrollView contentContainerStyle={[s.content, { paddingHorizontal: width < 375 ? 16 : 20 }]}>
      <ScreenHeader title="Settings" action={<HeaderAction label="Sign out" icon="log-out-outline" onPress={() => setConfirmation('logout')} />} />
      <View style={[s.card, p.profile, stacked && p.stacked]}><Avatar name={mia.session!.user.displayName} size={agent ? 60 : 48} /><View style={[p.identity, stacked && p.stackedText]}><Text style={s.sectionTitle}>{mia.session!.user.displayName}</Text><Text style={agent ? s.body : s.small}>@{mia.session!.user.username}</Text><Text style={[agent ? s.body : s.small, agent && { marginTop: 3 }]}>{mia.session!.user.phoneNumber}</Text></View></View>
      <View style={p.assistantSection}>{agent ? <SectionCaption>Your assistant</SectionCaption> : <Text style={p.groupTitle}>YOUR ASSISTANT</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Mia voice mode" accessibilityHint={mia.aiMode ? 'Hands-free assistance is on. Opens Mia home.' : 'Opens a confirmation before enabling hands-free assistance.'}
        onPress={() => { if (mia.aiMode) void mia.navigate('assistant'); else setConfirmation('voice'); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [s.card, p.assistantCard, pressed && { backgroundColor: colors.surfacePressed }, focused && s.focus]}>
        <View style={[p.assistantTop, stacked && p.stacked]}><View accessible={false} accessibilityElementsHidden style={p.symbol}>{agent && <View style={p.reflection} />}<View style={p.icon}><Icon name="sparkles-outline" color={colors.accentLight} size={agent ? 25 : 22} /></View></View>
          <View style={[p.description, stacked && p.stackedText]}><Text style={agent ? p.assistantTitle : s.label}>Mia voice mode{!agent && mia.aiMode ? ' \u00b7 On' : ''}</Text>{agent ? <View style={p.stateBadge}><Text style={p.stateText}>{mia.aiMode ? 'On' : 'Off'}</Text></View> : <Text style={s.small}>{mia.aiMode ? 'Mia is with you. Return to your assistant.' : 'Open chats, hear messages and reply hands-free.'}</Text>}</View>
          {!stacked && <Icon name="chevron-forward" size={18} color={agent ? colors.accentLight : colors.muted} />}</View>
        {agent && <Text style={s.body}>{mia.aiMode ? 'Mia is with you. Return to your assistant.' : 'Open chats, hear messages and reply hands-free.'}</Text>}
      </Pressable>
      {agent && <Text style={p.helper}>Tap anywhere to mute. Hold anywhere for 5 seconds to exit.</Text>}</View>
    </ScrollView></Reveal></View>
    <ConfirmationDialog visible={confirmation !== null} busy={busy} onCancel={cancel} onConfirm={() => void confirm()}
      title={confirmation === 'voice' ? 'Enable hands-free voice mode?' : 'Sign out?'}
      description={confirmation === 'voice'
        ? 'Mia will listen while voice mode is active. Tap anywhere to mute or unmute your microphone. To leave, hold for 5 seconds until it vibrates, or ask Mia and confirm when she checks.'
        : 'Saved messages stay in your account. Unsent messages and recordings on this iPhone will be removed.'}
      confirmLabel={confirmation === 'voice' ? 'Enable voice mode now' : 'Sign out now'}
      destructive={confirmation === 'logout'}
      cancelLabel={confirmation === 'voice' ? 'Keep voice mode off' : 'Keep me signed in'} />
  </>;
}
function createStyles(colors: typeof agentColors, agent: boolean) { return StyleSheet.create({
  groupTitle: { color: colors.muted, fontSize: 10, lineHeight: 16, letterSpacing: 2, fontWeight: '600', marginTop: 6 },
  profile: { flexDirection: 'row', alignItems: 'center', borderTopColor: agent ? '#4D3B63' : colors.line }, identity: { flex: 1, minWidth: 0, gap: 3 },
  stacked: { flexDirection: 'column', alignItems: 'flex-start' }, stackedText: { flex: 0, width: '100%' },
  assistantSection: { gap: agent ? 12 : 18, marginTop: agent ? 4 : 0 }, assistantCard: { backgroundColor: agent ? colors.elevated : colors.paper, borderColor: agent ? colors.borderAccent : colors.line, gap: agent ? 12 : 14 },
  assistantTop: { flexDirection: 'row', alignItems: 'center', gap: 14 }, assistantTitle: { fontSize: 19, lineHeight: 25, color: colors.ink, fontWeight: '600', letterSpacing: -.3 },
  symbol: { width: agent ? 48 : 42, height: agent ? 48 : 42 }, reflection: { position: 'absolute', width: 52, height: 38, borderRadius: 20, left: -3, bottom: -4, backgroundColor: '#8C94E8', opacity: .18, transform: [{ rotate: '-18deg' }] },
  icon: { width: agent ? 48 : 42, height: agent ? 48 : 42, borderRadius: agent ? 16 : 15, borderWidth: agent ? 1 : 0, borderColor: '#775C99', backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  description: { flex: 1, minWidth: 0, gap: agent ? 6 : 4 }, stateBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.soft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderAccent }, stateText: { color: colors.accentLight, fontSize: 12, lineHeight: 17, fontWeight: '500' }, helper: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 4 },
}); }
const classicStyles = createStyles(classicColors, false);
const agentStyles = createStyles(agentColors, true);

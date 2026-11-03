import React, { useState } from 'react';
import { Text, View } from 'react-native';
import type { Mia } from '../useMia';
import type { Draft } from '../types';
import { Button, Field, Notice, useUi } from '../ui';
export function DraftCard({ draft, mia }: { draft: Draft; mia: Mia }) {
  const { s } = useUi();
  const [editing, setEditing] = useState(false); const [text, setText] = useState(draft.text ?? ''); const [busy, setBusy] = useState(false);
  const recipient = draft.recipient?.displayName ?? mia.contacts.find(contact => contact.id === draft.recipientId)?.name ?? mia.chats.find(chat => chat.recipient.id === draft.recipientId)?.recipient.displayName;
  async function action(kind: 'review' | 'confirm' | 'discard' | 'edit') { setBusy(true); try { await mia.draftAction(draft, kind, text); setEditing(false); } catch (reason) { mia.fail(reason); await mia.refresh().catch(mia.fail); } finally { setBusy(false); } }
  return <View style={s.card}><Text style={s.label}>{recipient ? `To ${recipient}` : 'Recipient unavailable'}</Text>{editing ? <Field label="Edit draft" multiline value={text} onChangeText={setText} maxLength={8000} /> : <Text selectable style={s.body}>{draft.text ?? 'Voice note'}</Text>}{draft.mediaId && <Button quiet label="Preview voice note" icon="play-outline" onPress={() => void mia.playMedia(draft.mediaId!).catch(mia.fail)} />}
    {draft.state === 'ready' && draft.reviewedVersion === draft.version && recipient ? <Notice>Ready to send to {recipient}. Confirm when you are ready.</Notice> : <Text style={s.small}>Review your message before sending.</Text>}
    <View style={{ gap: 10 }}>{editing ? <><Button label="Save changes" disabled={!text.trim()} loading={busy} onPress={() => void action('edit')} /><Button quiet label="Cancel edit" onPress={() => setEditing(false)} /></> : <><Button label={draft.state === 'ready' && draft.reviewedVersion === draft.version ? 'Confirm & send' : 'Review message'} disabled={!recipient} loading={busy} icon={draft.state === 'ready' ? 'send-outline' : 'checkmark-outline'} onPress={() => void action(draft.state === 'ready' && draft.reviewedVersion === draft.version ? 'confirm' : 'review')} /><View style={s.between}>{draft.kind === 'text' && <Button quiet label="Edit draft" onPress={() => { setText(draft.text ?? ''); setEditing(true); }} />}<Button quiet label="Discard draft" disabled={busy} onPress={() => void action('discard')} /></View></>}</View>
  </View>;
}
export function MessageDrafts({ mia, drafts }: { mia: Mia; drafts: Draft[] }) {
  return <View style={{ gap: 14 }}>{drafts.map(draft => <DraftCard key={`${draft.id}:${draft.version}:${draft.state}`} draft={draft} mia={mia} />)}</View>;
}
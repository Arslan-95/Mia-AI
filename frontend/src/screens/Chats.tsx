import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View, findNodeHandle, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, Button, Empty, Icon, SearchField, agentColors, classicColors, useUi } from '../ui';
import { Reveal } from '../motion';
import { ConversationStatus } from './ConversationStatus';
import { VoiceNoteBubble } from './VoiceNoteBubble';
import { ChatBackGesture } from './ChatBackGesture';
import { MessageList } from './MessageList';
import { ChatComposer } from './ChatComposer';
import { ChatsHeader, ConversationHeader } from './ConversationHeaders';

export function Chats({ mia, bottomInset, overlayInset = 0, preview = false, renderBackScreen }: {
  mia: Mia; bottomInset: number; overlayInset?: number; preview?: boolean; renderBackScreen?(): React.ReactNode;
}) {
  const { agent, colors, s } = useUi();
  const c = agent ? agentStyles : classicStyles;
  const { width, fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.4;
  const chat = mia.chats.find(item => item.id === mia.activeChatId);
  const heading = useRef<Text>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (chat && !mia.aiMode && !preview) { const node = findNodeHandle(heading.current); if (node) AccessibilityInfo.setAccessibilityFocus(node); }
  }, [chat?.id, preview]);
  const searchQuery = query.trim().toLowerCase();
  const matchingChats = mia.chats.filter(item => `${item.recipient.displayName} ${item.recipient.username}`.toLowerCase().includes(searchQuery));
  if (!chat) return <View style={{ flex: 1 }}><Reveal style={{ flex: 1 }}><ScrollView contentContainerStyle={[c.content, { paddingHorizontal: width < 375 ? 16 : 20, paddingBottom: 20 + overlayInset }]} keyboardShouldPersistTaps="handled">
    <ChatsHeader unreadCount={mia.chats.reduce((sum, item) => sum + item.unreadCount, 0)} onNewChat={() => void mia.navigate('people')} onSettings={() => void mia.navigate('settings')} />
    <SearchField label="Search chats" placeholder="Search chats" value={query} onChangeText={setQuery} />
    {!matchingChats.length && <Empty compact={!!searchQuery} title={searchQuery ? 'No chats found' : 'Start a conversation'} text={searchQuery ? 'No chats match your search.' : 'Find your people. Send a message. Or just ask Mia.'}>{!searchQuery && <Button secondary label="Find people" icon="add-outline" onPress={() => void mia.navigate('people')} />}</Empty>}
    {!!matchingChats.length && <View style={agent ? s.insetList : c.chatList}>{matchingChats.map((item, index) => <React.Fragment key={item.id}><Pressable accessibilityRole="button" accessibilityLabel={`${item.recipient.displayName}${item.unreadCount ? `, ${item.unreadCount} unread` : ''}. ${item.lastMessage?.text ?? (item.lastMessage?.kind === 'voice' ? 'Voice note' : 'No messages yet')}`} onPress={() => void mia.navigate('chats', item.id)} style={({ pressed }) => [s.personRow, agent && item.unreadCount > 0 && c.unreadRow, pressed && { backgroundColor: colors.surfacePressed }]}>
      <Avatar name={item.recipient.displayName} size={48} />
      <View style={c.chatText}><View style={[s.between, largeText && c.largeTopLine]}><Text numberOfLines={largeText ? 2 : 1} style={[c.name, { flex: 1 }]}>{item.recipient.displayName}</Text>{!largeText && <Text style={[c.date, item.unreadCount > 0 && { color: colors.accentLight }]}>{item.lastMessage ? new Date(item.lastMessage.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : ''}</Text>}</View>
        <View style={s.between}><View style={[s.row, { flex: 1, gap: 6, minWidth: 0 }]}>{item.lastMessage?.kind === 'voice' && <Icon name="mic-outline" size={14} color={colors.muted} />}<Text numberOfLines={largeText ? 2 : 1} style={[c.preview, item.unreadCount > 0 && { color: agent ? colors.ink : '#CEC6E0' }]}>{item.lastMessage?.text ?? (item.lastMessage?.kind === 'voice' ? 'Voice message' : 'Say hello')}</Text></View>{item.unreadCount > 0 && <View style={c.badge}><Text style={c.badgeText}>{item.unreadCount > 99 ? '99+' : item.unreadCount}</Text></View>}</View>
        {largeText && item.lastMessage && <Text style={[c.date, { maxWidth: '100%' }, item.unreadCount > 0 && { color: colors.accentLight }]}>{new Date(item.lastMessage.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</Text>}
      </View>
    </Pressable>{agent && index < matchingChats.length - 1 && <View style={s.rowDivider} />}</React.Fragment>)}</View>}
  </ScrollView></Reveal></View>;

  const messages = mia.messages[chat.id] ?? [];
  const drafts = mia.drafts.filter(draft => draft.recipientId === chat.recipient.id);
  const conversation = <>
    <ConversationHeader name={chat.recipient.displayName} username={chat.recipient.username} headingRef={heading} onBack={() => void mia.navigateBack()} />
    <MessageList key={`${mia.session!.user.id}/${chat.id}`} userId={mia.session!.user.id} chatId={chat.id} positions={mia.chatScrollPositions} scrollRequest={mia.scrollRequests[chat.id]} passive={preview} scrollEnabled={!preview}
      data={messages} onVisibleMessages={mia.prefetchVoiceMessages} keyExtractor={item => item.id} contentContainerStyle={[c.messages, overlayInset > 0 && { paddingTop: 16 + overlayInset }]} ItemSeparatorComponent={() => <View style={c.messageGap} />} keyboardShouldPersistTaps="handled" scrollEventThrottle={32}
      ListFooterComponent={mia.hasOlder[chat.id] ? <Button quiet label="Load earlier messages" onPress={() => void mia.loadMessages(chat.id, messages[messages.length - 1]?.id).catch(mia.fail)} /> : null}
      ListEmptyComponent={<Empty title="Say something" text="A message or a voice note. It starts here." />}
      renderItem={({ item }) => {
        const mine = item.senderId === mia.session?.user.id;
        return <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 6 }}><View style={[c.bubble, { maxWidth: largeText ? '94%' : agent ? '86%' : '88%' }, mine ? c.sent : c.received]}>
          {item.kind === 'voice' && item.mediaId && <VoiceNoteBubble message={item} playback={mia.originalPlayback} passive={mia.aiMode} onToggle={() => void mia.toggleMediaPlayback(item.mediaId!).catch(mia.fail)} />}
          {!!item.text && <Text selectable style={c.messageText}>{item.text}</Text>}
        </View><Text style={c.timestamp}>{new Date(item.createdAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}{mine ? '  ·  You' : ''}</Text></View>;
      }}
      ListHeaderComponent={<View style={{ gap: 12 }}>
        {mia.pending.filter(item => item.chatId === chat.id && !messages.some(message => message.clientMessageId === item.clientMessageId)).map(item => <View key={item.clientMessageId} style={[agent ? c.pending : s.card, agent && { maxWidth: largeText ? '94%' : '86%' }, !agent && { backgroundColor: colors.yellow }, item.status === 'failed' && c.failed]}><Text style={agent ? c.messageText : s.body}>{item.content.kind === 'text' ? item.content.text : 'Voice note'}</Text><Text style={[s.small, item.status === 'failed' && { color: colors.red }]}>{item.status === 'failed' ? 'Not sent. Your message is kept here.' : 'Sending…'}</Text>{item.status === 'failed' && <Button secondary label="Retry message" icon="refresh" onPress={() => void mia.sendPending(item)} />}</View>)}
      </View>} />
    {!mia.aiMode && <View style={{ paddingHorizontal: 16, paddingTop: 8 }}><ConversationStatus error={mia.error} draft={drafts[0]} recipient={chat.recipient.displayName} onDismiss={() => mia.setError('')} onOpenDraft={() => void mia.navigate('drafts')} /></View>}
    {!mia.aiMode && <ChatComposer key={chat.id} mia={mia} chatId={chat.id} recipient={chat.recipient.displayName} bottomInset={bottomInset} />}
  </>;
  return preview ? <View style={{ flex: 1, backgroundColor: colors.background }}>{conversation}</View>
    : <ChatBackGesture key={chat.id} chatId={chat.id} navigationRevision={mia.navigationRevision} enabled={!mia.aiMode} onBack={() => void mia.navigateBack()} renderBackScreen={renderBackScreen}>{conversation}</ChatBackGesture>;
}

function createStyles(colors: typeof agentColors, agent: boolean) { return StyleSheet.create({
  content: { flexGrow: 1, padding: 20, paddingTop: 12, gap: agent ? 20 : 18 },
  chatList: { marginHorizontal: -8 },
  chatText: { flex: 1, gap: agent ? 5 : 9, minWidth: 0 }, name: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }, preview: { color: colors.muted, fontSize: agent ? 14 : 13, lineHeight: 20, flex: 1 },
  largeTopLine: { alignItems: 'flex-start' }, unreadRow: { backgroundColor: '#21182F' },
  date: { fontSize: agent ? 12 : 10, lineHeight: 17, color: agent ? colors.textTertiary : colors.muted, maxWidth: 64 }, badge: { minWidth: 22, minHeight: 22, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8, backgroundColor: colors.accent, justifyContent: 'center' }, badgeText: { fontSize: agent ? 12 : 10, lineHeight: 17, fontWeight: '700', textAlign: 'center', color: '#140D24' },
  messages: { flexGrow: 1, padding: agent ? 16 : 20 }, messageGap: { height: agent ? 14 : 16 },
  bubble: { paddingHorizontal: agent ? 14 : 17, paddingVertical: agent ? 12 : 14, borderRadius: 22, gap: 8, borderWidth: 1 },
  sent: { backgroundColor: agent ? colors.sentFill : '#53348E', borderColor: agent ? colors.sentBorder : '#7050A8', borderBottomRightRadius: agent ? 8 : 6 }, received: { backgroundColor: colors.paper, borderColor: colors.line, borderBottomLeftRadius: agent ? 8 : 6 },
  messageText: { color: colors.ink, fontSize: agent ? 16 : 15, lineHeight: agent ? 24 : 23 }, timestamp: { color: colors.muted, fontSize: agent ? 12 : 10, lineHeight: 17, marginHorizontal: 5 },
  pending: { alignSelf: 'flex-end', backgroundColor: agent ? colors.sentFill : colors.yellow, borderColor: agent ? colors.sentBorder : colors.line, borderWidth: 1, borderRadius: 22, borderBottomRightRadius: 8, paddingHorizontal: 14, paddingVertical: 12, gap: 8 }, failed: { borderColor: '#925066', backgroundColor: colors.errorSurface },
}); }
const classicStyles = createStyles(classicColors, false);
const agentStyles = createStyles(agentColors, true);

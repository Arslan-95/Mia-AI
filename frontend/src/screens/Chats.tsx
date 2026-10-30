import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View, findNodeHandle, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, Button, Empty, HeaderAction, Icon, ScreenAtmosphere, ScreenHeader, SearchField, agentColors, classicColors, useUi } from '../ui';
import { Reveal } from '../motion';
import { MessageDrafts } from './MessageDrafts';
import { ChatBackGesture } from './ChatBackGesture';
import { MessageList } from './MessageList';

export function Chats({ mia, bottomInset }: { mia: Mia; bottomInset: number }) {
  const { agent, colors, s } = useUi();
  const c = agent ? agentStyles : classicStyles;
  const { width, fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.4;
  const chat = mia.chats.find(item => item.id === mia.activeChatId);
  const heading = useRef<Text>(null);
  const [query, setQuery] = useState('');
  const [showDrafts, setShowDrafts] = useState(false);
  useEffect(() => {
    setShowDrafts(false);
    if (chat && !mia.aiMode) { const node = findNodeHandle(heading.current); if (node) AccessibilityInfo.setAccessibilityFocus(node); }
  }, [chat?.id]);
  const searchQuery = query.trim().toLowerCase();
  const matchingChats = mia.chats.filter(item => `${item.recipient.displayName} ${item.recipient.username}`.toLowerCase().includes(searchQuery));
  if (!chat) return <View style={{ flex: 1 }}>{agent && <ScreenAtmosphere />}<Reveal style={{ flex: 1 }}><ScrollView contentContainerStyle={[c.content, { paddingHorizontal: width < 375 ? 16 : 20 }]} keyboardShouldPersistTaps="handled">
    <ScreenHeader title="Chats" action={<HeaderAction label="New chat" icon="create-outline" onPress={() => void mia.navigate('people')} />} />
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
  const composer = mia.composers[chat.id] ?? '';
  const drafts = mia.drafts.filter(draft => draft.recipientId === chat.recipient.id);
  return <ChatBackGesture chatId={chat.id} enabled={!mia.aiMode} onBack={() => void mia.navigateBack()}>
    <View style={c.chatHeader}><Button quiet iconOnly label="Back" icon="chevron-back" onPress={() => void mia.navigateBack()} style={c.headerAction} /><Avatar name={chat.recipient.displayName} size={agent ? 38 : 36} /><View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text ref={heading} accessibilityRole="header" numberOfLines={largeText ? 2 : 1} style={c.name}>{chat.recipient.displayName}</Text><Text numberOfLines={largeText ? 2 : 1} style={s.small}>@{chat.recipient.username}</Text></View></View>
    <MessageList key={`${mia.session!.user.id}/${chat.id}`} userId={mia.session!.user.id} chatId={chat.id} positions={mia.chatScrollPositions}
      data={messages} keyExtractor={item => item.id} contentContainerStyle={c.messages} ItemSeparatorComponent={() => <View style={c.messageGap} />} keyboardShouldPersistTaps="handled" scrollEventThrottle={32}
      ListFooterComponent={mia.hasOlder[chat.id] ? <Button quiet label="Load earlier messages" onPress={() => void mia.loadMessages(chat.id, messages[messages.length - 1]?.id).catch(mia.fail)} /> : null}
      ListEmptyComponent={<Empty title="Say something" text="A message or a voice note. It starts here." />}
      renderItem={({ item }) => {
        const mine = item.senderId === mia.session?.user.id;
        return <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 6 }}><View style={[c.bubble, { maxWidth: largeText ? '94%' : agent ? '86%' : '88%' }, mine ? c.sent : c.received]}>
          {item.kind === 'voice' && item.mediaId && <Button label="Play voice note" secondary icon="play" onPress={() => void mia.playMedia(item.mediaId!).catch(mia.fail)} />}
          {!!item.text && <Text selectable style={c.messageText}>{item.text}</Text>}
        </View><Text style={c.timestamp}>{new Date(item.createdAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}{mine ? '  ·  You' : ''}</Text></View>;
      }}
      ListHeaderComponent={<View style={{ gap: 12 }}>
        {mia.pending.filter(item => item.chatId === chat.id).map(item => <View key={item.clientMessageId} style={[agent ? c.pending : s.card, agent && { maxWidth: largeText ? '94%' : '86%' }, !agent && { backgroundColor: colors.yellow }, item.status === 'failed' && c.failed]}><Text style={agent ? c.messageText : s.body}>{item.content.kind === 'text' ? item.content.text : 'Voice note'}</Text><Text style={[s.small, item.status === 'failed' && { color: colors.red }]}>{item.status === 'failed' ? 'Not sent. Your message is kept here.' : 'Sending…'}</Text>{item.status === 'failed' && <Button secondary label="Retry message" icon="refresh" onPress={() => void mia.sendPending(item)} />}</View>)}
        {showDrafts && <MessageDrafts mia={mia} drafts={drafts} />}
      </View>} />
    {drafts.length > 0 && <View style={c.draftsStrip}><Button secondary={agent} quiet={!agent} label={`${showDrafts ? 'Hide' : 'Review'} ${drafts.length} saved ${drafts.length === 1 ? 'message' : 'messages'}`} icon="bookmark-outline" onPress={() => setShowDrafts(!showDrafts)} /></View>}
    {!mia.aiMode && <View testID="message-composer-area" style={[c.composerArea, { paddingBottom: Math.max(bottomInset, 8) }]}>
      <View style={c.composer}>
        <Button quiet iconOnly label="Voice note" icon="mic-outline" disabled={mia.audioState === 'recording' || !!mia.recording} onPress={() => { Keyboard.dismiss(); void mia.startRecording().catch(mia.fail); }} style={c.composerAction} />
        <TextInput accessibilityLabel={`Message ${chat.recipient.displayName}`} placeholder="Message…" placeholderTextColor={colors.muted} keyboardAppearance="dark" selectionColor={colors.accentLight} multiline maxLength={8000} value={composer} onChangeText={mia.setComposer} style={c.composerInput} />
        <Button iconOnly label="Send" icon="arrow-up" disabled={!composer.trim()} onPress={() => void mia.sendText()} style={[c.send, !composer.trim() && { backgroundColor: colors.line }]} />
      </View>
    </View>}
  </ChatBackGesture>;
}

function createStyles(colors: typeof agentColors, agent: boolean) { return StyleSheet.create({
  content: { flexGrow: 1, padding: 20, gap: agent ? 20 : 18 },
  chatList: { marginHorizontal: -8 },
  chatText: { flex: 1, gap: agent ? 5 : 9, minWidth: 0 }, name: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }, preview: { color: colors.muted, fontSize: agent ? 14 : 13, lineHeight: 20, flex: 1 },
  largeTopLine: { alignItems: 'flex-start' }, unreadRow: { backgroundColor: '#21182F' },
  date: { fontSize: agent ? 12 : 10, lineHeight: 17, color: agent ? colors.textTertiary : colors.muted, maxWidth: 64 }, badge: { minWidth: 22, minHeight: 22, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8, backgroundColor: colors.accent, justifyContent: 'center' }, badgeText: { fontSize: agent ? 12 : 10, lineHeight: 17, fontWeight: '700', textAlign: 'center', color: '#140D24' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: agent ? 12 : 8, paddingTop: agent ? 8 : 6, paddingBottom: agent ? 8 : 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: agent ? '#110E1C' : 'transparent' },
  headerAction: { width: 44, height: 44, minHeight: 44, paddingVertical: 0, paddingHorizontal: 0 },
  messages: { flexGrow: 1, padding: agent ? 16 : 20 }, messageGap: { height: agent ? 14 : 16 },
  bubble: { paddingHorizontal: agent ? 14 : 17, paddingVertical: agent ? 12 : 14, borderRadius: 22, gap: 8, borderWidth: 1 },
  sent: { backgroundColor: agent ? colors.sentFill : '#53348E', borderColor: agent ? colors.sentBorder : '#7050A8', borderBottomRightRadius: agent ? 8 : 6 }, received: { backgroundColor: colors.paper, borderColor: colors.line, borderBottomLeftRadius: agent ? 8 : 6 },
  messageText: { color: colors.ink, fontSize: agent ? 16 : 15, lineHeight: agent ? 24 : 23 }, timestamp: { color: colors.muted, fontSize: agent ? 12 : 10, lineHeight: 17, marginHorizontal: 5 },
  pending: { alignSelf: 'flex-end', backgroundColor: agent ? colors.sentFill : colors.yellow, borderColor: agent ? colors.sentBorder : colors.line, borderWidth: 1, borderRadius: 22, borderBottomRightRadius: 8, paddingHorizontal: 14, paddingVertical: 12, gap: 8 }, failed: { borderColor: '#925066', backgroundColor: colors.errorSurface },
  draftsStrip: { paddingHorizontal: agent ? 12 : 0, paddingTop: agent ? 8 : 0, paddingBottom: agent ? 4 : 0 },
  composerArea: { paddingHorizontal: agent ? 12 : 16, paddingTop: agent ? 8 : 6, backgroundColor: agent ? '#110E1C' : 'transparent', borderTopWidth: agent ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.line }, composer: { flexDirection: 'row', alignItems: 'flex-end', padding: agent ? 3 : 2, backgroundColor: agent ? colors.elevated : colors.paper, borderRadius: agent ? 26 : 24, borderWidth: 1, borderColor: agent ? '#49365F' : '#393045' },
  composerInput: { flex: 1, minWidth: 0, minHeight: 44, maxHeight: 120, paddingVertical: agent ? 11 : 12, paddingHorizontal: 4, color: colors.ink, fontSize: agent ? 16 : 15, lineHeight: agent ? 22 : 20 },
  composerAction: { width: 44, height: 44, minHeight: 44, paddingVertical: 0, paddingHorizontal: 0 },
  send: { width: 44, height: 44, minHeight: 44, paddingVertical: 0, paddingHorizontal: 0, borderRadius: 22 },
}); }
const classicStyles = createStyles(classicColors, false);
const agentStyles = createStyles(agentColors, true);

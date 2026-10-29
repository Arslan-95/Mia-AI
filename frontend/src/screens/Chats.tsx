import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View, findNodeHandle } from 'react-native';
import type { Mia } from '../useMia';
import { Avatar, Button, Empty, HeaderAction, Icon, ScreenHeader, SearchField, colors, s } from '../ui';
import { MessageDrafts } from './MessageDrafts';
import { ChatBackGesture } from './ChatBackGesture';
import { MessageList } from './MessageList';

export function Chats({ mia, bottomInset }: { mia: Mia; bottomInset: number }) {
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
  if (!chat) return <ScrollView contentContainerStyle={c.content} keyboardShouldPersistTaps="handled">
    <ScreenHeader title="Chats" action={<HeaderAction label="New chat" icon="create-outline" onPress={() => void mia.navigate('people')} />} />
    <SearchField label="Search chats" placeholder="Search chats" value={query} onChangeText={setQuery} />
    {!matchingChats.length && <Empty title={searchQuery ? 'No chats found' : 'Start a conversation'} text={searchQuery ? 'No chats match your search.' : 'Find your people. Send a message. Or just ask Mia.'}>{!searchQuery && <Button secondary label="Find people" icon="add-outline" onPress={() => void mia.navigate('people')} />}</Empty>}
    <View style={c.chatList}>{matchingChats.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.recipient.displayName}${item.unreadCount ? `, ${item.unreadCount} unread` : ''}. ${item.lastMessage?.text ?? (item.lastMessage?.kind === 'voice' ? 'Voice note' : 'No messages yet')}`} onPress={() => void mia.navigate('chats', item.id)} style={({ pressed }) => [s.personRow, { backgroundColor: pressed ? colors.paper : 'transparent' }]}>
      <Avatar name={item.recipient.displayName} size={48} />
      <View style={c.chatText}><View style={s.between}><Text numberOfLines={1} style={[c.name, { flex: 1 }]}>{item.recipient.displayName}</Text><Text style={[c.date, item.unreadCount > 0 && { color: colors.accentLight }]}>{item.lastMessage ? new Date(item.lastMessage.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : ''}</Text></View>
        <View style={s.between}><View style={[s.row, { flex: 1, gap: 6 }]}>{item.lastMessage?.kind === 'voice' && <Icon name="mic-outline" size={14} color={colors.muted} />}<Text numberOfLines={1} style={[c.preview, item.unreadCount > 0 && { color: '#CEC6E0' }]}>{item.lastMessage?.text ?? (item.lastMessage?.kind === 'voice' ? 'Voice message' : 'Say hello')}</Text></View>{item.unreadCount > 0 && <View style={c.badge}><Text style={c.badgeText}>{item.unreadCount > 99 ? '99+' : item.unreadCount}</Text></View>}</View>
      </View>
    </Pressable>)}</View>
  </ScrollView>;

  const messages = mia.messages[chat.id] ?? [];
  const composer = mia.composers[chat.id] ?? '';
  const drafts = mia.drafts.filter(draft => draft.recipientId === chat.recipient.id);
  return <ChatBackGesture chatId={chat.id} enabled={!mia.aiMode} onBack={() => void mia.navigateBack()}>
    <View style={c.chatHeader}><Button quiet iconOnly label="Back" icon="chevron-back" onPress={() => void mia.navigateBack()} style={c.headerAction} /><Avatar name={chat.recipient.displayName} size={36} /><View style={{ flex: 1, gap: 1 }}><Text ref={heading} accessibilityRole="header" numberOfLines={1} style={[s.sectionTitle, { fontSize: 16 }]}>{chat.recipient.displayName}</Text><Text style={s.small}>@{chat.recipient.username}</Text></View></View>
    <MessageList key={`${mia.session!.user.id}/${chat.id}`} userId={mia.session!.user.id} chatId={chat.id} positions={mia.chatScrollPositions}
      data={messages} keyExtractor={item => item.id} contentContainerStyle={c.messages} ItemSeparatorComponent={() => <View style={c.messageGap} />} keyboardShouldPersistTaps="handled" scrollEventThrottle={32}
      ListFooterComponent={mia.hasOlder[chat.id] ? <Button quiet label="Load earlier messages" onPress={() => void mia.loadMessages(chat.id, messages[messages.length - 1]?.id).catch(mia.fail)} /> : null}
      ListEmptyComponent={<Empty title="Say something" text="A message or a voice note. It starts here." />}
      renderItem={({ item }) => {
        const mine = item.senderId === mia.session?.user.id;
        return <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 7 }}><View style={[c.bubble, mine ? c.sent : c.received]}>
          {item.kind === 'voice' && item.mediaId && <Button label="Play voice note" secondary icon="play" onPress={() => void mia.playMedia(item.mediaId!).catch(mia.fail)} />}
          {!!item.text && <Text selectable style={c.messageText}>{item.text}</Text>}
        </View><Text style={c.timestamp}>{new Date(item.createdAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}{mine ? '  ·  You' : ''}</Text></View>;
      }}
      ListHeaderComponent={<View style={{ gap: 12 }}>
        {mia.pending.filter(item => item.chatId === chat.id).map(item => <View key={item.clientMessageId} style={[s.card, { backgroundColor: colors.yellow }]}><Text style={s.body}>{item.content.kind === 'text' ? item.content.text : 'Voice note'}</Text><Text style={s.small}>{item.status === 'failed' ? 'Not sent. Your message is kept here.' : 'Sending…'}</Text>{item.status === 'failed' && <Button secondary label="Retry message" icon="refresh" onPress={() => void mia.sendPending(item)} />}</View>)}
        {showDrafts && <MessageDrafts mia={mia} drafts={drafts} />}
      </View>} />
    {drafts.length > 0 && <Button quiet label={`${showDrafts ? 'Hide' : 'Review'} ${drafts.length} saved ${drafts.length === 1 ? 'message' : 'messages'}`} icon="bookmark-outline" onPress={() => setShowDrafts(!showDrafts)} />}
    <View testID="message-composer-area" style={[c.composerArea, { paddingBottom: Math.max(bottomInset, 8) }]}>
      <View style={c.composer}>
        <Button quiet iconOnly label="Voice note" icon="mic-outline" disabled={mia.audioState === 'recording' || !!mia.recording} onPress={() => { Keyboard.dismiss(); void mia.startRecording().catch(mia.fail); }} style={c.composerAction} />
        <TextInput accessibilityLabel={`Message ${chat.recipient.displayName}`} placeholder="Message…" placeholderTextColor={colors.muted} keyboardAppearance="dark" selectionColor={colors.accentLight} multiline maxLength={8000} value={composer} onChangeText={mia.setComposer} style={c.composerInput} />
        <Button iconOnly label="Send" icon="arrow-up" disabled={!composer.trim()} onPress={() => void mia.sendText()} style={c.send} />
      </View>
    </View>
  </ChatBackGesture>;
}

const c = StyleSheet.create({
  content: { flexGrow: 1, padding: 20, gap: 18 },
  chatList: { marginHorizontal: -8 },
  chatText: { flex: 1, gap: 9, minWidth: 0 }, name: { fontSize: 16, fontWeight: '600', color: colors.ink, letterSpacing: -.2 }, preview: { color: colors.muted, fontSize: 13, flex: 1 },
  date: { fontSize: 10, color: colors.muted }, badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 8, backgroundColor: '#A184EE', justifyContent: 'center' }, badgeText: { fontSize: 10, fontWeight: '700', textAlign: 'center', color: '#140D24' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  headerAction: { width: 44, height: 44, minHeight: 44, paddingVertical: 0, paddingHorizontal: 0 },
  messages: { flexGrow: 1, padding: 20 }, messageGap: { height: 16 },
  bubble: { maxWidth: '88%', paddingHorizontal: 17, paddingVertical: 14, borderRadius: 22, gap: 8, borderWidth: 1 },
  sent: { backgroundColor: '#53348E', borderColor: '#7050A8', borderBottomRightRadius: 6 }, received: { backgroundColor: colors.paper, borderColor: colors.line, borderBottomLeftRadius: 6 },
  messageText: { color: colors.ink, fontSize: 15, lineHeight: 23 }, timestamp: { color: colors.muted, fontSize: 10, marginHorizontal: 5 },
  composerArea: { paddingHorizontal: 16, paddingTop: 6 }, composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 2, backgroundColor: colors.paper, borderRadius: 24, borderWidth: 1, borderColor: '#393045' },
  composerInput: { flex: 1, minHeight: 44, maxHeight: 120, paddingVertical: 12, paddingHorizontal: 4, color: colors.ink, fontSize: 15, lineHeight: 20 },
  composerAction: { width: 44, height: 44, minHeight: 44, paddingVertical: 0, paddingHorizontal: 0 },
  send: { width: 44, height: 44, minHeight: 44, paddingVertical: 0, paddingHorizontal: 0, borderRadius: 22 },
});

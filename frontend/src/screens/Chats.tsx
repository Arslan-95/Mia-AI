import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View, findNodeHandle } from 'react-native';
import type { Message } from '../types';
import type { Mia } from '../useMia';
import { Avatar, Button, Empty, Icon, colors, s } from '../ui';
import { MessageDrafts } from './MessageDrafts';

export function Chats({ mia }: { mia: Mia }) {
  const chat = mia.chats.find(item => item.id === mia.activeChatId);
  const heading = useRef<Text>(null);
  const list = useRef<FlatList<Message>>(null);
  const atBottom = useRef(true);
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [showDrafts, setShowDrafts] = useState(false);
  useEffect(() => {
    atBottom.current = true; setShowDrafts(false);
    if (chat && !mia.aiMode) { const node = findNodeHandle(heading.current); if (node) AccessibilityInfo.setAccessibilityFocus(node); }
  }, [chat?.id]);
  const filtered = mia.chats.filter(item => (!unreadOnly || item.unreadCount > 0) && `${item.recipient.displayName} ${item.recipient.username}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (!chat) return <ScrollView contentContainerStyle={c.content} keyboardShouldPersistTaps="handled">
    <View style={s.between}>
      <Text accessibilityRole="header" style={s.heading}>Chats</Text>
      <Button secondary iconOnly label="New chat" icon="create-outline" onPress={() => void mia.navigate('people')} />
    </View>
    <View style={c.search}><Icon name="search-outline" size={19} color={colors.muted} /><TextInput accessibilityLabel="Search chats" placeholder="Search chats" placeholderTextColor={colors.muted} keyboardAppearance="dark" selectionColor={colors.accentLight} value={query} onChangeText={setQuery} style={c.searchInput} autoCorrect={false} /></View>
    <View style={c.filters}>
      {[{ label: 'All', active: !unreadOnly, value: false }, { label: 'Unread', active: unreadOnly, value: true }].map(filter => <Pressable key={filter.label} accessibilityRole="button" accessibilityState={{ selected: filter.active }} onPress={() => setUnreadOnly(filter.value)} style={[c.filter, filter.active && c.activeFilter]}><Text style={[c.filterLabel, filter.active && { color: colors.accentLight }]}>{filter.label}</Text></Pressable>)}
      <Text style={c.chatCount}>{mia.chats.length} {mia.chats.length === 1 ? 'chat' : 'chats'}</Text>
    </View>
    {!filtered.length && <Empty title={query || unreadOnly ? 'You’re all caught up' : 'Start a conversation'} text={query ? 'No chats match your search.' : unreadOnly ? 'No unread messages.' : 'Find your people. Send a message. Or just ask Mia.'}>{!query && !unreadOnly && <Button secondary label="Find people" icon="add-outline" onPress={() => void mia.navigate('people')} />}</Empty>}
    <View style={c.chatList}>{filtered.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.recipient.displayName}${item.unreadCount ? `, ${item.unreadCount} unread` : ''}. ${item.lastMessage?.text ?? (item.lastMessage?.kind === 'voice' ? 'Voice note' : 'No messages yet')}`} onPress={() => void mia.navigate('chats', item.id)} style={({ pressed }) => [c.chatRow, { backgroundColor: pressed ? colors.paper : 'transparent' }]}>
      <Avatar name={item.recipient.displayName} size={56} />
      <View style={c.chatText}><View style={s.between}><Text numberOfLines={1} style={[c.name, { flex: 1 }]}>{item.recipient.displayName}</Text><Text style={[c.date, item.unreadCount > 0 && { color: colors.accentLight }]}>{item.lastMessage ? new Date(item.lastMessage.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : ''}</Text></View>
        <View style={s.between}><View style={[s.row, { flex: 1, gap: 6 }]}>{item.lastMessage?.kind === 'voice' && <Icon name="mic-outline" size={14} color={colors.muted} />}<Text numberOfLines={1} style={[c.preview, item.unreadCount > 0 && { color: '#CEC6E0' }]}>{item.lastMessage?.text ?? (item.lastMessage?.kind === 'voice' ? 'Voice message' : 'Say hello')}</Text></View>{item.unreadCount > 0 && <View style={c.badge}><Text style={c.badgeText}>{item.unreadCount > 99 ? '99+' : item.unreadCount}</Text></View>}</View>
      </View>
    </Pressable>)}</View>
  </ScrollView>;

  const messages = mia.messages[chat.id] ?? [];
  const composer = mia.composers[chat.id] ?? '';
  const drafts = mia.drafts.filter(draft => draft.recipientId === chat.recipient.id);
  return <View style={{ flex: 1 }}>
    <View style={c.chatHeader}><Button quiet iconOnly label="Back" icon="chevron-back" onPress={() => void mia.navigate('chats')} /><Avatar name={chat.recipient.displayName} size={42} /><View style={{ flex: 1, gap: 3 }}><Text ref={heading} accessibilityRole="header" numberOfLines={1} style={[s.sectionTitle, { fontSize: 18 }]}>{chat.recipient.displayName}</Text><Text style={s.small}>@{chat.recipient.username}</Text></View><Icon name="chatbubble-ellipses-outline" size={20} color={colors.accentLight} /></View>
    <FlatList ref={list} data={[...messages].reverse()} keyExtractor={item => item.id} contentContainerStyle={c.messages} keyboardShouldPersistTaps="handled" scrollEventThrottle={100}
      onScroll={event => { const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent; atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 70; }}
      onContentSizeChange={() => { if (atBottom.current) list.current?.scrollToEnd({ animated: false }); }}
      ListHeaderComponent={mia.hasOlder[chat.id] ? <Button quiet label="Load earlier messages" onPress={() => { atBottom.current = false; void mia.loadMessages(chat.id, messages[messages.length - 1]?.id).catch(mia.fail); }} /> : messages.length ? <View style={c.historyLabel}><View style={c.historyLine} /><Text style={s.small}>Your conversation</Text><View style={c.historyLine} /></View> : null}
      ListEmptyComponent={<Empty title="Say something" text="A message or a voice note. It starts here." />}
      renderItem={({ item }) => {
        const mine = item.senderId === mia.session?.user.id;
        return <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 7 }}><View style={[c.bubble, mine ? c.sent : c.received]}>
          {item.kind === 'voice' && item.mediaId && <Button label="Play voice note" secondary icon="play" onPress={() => void mia.playMedia(item.mediaId!).catch(mia.fail)} />}
          {!!item.text && <Text selectable style={c.messageText}>{item.text}</Text>}
        </View><Text style={c.timestamp}>{new Date(item.createdAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}{mine ? '  ·  You' : ''}</Text></View>;
      }}
      ListFooterComponent={<View style={{ gap: 12 }}>
        {mia.pending.filter(item => item.chatId === chat.id).map(item => <View key={item.clientMessageId} style={[s.card, { backgroundColor: colors.yellow }]}><Text style={s.body}>{item.content.kind === 'text' ? item.content.text : 'Voice note'}</Text><Text style={s.small}>{item.status === 'failed' ? 'Not sent. Your message is kept here.' : 'Sending…'}</Text>{item.status === 'failed' && <Button secondary label="Retry message" icon="refresh" onPress={() => void mia.sendPending(item)} />}</View>)}
        {showDrafts && <MessageDrafts mia={mia} drafts={drafts} />}
      </View>} />
    {drafts.length > 0 && <Button quiet label={`${showDrafts ? 'Hide' : 'Review'} ${drafts.length} saved ${drafts.length === 1 ? 'message' : 'messages'}`} icon="bookmark-outline" onPress={() => setShowDrafts(!showDrafts)} />}
    <View style={c.composerArea}>
      <View style={c.composer}>
        <Button quiet iconOnly label="Voice note" icon="mic-outline" disabled={mia.audioState === 'recording' || !!mia.recording} onPress={() => void mia.startRecording().catch(mia.fail)} />
        <TextInput accessibilityLabel={`Message ${chat.recipient.displayName}`} placeholder="Message…" placeholderTextColor={colors.muted} keyboardAppearance="dark" selectionColor={colors.accentLight} multiline maxLength={8000} value={composer} onChangeText={mia.setComposer} style={c.composerInput} />
        <Button iconOnly label="Send" icon="arrow-up" disabled={!composer.trim()} onPress={() => void mia.sendText()} style={c.send} />
      </View>
      {!!composer.trim() && <Button quiet label="Save for later" icon="bookmark-outline" onPress={() => void mia.saveDraft().catch(mia.fail)} />}
    </View>
  </View>;
}

const c = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24, gap: 24 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line, borderRadius: 17, paddingHorizontal: 16 },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, minHeight: 50, paddingVertical: 12 },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 10 }, filter: { minHeight: 44, paddingHorizontal: 19, justifyContent: 'center', borderRadius: 22, borderWidth: 1, borderColor: colors.line },
  activeFilter: { backgroundColor: colors.soft, borderColor: '#4C386D' }, filterLabel: { fontSize: 13, color: colors.muted, fontWeight: '500' },
  chatCount: { color: colors.muted, fontSize: 11, marginLeft: 'auto' },
  chatList: { marginHorizontal: -8 }, chatRow: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingHorizontal: 8, paddingVertical: 18, borderRadius: 18 },
  chatText: { flex: 1, gap: 9, minWidth: 0 }, name: { fontSize: 16, fontWeight: '600', color: colors.ink, letterSpacing: -.2 }, preview: { color: colors.muted, fontSize: 13, flex: 1 },
  date: { fontSize: 10, color: colors.muted }, badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 8, backgroundColor: '#A184EE', justifyContent: 'center' }, badgeText: { fontSize: 10, fontWeight: '700', textAlign: 'center', color: '#140D24' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.line },
  messages: { flexGrow: 1, padding: 24, gap: 20 }, historyLabel: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 22 }, historyLine: { flex: 1, height: 1, backgroundColor: colors.line },
  bubble: { maxWidth: '88%', paddingHorizontal: 17, paddingVertical: 14, borderRadius: 22, gap: 8, borderWidth: 1 },
  sent: { backgroundColor: '#53348E', borderColor: '#7050A8', borderBottomRightRadius: 6 }, received: { backgroundColor: colors.paper, borderColor: colors.line, borderBottomLeftRadius: 6 },
  messageText: { color: colors.ink, fontSize: 15, lineHeight: 23 }, timestamp: { color: colors.muted, fontSize: 10, marginHorizontal: 5 },
  composerArea: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 20 }, composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 5, backgroundColor: colors.paper, borderRadius: 24, borderWidth: 1, borderColor: '#393045' },
  composerInput: { flex: 1, minHeight: 48, maxHeight: 140, paddingTop: 14, paddingBottom: 13, paddingHorizontal: 4, color: colors.ink, fontSize: 15 }, send: { width: 44, minHeight: 44, margin: 2, borderRadius: 17 },
});

import React, { useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type FlatListProps } from 'react-native';
import type { ChatScrollPositions } from '../chatScrollPositions';
import type { Message } from '../types';
import { colors } from '../ui';

type Props = Omit<FlatListProps<Message>, 'data' | 'inverted' | 'contentOffset' | 'onScroll' | 'maintainVisibleContentPosition'> & {
  userId: string; chatId: string; positions: ChatScrollPositions; data: readonly Message[];
};

// Keyed by account/chat at the call site: this is a native initial offset,
// not a scrollToEnd after the history has appeared on screen.
export function MessageList({ userId, chatId, positions, data, ...props }: Props) {
  const [initial] = useState(() => positions.read(userId, chatId));
  const [initialData, setInitialData] = useState(() => initial.offset ? initial.messages : undefined);
  const offset = useRef({ x: 0, y: initial.offset ?? 0 }).current;
  const restored = useRef(offset.y === 0);
  const visibleData = initialData ?? data;
  const dayStarts = useMemo(() => new Set(visibleData.filter((message, index) =>
    new Date(message.createdAt).toDateString() !== (visibleData[index + 1] ? new Date(visibleData[index + 1]!.createdAt).toDateString() : null)
  ).map(message => message.id)), [visibleData]);
  return <FlatList {...props} data={visibleData} inverted contentOffset={offset}
    renderItem={info => <View>
      {dayStarts.has(info.item.id) && <Text style={p.dayLabel}>{new Date(info.item.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>}
      {props.renderItem?.(info)}
    </View>}
    maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 70 }}
    onScrollBeginDrag={() => { restored.current = true; }}
    onScroll={event => {
      const y = Math.max(0, event.nativeEvent.contentOffset.y);
      // Ignore mount/layout events until the requested offset is installed;
      // a deliberate drag always takes precedence over restoration.
      if (!restored.current && Math.abs(y - offset.y) > 1) return;
      restored.current = true;
      positions.save(userId, chatId, initial.generation, y, visibleData);
    }}
    onContentSizeChange={(width, height) => {
      // Restore against the same message snapshot, then let native anchoring
      // insert messages that arrived while this chat was closed.
      if (initialData && height > 0) setInitialData(undefined);
      props.onContentSizeChange?.(width, height);
    }} />;
}
const p = StyleSheet.create({ dayLabel: { color: colors.muted, fontSize: 11, textAlign: 'center', marginTop: 4, marginBottom: 18 } });

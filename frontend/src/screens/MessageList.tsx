import React, { useRef, useState } from 'react';
import { FlatList, type FlatListProps } from 'react-native';
import type { ChatScrollPositions } from '../chatScrollPositions';
import type { Message } from '../types';

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
  return <FlatList {...props} data={visibleData} inverted contentOffset={offset}
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

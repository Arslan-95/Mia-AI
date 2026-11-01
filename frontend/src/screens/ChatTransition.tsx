import React, { useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, StyleSheet } from 'react-native';
import { useReducedMotion } from '../motion';
import type { Mia } from '../useMia';

type Route = Pick<Mia, 'tab' | 'activeChatId'> & { userId?: string };

/** Keep the outgoing conversation mounted until the entire viewport is black. */
export function useChatTransition(mia: Mia) {
  const reduced = useReducedMotion();
  const userId = mia.session?.user.id;
  const { tab, activeChatId, navigationDirection } = mia;
  const [shown, setShown] = useState<Route>({ tab, activeChatId, userId });
  const current = useRef(shown);
  const opacity = useRef(new Animated.Value(0)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const generation = useRef(0);
  const [reveal, setReveal] = useState(0);
  const [transitioning, setTransitioning] = useState(false);

  useLayoutEffect(() => {
    const token = ++generation.current;
    animation.current?.stop();
    const next = { tab, activeChatId, userId };
    const previous = current.current;
    const commit = () => { current.current = next; setShown(next); };
    const betweenChats = navigationDirection !== 'back' && previous.userId === userId && !!userId
      && previous.tab === 'chats' && tab === 'chats'
      && !!previous.activeChatId && !!activeChatId && previous.activeChatId !== activeChatId;

    if (reduced || !betweenChats) {
      opacity.setValue(0); setTransitioning(false); commit();
    } else {
      Keyboard.dismiss();
      setTransitioning(true);
      animation.current = Animated.timing(opacity, {
        toValue: 1, duration: 220, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
      });
      animation.current.start(({ finished }) => {
        if (!finished || generation.current !== token) return;
        commit();
        setReveal(token);
      });
    }
    return () => { generation.current++; animation.current?.stop(); };
  }, [tab, activeChatId, userId, navigationDirection, reduced, opacity]);

  // This effect runs after the destination has committed beneath the opaque
  // overlay, so its header, messages and footer appear together on the reveal.
  useLayoutEffect(() => {
    if (!reveal || generation.current !== reveal) return;
    animation.current = Animated.timing(opacity, {
      toValue: 0, delay: 60, duration: 300, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
    });
    animation.current.start(({ finished }) => {
      if (finished && generation.current === reveal) setTransitioning(false);
    });
  }, [reveal, opacity]);

  // Never retain a previous account's conversation, even for one render.
  const route = shown.userId === userId ? shown : { tab, activeChatId };
  return { mia: { ...mia, tab: route.tab, activeChatId: route.activeChatId }, opacity, transitioning };
}

export function ChatTransitionOverlay({ opacity, transitioning }: {
  opacity: Animated.Value; transitioning: boolean;
}) {
  return <Animated.View testID="chat-transition-overlay" pointerEvents={transitioning ? 'auto' : 'none'}
    accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[styles.blackout, { opacity }]} />;
}

const styles = StyleSheet.create({
  blackout: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: '#000000', zIndex: 100, elevation: 100 },
});

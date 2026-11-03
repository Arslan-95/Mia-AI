import React, { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Avatar, Icon, useUi } from '../../../shared/ui/ui';
import { usePressOpacity } from '../../../shared/ui/motion';

function HeaderButton({ label, icon, primary = false, onPress }: {
  label: string; icon: React.ComponentProps<typeof Icon>['name']; primary?: boolean; onPress(): void;
}) {
  const { colors, s } = useUi();
  const [focused, setFocused] = useState(false);
  const motion = usePressOpacity();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    onPressIn={motion.onPressIn} onPressOut={motion.onPressOut} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [styles.button, { backgroundColor: primary ? colors.accentLight : colors.paper, borderColor: primary ? '#E2D4FF' : colors.line }, pressed && { opacity: .8 }, focused && s.focus]}>
    <Animated.View style={{ opacity: motion.opacity }}><Icon name={icon} size={21} color={primary ? '#291B40' : colors.accentLight} /></Animated.View>
  </Pressable>;
}

export function ChatsHeader({ unreadCount, onNewChat, onSettings }: {
  unreadCount: number; onNewChat(): void; onSettings(): void;
}) {
  const { colors } = useUi();
  const { fontScale } = useWindowDimensions();
  return <View style={styles.home}>
    <View style={[styles.titleRow, fontScale > 1.6 && styles.stacked]}>
      <View style={styles.titleGroup}><Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>Chats</Text>
        {unreadCount > 0 && <View style={[styles.unread, { backgroundColor: colors.soft, borderColor: colors.line }]}><Text style={[styles.unreadText, { color: colors.accentLight }]}>{unreadCount} unread</Text></View>}
      </View>
      <View style={styles.actions}><HeaderButton label="Open settings" icon="options-outline" onPress={onSettings} /><HeaderButton label="New chat" icon="create-outline" primary onPress={onNewChat} /></View>
    </View>
  </View>;
}

export function ConversationHeader({ name, phoneNumber, headingRef, onBack, onOpenContact }: {
  name: string; phoneNumber: string | null; headingRef: React.Ref<Text>; onBack(): void; onOpenContact?(): void;
}) {
  const { colors, s } = useUi();
  const [focused, setFocused] = useState(false);
  const { fontScale, width } = useWindowDimensions();
  const largeText = fontScale >= 1.4;
  return <View style={[styles.conversation, { paddingHorizontal: width < 375 ? 12 : 18 }]}>
    <View style={styles.identityRow}>
      <HeaderButton label="Back" icon="chevron-back" onPress={onBack} />
      <Pressable testID="conversation-contact" accessibilityRole={onOpenContact ? 'button' : undefined} accessible={!!onOpenContact}
        accessibilityLabel={`Contact details for ${name}`} accessibilityHint="View phone number and change the saved contact name."
        disabled={!onOpenContact} onPress={onOpenContact} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.contact, pressed && { opacity: .65 }, focused && s.focus]}>
      <View style={[styles.portrait, { borderColor: '#B49ADD30', backgroundColor: colors.background }]}><Avatar name={name} size={44} round /></View>
      <View style={styles.identity}>
        <Text ref={headingRef} accessibilityRole="header" numberOfLines={largeText ? 2 : 1} style={[styles.name, { color: colors.ink }]}>{name}</Text>
        <Text numberOfLines={largeText ? 2 : 1} style={[styles.phoneNumber, { color: colors.textTertiary }]}>{phoneNumber || 'Phone number unavailable'}</Text>
      </View>
      {!!onOpenContact && <Icon name="chevron-forward" size={16} color={colors.muted} />}
      </Pressable>
    </View>
    <View pointerEvents="none" style={[styles.rule, { backgroundColor: colors.line }]}><View style={styles.ruleLight} /></View>
  </View>;
}

const styles = StyleSheet.create({
  home: { paddingBottom: 2 },
  titleGroup: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, flexShrink: 1 },
  unread: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexShrink: 1 },
  unreadText: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  stacked: { flexDirection: 'column', alignItems: 'flex-start', gap: 14 },
  title: { fontSize: 35, lineHeight: 43, fontWeight: '600', letterSpacing: -1.3, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: 9 },
  button: { width: 44, height: 44, flexShrink: 0, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  conversation: { flexShrink: 0, paddingTop: 8, backgroundColor: 'transparent' },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 15 },
  contact: { flex: 1, minWidth: 0, minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12 },
  portrait: { width: 54, height: 54, borderRadius: 27, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginLeft: 1 },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontSize: 19, lineHeight: 25, fontWeight: '600', letterSpacing: -.5 },
  phoneNumber: { fontSize: 11, lineHeight: 16, letterSpacing: .3 },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 56, opacity: .6 },
  ruleLight: { width: 38, height: StyleSheet.hairlineWidth, backgroundColor: '#BDA2E8', opacity: .65 },
});

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Draft } from '../../../shared/types';
import { Icon, useUi } from '../../../shared/ui/ui';

// One quiet location for task feedback. Errors take precedence over drafts.
export function ConversationStatus({ error, draft, recipient, passive = false, onDismiss, onOpenDraft }: {
  error: string; draft?: Draft; recipient?: string; passive?: boolean; onDismiss?(): void; onOpenDraft?(): void;
}) {
  const { colors } = useUi();
  if (!error && !draft) return null;
  return <View testID="conversation-status" accessibilityLiveRegion={error ? 'polite' : 'none'} style={[styles.card, { backgroundColor: error ? '#261A2B' : colors.soft, borderColor: error ? '#6E3D62' : colors.line }]}>
    <View style={styles.heading}><Text testID="conversation-status-title" style={[styles.title, { color: error ? '#EDBDD4' : colors.accentLight }]}>{error ? 'Something needs attention' : `Draft available${recipient ? ` · ${recipient}` : ''}`}</Text>
      {!passive && error && onDismiss && <Pressable accessibilityRole="button" accessibilityLabel="Dismiss error" onPress={onDismiss} hitSlop={10} style={styles.close}><Icon name="close" size={16} color={colors.muted} /></Pressable>}
    </View>{!!error && <Text testID="conversation-status-message" style={[styles.message, { color: '#E7CBDC' }]}>{error}</Text>}
    {!error && !passive && onOpenDraft && <Pressable accessibilityRole="button" accessibilityLabel="Open draft" onPress={onOpenDraft} style={styles.open}><Text style={[styles.link, { color: colors.accentLight }]}>Open draft</Text><Icon name="chevron-forward" size={14} color={colors.accentLight} /></Pressable>}
  </View>;
}
const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7, gap: 3, marginBottom: 8, alignSelf: 'center', maxWidth: '92%' },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, title: { fontSize: 11, lineHeight: 16, fontWeight: '600', flexShrink: 1 },
  message: { fontSize: 13, lineHeight: 19 }, close: { minWidth: 30, minHeight: 30, alignItems: 'center', justifyContent: 'center' },
  open: { flexDirection: 'row', gap: 4, alignItems: 'center', alignSelf: 'flex-start', minHeight: 34 }, link: { fontSize: 12, lineHeight: 18 },
});

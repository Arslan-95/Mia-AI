import React, { useRef } from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View, findNodeHandle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, colors, s } from '../ui';
import { useReducedMotion } from '../motion';

export function ConfirmationDialog({ visible, title, description, confirmLabel, cancelLabel, busy, destructive = false, onConfirm, onCancel }: {
  visible: boolean; title: string; description: string; confirmLabel: string; cancelLabel: string; busy: boolean;
  destructive?: boolean;
  onConfirm(): void; onCancel(): void;
}) {
  const heading = useRef<Text>(null);
  const reducedMotion = useReducedMotion();
  if (!visible) return null;
  return <Modal visible transparent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={onCancel} onShow={() => {
    const target = findNodeHandle(heading.current); if (target) AccessibilityInfo.setAccessibilityFocus(target);
  }}>
    <SafeAreaView style={p.backdrop}>
      <View style={p.dialog} accessibilityViewIsModal onAccessibilityEscape={onCancel}>
        <ScrollView contentContainerStyle={p.content} keyboardShouldPersistTaps="handled">
          <Text ref={heading} accessibilityRole="header" style={s.sectionTitle}>{title}</Text>
          <Text style={p.description}>{description}</Text>
          <View style={p.actions}><Button label={confirmLabel} destructive={destructive} loading={busy} onPress={onConfirm} />
          <Button secondary label={cancelLabel} disabled={busy} onPress={onCancel} /></View>
        </ScrollView>
      </View>
    </SafeAreaView>
  </Modal>;
}
const p = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000B3', justifyContent: 'center', alignItems: 'center', padding: 20 },
  dialog: { width: '100%', maxWidth: 420, maxHeight: '90%', borderRadius: 26, borderWidth: 1, borderColor: colors.borderAccent, backgroundColor: colors.elevated },
  content: { padding: 24, gap: 18 },
  description: { color: colors.muted, fontSize: 15, lineHeight: 23 }, actions: { gap: 10, marginTop: 2 },
});

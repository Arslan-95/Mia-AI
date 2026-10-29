import React, { useRef } from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View, findNodeHandle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, colors, s } from '../ui';

export function ConfirmationDialog({ visible, title, description, confirmLabel, cancelLabel, busy, onConfirm, onCancel }: {
  visible: boolean; title: string; description: string; confirmLabel: string; cancelLabel: string; busy: boolean;
  onConfirm(): void; onCancel(): void;
}) {
  const heading = useRef<Text>(null);
  if (!visible) return null;
  return <Modal visible transparent animationType="fade" onRequestClose={onCancel} onShow={() => {
    const target = findNodeHandle(heading.current); if (target) AccessibilityInfo.setAccessibilityFocus(target);
  }}>
    <SafeAreaView style={p.backdrop}>
      <View style={p.dialog} accessibilityViewIsModal onAccessibilityEscape={onCancel}>
        <ScrollView contentContainerStyle={p.content} keyboardShouldPersistTaps="handled">
          <Text ref={heading} accessibilityRole="header" style={s.sectionTitle}>{title}</Text>
          <Text style={s.body}>{description}</Text>
          <Button label={confirmLabel} loading={busy} onPress={onConfirm} />
          <Button quiet label={cancelLabel} disabled={busy} onPress={onCancel} />
        </ScrollView>
      </View>
    </SafeAreaView>
  </Modal>;
}
const p = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000099', justifyContent: 'center', alignItems: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 420, maxHeight: '90%', borderRadius: 24, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  content: { padding: 24, gap: 18 },
});

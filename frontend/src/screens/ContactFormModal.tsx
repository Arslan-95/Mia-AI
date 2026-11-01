import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { contactFormStatus, type ContactForm } from '../contactForm';
import { Icon, useUi } from '../ui';
import { useReducedMotion } from '../motion';
import { ShutterCard, type ShutterPhase } from './ShutterCard';

type Display = { form: ContactForm; phase: ShutterPhase; serial: number };

/** A modal presentation beneath the shared voice gesture surface, without a native Modal's input capture. */
export function ContactFormModal({ form, bottomClearance, contentInsets }: {
  form: ContactForm | null; bottomClearance: number; contentInsets: { top: number; left: number; right: number };
}) {
  const { colors } = useUi();
  const reduced = useReducedMotion();
  const { width: screenWidth, height, fontScale } = useWindowDimensions();
  const [display, setDisplay] = useState<Display | null>(null);
  const [visible, setVisible] = useState(false);
  const current = useRef<Display | null>(null);
  const serial = useRef(0);
  const scrim = useRef(new Animated.Value(0)).current;
  const backdrop = useRef<Animated.CompositeAnimation | null>(null);
  const backdropToken = useRef(0);
  const latest = useRef({ form, reduced }); latest.current = { form, reduced };
  const width = Math.max(0, Math.min(420, screenWidth - contentInsets.left - contentInsets.right - 32));
  const available = Math.max(0, height - contentInsets.top - bottomClearance - 24);

  function commit(next: Display | null) { current.current = next; setDisplay(next); }
  function fadeBackdrop(toValue: number, duration: number, done?: () => void) {
    const token = ++backdropToken.current;
    backdrop.current?.stop();
    backdrop.current = Animated.timing(scrim, { toValue, duration: latest.current.reduced ? 80 : duration, useNativeDriver: true, isInteraction: false });
    backdrop.current.start(({ finished }) => { if (finished && token === backdropToken.current) done?.(); });
  }
  function present(value: ContactForm) {
    setVisible(true);
    commit({ form: value, phase: 'enter', serial: ++serial.current });
    fadeBackdrop(.72, 260);
  }
  function dismiss() {
    fadeBackdrop(0, 220, () => { if (!latest.current.form && !current.current) setVisible(false); });
  }
  useEffect(() => {
    const view = current.current;
    if (!form) {
      if (view && view.phase !== 'exit') commit({ ...view, phase: 'exit' });
      return;
    }
    if (!view) present(form);
    // Preserve the outgoing snapshot; a rapid reopen waits for its exit.
    else if (view.phase !== 'exit') commit({ ...view, form });
  }, [form]);
  useEffect(() => () => { backdropToken.current++; backdrop.current?.stop(); current.current = null; }, []);

  if (!visible) return null;
  const rendered = display?.form;
  const compact = height - contentInsets.top - bottomClearance < 360 * fontScale;
  return <View testID="contact-form-modal" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.region}>
    <Animated.View testID="contact-form-scrim" style={[styles.scrim, { opacity: scrim }]} />
    <View style={[styles.position, { top: contentInsets.top + 12, left: contentInsets.left + 16, right: contentInsets.right + 16, bottom: bottomClearance + 12 }]}>
      {display && rendered && <ShutterCard key={display.serial} testIDPrefix="contact-form" width={width} maximumHeight={available} phase={display.phase} reduced={reduced}
        style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line, padding: compact ? 16 : 24, gap: compact ? 12 : 20 }]}
        onLayout={() => {}}
        onEntered={() => {
          const view = current.current;
          if (view?.serial === display.serial && view.phase === 'enter') commit({ ...view, phase: 'shown' });
        }}
        onExited={() => {
          const view = current.current;
          if (view?.serial !== display.serial || view.phase !== 'exit') return;
          commit(null);
          if (latest.current.form) present(latest.current.form); else dismiss();
        }}>
        <View style={styles.header}>
          <Icon name={rendered.status === 'saved' ? 'checkmark-circle-outline' : 'person-add-outline'} color={colors.accentLight} size={24} />
          <Text numberOfLines={1} maxFontSizeMultiplier={1.5} style={[styles.title, { color: colors.ink }]}>{rendered.operation === 'rename' ? 'Edit contact' : 'New contact'}</Text>
        </View>
        <Field compact={compact} label="Name" value={rendered.name} placeholder="Waiting for a name…" />
        <Field compact={compact} label="Phone number" value={rendered.identifier} placeholder="Waiting for details…" />
        <View style={styles.status}>
          {rendered.status === 'saving' && <ActivityIndicator size="small" color={colors.accentLight} />}
          <Text numberOfLines={2} maxFontSizeMultiplier={1.5} style={[styles.statusText, { color: rendered.status === 'failed' ? colors.errorText : colors.muted }]}>{contactFormStatus[rendered.status]}</Text>
        </View>
      </ShutterCard>}
    </View>
  </View>;
}

function Field({ label, value, placeholder, compact }: { label: string; value: string | null; placeholder: string; compact: boolean }) {
  const { colors } = useUi();
  return <View style={styles.field}>
    {!compact && <Text maxFontSizeMultiplier={1.5} style={[styles.label, { color: colors.muted }]}>{label}</Text>}
    <View style={[styles.valueBox, { backgroundColor: colors.soft, borderColor: colors.line, paddingVertical: compact ? 8 : 12 }]}>
      <Text selectable={false} numberOfLines={compact ? 1 : 2} maxFontSizeMultiplier={1.5} style={[styles.value, { color: value ? colors.ink : colors.muted }]}>{value || placeholder}</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  region: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#08060E' },
  position: { position: 'absolute', left: 16, right: 16, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontSize: 22, lineHeight: 28, fontWeight: '600' },
  field: { gap: 7 }, label: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  valueBox: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  value: { fontSize: 17, lineHeight: 23 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { flex: 1, fontSize: 13, lineHeight: 19 },
});

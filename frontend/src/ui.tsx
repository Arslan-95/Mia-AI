import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
export const colors = { background: '#F7F6F0', paper: '#FFFFFF', ink: '#242D29', muted: '#59665E', line: '#DEE3DA', green: '#315741', soft: '#E8EEDB', yellow: '#F1E7BC', red: '#A33230', blue: '#E9EAF5' };
export function Icon({ name, size = 22, color = colors.ink }: { name: React.ComponentProps<typeof Ionicons>['name']; size?: number; color?: string }) { return <Ionicons name={name} size={size} color={color} accessible={false} />; }
export function Button({ label, onPress, icon, secondary, quiet, disabled, loading, style, iconOnly }: { label: string; onPress: () => void; icon?: React.ComponentProps<typeof Ionicons>['name']; secondary?: boolean; quiet?: boolean; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; iconOnly?: boolean }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => [s.button, secondary && s.secondary, quiet && s.quiet, iconOnly && { width: 50, paddingHorizontal: 0 }, { opacity: disabled || loading ? .45 : pressed ? .75 : 1 }, focused && s.focus, style]}>
    {loading ? <ActivityIndicator color={secondary || quiet ? colors.green : colors.paper} /> : icon ? <Icon name={icon} color={secondary || quiet ? colors.green : colors.paper} size={20} /> : null}
    {!iconOnly && <Text style={[s.buttonText, (secondary || quiet) && { color: colors.green }]}>{label}</Text>}
  </Pressable>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) { return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} {...props} style={[s.input, props.multiline && { minHeight: 100 }, props.style]} /></View>; }
export function Avatar({ name, size = 52 }: { name: string; size?: number }) {
  const initials = name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  return <View accessible={false} style={[s.avatar, { width: size, height: size, borderRadius: size / 2 }]}><Text style={{ fontSize: size * .31, fontWeight: '600', color: colors.green }}>{initials}</Text></View>;
}
export function Empty({ icon = 'chatbubble-ellipses-outline', title, text, children }: { icon?: React.ComponentProps<typeof Ionicons>['name']; title: string; text: string; children?: React.ReactNode }) {
  return <View style={s.empty}><View style={s.emptyIcon}><Icon name={icon} size={32} color={colors.green} /></View><Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text><Text style={[s.body, { textAlign: 'center', maxWidth: 360 }]}>{text}</Text>{children}</View>;
}
export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <View accessibilityLiveRegion={error ? 'assertive' : 'polite'} style={[s.notice, error && { backgroundColor: '#FBEAE5' }]}><Text style={[s.small, error && { color: colors.red }]}>{children}</Text></View>; }
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background }, content: { padding: 24, gap: 20, flexGrow: 1 },
  heading: { fontSize: 34, fontWeight: '600', letterSpacing: -1.3, color: colors.ink }, eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 2.2, color: colors.green },
  sectionTitle: { fontSize: 22, fontWeight: '600', letterSpacing: -.5, color: colors.ink }, body: { fontSize: 16, lineHeight: 25, color: colors.muted }, small: { fontSize: 13, lineHeight: 20, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  card: { backgroundColor: colors.paper, borderRadius: 22, padding: 22, gap: 14, borderWidth: 1, borderColor: colors.line },
  button: { minHeight: 50, paddingHorizontal: 20, paddingVertical: 13, borderRadius: 16, backgroundColor: colors.green, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9 },
  secondary: { backgroundColor: colors.soft }, quiet: { backgroundColor: 'transparent' }, buttonText: { fontSize: 15, fontWeight: '600', color: colors.paper }, focus: { outlineWidth: 3, outlineColor: colors.green, outlineOffset: 3 },
  field: { gap: 8 }, label: { fontSize: 13, fontWeight: '600', color: colors.ink }, input: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 16, fontSize: 16, color: colors.ink, minHeight: 52 },
  avatar: { backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' }, empty: { padding: 28, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }, emptyIcon: { width: 80, height: 80, borderRadius: 28, backgroundColor: colors.soft, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  notice: { backgroundColor: colors.soft, padding: 16, borderRadius: 16 }, divider: { height: 1, backgroundColor: colors.line },
});

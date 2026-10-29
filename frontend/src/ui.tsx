import React, { useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

export const colors = {
  background: '#09090F', paper: '#13131E', elevated: '#1B1A29', ink: '#F3F0FF',
  muted: '#A09BB5', line: '#292637', accent: '#9471F7', accentLight: '#C9B6FF',
  soft: '#221B37', yellow: '#30271C', red: '#FF9EAD', blue: '#201D38', white: '#FFFFFF',
};
export function Icon({ name, size = 22, color = colors.ink }: { name: React.ComponentProps<typeof Ionicons>['name']; size?: number; color?: string }) { return <Ionicons name={name} size={size} color={color} accessible={false} />; }
export function Button({ label, onPress, icon, secondary, quiet, disabled, loading, style, iconOnly }: { label: string; onPress: () => void; icon?: React.ComponentProps<typeof Ionicons>['name']; secondary?: boolean; quiet?: boolean; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; iconOnly?: boolean }) {
  const [focused, setFocused] = useState(false);
  const foreground = secondary || quiet ? colors.accentLight : colors.white;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => [s.button, secondary && s.secondary, quiet && s.quiet, iconOnly && { width: 48, paddingHorizontal: 0 }, { opacity: disabled || loading ? .4 : pressed ? .7 : 1 }, focused && s.focus, style]}>
    {loading ? <ActivityIndicator color={foreground} /> : icon ? <Icon name={icon} color={foreground} size={20} /> : null}
    {!iconOnly && <Text style={[s.buttonText, { color: foreground }]}>{label}</Text>}
  </Pressable>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) { return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} selectionColor={colors.accentLight} keyboardAppearance="dark" {...props} style={[s.input, props.multiline && { minHeight: 100 }, props.style]} /></View>; }
export function SearchField({ label, hint, placeholder, value, onChangeText, maxLength, loading = false }: {
  label: string; hint?: string; placeholder: string; value: string; onChangeText(value: string): void;
  maxLength?: number; loading?: boolean;
}) {
  const [inputFocused, setInputFocused] = useState(false);
  const [clearFocused, setClearFocused] = useState(false);
  const input = useRef<TextInput>(null);
  const hasText = value.length > 0;
  return <View style={s.searchRow}>
    <TextInput ref={input} accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ busy: loading }} placeholder={placeholder} value={value} onChangeText={onChangeText}
      maxLength={maxLength} autoCapitalize="none" autoCorrect={false} keyboardAppearance="dark" placeholderTextColor={colors.muted}
      selectionColor={colors.accentLight} returnKeyType="search" onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
      onSubmitEditing={() => Keyboard.dismiss()} clearButtonMode="never"
      style={[s.input, s.searchInput, { paddingRight: 12 + (hasText ? 44 : 0) + (loading ? 28 : 0) }, inputFocused && s.searchInputFocused]} />
    {loading && <View pointerEvents="none" accessible={false} accessibilityElementsHidden style={[s.searchSpinner, { right: hasText ? 44 : 8 }]}>
      <ActivityIndicator size="small" color={colors.accentLight} />
    </View>}
    {hasText && <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${label.toLowerCase()}`}
        onPress={() => { setClearFocused(false); onChangeText(''); input.current?.focus(); }}
        onFocus={() => setClearFocused(true)} onBlur={() => setClearFocused(false)}
        style={({ pressed }) => [s.searchClear, { opacity: pressed ? .6 : 1 }, clearFocused && s.focus]}>
        <Icon name="close-circle" size={19} color={colors.muted} />
      </Pressable>
    }
  </View>;
}
const avatarColors = [ ['#25203D', '#C9B6FF'], ['#1D2B36', '#A3C9E7'], ['#322338', '#E3B1D4'], ['#25312D', '#B2D7C7'] ];
export function Avatar({ name, size = 52 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const palette = avatarColors[Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0) % avatarColors.length]!;
  return <View accessible={false} style={[s.avatar, { width: size, height: size, borderRadius: size * .36, backgroundColor: palette[0] }]}><Text style={{ fontSize: size * .3, fontWeight: '600', color: palette[1] }}>{initials}</Text></View>;
}
export function Empty({ icon = 'chatbubble-ellipses-outline', title, text, children }: { icon?: React.ComponentProps<typeof Ionicons>['name']; title: string; text: string; children?: React.ReactNode }) {
  return <View style={s.empty}><View style={s.emptyIcon}><Icon name={icon} size={30} color={colors.accentLight} /></View><Text accessibilityRole="header" style={[s.sectionTitle, { textAlign: 'center' }]}>{title}</Text><Text style={[s.body, { textAlign: 'center', maxWidth: 320 }]}>{text}</Text>{children}</View>;
}
export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <View accessibilityLiveRegion={error ? 'assertive' : 'polite'} style={[s.notice, error && { backgroundColor: '#301B28', borderColor: '#573044' }]}><Text style={[s.small, error && { color: colors.red }]}>{children}</Text></View>; }
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background }, content: { padding: 20, gap: 18, flexGrow: 1 },
  heading: { fontSize: 28, fontWeight: '600', letterSpacing: -.8, color: colors.ink }, eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 2.8, color: colors.accentLight },
  sectionTitle: { fontSize: 19, fontWeight: '600', letterSpacing: -.5, color: colors.ink }, body: { fontSize: 15, lineHeight: 22, color: colors.muted }, small: { fontSize: 12, lineHeight: 18, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 }, between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  card: { backgroundColor: colors.paper, borderRadius: 20, padding: 18, gap: 14, borderWidth: 1, borderColor: colors.line },
  button: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 14, backgroundColor: '#7852DB', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  secondary: { backgroundColor: colors.soft, borderWidth: 1, borderColor: '#3D2F59' }, quiet: { backgroundColor: 'transparent' }, buttonText: { fontSize: 14, fontWeight: '600', color: colors.white }, focus: { outlineWidth: 2, outlineColor: colors.accentLight, outlineOffset: 3 },
  field: { gap: 10 }, label: { fontSize: 13, fontWeight: '600', color: colors.ink }, input: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 16, fontSize: 16, color: colors.ink, minHeight: 54 },
  searchRow: { flexDirection: 'row', alignItems: 'center', position: 'relative' },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 13, fontSize: 14 },
  searchInputFocused: { borderColor: colors.accent },
  searchClear: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 44, minHeight: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  searchSpinner: { position: 'absolute', top: 0, bottom: 0, width: 28, alignItems: 'center', justifyContent: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#FFFFFF08' }, empty: { paddingHorizontal: 12, paddingVertical: 42, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }, emptyIcon: { width: 76, height: 76, borderRadius: 26, backgroundColor: colors.soft, borderWidth: 1, borderColor: '#44345E', justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  notice: { backgroundColor: colors.soft, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }, divider: { height: 1, backgroundColor: colors.line },
});

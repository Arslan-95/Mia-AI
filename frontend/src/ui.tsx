import React, { useRef, useState } from 'react';
import { ActivityIndicator, Animated, Keyboard, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { usePressOpacity } from './motion';

export const colors = {
  background: '#09090F', canvas: '#09090F', paper: '#13111D', surface: '#13111D', elevated: '#1B1629', surfaceRaised: '#1B1629',
  surfaceInset: '#0E0C15', surfacePressed: '#241C35', ink: '#F3EEFF', textPrimary: '#F3EEFF', muted: '#B0A5C2', textSecondary: '#B0A5C2', textTertiary: '#958AA7',
  line: '#30263F', border: '#30263F', borderAccent: '#665080', accent: '#A184EE', accentLight: '#D4C0FF',
  soft: '#241A38', surfaceAccent: '#241A38', actionFill: '#7954CF', sentFill: '#3D2B61', sentBorder: '#654A90',
  yellow: '#30271C', red: '#FFB0BF', errorText: '#FFB0BF', errorSurface: '#2B1725', blue: '#201D38', white: '#FFFFFF',
};
export function Icon({ name, size = 22, color = colors.ink }: { name: React.ComponentProps<typeof Ionicons>['name']; size?: number; color?: string }) { return <Ionicons name={name} size={size} color={color} accessible={false} />; }
export function ScreenAtmosphere() {
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.atmosphere}><View style={s.amethystLight} /><View style={s.periwinkleLight} /></View>;
}
export function ScreenHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return <View style={s.screenHeader}><Text accessibilityRole="header" style={s.heading}>{title}</Text>{action}</View>;
}
export function SectionCaption({ children }: { children: React.ReactNode }) { return <Text accessibilityRole="header" style={s.sectionCaption}>{children}</Text>; }
export function InsetList({ children }: { children: React.ReactNode }) { return <View style={s.insetList}>{children}</View>; }
export function HeaderAction({ label, icon, onPress }: { label: string; icon: React.ComponentProps<typeof Icon>['name']; onPress(): void }) {
  const [focused, setFocused] = useState(false);
  const motion = usePressOpacity();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onPressIn={motion.onPressIn} onPressOut={motion.onPressOut} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [s.headerAction, pressed && { backgroundColor: colors.surfacePressed }, focused && s.focus]}>
    <Animated.View style={{ opacity: motion.opacity }}><Icon name={icon} size={21} color={colors.accentLight} /></Animated.View>
  </Pressable>;
}
export function Button({ label, onPress, icon, secondary, quiet, destructive, disabled, loading, style, iconOnly }: { label: string; onPress: () => void; icon?: React.ComponentProps<typeof Ionicons>['name']; secondary?: boolean; quiet?: boolean; destructive?: boolean; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; iconOnly?: boolean }) {
  const [focused, setFocused] = useState(false);
  const motion = usePressOpacity();
  const foreground = destructive ? colors.red : secondary || quiet ? colors.accentLight : colors.white;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading, busy: !!loading }} disabled={disabled || loading} onPress={onPress} onPressIn={motion.onPressIn} onPressOut={motion.onPressOut} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => [s.button, secondary && s.secondary, quiet && s.quiet, destructive && s.destructive, iconOnly && { width: 48, paddingHorizontal: 0 }, disabled && { backgroundColor: colors.line }, pressed && { backgroundColor: colors.surfacePressed }, focused && s.focus, style]}>
    <Animated.View style={[s.buttonContents, { opacity: motion.opacity }]}>
      {loading ? <ActivityIndicator color={foreground} /> : icon ? <Icon name={icon} color={foreground} size={20} /> : null}
      {!iconOnly && <Text style={[s.buttonText, { color: foreground }]}>{label}</Text>}
    </Animated.View>
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
    <View pointerEvents="none" accessible={false} style={s.searchLeading}><Icon name="search-outline" size={19} color={colors.muted} /></View>
    {loading && <View pointerEvents="none" accessible={false} accessibilityElementsHidden style={[s.searchSpinner, { right: hasText ? 44 : 8 }]}><ActivityIndicator size="small" color={colors.accentLight} /></View>}
    {hasText && <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${label.toLowerCase()}`}
        onPress={() => { setClearFocused(false); onChangeText(''); input.current?.focus(); }}
        onFocus={() => setClearFocused(true)} onBlur={() => setClearFocused(false)}
        style={({ pressed }) => [s.searchClear, pressed && { backgroundColor: colors.surfacePressed }, clearFocused && s.focus]}><Icon name="close-circle" size={19} color={colors.muted} /></Pressable>}
  </View>;
}
const avatarColors = [ ['#29213D', '#D4C0FF'], ['#1D2B36', '#A3C9E7'], ['#322338', '#E3B1D4'], ['#25312D', '#B2D7C7'] ];
export function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const palette = avatarColors[Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0) % avatarColors.length]!;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[s.avatar, { width: size, height: size, borderRadius: size * .34, backgroundColor: palette[0] }]}><Text allowFontScaling={false} style={{ fontSize: size * .3, fontWeight: '600', color: palette[1] }}>{initials}</Text></View>;
}
export function Empty({ icon = 'chatbubble-ellipses-outline', title, text, children, compact = false }: { icon?: React.ComponentProps<typeof Ionicons>['name']; title: string; text: string; children?: React.ReactNode; compact?: boolean }) {
  return <View style={[s.empty, compact && s.emptyCompact]}><View accessible={false} accessibilityElementsHidden style={s.emptySymbol}><View style={s.emptyReflection} /><View style={s.emptyIcon}><Icon name={icon} size={28} color={colors.accentLight} /></View></View><Text accessibilityRole="header" style={[s.sectionTitle, { textAlign: 'center' }]}>{title}</Text><Text style={[s.body, { textAlign: 'center', maxWidth: 290 }]}>{text}</Text>{children && <View style={{ marginTop: 12 }}>{children}</View>}</View>;
}
export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <View accessibilityLiveRegion={error ? 'assertive' : 'polite'} style={[s.notice, error && { backgroundColor: colors.errorSurface, borderColor: '#613449' }]}><Icon name={error ? 'alert-circle-outline' : 'information-circle-outline'} size={20} color={error ? colors.red : colors.accentLight} /><Text style={[s.body, { flex: 1 }, error && { color: colors.red }]}>{children}</Text></View>; }
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background }, content: { padding: 20, gap: 20, flexGrow: 1 },
  heading: { flex: 1, fontSize: 32, lineHeight: 38, fontWeight: '600', letterSpacing: -.8, color: colors.ink }, eyebrow: { fontSize: 12, lineHeight: 18, fontWeight: '500', color: colors.accentLight },
  screenHeader: { minHeight: 54, paddingTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headerAction: { width: 44, height: 44, borderRadius: 16, borderWidth: 1, borderColor: '#49365F', backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  atmosphere: { position: 'absolute', top: 0, left: 0, right: 0, height: 190, overflow: 'hidden' },
  amethystLight: { position: 'absolute', width: 360, height: 220, borderRadius: 180, top: -145, right: -55, backgroundColor: colors.accent, opacity: .065 },
  periwinkleLight: { position: 'absolute', width: 320, height: 190, borderRadius: 160, top: -130, right: 100, backgroundColor: '#92A8FF', opacity: .04 },
  insetList: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line, borderRadius: 22, padding: 4 },
  sectionCaption: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: '500', paddingHorizontal: 4 },
  personRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 14, borderRadius: 18, minHeight: 80 },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 72, marginRight: 12 },
  sectionTitle: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -.3, color: colors.ink }, body: { fontSize: 14, lineHeight: 21, color: colors.muted }, small: { fontSize: 12, lineHeight: 17, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 }, between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  card: { backgroundColor: colors.paper, borderRadius: 26, padding: 20, gap: 14, borderWidth: 1, borderColor: colors.line },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: colors.actionFill, justifyContent: 'center', alignItems: 'center' },
  buttonContents: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, maxWidth: '100%' },
  secondary: { backgroundColor: colors.soft, borderWidth: 1, borderColor: '#49365F' }, quiet: { backgroundColor: 'transparent' }, destructive: { backgroundColor: colors.errorSurface, borderWidth: 1, borderColor: '#734052' }, buttonText: { flexShrink: 1, fontSize: 15, lineHeight: 21, fontWeight: '600', color: colors.white, textAlign: 'center' }, focus: { outlineWidth: 2, outlineColor: colors.accentLight, outlineOffset: 3 },
  field: { gap: 10 }, label: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: colors.ink }, input: { backgroundColor: colors.surfaceInset, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 16, fontSize: 16, color: colors.ink, minHeight: 54 },
  searchRow: { flexDirection: 'row', alignItems: 'center', position: 'relative' },
  searchInput: { flex: 1, minWidth: 0, minHeight: 48, paddingLeft: 44, paddingVertical: 12, borderRadius: 16, fontSize: 15 }, searchLeading: { position: 'absolute', left: 16 },
  searchInputFocused: { borderColor: colors.borderAccent },
  searchClear: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 44, minHeight: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  searchSpinner: { position: 'absolute', top: 0, bottom: 0, width: 28, alignItems: 'center', justifyContent: 'center' },
  avatar: { flexShrink: 0, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#FFFFFF12', borderTopColor: '#FFFFFF24' },
  empty: { paddingHorizontal: 12, paddingVertical: 24, flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }, emptyCompact: { flex: 0, padding: 24, backgroundColor: colors.paper, borderRadius: 22, borderWidth: 1, borderColor: colors.line },
  emptySymbol: { width: 72, height: 72, marginBottom: 8, alignItems: 'center', justifyContent: 'center' }, emptyReflection: { position: 'absolute', width: 66, height: 48, borderRadius: 28, backgroundColor: '#8C94E8', opacity: .12, left: 4, bottom: 0, transform: [{ rotate: '-20deg' }] }, emptyIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: colors.soft, borderWidth: 1, borderColor: '#665080', justifyContent: 'center', alignItems: 'center' },
  notice: { backgroundColor: colors.soft, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.line, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
});

import React, { useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getCountries, getCountryCallingCode, getExampleNumber, type CountryCode } from 'libphonenumber-js/min';
import examples from 'libphonenumber-js/examples.mobile.json';
import countryNames from '../model/phoneCountryNames.json';
import { changePhoneCountry, editPhoneNumber, type PhoneInputValue } from '../model/phoneNumberInput';
import { Button, Icon, SearchField, useUi } from '../../../shared/ui/ui';

const countries = getCountries().map(code => ({
  code, name: countryNames[code], callingCode: `+${getCountryCallingCode(code)}`,
  flag: String.fromCodePoint(...[...code].map(letter => 127397 + letter.charCodeAt(0))),
})).sort((left, right) => left.name.localeCompare(right.name));

export function PhoneNumberField({ value, onChange, editable }: {
  value: PhoneInputValue; onChange(value: PhoneInputValue): void; editable: boolean;
}) {
  const { colors, s } = useUi();
  const input = useRef<TextInput>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const selected = countries.find(country => country.code === value.country)!;
  const search = query.trim().toLowerCase();
  const matches = countries.filter(country => `${country.name} ${country.code} ${country.callingCode}`.toLowerCase().includes(search));

  function selectCountry(country: CountryCode) {
    onChange(changePhoneCountry(country, value));
    setPickerOpen(false);
  }

  return <>
    <View style={[p.phone, { backgroundColor: colors.surfaceInset, borderColor: focused ? colors.accent : colors.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Country: ${selected.name}, ${selected.callingCode}`}
        accessibilityHint="Choose your country and calling code"
        accessibilityState={{ disabled: !editable, expanded: pickerOpen }}
        disabled={!editable}
        onPress={() => { Keyboard.dismiss(); setQuery(''); setPickerOpen(true); }}
        style={({ pressed }) => [p.country, { borderRightColor: colors.line }, pressed && { opacity: 0.6 }]}
      >
        <Text style={p.flag} accessible={false}>{selected.flag}</Text>
        <Text style={[p.callingCode, { color: colors.ink }]}>{selected.callingCode}</Text>
        <Icon name="chevron-down" size={13} color={colors.muted} />
      </Pressable>
      <TextInput
        ref={input}
        accessibilityLabel="Phone number"
        accessibilityHint={`Enter your number in ${selected.name}, without the country code`}
        placeholder={getExampleNumber(value.country, examples)?.formatNational() ?? 'Phone number'}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accentLight}
        keyboardAppearance="dark"
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        autoComplete="tel"
        autoCorrect={false}
        maxLength={32}
        value={value.text}
        onChangeText={text => onChange(editPhoneNumber(text, value))}
        editable={editable}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[p.number, { color: colors.ink }]}
      />
    </View>
    <Modal visible={pickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickerOpen(false)} onDismiss={() => input.current?.focus()}>
      <SafeAreaView style={[p.sheet, { backgroundColor: colors.background }]}>
        <KeyboardAvoidingView behavior="padding" style={p.fill}>
          <View style={p.header}>
            <Text accessibilityRole="header" style={[s.sectionTitle, p.fill]}>Choose country</Text>
            <Button quiet iconOnly label="Close country picker" icon="close" onPress={() => setPickerOpen(false)} />
          </View>
          <View style={p.search}>
            <SearchField label="Country or calling code" placeholder="Search country or code" value={query} onChangeText={setQuery} />
          </View>
          <FlatList
            data={matches}
            keyExtractor={country => country.code}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={p.list}
            ListEmptyComponent={<Text style={[s.body, p.empty]}>No countries found.</Text>}
            renderItem={({ item }) => <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.callingCode}`}
              accessibilityState={{ selected: item.code === value.country }}
              onPress={() => selectCountry(item.code)}
              style={({ pressed }) => [p.option, pressed && { backgroundColor: colors.soft }]}
            >
              <Text style={p.flag} accessible={false}>{item.flag}</Text>
              <Text style={[s.body, p.fill, { color: colors.ink }]}>{item.name}</Text>
              <Text style={[s.body, { color: colors.muted }]}>{item.callingCode}</Text>
              <View style={p.check}>{item.code === value.country && <Icon name="checkmark" size={20} color={colors.accentLight} />}</View>
            </Pressable>}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  </>;
}

const p = StyleSheet.create({
  phone: { flexDirection: 'row', alignItems: 'center', minHeight: 64, borderWidth: 1, borderRadius: 16 },
  country: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 48, paddingHorizontal: 12, borderRightWidth: 1 },
  flag: { fontSize: 22 }, callingCode: { fontSize: 16, fontWeight: '500' },
  number: { flex: 1, minWidth: 0, minHeight: 62, paddingHorizontal: 12, paddingVertical: 16, fontSize: 18, fontVariant: ['tabular-nums'] },
  sheet: { flex: 1 }, fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 24, paddingRight: 12, paddingVertical: 12, gap: 12 },
  search: { paddingHorizontal: 24, paddingBottom: 12 },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, padding: 12, borderRadius: 12 },
  check: { width: 20 }, empty: { textAlign: 'center', padding: 24 },
});

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Mia } from '../../../app/useMia';
import type { Profile } from '../../../shared/types';
import { Avatar, Empty, Icon, ScreenHeader, SearchField, SectionCaption, agentColors, classicColors, useUi } from '../../../shared/ui/ui';
import { Reveal } from '../../../shared/ui/motion';
import { phoneSearchNumber } from '../../../shared/phone';
export function People({ mia, overlayInset = 0 }: { mia: Mia; overlayInset?: number }) {
  const { agent, s } = useUi();
  const p = agent ? agentStyles : classicStyles;
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState(''); const [results, setResults] = useState<Profile[]>([]); const [searched, setSearched] = useState(false); const [loading, setLoading] = useState(false); const epoch = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const latestQuery = useRef('');
  const searchQuery = query.trim();
  const validPhone = !!phoneSearchNumber(searchQuery);
  const searchResults = results.map(person => {
    const saved = mia.contacts.find(contact => contact.id === person.id);
    return { ...person, displayName: saved?.name ?? person.displayName, saved: !!saved };
  });
  const { api, fail } = mia;
  function changeQuery(value: string) {
    if (value.trim() !== latestQuery.current) {
      epoch.current++; activeRequest.current?.abort();
      setResults([]); setSearched(false); setLoading(false);
    }
    latestQuery.current = value.trim();
    setQuery(value);
  }
  useEffect(() => {
    if (!validPhone) return;
    const request = ++epoch.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    const current = () => !controller.signal.aborted && request === epoch.current;
    const timer = setTimeout(() => {
      if (!current()) return;
      setLoading(true);
      void api.request<Profile[]>(`/v1/users?query=${encodeURIComponent(searchQuery)}`, 'GET', undefined, controller.signal)
        .then(list => { if (current()) { setResults(list); setSearched(true); } })
        .catch(reason => { if (current()) fail(reason); })
        .finally(() => { if (current()) setLoading(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); if (activeRequest.current === controller) activeRequest.current = null; };
  }, [api, fail, searchQuery, validPhone]);
  return <View style={{ flex: 1 }}><Reveal style={{ flex: 1 }}><ScrollView contentContainerStyle={[s.content, { paddingHorizontal: width < 375 ? 16 : 20, paddingBottom: 20 + overlayInset }]} keyboardShouldPersistTaps="handled">
    <ScreenHeader title="Contacts" />
    <SearchField label="Find by phone number" hint="Enter the full phone number, including country code. Search finds people registered on Mia."
      placeholder="Phone number" keyboardType="phone-pad" value={query} onChangeText={changeQuery} maxLength={50} loading={loading} />
    {agent && <Text style={p.helper}>Search Mia by phone number, including country code.</Text>}
    {!!searchQuery && !validPhone && <Text accessibilityLiveRegion="polite" style={s.body}>Enter the full phone number, including country code.</Text>}
    {loading && <Text accessibilityLiveRegion="polite" style={s.body}>Searching Mia…</Text>}
    {searched && <Reveal identity={results}><View accessibilityLiveRegion="polite" style={p.section}>
      {results.length ? <>{agent ? <SectionCaption>Search results</SectionCaption> : <Text style={s.label}>Search results</Text>}<View style={agent ? s.insetList : p.list}>{searchResults.map((person, index) => <React.Fragment key={person.id}><PersonRow name={person.displayName} phoneNumber={person.phoneNumber} add={!person.saved} onPress={() => void mia.startChat(person, !person.saved).catch(mia.fail)} />{agent && index < results.length - 1 && <View style={s.rowDivider} />}</React.Fragment>)}</View></> : agent ? <Empty compact icon="search-outline" title="No matching people" text="Check the phone number." /> : <Text style={s.body}>No matching people. Check the phone number.</Text>}
    </View></Reveal>}
    {!mia.contacts.length && !searchQuery && <Empty icon="people-outline" title="Your people, here" text="Find someone by phone number. Your saved contacts will appear here." />}
    {!!mia.contacts.length && <View style={p.section}>{agent && <SectionCaption>Saved contacts</SectionCaption>}<View style={agent ? s.insetList : p.list}>{mia.contacts.map((person, index) => <React.Fragment key={person.contactId}><PersonRow name={person.name} phoneNumber={person.phoneNumber} onPress={() => void mia.startChat(person).catch(mia.fail)} />{agent && index < mia.contacts.length - 1 && <View style={s.rowDivider} />}</React.Fragment>)}</View></View>}
  </ScrollView></Reveal></View>;
}
function PersonRow({ name, phoneNumber, add = false, onPress }: { name: string; phoneNumber: string | null; add?: boolean; onPress(): void }) {
  const { agent, colors, s } = useUi();
  const p = agent ? agentStyles : classicStyles;
  const [focused, setFocused] = useState(false);
  const { fontScale } = useWindowDimensions();
  return <Pressable accessibilityRole="button" accessibilityLabel={add ? `Add ${name} and open chat` : `${name}, ${phoneNumber || 'phone number unavailable'}`} accessibilityHint={add ? 'Save this person to your contacts and open a conversation.' : 'Open conversation.'}
    onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [s.personRow, pressed && { backgroundColor: colors.surfacePressed }, focused && s.focus]}>
    <Avatar name={name} size={48} />
    <View style={p.personText}><Text numberOfLines={fontScale >= 1.4 ? 2 : 1} style={p.name}>{name}</Text><Text numberOfLines={fontScale >= 1.4 ? 2 : 1} style={p.phoneNumber}>{phoneNumber || 'Phone number unavailable'}</Text></View>
    <View accessible={false} style={agent && add ? p.add : undefined}><Icon name={add ? 'add-outline' : 'chevron-forward'} size={18} color={agent && add ? colors.accentLight : colors.muted} /></View>
  </Pressable>;
}
function createStyles(colors: typeof agentColors, agent: boolean) { return StyleSheet.create({
  list: { marginHorizontal: -8 },
  section: { gap: agent ? 12 : 10 }, helper: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: -8 },
  personText: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' }, phoneNumber: { color: colors.muted, fontSize: agent ? 13 : 12, lineHeight: agent ? 19 : 18 },
  add: { width: 32, height: 32, borderRadius: 12, backgroundColor: colors.soft, borderWidth: 1, borderColor: '#49365F', justifyContent: 'center', alignItems: 'center' },
}); }
const classicStyles = createStyles(classicColors, false);
const agentStyles = createStyles(agentColors, true);

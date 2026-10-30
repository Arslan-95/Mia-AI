import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Mia } from '../useMia';
import type { Profile } from '../types';
import { Avatar, Empty, Icon, ScreenAtmosphere, ScreenHeader, SearchField, SectionCaption, agentColors, classicColors, useUi } from '../ui';
import { Reveal } from '../motion';
export function People({ mia }: { mia: Mia }) {
  const { agent, s } = useUi();
  const p = agent ? agentStyles : classicStyles;
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState(''); const [results, setResults] = useState<Profile[]>([]); const [searched, setSearched] = useState(false); const [loading, setLoading] = useState(false); const epoch = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const latestQuery = useRef('');
  const searchQuery = query.trim();
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
    if (searchQuery.length < 2) return;
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
  }, [api, fail, searchQuery]);
  return <View style={{ flex: 1 }}>{agent && <ScreenAtmosphere />}<Reveal style={{ flex: 1 }}><ScrollView contentContainerStyle={[s.content, { paddingHorizontal: width < 375 ? 16 : 20 }]} keyboardShouldPersistTaps="handled">
    <ScreenHeader title="Contacts" />
    <SearchField label="Find by phone number or username" hint="Type at least two characters. For phone numbers, include the country code. Search finds people registered on Mia."
      placeholder="Phone number or username" value={query} onChangeText={changeQuery} maxLength={50} loading={loading} />
    {agent && <Text style={p.helper}>Search Mia by username or phone number, including country code.</Text>}
    {searchQuery.length === 1 && <Text accessibilityLiveRegion="polite" style={s.body}>Enter at least 2 characters to search.</Text>}
    {loading && <Text accessibilityLiveRegion="polite" style={s.body}>Searching Mia…</Text>}
    {searched && <Reveal identity={results}><View accessibilityLiveRegion="polite" style={p.section}>
      {results.length ? <>{agent ? <SectionCaption>Search results</SectionCaption> : <Text style={s.label}>Search results</Text>}<View style={agent ? s.insetList : p.list}>{results.map((person, index) => <React.Fragment key={person.id}><PersonRow name={person.displayName} username={person.username} add onPress={() => void mia.startChat(person, true).catch(mia.fail)} />{agent && index < results.length - 1 && <View style={s.rowDivider} />}</React.Fragment>)}</View></> : agent ? <Empty compact icon="search-outline" title="No matching people" text="Check the phone number or username." /> : <Text style={s.body}>No matching people. Check the phone number or username.</Text>}
    </View></Reveal>}
    {!mia.contacts.length && !searchQuery && <Empty icon="people-outline" title="Your people, here" text="Find someone by phone number or username. Your saved contacts will appear here." />}
    {!!mia.contacts.length && <View style={p.section}>{agent && <SectionCaption>Saved contacts</SectionCaption>}<View style={agent ? s.insetList : p.list}>{mia.contacts.map((person, index) => <React.Fragment key={person.contactId}><PersonRow name={person.name} username={person.username} onPress={() => void mia.startChat(person).catch(mia.fail)} />{agent && index < mia.contacts.length - 1 && <View style={s.rowDivider} />}</React.Fragment>)}</View></View>}
  </ScrollView></Reveal></View>;
}
function PersonRow({ name, username, add = false, onPress }: { name: string; username: string; add?: boolean; onPress(): void }) {
  const { agent, colors, s } = useUi();
  const p = agent ? agentStyles : classicStyles;
  const [focused, setFocused] = useState(false);
  const { fontScale } = useWindowDimensions();
  return <Pressable accessibilityRole="button" accessibilityLabel={add ? `Add ${name} and open chat` : `${name}, @${username}`} accessibilityHint={add ? 'Save this person to your contacts and open a conversation.' : 'Open conversation.'}
    onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [s.personRow, pressed && { backgroundColor: colors.surfacePressed }, focused && s.focus]}>
    <Avatar name={name} size={48} />
    <View style={p.personText}><Text numberOfLines={fontScale >= 1.4 ? 2 : 1} style={p.name}>{name}</Text><Text numberOfLines={fontScale >= 1.4 ? 2 : 1} style={p.username}>@{username}</Text></View>
    <View accessible={false} style={agent && add ? p.add : undefined}><Icon name={add ? 'add-outline' : 'chevron-forward'} size={18} color={agent && add ? colors.accentLight : colors.muted} /></View>
  </Pressable>;
}
function createStyles(colors: typeof agentColors, agent: boolean) { return StyleSheet.create({
  list: { marginHorizontal: -8 },
  section: { gap: agent ? 12 : 10 }, helper: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: -8 },
  personText: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' }, username: { color: colors.muted, fontSize: agent ? 13 : 12, lineHeight: agent ? 19 : 18 },
  add: { width: 32, height: 32, borderRadius: 12, backgroundColor: colors.soft, borderWidth: 1, borderColor: '#49365F', justifyContent: 'center', alignItems: 'center' },
}); }
const classicStyles = createStyles(classicColors, false);
const agentStyles = createStyles(agentColors, true);

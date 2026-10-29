import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import type { Profile } from '../types';
import { Avatar, Empty, Icon, ScreenHeader, SearchField, colors, s } from '../ui';
export function People({ mia }: { mia: Mia }) {
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
  return <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <ScreenHeader title="Contacts" />
    <SearchField label="Find by phone number or username" hint="Type at least two characters. For phone numbers, include the country code. Search finds people registered on Mia."
      placeholder="Phone number or username" value={query} onChangeText={changeQuery} maxLength={50} loading={loading} />
    {searched && <Text accessibilityLiveRegion="polite" style={s.label}>{results.length ? 'SEARCH RESULTS' : 'No matching people. Check the phone number or username.'}</Text>}
    {!!results.length && <View>{results.map(person => <PersonRow key={person.id} name={person.displayName} username={person.username} add onPress={() => void mia.startChat(person, true).catch(mia.fail)} />)}</View>}
    {!mia.contacts.length && !searched && <Empty icon="people-outline" title="Your people, here" text="Find someone by phone number or username. Your saved contacts will appear here." />}
    {!!mia.contacts.length && <View style={p.list}>{mia.contacts.map(person => <PersonRow key={person.contactId} name={person.name} username={person.username} onPress={() => void mia.startChat(person).catch(mia.fail)} />)}</View>}
  </ScrollView>;
}
function PersonRow({ name, username, add = false, onPress }: { name: string; username: string; add?: boolean; onPress(): void }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={add ? `Add ${name} and open chat` : `${name}, @${username}`} accessibilityHint={add ? 'Save this person to your contacts and open a conversation.' : 'Open conversation.'}
    onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [s.personRow, pressed && { backgroundColor: colors.paper }, focused && s.focus]}>
    <Avatar name={name} size={48} />
    <View style={p.personText}><Text numberOfLines={1} style={p.name}>{name}</Text><Text numberOfLines={1} style={s.small}>@{username}</Text></View>
    <Icon name={add ? 'add-outline' : 'chevron-forward'} size={18} color={colors.muted} />
  </Pressable>;
}
const p = StyleSheet.create({
  list: { marginHorizontal: -8 },
  personText: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.ink, fontSize: 16, fontWeight: '600' },
});

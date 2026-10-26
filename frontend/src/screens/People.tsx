import React, { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import type { Profile } from '../types';
import { Avatar, Button, Empty, Field, s } from '../ui';
export function People({ mia }: { mia: Mia }) {
  const [query, setQuery] = useState(''); const [results, setResults] = useState<Profile[]>([]); const [searched, setSearched] = useState(false); const [loading, setLoading] = useState(false); const epoch = useRef(0);
  async function search() {
    const request = ++epoch.current; setLoading(true);
    try { const list = await mia.api.request<Profile[]>(`/v1/users?query=${encodeURIComponent(query.trim())}`); if (request === epoch.current) { setResults(list); setSearched(true); } }
    catch (reason) { mia.fail(reason); } finally { if (request === epoch.current) setLoading(false); }
  }
  return <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled"><Text style={s.eyebrow}>THE PEOPLE WHO MATTER</Text><Text accessibilityRole="header" style={s.heading}>Your circle</Text><Text style={s.body}>A familiar name. A new conversation.</Text><View style={s.card}><Field label="Find by username" placeholder="At least 2 characters" value={query} onChangeText={value => { epoch.current++; setQuery(value); setSearched(false); setResults([]); setLoading(false); }} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => { if (query.trim().length >= 2) void search(); }} /><Button label="Search people" icon="search-outline" disabled={query.trim().length < 2} loading={loading} onPress={() => void search()} /></View>
    {searched && <Text style={s.label}>{results.length ? 'SEARCH RESULTS' : 'No matching usernames. Try a different prefix.'}</Text>}
    {results.map(person => <View key={person.id} style={[s.card, s.row]}><Avatar name={person.displayName} /><View style={{ flex: 1, gap: 4 }}><Text style={s.label}>{person.displayName}</Text><Text style={s.small}>@{person.username}</Text><Button quiet label="Add & chat" icon="add-outline" onPress={() => void mia.startChat(person, true).catch(mia.fail)} /></View></View>)}
    <Text style={s.label}>SAVED CONTACTS · {mia.contacts.length}</Text>{!mia.contacts.length && <Empty icon="people-outline" title="Make room for your people" text="Search for a username above. Contacts you add will appear here." />}
    {mia.contacts.map(person => <View key={person.contactId} style={[s.row, { paddingVertical: 14 }]}><Avatar name={person.name} /><View style={{ flex: 1, gap: 5 }}><Text style={[s.label, { fontSize: 17 }]}>{person.name}</Text><Text style={s.small}>@{person.username}</Text></View><Button secondary label="Chat" icon="chatbubble-outline" onPress={() => void mia.startChat(person).catch(mia.fail)} /></View>)}
  </ScrollView>;
}

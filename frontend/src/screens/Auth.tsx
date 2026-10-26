import React, { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Button, Field, Icon, Notice, colors, s } from '../ui';
export function Auth({ mia }: { mia: Mia }) {
  const [register, setRegister] = useState(false); const [settings, setSettings] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [username, setUsername] = useState(''); const [displayName, setDisplayName] = useState('');
  const valid = email.includes('@') && password.length >= (register ? 12 : 1) && (!register || (/^[a-z][a-z0-9_]{2,29}$/.test(username) && displayName.trim().length > 0));
  return <ScrollView contentContainerStyle={a.container} keyboardShouldPersistTaps="handled">
    <View style={a.brand}><View style={a.wordmark}><Icon name="sparkles" size={25} color={colors.green} /><Text style={a.logo}>mia</Text></View><Button quiet label="Connection" icon="options-outline" onPress={() => setSettings(!settings)} /></View>
    {settings && <Connection mia={mia} />}
    <View style={a.hero}>
      <View style={a.orbit}><View style={a.orbitInner}><Icon name="chatbubble-ellipses-outline" size={44} color={colors.green} /></View><View style={a.star}><Icon name="sparkles" size={22} color={colors.green} /></View><View style={a.dot} /></View>
      <Text style={s.eyebrow}>A LITTLE CLOSER</Text>
      <Text accessibilityRole="header" style={a.title}>Good conversations.{"\n"}Your way.</Text>
      <Text style={[s.body, { textAlign: 'center', maxWidth: 360 }]}>A calm place to connect. Write, speak, and let Mia help with the little things.</Text>
    </View>
    <View style={a.form}>
      <View style={{ gap: 6 }}><Text accessibilityRole="header" style={s.sectionTitle}>{register ? 'Make yourself at home' : 'Welcome back'}</Text><Text style={s.small}>{register ? 'Create an account on your connected Mia server.' : 'Sign in to pick up the conversation.'}</Text></View>
      {register && <><Field label="Your name" value={displayName} onChangeText={setDisplayName} autoComplete="name" maxLength={80} /><Field label="Username" value={username} onChangeText={value => setUsername(value.toLowerCase())} autoCapitalize="none" autoCorrect={false} maxLength={30} /><Text style={s.small}>3–30 lowercase letters, numbers, or underscores. Start with a letter.</Text></>}
      <Field label="Email address" value={email} onChangeText={setEmail} autoComplete="email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete={register ? 'new-password' : 'current-password'} textContentType={register ? 'newPassword' : 'password'} maxLength={128} onSubmitEditing={() => { if (valid) void mia.signIn(register, register ? { email, password, username, displayName } : { email, password }); }} />
      {register && <Text style={s.small}>Use at least 12 characters.</Text>}
      {mia.error ? <Notice error>{mia.error}</Notice> : null}
      <Button label={register ? 'Create account' : 'Sign in'} icon="arrow-forward" loading={mia.busy} disabled={!valid} onPress={() => void mia.signIn(register, register ? { email, password, username, displayName } : { email, password })} />
      <Button quiet label={register ? 'Already have an account? Sign in' : 'New here? Create an account'} onPress={() => { setRegister(!register); mia.setError(''); }} />
      <View style={s.divider} /><Text style={[s.small, { textAlign: 'center' }]}>{Platform.OS === 'web' ? 'Web preview · sessions end when this page reloads.' : 'Your sign-in is stored securely on this device.'}{'\n'}Built for touch, larger text, and screen readers.</Text>
    </View>
    <Text style={[s.small, { textAlign: 'center', padding: 24 }]}>YOUR PEOPLE. YOUR PACE.</Text>
  </ScrollView>;
}
export function Connection({ mia }: { mia: Mia }) {
  const [server, setServer] = useState(mia.address); const [saved, setSaved] = useState(false);
  return <View style={[s.card, { width: '100%', maxWidth: 500, alignSelf: 'center' }]}><Field label="Mia server address" value={server} onChangeText={value => { setServer(value); setSaved(false); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" /><Text style={s.small}>On an iPhone, use your computer’s local network address. A public server requires HTTPS. Changing the server signs you out of this device.</Text><Button secondary label="Save server" onPress={() => { void import('../api').then(({ normalizeAddress }) => mia.saveSettings(normalizeAddress(server), mia.voiceMode)).then(() => setSaved(true)).catch(mia.fail); }} />{saved && <Notice>Server saved.</Notice>}</View>;
}
const a = StyleSheet.create({ container: { flexGrow: 1, backgroundColor: colors.background, paddingHorizontal: 24, paddingBottom: 20 }, brand: { width: '100%', maxWidth: 1050, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 20 }, wordmark: { flexDirection: 'row', gap: 8, alignItems: 'center' }, logo: { fontSize: 33, letterSpacing: -2, fontWeight: '700', color: colors.green }, hero: { alignItems: 'center', paddingTop: 14, paddingBottom: 32, gap: 14 }, orbit: { width: 128, height: 114, borderWidth: 1, borderColor: '#C9D5BD', borderRadius: 70, transform: [{ rotate: '-16deg' }], alignItems: 'center', justifyContent: 'center', marginBottom: 12 }, orbitInner: { width: 88, height: 88, backgroundColor: colors.soft, borderRadius: 32, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '16deg' }] }, star: { position: 'absolute', right: -2, top: -4, backgroundColor: colors.yellow, width: 42, height: 42, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#9DAC88', position: 'absolute', left: 0, bottom: 10 }, title: { fontSize: 38, lineHeight: 44, letterSpacing: -1.8, fontWeight: '500', textAlign: 'center', color: colors.ink }, form: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: 17, padding: 24, borderRadius: 26, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line } });

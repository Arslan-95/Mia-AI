import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import type { OtpChallenge } from '../types';
import { ApiError } from '../api';
import { Button, Field, Notice, colors, s } from '../ui';
import { MiaCore } from './AssistantOrb';

export function Auth({ mia }: { mia: Mia }) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [locked, setLocked] = useState(false);
  const [pending, setPending] = useState<'request' | 'verify' | null>(null);
  const [now, setNow] = useState(Date.now());
  const requestEpoch = useRef(0);
  const phone = phoneNumber.trim().replace(/[\s()-]/g, '');
  const validPhone = /^\+[1-9]\d{6,14}$/.test(phone);
  const remaining = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000)) : 0;

  useEffect(() => {
    if (!challenge) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge?.challengeId]);

  useEffect(() => {
    return () => { requestEpoch.current++; };
  }, []);

  async function requestCode() {
    if (!validPhone || pending) return;
    const epoch = ++requestEpoch.current;
    setPending('request'); mia.setError('');
    try {
      const next = await mia.requestOtp(phone);
      if (requestEpoch.current !== epoch) return;
      setChallenge(next); setCode(''); setLocked(false); setNow(Date.now());
    } catch (reason) { if (requestEpoch.current === epoch) mia.fail(reason); }
    finally { if (requestEpoch.current === epoch) setPending(null); }
  }

  async function verifyCode() {
    if (!challenge || !/^\d{6}$/.test(code) || remaining <= 0 || locked || pending) return;
    setPending('verify'); mia.setError('');
    try { await mia.verifyOtp(challenge.challengeId, code); }
    catch (reason) { if (reason instanceof ApiError && reason.code === 'OTP_LOCKED') setLocked(true); mia.fail(reason); }
    finally { setPending(null); }
  }

  function changeNumber() {
    requestEpoch.current++; setChallenge(null); setCode(''); setLocked(false); setPending(null); mia.setError('');
  }

  return (
    <ScrollView contentContainerStyle={a.container} keyboardShouldPersistTaps="handled">
      <View style={a.brand}>
        <Wordmark />
      </View>
      <View style={a.hero}>
        <MiaCore compact />
        <Text style={s.eyebrow}>CONNECTED, NATURALLY</Text>
        <Text accessibilityRole="header" style={a.title}>{challenge ? 'One small step.' : 'Your people.\nA new frequency.'}</Text>
        <Text style={[s.body, a.centered]}>{challenge ? 'Enter your code to continue.' : 'Messages, voice, and a little help from Mia.'}</Text>
      </View>

      <View style={a.form}>
        <Text accessibilityRole="header" style={s.sectionTitle}>{challenge ? 'Enter verification code' : 'Your phone number'}</Text>
        {!challenge ? (
          <>
            <Field
              label="Phone number with country code"
              placeholder="+1 202 555 0123"
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              autoCorrect={false}
              maxLength={24}
              editable={!pending}
            />
            <Text style={s.small}>Include + and the country code. This number identifies your account.</Text>
            {!!mia.error && <Notice error>{mia.error}</Notice>}
            <Button label="Continue" icon="arrow-forward" disabled={!validPhone} loading={pending === 'request'} onPress={() => void requestCode()} />
          </>
        ) : (
          <>
            <Text style={s.body}>Verifying {phone}</Text>
            <Field
              label="6-digit verification code"
              value={code}
              onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoCorrect={false}
              maxLength={6}
              editable={!pending && remaining > 0 && !locked}
              style={a.code}
            />
            {locked ? <Notice>This verification session is locked. Request a new code to continue.</Notice> : remaining > 0 ? <Text style={s.small}>Verification expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}.</Text> : <Notice>This verification session has expired. Request a new code to continue.</Notice>}
            {!!mia.error && <Notice error>{mia.error}</Notice>}
            <Button label="Verify & continue" icon="checkmark-outline" loading={pending === 'verify'} disabled={!/^\d{6}$/.test(code) || remaining <= 0 || locked || pending === 'request'} onPress={() => void verifyCode()} />
            <Button secondary label={remaining > 0 ? 'Request another code' : 'Request a new code'} loading={pending === 'request'} disabled={pending === 'verify'} onPress={() => void requestCode()} />
            <Button quiet label="Use a different number" disabled={pending === 'verify'} onPress={changeNumber} />
          </>
        )}
      </View>
      <Text style={[s.small, a.footer]}>SPACE TO CONNECT.</Text>
    </ScrollView>
  );
}

export function CompleteProfile({ mia }: { mia: Mia }) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const valid = !!displayName.trim() && /^[a-z][a-z0-9_]{2,29}$/.test(username);
  return (
    <ScrollView contentContainerStyle={a.container} keyboardShouldPersistTaps="handled">
      <View style={a.brand}><Wordmark /></View>
      <View style={a.hero}>
        <Text style={s.eyebrow}>YOUR OWN SPACE</Text>
        <Text accessibilityRole="header" style={a.title}>What should we{'\n'}call you?</Text>
        <Text style={[s.body, a.centered]}>Choose the name your people will see.</Text>
      </View>
      <View style={a.form}>
        <Field label="Your name" value={displayName} onChangeText={setDisplayName} autoComplete="name" textContentType="name" maxLength={80} editable={!mia.busy} />
        <Field label="Username" value={username} onChangeText={value => setUsername(value.toLowerCase())} autoCapitalize="none" autoCorrect={false} maxLength={30} editable={!mia.busy} />
        <Text style={s.small}>People can find you by username. Use 3–30 lowercase letters, numbers, or underscores, starting with a letter.</Text>
        {!!mia.error && <Notice error>{mia.error}</Notice>}
        <Button label="Start connecting" icon="arrow-forward" disabled={!valid} loading={mia.busy} onPress={() => void mia.completeProfile(username, displayName.trim())} />
        <Button quiet label="Use a different phone number" disabled={mia.busy} onPress={() => void mia.logout().catch(mia.fail)} />
      </View>
    </ScrollView>
  );
}

function Wordmark() {
  return <View style={a.wordmark}><Text style={a.logo}>mia<Text style={{ color: colors.accent }}>.</Text></Text></View>;
}

const a = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: colors.background, paddingHorizontal: 24, paddingBottom: 20 },
  brand: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 20 },
  wordmark: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  logo: { fontSize: 33, letterSpacing: -2, fontWeight: '700', color: colors.ink },
  hero: { alignItems: 'center', paddingTop: 14, paddingBottom: 32, gap: 14 },
  title: { fontSize: 40, lineHeight: 46, letterSpacing: -1.8, fontWeight: '500', textAlign: 'center', color: colors.ink },
  form: { width: '100%', gap: 17, padding: 24, borderRadius: 26, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  centered: { textAlign: 'center' },
  code: { fontSize: 26, letterSpacing: 8, textAlign: 'center' },
  footer: { textAlign: 'center', padding: 24 },
});

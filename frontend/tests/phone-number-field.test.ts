import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import type { Mia } from '../src/app/useMia';
import type { Auth } from '../src/features/auth/ui/Auth';

const sources: Record<string, string> = {
  'react-native': `export const ScrollView='ScrollView', Text='Text', View='View', TextInput='TextInput',
    FlatList='FlatList', Modal='Modal', Pressable='Pressable', KeyboardAvoidingView='KeyboardAvoidingView';
    export const StyleSheet={create: value => value}; export const Keyboard={dismiss() {}};`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeAreaView';`,
  '../../../shared/ui/ui': `export const colors={}, s={}; export const Button='Button', Field='Field', Notice='Notice', Icon='Icon', SearchField='SearchField';
    export const useUi=() => ({colors, s});`,
  '../../assistant/ui/AssistantOrb': `export const MiaCore='MiaCore';`,
};
const bundle = build({
  stdin: { contents: `export { Auth } from './src/features/auth/ui/Auth';`, resolveDir: fileURLToPath(new URL('../', import.meta.url).toString()) },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  plugins: [{ name: 'native-boundary', setup(builder) {
    builder.onResolve({ filter: /^(react-native|react-native-safe-area-context|\.\.\/\.\.\/\.\.\/shared\/ui\/ui|\.\.\/\.\.\/assistant\/ui\/AssistantOrb)$/ }, args => ({ path: args.path, namespace: 'native-boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'native-boundary' }, args => ({ contents: sources[args.path]!, loader: 'js' }));
  } }],
});

async function harness() {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const module = { exports: {} as { Auth: typeof Auth } };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  const sent: string[] = [];
  const mia = {
    error: '', setError() {}, cancelOtp() {}, fail(reason: unknown) { throw reason; },
    async requestOtp(phone: string) {
      sent.push(phone);
      return { challengeId: 'test-challenge', expiresAt: new Date(Date.now() + 300_000).toISOString(), delivery: 'test' };
    },
  } as unknown as Mia;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(module.exports.Auth, { mia })); });
  const input = () => renderer.root.findByType('TextInput' as any);
  const button = (label: string) => renderer.root.findAllByType('Button' as any).find(node => node.props.label === label)!;
  return { sent, input, button, tree: () => renderer.root,
    type: async (text: string) => { await act(async () => input().props.onChangeText(text)); },
    async country(query: string, code: string) {
      const chooser = renderer.root.findAllByType('Pressable' as any).find(node => node.props.accessibilityLabel.startsWith('Country:'))!;
      await act(async () => chooser.props.onPress());
      await act(async () => renderer.root.findByType('SearchField' as any).props.onChangeText(query));
      const list = renderer.root.findByType('FlatList' as any);
      const item = list.props.data.find((country: { code: string }) => country.code === code);
      assert.ok(item, `${code} appears in search results for ${query}`);
      await act(async () => list.props.renderItem({ item }).props.onPress());
    },
    async close() { await act(async () => renderer.unmount()); },
  };
}

test('country selection formats a national number, sends E.164 and retains it when returning from verification', async () => {
  const h = await harness();
  try {
    assert.equal(h.button('Continue').props.disabled, true);
    await h.country('Georgia', 'GE');
    await h.type('555123456');
    assert.equal(h.input().props.value, '555 12 34 56');
    assert.equal(h.input().props.keyboardType, 'phone-pad');
    assert.equal(h.input().props.autoComplete, 'tel');
    assert.equal(h.button('Continue').props.disabled, false);
    await act(async () => h.button('Continue').props.onPress());
    assert.deepEqual(h.sent, ['+995555123456']);
    await act(async () => h.button('Use a different number').props.onPress());
    assert.equal(h.input().props.value, '555 12 34 56');
    assert.ok(h.tree().findAllByType('Pressable' as any).some(node => node.props.accessibilityLabel === 'Country: Georgia, +995'));
  } finally { await h.close(); }
});

test('international paste selects its country and national trunk prefixes never duplicate the calling code', async () => {
  const h = await harness();
  try {
    await h.type('+44 7700 900123');
    assert.equal(h.input().props.value, '07700 900123');
    assert.ok(h.tree().findAllByType('Pressable' as any).some(node => node.props.accessibilityLabel === 'Country: United Kingdom, +44'));
    await act(async () => h.button('Continue').props.onPress());
    assert.deepEqual(h.sent, ['+447700900123']);
    await act(async () => h.button('Use a different number').props.onPress());
    await h.country('+995', 'GE');
    await h.type('555123456');
    await h.country('GB', 'GB');
    await h.type('07700 900123');
    await act(async () => h.button('Continue').props.onPress());
    assert.deepEqual(h.sent, ['+447700900123', '+447700900123']);
  } finally { await h.close(); }
});

test('backspace can remove formatting and incomplete, cleared or oversized numbers cannot send an SMS', async () => {
  const h = await harness();
  try {
    await h.type('202');
    assert.equal(h.input().props.value, '(202)');
    await h.type('(202');
    assert.equal(h.input().props.value, '(202');
    await h.type('(20');
    assert.equal(h.input().props.value, '(20');
    assert.equal(h.button('Continue').props.disabled, true);
    await act(async () => h.button('Continue').props.onPress());
    await h.type('2025550123');
    assert.equal(h.button('Continue').props.disabled, false);
    await h.type('');
    assert.equal(h.input().props.value, '');
    await h.country('Georgia', 'GE');
    assert.equal(h.button('Continue').props.disabled, true);
    await h.type('555123456789012345');
    assert.equal(h.button('Continue').props.disabled, true);
    await act(async () => h.button('Continue').props.onPress());
    assert.deepEqual(h.sent, []);
  } finally { await h.close(); }
});

test('resend sits beside the verification timer and waits two minutes after each successful request', async t => {
  let now = Date.now();
  let tick!: () => void;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => { tick = callback; return 1 as any; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const h = await harness();
  const resend = () => h.tree().findAllByType('Pressable' as any).find(node => node.props.accessibilityLabel === 'Resend')!;
  const advance = async (milliseconds: number) => { now += milliseconds; await act(async () => tick()); };
  try {
    await h.type('+995555123456');
    await act(async () => h.button('Continue').props.onPress());
    assert.equal(h.button('Start again'), undefined);
    assert.equal(resend().findByType('Text' as any).props.children, 'Resend');
    assert.equal(resend().findByType('Text' as any).props.style[1].textDecorationLine, 'underline');
    assert.ok(resend().parent!.findAllByType('Text' as any).some(node => String(node.props.children).startsWith('Verification expires in')));
    assert.equal(resend().props.disabled, true);
    await act(async () => resend().props.onPress());
    assert.equal(h.sent.length, 1);
    await advance(119_000);
    assert.equal(resend().props.disabled, true);
    await advance(1_000);
    assert.equal(resend().props.disabled, false);
    await act(async () => h.tree().findByType('Field' as any).props.onChangeText('123456'));
    await act(async () => resend().props.onPress());
    assert.equal(h.sent.length, 2);
    assert.equal(h.tree().findByType('Field' as any).props.value, '');
    assert.equal(resend().props.disabled, true);
    await advance(120_000);
    assert.equal(resend().props.disabled, false);
  } finally { await h.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PhoneSignIn } from '../src/phoneAuth';
import type { nativePhoneAuth } from '../src/phoneAuthNative';

test('native adapter allows first SMS when signed out, but preserves other sign-out failures', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url).toString());
  const auth = { languageCode: '' };
  let signOutError: unknown = { code: 'auth/no-current-user' }, sends = 0;
  const sdk = {
    getAuth: () => auth,
    signOut: async (instance: unknown) => { assert.equal(instance, auth); if (signOutError) throw signOutError; },
    signInWithPhoneNumber: async (instance: unknown, phone: string) => {
      assert.equal(instance, auth); assert.equal(phone, '+12025550101'); sends++;
      return { verificationId: 'native-verification', confirm: async () => ({ user: {
        phoneNumber: phone, getIdToken: async () => 'verified-native-token',
      } }) };
    },
  };
  const bundle = await build({
    stdin: { contents: `export { nativePhoneAuth } from './src/phoneAuthNative';`, resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['@react-native-firebase/auth'],
  });
  const module = { exports: {} as { nativePhoneAuth: typeof nativePhoneAuth } };
  const nativeRequire = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(
    (id: string) => id === '@react-native-firebase/auth' ? sdk : nativeRequire(id), module, module.exports);
  const flow = () => new PhoneSignIn(async () => module.exports.nativePhoneAuth());
  const clean = flow();
  const challenge = await clean.request('+12025550101');
  assert.equal(sends, 1);
  signOutError = undefined;
  const result = await clean.verify(challenge.challengeId, '123456', async token => {
    assert.equal(token, 'verified-native-token'); return 'mia-session';
  });
  assert.equal(result, 'mia-session');
  signOutError = { code: 'auth/internal-error' };
  await assert.rejects(flow().request('+12025550101'), { code: 'PHONE_AUTH_UNAVAILABLE' });
  assert.equal(sends, 1);
});

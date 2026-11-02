import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PhoneSignIn } from '../src/phoneAuth';
import { SmsAttemptBudget } from '../src/smsAttemptBudget';
import type { smsAttemptStorage } from '../src/storage';

const root = fileURLToPath(new URL('../', import.meta.url).toString()).replaceAll('\\', '/');

test('real SMS storage adapter preserves history and blocks dispatch on Keychain read failure', async () => {
  const now = 1_800_000_000_000;
  const history = JSON.stringify(Array.from({ length: 10 }, (_, index) => now - (index + 1) * 60_000));
  let saved = history, readFailure = true, writes = 0, sends = 0;
  const secureStore = {
    getItemAsync: async (key: string) => {
      assert.equal(key, 'mia.sms.attempts');
      if (readFailure) throw new Error('Keychain temporarily unavailable');
      return saved;
    },
    setItemAsync: async (key: string, value: string) => {
      assert.equal(key, 'mia.sms.attempts'); writes++; saved = value;
    },
  };
  // Exercise the production storage module; only the native OS boundary is mocked.
  const bundle = await build({
    stdin: { contents: `export { smsAttemptStorage } from './src/storage';`, resolveDir: root },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['expo-secure-store'],
  });
  const module = { exports: {} as { smsAttemptStorage: typeof smsAttemptStorage } };
  const nativeRequire = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', bundle.outputFiles[0]!.text)(
    (id: string) => id === 'expo-secure-store' ? secureStore : nativeRequire(id), module, module.exports);
  const flow = () => new PhoneSignIn(async () => ({
    signOut: async () => {},
    sendCode: async () => { sends++; return { verificationId: 'unused', confirm: async () => null }; },
  }), () => now, new SmsAttemptBudget(module.exports.smsAttemptStorage));

  await assert.rejects(flow().request('+12025550101'), { code: 'PHONE_AUTH_UNAVAILABLE' });
  assert.equal(writes, 0);
  assert.equal(saved, history);
  readFailure = false;
  await assert.rejects(flow().request('+12025550101'), { code: 'OTP_RATE_LIMIT' });
  assert.equal(sends, 0);
  assert.equal(writes, 0);
});

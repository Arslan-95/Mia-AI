import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { Session } from './types';
// Native secrets use Keychain/Keystore. Web credentials live only in memory.
let webSession: Session | null = null;
export const sessionStorage = {
  async read(): Promise<Session | null> {
    const value = Platform.OS === 'web' ? webSession : await SecureStore.getItemAsync('mia.session').then(v => v ? JSON.parse(v) as Session : null);
    return value && Date.parse(value.expiresAt) > Date.now() ? value : null;
  },
  async write(value: Session | null) {
    if (Platform.OS === 'web') { webSession = value; return; }
    if (value) await SecureStore.setItemAsync('mia.session', JSON.stringify(value), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else await SecureStore.deleteItemAsync('mia.session');
  },
};
export const preferences = {
  async get(key: string) { try { return Platform.OS === 'web' ? globalThis.localStorage?.getItem(key) ?? null : await SecureStore.getItemAsync(key); } catch { return null; } },
  async set(key: string, value: string) { if (Platform.OS === 'web') globalThis.localStorage?.setItem(key, value); else await SecureStore.setItemAsync(key, value); },
};

import * as SecureStore from 'expo-secure-store';
import { createSessionStore } from './sessionStore';

const keychain = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
  remove: (key: string) => SecureStore.deleteItemAsync(key),
};

export const sessionStorage = createSessionStore(keychain);
export const preferences = {
  async get(key: string) {
    try { return await keychain.get(key); } catch { return null; }
  },
  set: keychain.set,
};

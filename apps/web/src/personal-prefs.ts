import { useEffect, useSyncExternalStore } from 'react';
import type { ChatPersonalPreferenceDTO, PersonalPreferencesDTO } from '@tiecoms/contracts';
import { client, useClient } from './app-client.ts';
import { errorText } from './i18n.ts';
import { toast } from './menu.tsx';
import { setAccentPreference, setThemePreference } from './theme.ts';

const EMPTY: PersonalPreferencesDTO = { sections: [], conversations: {} };
let owner: string | null = null;
let value = EMPTY;
let loading: Promise<void> | null = null;
let queue = Promise.resolve();
let focusSubscribed = false;
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());
const applyAppearance = () => { if (value.appearance) { setThemePreference(value.appearance.mode); setAccentPreference(value.appearance.accent); } else setAccentPreference(null); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export async function loadPersonalPreferences(userId: string, refresh = false) {
  if (owner !== userId) { owner = userId; value = EMPTY; loading = null; announce(); }
  if (loading) return loading;
  if (!refresh && value !== EMPTY) return;
  const requestedOwner = userId;
  loading = client.request<PersonalPreferencesDTO>('/me/personal-preferences').then((data) => {
    if (owner === requestedOwner) { value = data; applyAppearance(); announce(); }
  }).finally(() => { if (owner === requestedOwner) loading = null; });
  return loading;
}

export function usePersonalPreferences() {
  const userId = useClient((state) => state.data?.me.id);
  useEffect(() => {
    if (!userId) return;
    if (owner !== userId || !loading) void loadPersonalPreferences(userId).catch((error) => toast(errorText(error)));
    if (!focusSubscribed) {
      focusSubscribed = true;
      window.addEventListener('focus', () => {
        const currentUser = client.getState().data?.me.id;
        if (currentUser) void queue.then(() => loadPersonalPreferences(currentUser, true)).catch((error) => toast(errorText(error)));
      });
    }
  }, [userId]);
  const snapshot = useSyncExternalStore(subscribe, () => value);
  return owner === userId ? snapshot : EMPTY;
}

/** Serializes writes from controls in multiple open chat panels. No optimistic state survives a failed save. */
export function updatePersonalPreferences(change: (current: PersonalPreferencesDTO) => PersonalPreferencesDTO) {
  const userId = client.getState().data?.me.id;
  const operation = queue.then(async () => {
    if (!userId || client.getState().data?.me.id !== userId) return;
    await loadPersonalPreferences(userId, true);
    if (client.getState().data?.me.id !== userId) return;
    const next = change(value);
    const saved = await client.request<PersonalPreferencesDTO>('/me/personal-preferences', { method: 'PUT', json: next });
    if (owner === userId) { value = saved; applyAppearance(); announce(); }
  });
  queue = operation.catch((error) => { toast(errorText(error)); });
  return operation;
}

export const updatePersonalChat = (id: string, patch: Partial<ChatPersonalPreferenceDTO>) => updatePersonalPreferences((current) => ({
  ...current, conversations: { ...current.conversations, [id]: { ...current.conversations[id], ...patch } },
}));

export const CHAT_FONTS = { system: 'inherit', serif: 'Georgia, "Times New Roman", serif', mono: 'ui-monospace, SFMono-Regular, Consolas, monospace', rounded: '"Avenir Next", "Trebuchet MS", sans-serif' } as const;
export const chatAppearanceStyle = (pref: ChatPersonalPreferenceDTO = {}) => ({ fontFamily: CHAT_FONTS[pref.font ?? 'system'] });

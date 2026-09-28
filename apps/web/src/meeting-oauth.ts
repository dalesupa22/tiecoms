import type { MeetingProvider } from '@tiecoms/contracts';

const KEY = 'chaggu:meeting-proof';
type Proof = { provider: MeetingProvider; userId: string; verifier: string; createdAt: number };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The browser that began the operation must also receive the callback receipt. */
export async function prepareMeetingProof(storage: Store, userId: string, provider: MeetingProvider, stillOwns: () => boolean = () => true) {
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  if (!stillOwns()) throw new Error('Session changed');
  storage.setItem(KEY, JSON.stringify({ provider, userId, verifier, createdAt: Date.now() } satisfies Proof));
  return challenge;
}
export function clearMeetingProof(storage: Store) { storage.removeItem(KEY); }
export function clearForeignMeetingProof(storage: Store, userId: string | null) {
  try {
    const value = JSON.parse(storage.getItem(KEY) ?? 'null') as Proof | null;
    if (!userId || (value && value.userId !== userId)) clearMeetingProof(storage);
  } catch { clearMeetingProof(storage); }
}
/** Consume before confirmation, never store the callback receipt or log it. */
export function takeMeetingProof(storage: Store, userId: string, provider: string): string {
  const raw = storage.getItem(KEY);
  clearMeetingProof(storage);
  let proof: Proof | null = null;
  try { proof = JSON.parse(raw ?? 'null'); } catch {}
  if (!proof || proof.userId !== userId || proof.provider !== provider || !/^[\w-]{43}$/.test(proof.verifier)
    || Date.now() - proof.createdAt > 10 * 60_000 || proof.createdAt > Date.now()) {
    throw new Error('Vuelve a conectar la cuenta desde este navegador. / Connect the account again from this browser.');
  }
  return proof.verifier;
}

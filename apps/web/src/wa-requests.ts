import type { WaAccountDTO } from '@tiecoms/contracts';
import { client } from './app-client.ts';
let accountCache: { owner: string; at: number; accounts: WaAccountDTO[] } | null = null;
let accountRequest: { owner: string; promise: Promise<WaAccountDTO[]> } | null = null;
export function waAccounts(refresh = false): Promise<WaAccountDTO[]> {
  const owner = client.getSessionIdentity();
  if (owner == null) return Promise.resolve([]);
  if (accountRequest?.owner === owner) return accountRequest.promise;
  if (!refresh && accountCache?.owner === owner && Date.now() - accountCache.at < 60_000) return Promise.resolve(accountCache.accounts);
  const promise = client.request<{ accounts: WaAccountDTO[] }>('/whatsapp/accounts').then((r) => { if (client.getSessionIdentity() === owner) accountCache = { owner, at: Date.now(), accounts: r.accounts }; return r.accounts; }).finally(() => { if (accountRequest?.promise === promise) accountRequest = null; });
  accountRequest = { owner, promise }; return promise;
}

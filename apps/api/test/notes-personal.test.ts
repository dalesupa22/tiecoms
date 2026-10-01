import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const API = process.env.API_URL ?? 'http://localhost:3020';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(API).hostname)) throw new Error('Notes regression requires a local API; production mutations are prohibited');
const run = randomUUID().slice(0, 8);
async function call(path: string, opts: { token?: string; method?: string; body?: unknown; raw?: Buffer; type?: string } = {}) {
  const response = await fetch(`${API}/api/v1${path}`, { method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.raw ? { 'content-type': 'application/octet-stream', 'x-file-type': opts.type ?? 'text/plain' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : opts.raw });
  return { status: response.status, json: await response.json() as any };
}
async function signup(name: string) {
  const result = await call('/auth/signup', { body: { name, email: `${name.toLowerCase()}.notes.${run}@example.com`, password: 'clave-segura-123', orgName: `Notes ${name} ${run}`, device: { deviceId: randomUUID(), name: 'notes regression', platform: 'web' } } });
  expect(result.status).toBe(200);
  return { token: result.json.accessToken as string, id: result.json.user.id as string };
}
let ana: Awaited<ReturnType<typeof signup>>, beto: Awaited<ReturnType<typeof signup>>, sharedId: string, outsiderId: string;
beforeAll(async () => {
  ana = await signup('Ana'); beto = await signup('Beto');
  const space = (await call('/workspaces', { token: ana.token, body: { name: `Together ${run}` } })).json;
  const invite = (await call(`/workspaces/${space.id}/invitations`, { token: ana.token, body: { role: 'member', conversationIds: [space.generalConversationId] } })).json;
  expect((await call(`/invitations/${invite.token}/accept`, { token: beto.token, body: {} })).status).toBe(200);
  const group = await call('/chats', { token: ana.token, body: { name: `Shared notes ${run}`, userIds: [beto.id] } });
  expect(group.status).toBe(200); sharedId = group.json.id;
  const outsider = await call('/workspaces', { token: beto.token, body: { name: `Outside ${run}` } });
  expect(outsider.status).toBe(200); outsiderId = outsider.json.generalConversationId;
});

describe('private notes', () => {
  it('persists notes with private files and references without posting chat messages, and refuses another owner', async () => {
    const bootBefore = (await call('/bootstrap', { token: ana.token })).json;
    const before = bootBefore.conversations.find((chat: any) => chat.id === sharedId).lastMessageSeq;
    const uploaded = await call('/drive/files?name=private-note.txt', { token: ana.token, raw: Buffer.from('private content') });
    expect(uploaded.status).toBe(200);
    const payload = { title: 'Only Ana can see this', body: 'Do not send to the tagged group', tags: [{ kind: 'conversation', id: sharedId, label: 'Shared chat' }, { kind: 'label', label: 'Research' }], fileIds: [uploaded.json.id], links: ['https://example.com/private-reference'] };
    const saved = await call('/notes', { token: ana.token, body: payload });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject(payload);
    expect(saved.json.files).toEqual([expect.objectContaining({ id: uploaded.json.id, visibility: 'private' })]);
    expect((await call('/notes', { token: ana.token })).json).toEqual([expect.objectContaining({ id: saved.json.id })]);
    expect((await call('/notes', { token: beto.token })).json).toEqual([]);
    expect((await call(`/notes/${saved.json.id}`, { token: beto.token, method: 'PUT', body: { ...payload, title: 'Stolen' } })).status).toBe(404);
    expect((await call(`/notes/${saved.json.id}`, { token: beto.token, method: 'DELETE' })).status).toBe(404);
    expect((await call(`/drive/files/${uploaded.json.id}/link`, { token: beto.token })).status).toBe(404);
    const after = (await call('/bootstrap', { token: ana.token })).json.conversations.find((chat: any) => chat.id === sharedId).lastMessageSeq;
    expect(after).toBe(before);
    const edited = await call(`/notes/${saved.json.id}`, { token: ana.token, method: 'PUT', body: { ...payload, title: 'Edited note' } });
    expect(edited.status).toBe(200); expect(edited.json.title).toBe('Edited note');
    expect((await call(`/notes/${saved.json.id}`, { token: ana.token, method: 'DELETE' })).status).toBe(200);
    expect((await call('/notes', { token: ana.token })).json).toEqual([]);
  });
  it('rejects shared files, inaccessible references and unsafe links', async () => {
    const uploaded = await call(`/drive/files?name=shared-note.txt&conversationId=${sharedId}&visibility=shared`, { token: ana.token, raw: Buffer.from('shared content') });
    expect(uploaded.status).toBe(200);
    expect((await call('/notes', { token: ana.token, body: { title: 'Invalid shared file', fileIds: [uploaded.json.id] } })).status).toBe(400);
    expect((await call('/notes', { token: ana.token, body: { title: 'Invalid reference', tags: [{ kind: 'conversation', id: outsiderId, label: 'Hidden chat' }] } })).status).toBe(404);
    expect((await call('/notes', { token: ana.token, body: { title: 'Invalid link', links: ['javascript:alert(1)'] } })).status).toBe(400);
    expect((await call('/notes', { token: ana.token, body: { title: 'Invalid ref ID', tags: [{ kind: 'issue', label: 'Unknown task' }] } })).status).toBe(400);
  });
});

describe('personal organization and profile', () => {
  it('persists personal favorites, archive, section, style and custom theme without archiving a shared conversation', async () => {
    const sectionId = randomUUID();
    const preferences = { sections: [{ id: sectionId, name: 'Xertiflow' }], conversations: { [sharedId]: { favorite: true, archived: true, sectionId, background: 'mint', font: 'serif', hideBar: true } }, appearance: { mode: 'dark', accent: '#0a7c87' } };
    expect((await call('/me/personal-preferences', { token: ana.token, method: 'PUT', body: preferences })).status).toBe(200);
    expect((await call('/me/personal-preferences', { token: ana.token })).json).toEqual(preferences);
    expect((await call('/me/personal-preferences', { token: beto.token })).json).toEqual({ sections: [], conversations: {} });
    for (const person of [ana, beto]) expect((await call('/bootstrap', { token: person.token })).json.conversations.some((chat: any) => chat.id === sharedId)).toBe(true);
    expect((await call('/me/personal-preferences', { token: ana.token, method: 'PUT', body: { sections: [], conversations: { [sharedId]: { sectionId } } } })).status).toBe(400);
    expect((await call('/me/personal-preferences', { token: ana.token, method: 'PUT', body: { sections: [], conversations: { [outsiderId]: { favorite: true } } } })).status).toBe(404);
  });
  it('shares only the profile details chosen by the person within the existing directory scope', async () => {
    const details = { phone: '+57 300 123 4567', company: 'Example company', bio: 'Available after noon' };
    const profile = await call('/me', { token: ana.token, method: 'PATCH', body: details });
    expect(profile.status).toBe(200); expect(profile.json).toMatchObject(details);
    const visible = (await call('/bootstrap', { token: beto.token })).json.people.find((person: any) => person.id === ana.id);
    expect(visible).toMatchObject(details); expect(visible.email).toBeUndefined();
    const stranger = await signup('Stranger');
    expect((await call('/bootstrap', { token: stranger.token })).json.people.some((person: any) => person.id === ana.id)).toBe(false);
  });
});

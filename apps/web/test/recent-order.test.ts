/**
 * «Recientes»: al escribirle a alguien (o recibir un mensaje) su chat sube, sin esperar al bootstrap.
 * Antes, activityOf usaba lastHumanPreview del bootstrap y bumpMeta no lo actualizaba (reporte de Danny, 29-sep-2026).
 */
import { describe, expect, it } from 'vitest';
import { TieComsClient, MemoryStorage, humanPreviewOf } from '@tiecoms/client-core';
import type { BootstrapDTO, ConversationDTO, MessageDTO } from '@tiecoms/contracts';
import { activityOf, compareConversations } from '../src/home-order.ts';

const preview = (id: string, seq: number, authorId: string, createdAt: string) => ({ messageId: id, seq, authorId, body: `hola ${id}`, attachments: null, createdAt });
const dm = (id: string, seq: number, at: string, author: string) => ({
  id, kind: 'direct', parentId: null, deriveKind: null, pinnedAt: null, mutedUntil: null, unread: 0, unreadMentions: 0,
  lastMessageSeq: seq, lastReadSeq: seq, historyFromSeq: 0, lastMessageAt: at, lastHumanPreview: preview(`${id}-${seq}`, seq, author, at),
}) as unknown as ConversationDTO;
const msg = (conversationId: string, seq: number, authorId: string, createdAt: string, extra: Partial<MessageDTO> = {}) => ({
  id: `${conversationId}-m${seq}`, conversationId, seq, authorId, clientMessageId: null, kind: 'text', body: 'Te escribo', replyTo: null, mergedFrom: null,
  forwarded: null, createdAt, editedAt: null, deletedAt: null, ...extra,
}) as MessageDTO;

function clientWith(conversations: ConversationDTO[]) {
  const client = new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'test', storage: new MemoryStorage() });
  (client as any).state = { ...client.getState(), status: 'ready', data: { me: { id: 'danny' }, conversations } as BootstrapDTO };
  return client;
}
const order = (client: TieComsClient) => [...client.getState().data!.conversations].sort(compareConversations).map((c) => c.id);

describe('Recientes sube la conversación con actividad', () => {
  it('escribirle a Harold lo pone por encima de Fidel', () => {
    const client = clientWith([dm('fidel', 5, '2026-09-29T20:00:00Z', 'fidel'), dm('harold', 3, '2026-09-29T18:00:00Z', 'harold')]);
    expect(order(client)).toEqual(['fidel', 'harold']);
    (client as any).bumpMeta(msg('harold', 4, 'danny', '2026-09-29T21:00:00Z'));
    expect(order(client)).toEqual(['harold', 'fidel']);
    const h = client.getState().data!.conversations.find((c) => c.id === 'harold')!;
    expect(activityOf(h)).toBe('2026-09-29T21:00:00Z');
    expect(h.lastHumanPreview).toMatchObject({ authorId: 'danny', body: 'Te escribo', seq: 4 });
  });

  it('un mensaje recibido también sube su chat', () => {
    const client = clientWith([dm('fidel', 5, '2026-09-29T20:00:00Z', 'fidel'), dm('harold', 3, '2026-09-29T18:00:00Z', 'harold')]);
    (client as any).bumpMeta(msg('harold', 4, 'harold', '2026-09-29T21:00:00Z'));
    expect(order(client)[0]).toBe('harold');
  });

  it('un mensaje de sistema no cambia la última vista previa de una persona', () => {
    const client = clientWith([dm('harold', 3, '2026-09-29T18:00:00Z', 'harold')]);
    (client as any).bumpMeta(msg('harold', 4, 'danny', '2026-09-29T21:00:00Z', { kind: 'system', body: '{"k":"issue.created"}' }));
    const h = client.getState().data!.conversations[0]!;
    expect(h.lastHumanPreview?.seq).toBe(3);
    expect(h.lastMessageAt).toBe('2026-09-29T21:00:00Z');
  });

  it('una sola vista no filtra el texto y resume adjuntos', () => {
    const p = humanPreviewOf(msg('x', 1, 'a', '2026-09-29T21:00:00Z', {
      viewOnce: true, body: 'secreto',
      attachments: [{ id: 'f', name: 'foto.jpg', contentType: 'image/jpeg', sizeBytes: 1, width: null, height: null, url: '', thumbUrl: null }],
    }));
    expect(p.body).toBe('');
    expect(p.viewOnce).toBe(true);
    expect(p.attachments).toMatchObject({ count: 1, images: 1, files: 0 });
  });
});

import { createHash } from 'node:crypto';
import { conversationAccess } from '../access.ts';
import type { Tx } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { sha256 } from '../security.ts';
import * as attachments from './attachments.ts';
import * as issues from './issues.ts';
import { decodeFile, validateFileType } from './mcp-file-input.ts';
import { idempotentUpload, requestHash } from './mcp-idempotency.ts';
import type { McpCtx } from './mcp-wa.ts';

export type FileInput = { name: string; content_type: string; data_base64: string; idempotency_key: string };

export async function taskWriteAccess(c: Tx, userId: string, id: string) {
  // Same row lock/order as updateIssue: append must not race a product update or another upload.
  await c.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE', [id]);
  const issue = await issues.loadVisible(c, userId, id);
  if (issue.visibility === 'all' && issue.conversationId) await conversationAccess(c, userId, issue.conversationId, 'post', true);
  return issue;
}

function inputFile(a: FileInput) {
  const body = decodeFile(a.data_base64);
  const sniffed = attachments.sniffImage(body);
  const type = validateFileType(body, a.content_type, sniffed, sniffed ? attachments.imageSize(body) : null);
  return { body, type, name: a.name };
}

/** Deterministic object identity: a crash after S3 but before SQL never produces a second object. */
function fileId(ctx: McpCtx, operation: string, key: string, hash: Buffer) {
  const b = sha256(`${ctx.tokenId}:${operation}:${key}:${hash.toString('hex')}`).subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function uploadChat(ctx: McpCtx, chatId: string, a: FileInput) {
  const input = inputFile(a);
  const payload = { chatId, name: input.name, type: input.type, digest: createHash('sha256').update(input.body).digest('hex') };
  const id = fileId(ctx, 'upload_chat_attachment', a.idempotency_key, requestHash('upload_chat_attachment', payload));
  return idempotentUpload(ctx, a.idempotency_key, 'upload_chat_attachment', payload,
    (c) => conversationAccess(c, ctx.userId, chatId, 'post', true),
    () => attachments.prepareFileUpload(ctx.userId, { conversationId: chatId }, input, id),
    async (c, prepared) => ({ chatId, attachment: await attachments.persistFileUpload(c, prepared) }),
    async (c, response) => {
      const row = await attachments.readable(ctx.userId, response.attachment.id, c);
      if (row.conversation_id !== chatId || row.owner_id !== ctx.userId) throw notFound('Adjunto');
    });
}

/** One operation uploads and APPENDS to the task, preserving files attached by other people. */
export async function uploadTask(ctx: McpCtx, issueId: string, a: FileInput) {
  const input = inputFile(a);
  const payload = { issueId, name: input.name, type: input.type, digest: createHash('sha256').update(input.body).digest('hex') };
  const id = fileId(ctx, 'upload_task_attachment', a.idempotency_key, requestHash('upload_task_attachment', payload));
  let conversationId: string | null = null;
  return idempotentUpload(ctx, a.idempotency_key, 'upload_task_attachment', payload,
    async (c) => { const issue = await taskWriteAccess(c, ctx.userId, issueId); conversationId = issue.conversationId;
      if ((issue.attachments?.length ?? 0) >= 20 && !issue.attachments?.some((f) => f.id === id)) throw badRequest('Máximo 20 adjuntos por tarea'); },
    () => attachments.prepareFileUpload(ctx.userId, { conversationId, issueId }, input, id),
    async (c, prepared) => {
      // A task moved during S3 cannot accept an upload prepared for its previous chat.
      if (prepared.conversationId !== conversationId) throw badRequest('La tarea cambió de chat durante la subida; reintenta');
      const file = await attachments.persistFileUpload(c, prepared);
      const current = await issues.loadVisible(c, ctx.userId, issueId);
      const ids = [...new Set([...(current.attachments ?? []).map((f) => f.id), file.id])];
      const updated = await issues.updateIssue(ctx.userId, issueId, { attachmentIds: ids }, c);
      return { taskId: issueId, attachment: file, attachments: updated.attachments ?? [] };
    },
    async (c, response) => {
      const row = await attachments.readable(ctx.userId, response.attachment.id, c);
      if (row.issue_id !== issueId) throw notFound('Adjunto');
      // Do not replay names/URLs of other files that were removed since this request.
      const current = await issues.loadVisible(c, ctx.userId, issueId);
      response.attachments = current.attachments ?? [];
    });
}

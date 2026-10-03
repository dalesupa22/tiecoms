/**
 * Constantes del conector MCP sin dependencias: el puente de WhatsApp carga mcp-wa.ts y, por la cadena de imports,
 * también mcp.ts; si estas listas vivieran en mcp-wa.ts, mcp.ts las leería antes de que existan (import circular).
 */
export const WA_KINDS = ['text', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'contact', 'poll', 'event'] as const;
export const WA_WEBHOOK_EVENTS = ['whatsapp.message.received', 'whatsapp.message.sent', 'whatsapp.message.transcribed', 'whatsapp.draft.sent', 'whatsapp.draft.discarded'] as const;

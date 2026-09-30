/** «Nueva llamada» con enlace: texto para compartir, WhatsApp/correo, validación del correo del invitado y bandeja limpia. */
import { describe, expect, it, vi } from 'vitest';

// i18n.ts marca el idioma en <html>: basta un documento mínimo (sin jsdom).
vi.hoisted(() => { (globalThis as any).document ??= { documentElement: {} }; });
import type { ConversationDTO } from '@tiecoms/contracts';
import { inviteText, mailtoHref, validGuestEmail, whatsappHref } from '../src/call-link.ts';
import { listedChat } from '../src/home-order.ts';
import { setLang } from '../src/i18n.ts';

const url = 'https://app.chaggu.com/llamada/AbCdEfGhIjKlMnOp1234';

describe('compartir el enlace', () => {
  it('texto sugerido en español e inglés', () => {
    setLang('es');
    expect(inviteText(url)).toBe(`Únete a mi llamada en chaggu: ${url}. Solo necesitas tu nombre y correo.`);
    setLang('en');
    expect(inviteText(url)).toBe(`Join my call on chaggu: ${url}. You only need your name and email.`);
    setLang('es');
  });
  it('WhatsApp y correo llevan el texto codificado', () => {
    const wa = whatsappHref(url);
    expect(wa.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(wa.slice('https://wa.me/?text='.length))).toBe(inviteText(url));
    const m = new URL(mailtoHref(url));
    expect(m.protocol).toBe('mailto:');
    expect(m.searchParams.get('subject')).toBe('Únete a mi llamada en chaggu');
    expect(m.searchParams.get('body')).toContain(url);
  });
});

describe('correo del invitado', () => {
  it('acepta correos normales (con mayúsculas y espacios)', () => {
    for (const e of ['laura@cliente.co', ' Laura.Cliente@Example.COM ', 'a+b@sub.dominio.com.co']) expect(validGuestEmail(e), e).toBe(true);
  });
  it('rechaza lo que no es correo', () => {
    for (const e of ['', 'laura', 'laura@', '@cliente.co', 'a@b', 'a b@c.com', 'a@b.c', `${'x'.repeat(250)}@a.co`]) expect(validGuestEmail(e), e).toBe(false);
  });
});

describe('la conversación de una «Nueva llamada» no ensucia la bandeja', () => {
  const conv = (over: Partial<ConversationDTO>) => ({ id: 'c', kind: 'multi', lastHumanPreview: null, ...over }) as ConversationDTO;
  it('sin mensajes de personas no sale; con uno sí; los chats normales siempre', () => {
    expect(listedChat(conv({ meeting: true }))).toBe(false);
    expect(listedChat(conv({ meeting: true, lastHumanPreview: { messageId: 'm', seq: 3, authorId: 'u', body: 'Notas', attachments: [], createdAt: '2026-09-30T10:00:00Z' } as any }))).toBe(true);
    expect(listedChat(conv({}))).toBe(true);
  });
});

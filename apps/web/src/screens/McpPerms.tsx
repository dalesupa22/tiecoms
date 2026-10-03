import { useEffect, useState } from 'react';
import type { WaAccountDTO } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { t } from '../i18n.ts';

/** Permisos del conector MCP (apps/api/src/modules/mcp.ts › SCOPES), en el orden en que se muestran. */
export const MCP_SCOPES = ['chats:read', 'chats:write', 'whatsapp:read', 'whatsapp:send', 'whatsapp:draft', 'email', 'tasks:read', 'tasks:write', 'calendar', 'reading'] as const;

export interface McpPermsValue { scopes: string[]; wa: 'shared' | string[] }

/** Mis números de WhatsApp (para elegir cuáles ve la IA). */
export function useWaAccounts() {
  const [accounts, setAccounts] = useState<WaAccountDTO[] | null>(null);
  useEffect(() => { client.request<{ accounts: WaAccountDTO[] }>('/whatsapp/accounts').then((r) => setAccounts(r.accounts)).catch(() => setAccounts([])); }, []);
  return accounts;
}

/** Casillas de permisos y de números de WhatsApp. «shared» = los números con «Compartir con integraciones». */
export function McpPermsPicker({ value, onChange, accounts }: { value: McpPermsValue; onChange: (v: McpPermsValue) => void; accounts: WaAccountDTO[] | null }) {
  const toggle = (s: string) => onChange({ ...value, scopes: value.scopes.includes(s) ? value.scopes.filter((x) => x !== s) : [...value.scopes, s] });
  const usesWa = value.scopes.some((s) => s.startsWith('whatsapp:'));
  const chosen = value.wa === 'shared' ? (accounts ?? []).filter((a) => a.integrationsEnabled).map((a) => a.id) : value.wa;
  const toggleWa = (id: string) => onChange({ ...value, wa: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] });
  return (
    <div className="mcp-perms">
      <div className="small muted" style={{ marginBottom: 6 }}>{t('mcpPerms.can')}</div>
      <div className="mcp-perms-grid">
        {MCP_SCOPES.map((s) => (
          <label key={s} className="small mcp-perm"><input type="checkbox" checked={value.scopes.includes(s)} onChange={() => toggle(s)} /> {t(`mcpPerms.${s}`)}</label>
        ))}
      </div>
      {usesWa && !!accounts?.length && (
        <>
          <div className="small muted" style={{ margin: '10px 0 6px' }}>{t('mcpPerms.waNumbers')}</div>
          {accounts.map((a) => (
            <label key={a.id} className="small mcp-perm" style={{ display: 'flex' }}>
              <input type="checkbox" checked={chosen.includes(a.id)} onChange={() => toggleWa(a.id)} />
              <span>&nbsp;{a.label} <span className="muted">· {a.kind === 'business' ? 'Business' : t('mcpPerms.personal')}{a.integrationsEnabled ? '' : ` · ${t('mcpPerms.notShared')}`}</span></span>
            </label>
          ))}
          <div className="hint">{t('mcpPerms.waHint')}</div>
        </>
      )}
    </div>
  );
}

/** Lo que va al API: null = todos los permisos; waAccountIds null = «los compartidos». */
export function permsPayload(v: McpPermsValue, accounts: WaAccountDTO[] | null) {
  const shared = (accounts ?? []).filter((a) => a.integrationsEnabled).map((a) => a.id).sort().join(',');
  const wa = v.wa === 'shared' || [...v.wa].sort().join(',') === shared ? null : v.wa;
  return { scopes: v.scopes.length === MCP_SCOPES.length ? null : v.scopes, waAccountIds: wa };
}

/** «Leyó 3 chats · envió 1» con lo que hizo hoy un token. */
export function todaySummary(today: { tool: string; n: number }[]) {
  const n = (pred: (tool: string) => boolean) => today.filter((x) => pred(x.tool)).reduce((a, x) => a + x.n, 0);
  const read = n((x) => x.startsWith('read_') || x.startsWith('list_') || x.startsWith('search_') || x.startsWith('get_') || x.startsWith('find_') || x === 'unread_summary');
  const sent = n((x) => x.startsWith('send_') || x === 'reply_email');
  const drafts = n((x) => x === 'create_whatsapp_draft');
  const parts = [read ? t('mcpPerms.todayRead', { n: read }) : '', sent ? t('mcpPerms.todaySent', { n: sent }) : '', drafts ? t('mcpPerms.todayDrafts', { n: drafts }) : ''].filter(Boolean);
  return parts.length ? `${t('mcpPerms.today')}: ${parts.join(' · ')}` : '';
}

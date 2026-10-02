// Pantalla «Agentes» (/agentes, docs/AGENTES.md): las IA de la empresa con dueño, grupos, tareas que han tomado y
// último uso. La administración crea agentes y entrega su token MCP; la administración o el dueño lo rotan o apagan.
import { useEffect, useState, type FormEvent } from 'react';
import type { AgentDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, getLang, locale } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { navigate } from '../router.ts';
import { Avatar, Modal, orgById } from '../ui.tsx';
import { openDialog } from '../actions.tsx';
import { IssueDrawer } from './Issues.tsx';

const L = (es: string, en: string) => (getLang() === 'en' ? en : es);
const STATUS: Record<string, [string, string]> = {
  open: ['Abierta', 'Open'], in_progress: ['En proceso', 'In progress'], waiting: ['En espera', 'Waiting'], done: ['Resuelta', 'Done'], cancelled: ['Cancelada', 'Cancelled'],
};

function ago(isoDate: string | null) {
  if (!isoDate) return L('nunca', 'never');
  const s = Math.max(0, (Date.now() - Date.parse(isoDate)) / 1000);
  if (s < 90) return L('hace un momento', 'just now');
  if (s < 3600) return L(`hace ${Math.round(s / 60)} min`, `${Math.round(s / 60)} min ago`);
  if (s < 86400) return L(`hace ${Math.round(s / 3600)} h`, `${Math.round(s / 3600)} h ago`);
  if (s < 86400 * 14) return L(`hace ${Math.round(s / 86400)} d`, `${Math.round(s / 86400)} d ago`);
  return new Date(isoDate).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

export function AgentsScreen() {
  const d = useClient((s) => s.data)!;
  const orgs = d.organizations.filter((o) => o.myRole);
  const [orgId, setOrgId] = useState<string | null>(d.me.primaryOrgId && orgs.some((o) => o.id === d.me.primaryOrgId) ? d.me.primaryOrgId : orgs[0]?.id ?? null);
  const [data, setData] = useState<{ agents: AgentDTO[]; canCreate: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const load = () => { if (orgId) client.listOrgAgents(orgId).then((r) => { setData(r); setError(null); }).catch((e) => setError(errorText(e))); };
  useEffect(load, [orgId]);
  const org = orgById(d, orgId);
  const list = (data?.agents ?? []).filter((a) => !q || `${a.name} ${a.title ?? ''} ${a.owner?.name ?? ''} ${a.groups.map((g) => g.name).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const totals = (data?.agents ?? []).reduce((t, a) => ({ open: t.open + a.tasks.open, done: t.done + a.tasks.done }), { open: 0, done: 0 });

  const create = () => orgId && openDialog((close) => <NewAgentDialog orgId={orgId} onClose={close} onCreated={load} />);
  const rotate = (a: AgentDTO) => {
    if (!orgId || !confirm(L(`¿Generar un token nuevo para @${a.name}? El actual deja de funcionar al instante.`, `Generate a new token for @${a.name}? The current one stops working right away.`))) return;
    client.rotateOrgAgentToken(orgId, a.id).then((r) => { load(); openDialog((close) => <TokenDialog name={a.name} token={r.token} onClose={close} />); }).catch((e) => toast(errorText(e)));
  };
  const disable = (a: AgentDTO) => {
    if (!orgId || !confirm(L(`¿Apagar a @${a.name}? Se revocan sus tokens y sale de la empresa. Sus mensajes y tareas quedan como historia.`, `Turn off @${a.name}? Its tokens are revoked. Its messages and tasks stay as history.`))) return;
    client.disableOrgAgent(orgId, a.id).then(() => { toast(L(`@${a.name} apagado`, `@${a.name} turned off`)); load(); }).catch((e) => toast(errorText(e)));
  };

  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 900 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div className="grow">
          <h1 style={{ marginBottom: 4 }}>{L('Agentes', 'Agents')}</h1>
          <div className="muted">{L('Las IA que trabajan con tu equipo. Cada una tiene dueño, entra a grupos como una persona y deja rastro de lo que toma y resuelve.', 'The AIs working with your team. Each has an owner, joins groups like a person and leaves a trail of what it takes on and resolves.')}</div>
        </div>
        {data?.canCreate && <button className="btn primary" onClick={create}>＋ {L('Nuevo agente', 'New agent')}</button>}
      </div>
      {orgs.length > 1 && (
        <div className="seg" style={{ margin: '14px 0 0', maxWidth: 520 }}>
          {orgs.map((o) => <button key={o.id} className={o.id === orgId ? 'on' : ''} onClick={() => setOrgId(o.id)}>{o.name}</button>)}
        </div>
      )}
      {data && data.agents.length > 0 && (
        <div className="agents-stats">
          <div><b>{data.agents.length}</b><span>{L('agentes', 'agents')}</span></div>
          <div><b>{totals.open}</b><span>{L('tareas abiertas', 'open tasks')}</span></div>
          <div><b>{totals.done}</b><span>{L('resueltas', 'resolved')}</span></div>
        </div>
      )}
      {data && data.agents.length > 3 && <input className="input" style={{ margin: '4px 0 14px' }} placeholder={L('Buscar agente, dueño o grupo', 'Search agent, owner or group')} value={q} onChange={(e) => setQ(e.target.value)} />}
      {error && <div className="error" style={{ marginTop: 14 }}>{error}</div>}
      {!data && !error && <div className="hint" style={{ marginTop: 14 }}>{L('Cargando…', 'Loading…')}</div>}
      {data && data.agents.length === 0 && (
        <div className="empty" style={{ marginTop: 18 }}>{L(`${org?.name ?? 'Tu empresa'} aún no tiene agentes.`, `${org?.name ?? 'Your company'} has no agents yet.`)}{data.canCreate ? ` ${L('Crea el primero y conéctalo por MCP.', 'Create the first one and connect it via MCP.')}` : ''}</div>
      )}
      <div className="agents-list">
        {list.map((a) => (
          <article key={a.id} className="card agent-card">
            <div className="agent-head">
              <Avatar person={{ id: a.id, name: a.name, kind: 'agent', orgId, title: a.title, area: a.area, guest: false, guestUntil: null, avatarUrl: a.avatarUrl }} size={46} />
              <div className="grow agent-who" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <b className="agent-name">@{a.name}</b>
                  <span className={`agent-state ${a.connected ? (a.lastUsedAt && Date.now() - Date.parse(a.lastUsedAt) < 86400e3 ? 'on' : 'idle') : 'off'}`}>
                    {a.connected ? (a.lastUsedAt ? `${L('Conectado', 'Connected')} · ${L('usado', 'used')} ${ago(a.lastUsedAt)}` : L('Token listo · sin usar aún', 'Token ready · not used yet')) : L('Sin token', 'No token')}
                  </span>
                  <span className={`agent-state ${a.webhook ? 'live' : ''}`} title={a.webhook
                    ? L(`Le avisamos al instante cuando le escriben, lo mencionan o le responden${a.webhook.allMessages ? ', y ante todo mensaje de sus grupos' : ''}.`, `Notified instantly on direct messages, mentions and replies${a.webhook.allMessages ? ', and on every message in its groups' : ''}.`)
                    : L('Sin webhook: revisa sus mensajes por MCP cada cierto tiempo.', 'No webhook: it checks its messages via MCP periodically.')}>
                    {a.webhook ? `⚡ ${L('Responde al instante', 'Replies instantly')}${a.webhook.allMessages ? ` · ${L('todo', 'all')}` : ''}` : L('Sin aviso inmediato', 'No instant alerts')}
                  </span>
                </div>
                <div className="small muted ellipsis">{[a.title, a.owner ? `${L('Dueño', 'Owner')}: ${a.owner.name}` : null, `${L('desde', 'since')} ${new Date(a.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })}`].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="row agent-actions" style={{ gap: 6 }}>
                <button className="btn small" onClick={() => client.openDirect(a.id).then((r) => navigate(`/c/${r.id}`)).catch((e) => toast(errorText(e)))}>✉ {L('Escribir', 'Message')}</button>
                {a.canManage && <button className="btn small ghost" onClick={() => rotate(a)} title={L('Generar token nuevo', 'New token')}>⟳ Token</button>}
                {a.canManage && <button className="btn small ghost agent-off" onClick={() => disable(a)}>{L('Apagar', 'Turn off')}</button>}
              </div>
            </div>
            {a.canManage && a.webhook && (
              <div className="small muted">
                Webhook: <span className="mono">{a.webhook.host ?? '—'}</span>
                {' · '}{a.webhook.pending ? <b style={{ color: 'var(--danger)' }}>{a.webhook.pending} {L('avisos sin entregar', 'undelivered')}</b> : L('todo entregado', 'all delivered')}
                {a.webhook.lastDeliveredAt ? ` · ${L('último aviso', 'last alert')} ${ago(a.webhook.lastDeliveredAt)}` : ''}
              </div>
            )}
            <div className="agent-meta">
              <div>
                <div className="eyebrow">{L('Grupos', 'Groups')}</div>
                <div className="agent-chips">
                  {a.groups.map((g) => <button key={g.id} className="tag agent-chip" onClick={() => navigate(`/c/${g.id}`)}># {g.name ?? L('grupo', 'group')}</button>)}
                  {a.hiddenGroups > 0 && <span className="tag muted">+{a.hiddenGroups} {L('que no ves', 'you cannot see')}</span>}
                  {a.groups.length === 0 && a.hiddenGroups === 0 && <span className="small muted">{L('Ninguno todavía', 'None yet')}</span>}
                </div>
              </div>
              <div>
                <div className="eyebrow">{L('Tareas', 'Tasks')}</div>
                <div className="small"><b>{a.tasks.open}</b> {L('abiertas', 'open')} · <b>{a.tasks.done}</b> {L('resueltas', 'resolved')}</div>
              </div>
            </div>
            {a.tasks.recent.length > 0 && (
              <div className="agent-tasks">
                {a.tasks.recent.map((tk) => (
                  <button key={tk.id} className="agent-task" onClick={() => setOpenIssue(tk.id)}>
                    <span className={`agent-task-status s-${tk.status}`}>{L(...(STATUS[tk.status] ?? [tk.status, tk.status]))}</span>
                    <span className="grow ellipsis">{tk.title}</span>
                    <span className="small muted agent-task-where">{tk.chat ? `# ${tk.chat} · ` : ''}{ago(tk.updatedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {openIssue && <IssueDrawer id={openIssue} onClose={() => { setOpenIssue(null); load(); }} />}
    </div></div>
  );
}

function NewAgentDialog({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: () => void }) {
  const d = useClient((s) => s.data)!;
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; token: string; failed: string[] } | null>(null);
  // Grupos que yo administro: ahí puedo sumar al agente.
  const groups = d.conversations.filter((c) => (c.kind === 'group' || c.kind === 'internal') && c.canManage).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await client.createOrgAgent(orgId, { name, title: title || undefined, conversationIds: [...picked] });
      onCreated();
      setMade({ name: r.name, token: r.token, failed: r.groups.filter((g) => !g.ok).map((g) => groups.find((c) => c.id === g.id)?.name ?? g.id) });
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  if (made) return <TokenDialog name={made.name} token={made.token} failed={made.failed} onClose={onClose} />;
  return (
    <Modal title={L('Nuevo agente', 'New agent')} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{L('Un agente es una IA que vive afuera (Claude, Codex, el servidor de tu CRM…) y entra a chaggu como miembro, con su propio token. Tú quedas de dueño.', 'An agent is an AI that lives elsewhere (Claude, Codex, your CRM server…) and joins chaggu as a member with its own token. You become its owner.')}</p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{L('Nombre (así lo mencionan: @nombre)', 'Name (mention as @name)')}</span><input className="input" required minLength={2} maxLength={40} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="claude" /></label>
        <label className="field"><span>{L('Qué hace', 'What it does')}</span><input className="input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L('Agente de soporte y desarrollo', 'Support and development agent')} /></label>
        <div className="field"><span>{L('Grupos donde entra', 'Groups it joins')}</span>
          <div className="agent-pick">
            {groups.length === 0 && <span className="small muted">{L('No administras grupos; puedes sumarlo después desde cada grupo.', 'You do not manage any group; add it later from each group.')}</span>}
            {groups.map((c) => (
              <label key={c.id} className="check"><input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} /> # {c.name}</label>
            ))}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{L('Cancelar', 'Cancel')}</button><button className="btn primary" disabled={busy || name.trim().length < 2}>{busy ? L('Creando…', 'Creating…') : L('Crear agente', 'Create agent')}</button></div>
      </form>
    </Modal>
  );
}

function TokenDialog({ name, token, failed = [], onClose }: { name: string; token: string; failed?: string[]; onClose: () => void }) {
  const endpoint = `${location.origin}/api/mcp`;
  const cmd = `claude mcp add --transport http chaggu-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')} ${endpoint} --header "Authorization: Bearer ${token}"`;
  const copy = (s: string) => void copyText(s).then(() => toast(L('Copiado', 'Copied')));
  return (
    <Modal title={L(`Token de @${name}`, `@${name} token`)} onClose={onClose}>
      <p style={{ margin: 0 }}>{L('Guárdalo ya: solo se muestra esta vez. Con él, el agente ve y escribe solo en los grupos donde está.', 'Save it now: it is shown only once. With it the agent sees and writes only in the groups it belongs to.')}</p>
      {failed.length > 0 && <div className="error">{L('No se pudo sumar a', 'Could not add to')}: {failed.join(', ')}</div>}
      <div className="field"><span>Token MCP</span><div className="linkbox"><input className="input mono" readOnly value={token} onFocus={(e) => e.currentTarget.select()} /><button type="button" className="btn" onClick={() => copy(token)}>{L('Copiar', 'Copy')}</button></div></div>
      <div className="field"><span>{L('Servidor MCP', 'MCP server')}</span><div className="linkbox"><input className="input mono" readOnly value={endpoint} /><button type="button" className="btn" onClick={() => copy(endpoint)}>{L('Copiar', 'Copy')}</button></div></div>
      <div className="field"><span>{L('Para Claude Code', 'For Claude Code')}</span><div className="linkbox"><input className="input mono" readOnly value={cmd} onFocus={(e) => e.currentTarget.select()} /><button type="button" className="btn" onClick={() => copy(cmd)}>{L('Copiar', 'Copy')}</button></div></div>
      <div className="modal-actions"><button className="btn primary" onClick={onClose}>{L('Listo, lo guardé', 'Done, I saved it')}</button></div>
    </Modal>
  );
}

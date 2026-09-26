import { useEffect, useState, type FormEvent } from 'react';
import type { BootstrapDTO, ConversationDTO, DeriveKind, MessageDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { navigate } from '../router.ts';
import { Modal, OrgMark, conversationTitle, orgById, personById } from '../ui.tsx';

const KIND_TONE: Record<DeriveKind, string> = { same: 'k-same', internal: 'k-internal', directive: 'k-directive', side: 'k-side' };

export function KindBadge({ kind }: { kind: DeriveKind | null }) {
  if (!kind) return null;
  return <span className={`kind-badge ${KIND_TONE[kind]}`}>{t(`lin.kind.${kind}`)}</span>;
}

/** Empresas que realmente participan en una conversación (según sus miembros). */
function orgsIn(d: BootstrapDTO, c: ConversationDTO) {
  return [...new Set(c.memberIds.map((id) => personById(d, id)?.orgId).filter(Boolean))].map((o) => orgById(d, o as string)).filter(Boolean);
}

export function DeriveDialog({ conv, message, onClose }: { conv: ConversationDTO; message: MessageDTO; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const myOrg = orgById(d, d.me.primaryOrgId);
  const excerpt = message.body.replace(/\s+/g, ' ').trim();
  const short = excerpt.length > 40 ? `${excerpt.slice(0, 40).replace(/\s+\S*$/, '')}…` : excerpt;
  const [kind, setKind] = useState<Exclude<DeriveKind, 'side'>>('same');
  const [name, setName] = useState(`${t('derive.prefix.same')} · ${short}`);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (k: Exclude<DeriveKind, 'side'>) => { setKind(k); setName(`${t(`derive.prefix.${k}`)} · ${short}`); };
  const options: [Exclude<DeriveKind, 'side'>, string, string][] = [
    ['same', t('derive.same'), t('derive.sameNote')],
    ['internal', t('derive.internal', { org: myOrg?.name ?? '' }), t('derive.internalNote')],
    ['directive', t('derive.directive'), t('derive.directiveNote')],
  ];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await client.derive(conv.id, { messageId: message.id, kind, name, reason: reason || undefined });
      onClose();
      navigate(`/c/${r.id}`);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('derive.title')} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{t('derive.body')}</p>
      <blockquote className="derive-quote">“{excerpt.slice(0, 220)}”</blockquote>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="list">
          {options.map(([k, label, note]) => (
            <label key={k} className={`check derive-opt ${kind === k ? 'is-on' : ''}`}>
              <input type="radio" name="kind" checked={kind === k} onChange={() => pick(k)} />
              <span className="grow"><b>{label}</b><span className="small muted" style={{ display: 'block' }}>{note}</span></span>
            </label>
          ))}
        </div>
        <label className="field"><span>{t('derive.name')}</span><input className="input" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>{t('derive.reason')}</span><input className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy}>{t('derive.create')}</button></div>
      </form>
    </Modal>
  );
}

function ReturnDialog({ conv, parentName, onClose }: { conv: ConversationDTO; parentName: string; onClose: () => void }) {
  const d = useClient((s) => s.data)!;
  const local = useClient((s) => s.conversations[conv.id]);
  const lastText = [...(local?.messages ?? [])].reverse().find((m) => m.kind === 'text' && !m.deletedAt)?.body ?? '';
  const side = conv.deriveKind === 'side';
  const [summary, setSummary] = useState(side ? '' : lastText);
  const [source, setSource] = useState<'ai' | 'fallback' | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // La apertura solo obtiene el respaldo local. La IA necesita una acción explícita.
  useEffect(() => {
    if (!side) return;
    let alive = true;
    client.request<{ summary: string; source: 'ai' | 'fallback' }>(`/conversations/${conv.id}/return/suggest`, { method: 'POST', json: { aiConsent: false } })
      .then((r) => { if (alive) { setSummary((s) => s || r.summary); setSource(r.source); } })
      .catch(() => { if (alive) { setSummary((s) => s || lastText); setSource('fallback'); } });
    return () => { alive = false; };
  }, [conv.id]);
  async function suggestWithAi() {
    setAiBusy(true); setError(null);
    try {
      const r = await client.request<{ summary: string; source: 'ai' | 'fallback' }>(`/conversations/${conv.id}/return/suggest`, { method: 'POST', json: { aiConsent: true } });
      setSummary(r.summary); setSource(r.source);
    } catch (e) { setError(errorText(e)); } finally { setAiBusy(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await client.returnResult(conv.id, summary);
      onClose();
      const parent = client.getState().data?.conversations.find((c) => c.id === r.parentId);
      navigate(`/c/${r.parentId}${parent ? `?m=${parent.lastMessageSeq}` : ''}`);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={conv.deriveKind === 'side' ? t('side.return') : t('lin.returnTitle')} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{conv.deriveKind === 'side' ? t('side.returnBody', { name: parentName }) : t('lin.returnBody', { name: parentName })}</p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {side && <div className="card" style={{ padding: 10 }}>
          <p className="small" style={{ marginTop: 0 }}>{t('ai.sideDisclosure')}</p>
          <button type="button" className="btn small" disabled={busy || aiBusy || source === null} onClick={() => void suggestWithAi()}>{aiBusy ? t('side.suggesting') : t('ai.allowSummary')}</button>
        </div>}
        {side && <div className="small muted">{source === null ? t('side.suggesting') : source === 'ai' ? `✨ ${t('side.suggested')} · ${t('side.returnEdit')}` : `${t('side.suggestedFallback')} · ${t('side.returnEdit')}`}</div>}
        <textarea className="input" rows={5} disabled={aiBusy} required minLength={2} maxLength={4000} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={side && source === null ? t('side.suggesting') : undefined} />
        {side && summary.trim() && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{t('side.previewInGroup')}</div>
            <div className="card" style={{ padding: 10 }}>
              <div className="merged-card"><span>↩ {t('side.fromSidechat')}</span></div>
              <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}><b>{d.me.name}</b> · {summary.trim()}</div>
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={busy || aiBusy || summary.trim().length < 2}>{side ? t('side.publish') : t('lin.returnSend')}</button></div>
      </form>
    </Modal>
  );
}

/** Barra de linaje: de dónde viene, en qué derivó, y devolver el resultado. */
export function LineageBar({ conv }: { conv: ConversationDTO }) {
  const d = useClient((s) => s.data)!;
  const [returning, setReturning] = useState(false);
  const parent = conv.parentId ? d.conversations.find((c) => c.id === conv.parentId) : null;
  // Las laterales son privadas y se ven como chip bajo su mensaje ancla, no aquí.
  const kids = d.conversations.filter((c) => c.parentId === conv.id && c.deriveKind !== 'side');
  if (!conv.parentId && !kids.length) return null;
  return (
    <div className="lineage">
      <span className="eyebrow">{t('lin.label')}</span>
      {conv.parentId && (parent
        ? <button className="lin-chip" onClick={() => navigate(`/c/${parent.id}${conv.parentMessageSeq ? `?m=${conv.parentMessageSeq}` : ''}`)}>↖ {t('lin.from')} «{conversationTitle(d, parent)}»</button>
        : <span className="lin-chip is-muted">↖ {t('lin.fromHidden')}</span>)}
      {conv.deriveKind && <KindBadge kind={conv.deriveKind} />}
      {kids.length > 0 && <span className="small muted">{t('lin.kids')}</span>}
      {kids.map((k) => (
        <button key={k.id} className="lin-chip" onClick={() => navigate(`/c/${k.id}`)}>⑂ {conversationTitle(d, k)}{k.returnedAt ? ' ✓' : ''}</button>
      ))}
      <span className="grow" />
      {conv.returnedAt && <span className="lin-done">✓ {t('lin.returned')}</span>}
      {conv.parentId && parent && !conv.returnedAt && conv.canPost && (
        <button className="btn primary small" onClick={() => setReturning(true)}>{conv.deriveKind === 'side' ? `↩ ${t('side.return')}` : t('lin.return')}</button>
      )}
      <button className="btn ghost small" onClick={() => navigate('/trazo')}>{t('lin.trazo')}</button>
      {returning && parent && <ReturnDialog conv={conv} parentName={conversationTitle(d, parent)} onClose={() => setReturning(false)} />}
    </div>
  );
}

/** Tarjeta del mensaje que trae de vuelta el resultado de una derivada. */
export function MergedCard({ childId, kind }: { childId: string; kind?: DeriveKind | null }) {
  const d = useClient((s) => s.data)!;
  const child = d.conversations.find((c) => c.id === childId);
  const side = kind === 'side' || child?.deriveKind === 'side';
  return (
    <div className={`merged-card ${side ? 'is-side' : ''}`}>
      <span>↩ {side ? t('side.fromSidechat') : child ? t('lin.resultOf', { name: conversationTitle(d, child) }) : t('lin.resultHidden')}</span>
      {child && <button className="btn ghost small" onClick={() => navigate(`/c/${child.id}`)}>{t('lin.open')}</button>}
    </div>
  );
}

// ---------- Trazo ----------
interface Node { c: ConversationDTO; depth: number }

export function TrazoScreen() {
  const d = useClient((s) => s.data)!;
  const convs = d.conversations.filter((c) => c.kind !== 'direct');
  const byId = new Map(convs.map((c) => [c.id, c]));
  const kidsOf = (id: string) => convs.filter((c) => c.parentId === id).sort((a, b) => (a.lastMessageAt ?? '').localeCompare(b.lastMessageAt ?? ''));
  // Raíz: tiene derivadas visibles y su origen no existe o no es visible.
  const roots = convs.filter((c) => kidsOf(c.id).length > 0 && (!c.parentId || !byId.has(c.parentId)))
    .concat(convs.filter((c) => c.parentId && !byId.has(c.parentId) && kidsOf(c.id).length === 0));
  const chains = roots.map((root) => {
    const nodes: Node[] = [];
    const walk = (c: ConversationDTO, depth: number) => { nodes.push({ c, depth }); kidsOf(c.id).forEach((k) => walk(k, depth + 1)); };
    walk(root, 0);
    const orgs = [...new Map(nodes.flatMap((n) => orgsIn(d, n.c)).map((o) => [o!.id, o])).values()];
    return { root, nodes, orgs };
  });

  return (
    <div className="page"><div className="page-narrow" style={{ maxWidth: 960 }}>
      <h1>{t('nav.trazo')}</h1>
      <div className="muted" style={{ maxWidth: 720 }}>{t('trazo.sub')}</div>
      {chains.length === 0 && <div className="empty" style={{ marginTop: 20 }}>{t('trazo.empty')}</div>}
      <div className="list" style={{ marginTop: 20, gap: 16 }}>
        {chains.map(({ root, nodes, orgs }) => (
          <section key={root.id} className="card trazo-chain">
            <header className="row" style={{ flexWrap: 'wrap' }}>
              <b style={{ fontSize: 16 }}>{conversationTitle(d, root)}</b>
              <span className="small muted">{d.workspaces.find((w) => w.id === root.workspaceId)?.name}</span>
              <span className="grow" />
              <span className="small muted">{t('trazo.tramos', { n: nodes.length })}</span>
              <span className="row" style={{ gap: 4 }} title={t('trazo.companies')}>{orgs.map((o) => <OrgMark key={o!.id} org={o} size={20} />)}</span>
            </header>
            <div className="trazo-nodes">
              {nodes.map(({ c, depth }) => (
                <div key={c.id} className="trazo-row" style={{ marginLeft: depth * 28 }}>
                  {depth > 0 && <span className="trazo-rail" aria-hidden="true" />}
                  <button className={`trazo-node ${c.returnedAt ? 'is-back' : c.parentId ? 'is-open' : ''}`} onClick={() => navigate(`/c/${c.id}`)}>
                    <span className="row" style={{ gap: 8 }}>
                      <b className="ellipsis grow">{conversationTitle(d, c)}</b>
                      <KindBadge kind={c.deriveKind} />
                      {c.parentId && (c.returnedAt
                        ? <span className="lin-done">↩ {t('trazo.returnedOn', { date: new Date(c.returnedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) })}</span>
                        : <span className="lin-open">● {t('trazo.open')}</span>)}
                    </span>
                    {c.deriveReason && <span className="small muted" style={{ display: 'block' }}>{c.deriveReason}</span>}
                    <span className="row" style={{ gap: 4, marginTop: 6 }}>
                      {orgsIn(d, c).map((o) => <OrgMark key={o!.id} org={o} size={18} />)}
                      <span className="small muted">· {c.memberIds.length}</span>
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div></div>
  );
}

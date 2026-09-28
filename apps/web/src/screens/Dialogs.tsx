import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { client, useClient } from '../app-client.ts';
import { BASE, navigate } from '../router.ts';
import { Avatar, Modal, conversationTitle, orgById } from '../ui.tsx';
import { errorText, getLang, locale, t } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { addCandidates, cachedLink, filterPeople, inviteCall, inviteOptions, isEmail, linkKey, pendingForGroup, rememberLink, type CachedLink, type InviteKind } from '../add-invite.ts';
import { InviteResult, PendingInvitations } from './Invitations.tsx';

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e: any) {
      setError(errorText(e));
    } finally { setBusy(false); }
  }
  return { busy, error, run };
}

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const s = useSubmit();
  const submit = (e: FormEvent) => { e.preventDefault(); void s.run(async () => {
    const r = await client.createWorkspace({ name, department: department || undefined });
    onClose();
    navigate(`/w/${r.id}`);
  }); };
  return (
    <Modal title={t('dlg.newSpace')} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{t('dlg.newSpaceBody')}</p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{t('dlg.spaceName')}</span><input className="input" required minLength={2} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('dlg.spaceNamePh')} /></label>
        <label className="field"><span>{t('dlg.department')}</span><input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder={t('dlg.departmentPh')} /></label>
        {s.error && <div className="error">{s.error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={s.busy}>{t('dlg.createSpace')}</button></div>
      </form>
    </Modal>
  );
}

export function NewGroupDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const d = useClient((st) => st.data)!;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'group' | 'internal'>('group');
  const [level, setLevel] = useState<'operativo' | 'directivo'>('operativo');
  const [picked, setPicked] = useState<string[]>([]);
  const s = useSubmit();
  const ids = new Set(d.workspaces.find((w) => w.id === workspaceId)?.memberIds ?? []);
  let candidates = d.people.filter((p) => ids.has(p.id) && p.id !== d.me.id);
  if (kind === 'internal') candidates = candidates.filter((p) => p.orgId === d.me.primaryOrgId);
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const submit = (e: FormEvent) => { e.preventDefault(); void s.run(async () => {
    const r = await client.createConversation(workspaceId, { name, kind, level: kind === 'group' ? level : null, memberIds: picked.filter((p) => candidates.some((c) => c.id === p)) });
    onClose();
    navigate(`/c/${r.id}`);
  }); };
  return (
    <Modal title={t('dlg.newGroup')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>{t('dlg.name')}</span><input className="input" required minLength={2} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="seg">
          <button type="button" className={kind === 'group' ? 'on' : ''} onClick={() => setKind('group')}>{t('dlg.shared')}</button>
          <button type="button" className={kind === 'internal' ? 'on' : ''} onClick={() => setKind('internal')}>{t('dlg.internal')}</button>
        </div>
        {kind === 'group' && (
          <div className="seg">
            <button type="button" className={level === 'operativo' ? 'on' : ''} onClick={() => setLevel('operativo')}>{t('kind.operativo')}</button>
            <button type="button" className={level === 'directivo' ? 'on' : ''} onClick={() => setLevel('directivo')}>{t('kind.directivo')}</button>
          </div>
        )}
        <div className="eyebrow">{t('dlg.participants')}</div>
        {candidates.length === 0 && <div className="hint">{t('dlg.noCandidates')}</div>}
        <div className="list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {candidates.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
              <Avatar person={p} org={orgById(d, p.orgId)} size={28} />
              <span className="grow"><b>{p.name}</b><span className="small muted"> · {[p.title, p.area, orgById(d, p.orgId)?.name ?? t('common.guest')].filter(Boolean).join(' · ')}</span></span>
            </label>
          ))}
        </div>
        <div className="hint">{t('dlg.groupHint')}</div>
        {s.error && <div className="error">{s.error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={s.busy}>{t('dlg.createGroup')}</button></div>
      </form>
    </Modal>
  );
}

export function InviteDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const d = useClient((st) => st.data)!;
  const groups = d.conversations.filter((c) => c.workspaceId === workspaceId && c.kind === 'group');
  const general = groups.find((g) => g.name === 'General');
  const [role, setRole] = useState<'member' | 'guest'>('member');
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<string[]>(general ? [general.id] : []);
  const [until, setUntil] = useState('');
  const [history, setHistory] = useState<'now' | 'all'>('now');
  const [link, setLink] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);
  const s = useSubmit();
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const submit = (e: FormEvent) => { e.preventDefault(); void s.run(async () => {
    const r = await client.createInvitation(workspaceId, {
      email: email.trim(), role, conversationIds: picked, history,
      accessUntil: role === 'guest' && until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
      lang: getLang(),
    });
    setEmailSent(r.emailSent);
    setLink(`${location.origin}${BASE}/invite/${encodeURIComponent(r.token)}`);
  }); };

  if (link) {
    return (
      <Modal title={emailSent ? t('dlg.inviteSent') : t('dlg.linkReady')} onClose={onClose}>
        <InviteResult email={email.trim()} emailSent={emailSent} link={link} />
        <div className="modal-actions">
          <button className="btn" onClick={() => { setLink(null); setEmail(''); }}>{t('dlg.inviteAnother')}</button>
          <button className="btn primary" onClick={onClose}>{t('common.done')}</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('dlg.invite')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="seg">
          <button type="button" className={role === 'member' ? 'on' : ''} onClick={() => setRole('member')}>{t('dlg.fromCompany')}</button>
          <button type="button" className={role === 'guest' ? 'on' : ''} onClick={() => setRole('guest')}>{t('dlg.thirdParty')}</button>
        </div>
        <div className="hint">{role === 'member' ? t('dlg.memberHint') : t('dlg.guestHint')}</div>
        <label className="field"><span>{t('dlg.emailReq')}</span><input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('dlg.emailPh')} /></label>
        {role === 'guest' && <label className="field"><span>{t('dlg.leaveDate')}</span><input className="input" type="date" required value={until} onChange={(e) => setUntil(e.target.value)} min={new Date().toISOString().slice(0, 10)} /></label>}
        <div className="eyebrow">{t('dlg.groupsJoin')}</div>
        <div className="list">
          {groups.map((g) => (
            <label key={g.id} className="check"><input type="checkbox" checked={picked.includes(g.id)} onChange={() => toggle(g.id)} /><span className="grow">{g.name}</span>{g.level === 'directivo' && <span className="tag">{t('kind.directivo')}</span>}</label>
          ))}
        </div>
        <div className="seg">
          <button type="button" className={history === 'now' ? 'on' : ''} onClick={() => setHistory('now')}>{t('dlg.seeNew')}</button>
          <button type="button" className={history === 'all' ? 'on' : ''} onClick={() => setHistory('all')}>{t('dlg.seeHistory')}</button>
        </div>
        {s.error && <div className="error">{s.error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={s.busy || !email.trim() || (role === 'guest' && !picked.length)}>{s.busy ? t('common.wait') : t('dlg.sendInvite')}</button></div>
      </form>
      <PendingInvitations scope="workspaces" id={workspaceId} />
    </Modal>
  );
}

/**
 * «Agregar al grupo»: buscador, candidatos con casilla y, abajo, invitar a alguien nuevo por correo o
 * con enlace y código (colega de mi empresa, persona de la otra empresa o tercero). docs/GRUPOS.md, 28-sep-2026.
 */
export function AddMembersDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const d = useClient((st) => st.data)!;
  const conv = d.conversations.find((c) => c.id === conversationId)!;
  const opts = useMemo(() => inviteOptions(d, conv), [d, conv]);
  const orgName = (id: string | null) => (id ? orgById(d, id)?.name : undefined);
  const all = addCandidates(d, conv);
  const [query, setQuery] = useState('');
  const [emailHint, setEmailHint] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<'now' | 'all'>('now');
  const [kindKey, setKindKey] = useState<string | null>(opts.initial);
  const [sent, setSent] = useState<Record<string, { ok: boolean; link: string }>>({});
  const [link, setLink] = useState<CachedLink | null>(null);
  const [reload, setReload] = useState(0);
  const s = useSubmit();
  const inv = useSubmit();
  const search = useRef<HTMLInputElement>(null);
  const candidates = filterPeople(all, query, orgName);
  const q = query.trim().toLowerCase();
  const emailRow = isEmail(q) && candidates.length === 0;
  const kind = opts.kinds.find((k) => k.key === kindKey) ?? null;
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const kindLabel = (k: InviteKind) => (k.key === 'guest' ? t('add.guest') : t('add.from', { name: (k as { name: string }).name }));
  const kindHint = (k: InviteKind) => (k.key === 'mine' ? t('add.hintMine', { org: (k as { name: string }).name })
    : k.key === 'guest' ? t('add.hintGuest') : t('add.hintOther', { org: (k as { name: string }).name }));
  const groupName = conversationTitle(d, conv);
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });

  const create = (how: { email: string } | { link: true }) => {
    const c = inviteCall(kind!, opts.workspaceId!, conv.id, history, getLang(), how);
    return c.scope === 'organizations' ? client.createOrgInvitation(c.id, c.body) : client.createInvitation(c.id, c.body);
  };
  const sendEmail = () => void inv.run(async () => {
    const r = await create({ email: q });
    setSent((x) => ({ ...x, [q]: { ok: r.emailSent, link: r.url ?? '' } }));
    setReload((n) => n + 1);
  });
  const copyLink = () => void inv.run(async () => {
    const key = linkKey(kind!.key, conv.id, history);
    let l = cachedLink(key);
    if (!l) {
      const r = await create({ link: true });
      l = { url: r.url ?? '', code: r.code ?? null, expiresAt: r.expiresAt };
      rememberLink(key, l);
    }
    await copyText(l.code ? t('share.text', { name: groupName, url: l.url, code: l.code }) : t('share.textNoCode', { name: groupName, url: l.url }));
    setLink(l);
  });
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && 'share' in navigator;

  return (
    <Modal title={t('dlg.addToGroup')} onClose={onClose}>
      <div className="search-field" style={{ marginTop: 0 }}>
        <input ref={search} className="grow" type="search" autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setLink(null); }}
          placeholder={emailHint ? t('add.searchEmail') : t('add.search')} aria-label={t('add.search')} />
        {query && <button className="search-clear" aria-label={t('common.close')} onClick={() => { setQuery(''); search.current?.focus(); }}>×</button>}
      </div>
      {emailRow && opts.canInvite && kind && (
        <div className="invite-row">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="grow" style={{ minWidth: 0, wordBreak: 'break-all' }}>✉ <b>{t('add.inviteEmail', { email: q })}</b></span>
            {sent[q] ? <span className="tag">{t('add.pendingTag')}</span>
              : <button className="btn primary small" disabled={inv.busy} onClick={sendEmail}>{inv.busy ? t('common.wait') : t('add.send')}</button>}
          </div>
          {!sent[q] && (
            <label className="field" style={{ gap: 4 }}><span className="small muted">{t('add.type')}</span>
              <select className="input" value={kind.key} onChange={(e) => setKindKey(e.target.value)}>
                {opts.kinds.map((k) => <option key={k.key} value={k.key}>{kindLabel(k)}</option>)}
              </select>
            </label>
          )}
          {sent[q] && (sent[q].ok ? <div className="small"><b>{t('add.sent', { email: q })}</b></div> : <div className="error">{t('dlg.emailFailed', { email: q })}</div>)}
        </div>
      )}
      {!emailRow && query.trim() && candidates.length === 0 && all.length > 0 && <div className="hint">{t('add.noMatch')}</div>}
      {candidates.length > 0 && (
        <div className="list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {candidates.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
              <Avatar person={p} org={orgById(d, p.orgId)} size={28} />
              <span className="grow"><b>{p.name}</b><span className="small muted"> · {p.guest ? t('common.guest') : orgById(d, p.orgId)?.name ?? t('common.guest')}</span></span>
            </label>
          ))}
        </div>
      )}
      <div className="seg" style={{ display: 'flex' }}>
        <button className={history === 'now' ? 'on' : ''} onClick={() => { setHistory('now'); setLink(null); }}>{t('dlg.seeNewPl')}</button>
        <button className={history === 'all' ? 'on' : ''} onClick={() => { setHistory('all'); setLink(null); }}>{t('dlg.seeHistoryPl')}</button>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      {all.length > 0 && (
        <div className="modal-actions" style={{ marginTop: 0 }}>
          <button className="btn primary" disabled={!picked.length || s.busy} onClick={() => void s.run(async () => { await client.addMembers(conversationId, picked, history); onClose(); })}>
            {picked.length ? t('add.addN', { n: picked.length }) : t('dlg.add')}
          </button>
        </div>
      )}
      {conv.kind !== 'multi' && (
        <section className="add-invite">
          <div className="eyebrow">{t('add.newTitle')}</div>
          {!opts.canInvite && <div className="hint">{t('add.onlyMembers')}</div>}
          {opts.canInvite && (
            <>
              <div className="kind-chips" role="radiogroup" aria-label={t('add.type')}>
                {opts.kinds.map((k) => (
                  <button key={k.key} role="radio" aria-checked={k.key === kindKey} className={`kind-chip${k.key === kindKey ? ' on' : ''}`}
                    onClick={() => { setKindKey(k.key); setLink(null); }}>{kindLabel(k)}</button>
                ))}
              </div>
              {kind && <span className="hint">{kindHint(kind)}</span>}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => { setEmailHint(true); search.current?.focus(); }}>✉ {t('add.byEmail')}</button>
                <button className="btn" disabled={inv.busy || !kind} onClick={copyLink}>🔗 {t('add.copyLink')}</button>
                {touch && link && <button className="btn" onClick={() => navigator.share({ title: 'chaggu', text: link.code ? t('share.text', { name: groupName, url: link.url, code: link.code }) : link.url }).catch(() => {})}>{t('add.share')}</button>}
              </div>
              {link && (
                <div className="link-done">
                  <b>{t('add.copied', { date: date(link.expiresAt) })}</b>
                  {link.code && (
                    <span className="small muted row" style={{ gap: 6, alignItems: 'center' }}>{t('add.code', { code: link.code })}
                      <button className="btn ghost small" onClick={async () => { await copyText(link.code!); toast(t('share.codeCopied')); }}>{t('share.copyCode')}</button>
                    </span>
                  )}
                </div>
              )}
              {inv.error && <div className="error">{inv.error}</div>}
              <GroupPendingInvites conversationId={conv.id} workspaceId={opts.workspaceId!} orgId={opts.kinds.find((k) => k.key === 'mine') ? (opts.kinds.find((k) => k.key === 'mine') as { orgId: string }).orgId : null} reload={reload} />
            </>
          )}
        </section>
      )}
    </Modal>
  );
}

/** «Invitaciones pendientes (N)», plegado: las de este grupo, de la empresa y del espacio, con Reenviar y Anular. */
function GroupPendingInvites({ conversationId, workspaceId, orgId, reload }: { conversationId: string; workspaceId: string; orgId: string | null; reload: number }) {
  const [items, setItems] = useState<ReturnType<typeof pendingForGroup>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  const load = async () => {
    const lists = await Promise.all([
      client.listInvitations('workspaces', workspaceId).then((items) => ({ scope: 'workspaces' as const, id: workspaceId, items })).catch(() => null),
      orgId ? client.listInvitations('organizations', orgId).then((items) => ({ scope: 'organizations' as const, id: orgId, items })).catch(() => null) : null,
    ]);
    setItems(pendingForGroup(conversationId, lists.filter((l) => !!l) as NonNullable<(typeof lists)[number]>[]));
  };
  useEffect(() => { void load(); }, [conversationId, workspaceId, orgId, reload]);
  if (!items.length) return null;
  const act = async (inv: (typeof items)[number], what: 'resend' | 'revoke') => {
    if (what === 'revoke' && !confirm(t('inv.revokeConfirm', { email: inv.email }))) return;
    setBusy(inv.id); setNote(null);
    try {
      if (what === 'resend') {
        const r = await client.resendInvitation(inv.scope, inv.scopeId, inv.id);
        setNote(r.emailSent ? { id: inv.id, text: t('inv.resent') } : { id: inv.id, text: t('dlg.emailFailed', { email: inv.email }), bad: true });
      } else await client.revokeInvitation(inv.scope, inv.scopeId, inv.id);
      await load();
    } catch (e) { setNote({ id: inv.id, text: errorText(e), bad: true }); } finally { setBusy(null); }
  };
  return (
    <details className="pending-invites">
      <summary>{t('add.pendingN', { n: items.length })}</summary>
      <div className="list">
        {items.map((inv) => (
          <div key={inv.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="grow" style={{ minWidth: 0 }}><b style={{ wordBreak: 'break-all' }}>{inv.email}</b>
                <div className="small muted">{inv.expired ? t('inv.expired') : inv.emailStatus === 'sent' ? t('inv.by', { name: inv.invitedByName }) : t('inv.notSent')}</div>
              </span>
              {inv.canManage && (
                <>
                  <button className="btn small" disabled={busy === inv.id} onClick={() => act(inv, 'resend')}>{t('add.resend')}</button>
                  <button className="btn ghost small" disabled={busy === inv.id} onClick={() => act(inv, 'revoke')}>{t('add.revoke')}</button>
                </>
              )}
            </div>
            {note?.id === inv.id && <div className={note.bad ? 'error' : 'small'}>{note.text}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

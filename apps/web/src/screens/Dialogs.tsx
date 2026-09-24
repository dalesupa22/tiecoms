import { useState, type FormEvent } from 'react';
import { client, useClient } from '../app-client.ts';
import { BASE, navigate } from '../router.ts';
import { Avatar, Modal, orgById } from '../ui.tsx';
import { errorText, t } from '../i18n.ts';

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
  const [copied, setCopied] = useState(false);
  const s = useSubmit();
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const submit = (e: FormEvent) => { e.preventDefault(); void s.run(async () => {
    const r = await client.createInvitation(workspaceId, {
      email: email || undefined, role, conversationIds: picked, history,
      accessUntil: role === 'guest' && until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
    });
    setLink(`${location.origin}${BASE}/invite/${encodeURIComponent(r.token)}`);
  }); };

  if (link) {
    return (
      <Modal title={t('dlg.linkReady')} onClose={onClose}>
        <p className="muted" style={{ margin: 0 }}>{t('dlg.linkBody', { email: email ? t('dlg.linkOnlyFor', { email }) : '' })}</p>
        <div className="linkbox">
          <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn primary" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? t('common.copied') : t('common.copy')}</button>
        </div>
        <div className="modal-actions"><button className="btn" onClick={onClose}>{t('common.done')}</button></div>
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
        <label className="field"><span>{t('dlg.emailOpt')}</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('dlg.emailPh')} /></label>
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
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn primary" disabled={s.busy || (role === 'guest' && !picked.length)}>{t('dlg.generate')}</button></div>
      </form>
    </Modal>
  );
}

export function AddMembersDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const d = useClient((st) => st.data)!;
  const conv = d.conversations.find((c) => c.id === conversationId)!;
  // En un chat grupal se puede sumar a cualquiera con quien compartas un espacio o la empresa.
  const inWs = new Set(conv.kind === 'multi' ? d.people.map((p) => p.id) : d.workspaces.find((w) => w.id === conv.workspaceId)?.memberIds ?? []);
  let candidates = d.people.filter((p) => inWs.has(p.id) && !conv.memberIds.includes(p.id));
  if (conv.kind === 'internal') candidates = candidates.filter((p) => p.orgId === conv.internalOrgId);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<'now' | 'all'>('now');
  const s = useSubmit();
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  return (
    <Modal title={t('dlg.addToGroup')} onClose={onClose}>
      {candidates.length === 0 && <div className="hint">{t('dlg.allHere')}</div>}
      <div className="list" style={{ maxHeight: 300, overflow: 'auto' }}>
        {candidates.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
            <Avatar person={p} org={orgById(d, p.orgId)} size={28} />
            <span className="grow"><b>{p.name}</b><span className="small muted"> · {orgById(d, p.orgId)?.name ?? t('common.guest')}</span></span>
          </label>
        ))}
      </div>
      <div className="seg">
        <button className={history === 'now' ? 'on' : ''} onClick={() => setHistory('now')}>{t('dlg.seeNewPl')}</button>
        <button className={history === 'all' ? 'on' : ''} onClick={() => setHistory('all')}>{t('dlg.seeHistoryPl')}</button>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!picked.length || s.busy} onClick={() => void s.run(async () => { await client.addMembers(conversationId, picked, history); onClose(); })}>{t('dlg.add')}</button>
      </div>
    </Modal>
  );
}

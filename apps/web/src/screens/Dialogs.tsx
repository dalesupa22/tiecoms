import { useState, type FormEvent } from 'react';
import { client, useClient } from '../app-client.ts';
import { BASE, navigate } from '../router.ts';
import { Avatar, Modal, orgById } from '../ui.tsx';

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e: any) {
      const details = Array.isArray(e?.details) ? e.details.map((d: any) => d.message).join(' · ') : '';
      setError(details || e?.message || 'No se pudo completar');
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
    <Modal title="Nuevo espacio" onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>Un espacio es un tema de trabajo con otra empresa. Después invitas a su equipo; cada empresa conserva su identidad.</p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>Nombre del espacio</span><input className="input" required minLength={2} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Monitorías · SIMON" /></label>
        <label className="field"><span>Área o departamento (opcional)</span><input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Ej. Facultad de Administración" /></label>
        {s.error && <div className="error">{s.error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={s.busy}>Crear espacio</button></div>
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
    <Modal title="Nuevo grupo" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field"><span>Nombre</span><input className="input" required minLength={2} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="seg">
          <button type="button" className={kind === 'group' ? 'on' : ''} onClick={() => setKind('group')}>Compartido entre empresas</button>
          <button type="button" className={kind === 'internal' ? 'on' : ''} onClick={() => setKind('internal')}>Solo mi empresa</button>
        </div>
        {kind === 'group' && (
          <div className="seg">
            <button type="button" className={level === 'operativo' ? 'on' : ''} onClick={() => setLevel('operativo')}>Operativo</button>
            <button type="button" className={level === 'directivo' ? 'on' : ''} onClick={() => setLevel('directivo')}>Directivo</button>
          </div>
        )}
        <div className="eyebrow">Participantes</div>
        {candidates.length === 0 && <div className="hint">Aún no hay más personas en este espacio. Invita a la otra empresa desde el espacio.</div>}
        <div className="list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {candidates.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
              <Avatar person={p} org={orgById(d, p.orgId)} size={28} />
              <span className="grow"><b>{p.name}</b><span className="small muted"> · {orgById(d, p.orgId)?.name ?? 'Tercero'}</span></span>
            </label>
          ))}
        </div>
        <div className="hint">Solo quienes estén en el grupo podrán leerlo. Los grupos fuera de tu alcance no muestran su nombre.</div>
        {s.error && <div className="error">{s.error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={s.busy}>Crear grupo</button></div>
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
      <Modal title="Enlace listo" onClose={onClose}>
        <p className="muted" style={{ margin: 0 }}>Compártelo por el canal que ya usan (correo, WhatsApp). Es de un solo uso{email ? ` y solo sirve para ${email}` : ''}; vence en 7 días.</p>
        <div className="linkbox">
          <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn primary" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? 'Copiado' : 'Copiar'}</button>
        </div>
        <div className="modal-actions"><button className="btn" onClick={onClose}>Listo</button></div>
      </Modal>
    );
  }
  return (
    <Modal title="Invitar" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="seg">
          <button type="button" className={role === 'member' ? 'on' : ''} onClick={() => setRole('member')}>Persona de otra empresa</button>
          <button type="button" className={role === 'guest' ? 'on' : ''} onClick={() => setRole('guest')}>Tercero con fecha de salida</button>
        </div>
        <div className="hint">{role === 'member'
          ? 'Entra con su propia empresa. Si su empresa aún no está en el espacio, se suma al aceptar.'
          : 'Un tercero (abogado, consultor) solo entra a los grupos que marques, nunca al espacio completo, y pierde acceso en la fecha de salida.'}</div>
        <label className="field"><span>Correo (opcional, recomendado)</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@empresa.com" /></label>
        {role === 'guest' && <label className="field"><span>Fecha de salida</span><input className="input" type="date" required value={until} onChange={(e) => setUntil(e.target.value)} min={new Date().toISOString().slice(0, 10)} /></label>}
        <div className="eyebrow">Grupos a los que entra</div>
        <div className="list">
          {groups.map((g) => (
            <label key={g.id} className="check"><input type="checkbox" checked={picked.includes(g.id)} onChange={() => toggle(g.id)} /><span className="grow">{g.name}</span>{g.level === 'directivo' && <span className="tag">Directivo</span>}</label>
          ))}
        </div>
        <div className="seg">
          <button type="button" className={history === 'now' ? 'on' : ''} onClick={() => setHistory('now')}>Ve solo lo nuevo</button>
          <button type="button" className={history === 'all' ? 'on' : ''} onClick={() => setHistory('all')}>Ve el historial</button>
        </div>
        {s.error && <div className="error">{s.error}</div>}
        <div className="modal-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={s.busy || (role === 'guest' && !picked.length)}>Generar enlace</button></div>
      </form>
    </Modal>
  );
}

export function AddMembersDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const d = useClient((st) => st.data)!;
  const conv = d.conversations.find((c) => c.id === conversationId)!;
  const inWs = new Set(d.workspaces.find((w) => w.id === conv.workspaceId)?.memberIds ?? []);
  let candidates = d.people.filter((p) => inWs.has(p.id) && !conv.memberIds.includes(p.id));
  if (conv.kind === 'internal') candidates = candidates.filter((p) => p.orgId === conv.internalOrgId);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<'now' | 'all'>('now');
  const s = useSubmit();
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  return (
    <Modal title="Agregar al grupo" onClose={onClose}>
      {candidates.length === 0 && <div className="hint">Todas las personas del espacio ya están aquí. Para sumar a alguien nuevo, invítalo desde el espacio.</div>}
      <div className="list" style={{ maxHeight: 300, overflow: 'auto' }}>
        {candidates.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
            <Avatar person={p} org={orgById(d, p.orgId)} size={28} />
            <span className="grow"><b>{p.name}</b><span className="small muted"> · {orgById(d, p.orgId)?.name ?? 'Tercero'}</span></span>
          </label>
        ))}
      </div>
      <div className="seg">
        <button className={history === 'now' ? 'on' : ''} onClick={() => setHistory('now')}>Ven solo lo nuevo</button>
        <button className={history === 'all' ? 'on' : ''} onClick={() => setHistory('all')}>Ven el historial</button>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={!picked.length || s.busy} onClick={() => void s.run(async () => { await client.addMembers(conversationId, picked, history); onClose(); })}>Agregar</button>
      </div>
    </Modal>
  );
}

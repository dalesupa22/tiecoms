import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { DriveFileDTO, DriveFolderDTO, DriveTreeDTO, WorkspaceDTO } from '@tiecoms/contracts';
import { client, useClient } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { menuProps, toast, type MenuItem } from '../menu.tsx';
import { Modal, personById } from '../ui.tsx';

/** 'me' = Mis archivos; si no, el id del espacio. */
type ScopeKey = 'me' | string;
const wsParam = (k: ScopeKey) => (k === 'me' ? null : k);

const api = {
  tree: (k: ScopeKey) => client.request<DriveTreeDTO>(`/drive/tree${k === 'me' ? '' : `?workspaceId=${k}`}`),
  mkdir: (k: ScopeKey, parentId: string | null, name: string) => client.request<DriveFolderDTO>('/drive/folders', { method: 'POST', json: { workspaceId: wsParam(k), parentId, name } }),
  patchFolder: (id: string, p: Record<string, unknown>) => client.request<DriveFolderDTO>(`/drive/folders/${id}`, { method: 'PATCH', json: p }),
  rmFolder: (id: string) => client.request(`/drive/folders/${id}`, { method: 'DELETE' }),
  upload: (k: ScopeKey, folderId: string | null, file: File) => {
    const q = new URLSearchParams({ name: file.name });
    if (k !== 'me') q.set('workspaceId', k);
    if (folderId) q.set('folderId', folderId);
    return client.request<DriveFileDTO>(`/drive/files?${q}`, {
      method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream' },
    });
  },
  patchFile: (id: string, p: Record<string, unknown>) => client.request<DriveFileDTO>(`/drive/files/${id}`, { method: 'PATCH', json: p }),
  rmFile: (id: string) => client.request(`/drive/files/${id}`, { method: 'DELETE' }),
  link: (id: string) => client.request<{ url: string }>(`/drive/files/${id}/link`),
};

const MAX = 25 * 1024 * 1024;

export function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
export function fileIcon(type: string, name: string) {
  if (type.startsWith('image/')) return '🖼';
  if (type.startsWith('video/')) return '🎞';
  if (type.startsWith('audio/')) return '🎵';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return '📕';
  if (/sheet|excel|csv/.test(type) || /\.(xlsx?|csv)$/i.test(name)) return '📊';
  if (/presentation|powerpoint/.test(type) || /\.pptx?$/i.test(name)) return '📽';
  if (/word|document|rtf|text\//.test(type) || /\.(docx?|txt|md)$/i.test(name)) return '📄';
  if (/zip|compressed|tar|rar/.test(type)) return '🗜';
  return '📎';
}

function childrenOf(tree: DriveTreeDTO | undefined, parentId: string | null) {
  return {
    folders: (tree?.folders ?? []).filter((f) => f.parentId === parentId),
    files: (tree?.files ?? []).filter((f) => f.folderId === parentId),
  };
}
function pathTo(tree: DriveTreeDTO | undefined, id: string | null): DriveFolderDTO[] {
  const out: DriveFolderDTO[] = [];
  const byId = new Map((tree?.folders ?? []).map((f) => [f.id, f]));
  for (let cur = id ? byId.get(id) : undefined; cur && out.length < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.unshift(cur);
  return out;
}

export function FilesScreen() {
  const d = useClient((s) => s.data)!;
  const revision = useClient((s) => s.driveRevision);
  const [trees, setTrees] = useState<Record<ScopeKey, DriveTreeDTO>>({});
  const [scope, setScope] = useState<ScopeKey>('me');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['me']));
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const scopes: { key: ScopeKey; name: string; ws?: WorkspaceDTO }[] = useMemo(
    () => [{ key: 'me', name: t('files.mine') }, ...d.workspaces.map((w) => ({ key: w.id, name: w.name, ws: w }))], [d.workspaces],
  );

  const load = useCallback(async (k: ScopeKey) => {
    try { const tr = await api.tree(k); setTrees((all) => ({ ...all, [k]: tr })); } catch (e) { toast(errorText(e)); }
  }, []);
  // Se recargan los árboles abiertos cuando alguien cambia algo.
  useEffect(() => { for (const k of new Set([scope, ...expanded])) void load(k); }, [revision, load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!trees[scope]) void load(scope); }, [scope, trees, load]);

  const tree = trees[scope];
  // Si la carpeta abierta se borró, vuelve a la raíz.
  useEffect(() => { if (tree && folderId && !tree.folders.some((f) => f.id === folderId)) setFolderId(null); }, [tree, folderId]);
  const here = childrenOf(tree, folderId);
  const search = q.trim().toLowerCase();
  const found = search && tree ? { folders: tree.folders.filter((f) => f.name.toLowerCase().includes(search)), files: tree.files.filter((f) => f.name.toLowerCase().includes(search)) } : null;
  const list = found ?? here;
  const crumbs = pathTo(tree, folderId);

  function open(k: ScopeKey, id: string | null) {
    setScope(k); setFolderId(id); setQ('');
    setExpanded((s) => new Set([...s, k, ...pathTo(trees[k], id).map((f) => f.id)]));
  }
  function toggle(id: string) { setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }

  async function newFolder() {
    const name = prompt(t('files.folderName'))?.trim();
    if (!name) return;
    try { const f = await api.mkdir(scope, folderId, name); await load(scope); open(scope, f.id); } catch (e) { toast(errorText(e)); }
  }
  async function uploadMany(files: File[]) {
    const ok = files.filter((f) => f.size > 0 && f.size <= MAX);
    if (ok.length < files.length) toast(t('files.tooBig'));
    if (!ok.length) return;
    setUploading({ done: 0, total: ok.length });
    let failed = 0;
    for (const [i, f] of ok.entries()) {
      try { await api.upload(scope, folderId, f); } catch (e) { failed++; toast(`${f.name}: ${errorText(e)}`); }
      setUploading({ done: i + 1, total: ok.length });
    }
    setUploading(null);
    if (failed < ok.length) toast(t('files.uploaded', { n: ok.length - failed }));
    void load(scope);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault(); setDrag(false);
    void uploadMany([...e.dataTransfer.files]);
  }
  async function download(f: DriveFileDTO) {
    try { const { url } = await api.link(f.id); window.open(url, '_blank', 'noopener'); } catch (e) { toast(errorText(e)); }
  }
  const canEdit = (createdBy: string) => tree?.canManageAll || createdBy === d.me.id;

  function folderMenu(f: DriveFolderDTO): MenuItem[] {
    return [
      { label: t('files.open'), icon: '📂', onSelect: () => open(scope, f.id) },
      { label: t('files.rename'), icon: '✎', disabled: !canEdit(f.createdBy), onSelect: async () => {
        const name = prompt(t('files.newName'), f.name)?.trim();
        if (name && name !== f.name) try { await api.patchFolder(f.id, { name }); void load(scope); } catch (e) { toast(errorText(e)); }
      } },
      { label: t('files.move'), icon: '↦', disabled: !canEdit(f.createdBy), onSelect: () => setMoving({ kind: 'folder', item: f }) },
      { divider: true },
      { label: t('files.delete'), icon: '🗑', danger: true, disabled: !canEdit(f.createdBy), onSelect: async () => {
        if (!confirm(t('files.deleteFolderConfirm', { name: f.name }))) return;
        try { await api.rmFolder(f.id); void load(scope); } catch (e) { toast(errorText(e)); }
      } },
    ];
  }
  function fileMenu(f: DriveFileDTO): MenuItem[] {
    return [
      { label: t('files.download'), icon: '⤓', onSelect: () => void download(f) },
      { label: t('files.rename'), icon: '✎', disabled: !canEdit(f.createdBy), onSelect: async () => {
        const name = prompt(t('files.newName'), f.name)?.trim();
        if (name && name !== f.name) try { await api.patchFile(f.id, { name }); void load(scope); } catch (e) { toast(errorText(e)); }
      } },
      { label: t('files.move'), icon: '↦', disabled: !canEdit(f.createdBy), onSelect: () => setMoving({ kind: 'file', item: f }) },
      { divider: true },
      { label: t('files.delete'), icon: '🗑', danger: true, disabled: !canEdit(f.createdBy), onSelect: async () => {
        if (!confirm(t('files.deleteFileConfirm', { name: f.name }))) return;
        try { await api.rmFile(f.id); void load(scope); } catch (e) { toast(errorText(e)); }
      } },
    ];
  }
  const [moving, setMoving] = useState<{ kind: 'folder'; item: DriveFolderDTO } | { kind: 'file'; item: DriveFileDTO } | null>(null);
  const scopeName = scopes.find((s) => s.key === scope)?.name ?? '';

  return (
    <div className="page"><div className="page-narrow">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <h1 className="grow">{t('files.title')}</h1>
        <button className="btn small" onClick={newFolder}>＋ {t('files.newFolder')}</button>
        <button className="btn primary small" disabled={!!uploading} onClick={() => input.current?.click()}>⤒ {t('files.upload')}</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { void uploadMany([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      <p className="muted" style={{ margin: '0 0 16px' }}>{t('files.intro')}</p>

      <div className="drive">
        <nav className="card drive-tree" aria-label={t('files.tree')}>
          {scopes.map((s) => (
            <div key={s.key}>
              <TreeRow depth={0} label={s.name} icon={s.key === 'me' ? '🔒' : '▦'} active={scope === s.key && !folderId}
                open={expanded.has(s.key)} hasChildren onToggle={() => { toggle(s.key); if (!trees[s.key]) void load(s.key); }} onOpen={() => open(s.key, null)} />
              {expanded.has(s.key) && <Branch tree={trees[s.key]} parentId={null} depth={1} expanded={expanded} toggle={toggle}
                activeId={scope === s.key ? folderId : '__none'} onOpen={(id) => open(s.key, id)} />}
            </div>
          ))}
        </nav>

        <section className={`card drive-main ${drag ? 'is-drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={onDrop}>
          <div className="drive-head">
            <div className="drive-crumbs">
              <button className={!folderId ? 'on' : ''} onClick={() => open(scope, null)}>{scopeName}</button>
              {crumbs.map((c) => <span key={c.id}><span className="muted">›</span><button className={c.id === folderId ? 'on' : ''} onClick={() => open(scope, c.id)}>{c.name}</button></span>)}
            </div>
            <input className="input" style={{ maxWidth: 220 }} placeholder={t('files.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {uploading && <div className="drive-progress"><span style={{ width: `${(uploading.done / uploading.total) * 100}%` }} />{t('files.uploading', { done: uploading.done, total: uploading.total })}</div>}
          {!tree && <div className="hint" style={{ padding: 16 }}>{t('common.loading')}</div>}
          {tree && !list.folders.length && !list.files.length && (
            <div className="drive-empty">
              <div style={{ fontSize: 34 }}>🗂</div>
              <b>{found ? t('files.noResults') : t('files.empty')}</b>
              {!found && <span className="small muted">{t('files.emptyHint')}</span>}
            </div>
          )}
          <div className="drive-list">
            {list.folders.map((f) => (
              <button key={f.id} className="drive-item" onDoubleClick={() => open(scope, f.id)} onClick={() => open(scope, f.id)} {...menuProps(() => folderMenu(f))}>
                <span className="drive-ico">📁</span>
                <span className="grow ellipsis"><b>{f.name}</b>{found && <span className="small muted"> · {pathTo(tree, f.parentId).map((p) => p.name).join(' › ') || scopeName}</span>}</span>
                <span className="small muted">{((n) => (n === 0 ? t('files.item0') : n === 1 ? t('files.item1') : t('files.items', { n })))(childrenOf(tree, f.id).folders.length + childrenOf(tree, f.id).files.length)}</span>
                <span className="drive-more" onClick={(e) => { e.stopPropagation(); (e.currentTarget.parentElement as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })); }}>⋯</span>
              </button>
            ))}
            {list.files.map((f) => (
              <button key={f.id} className="drive-item" onClick={() => void download(f)} {...menuProps(() => fileMenu(f))}>
                <span className="drive-ico">{fileIcon(f.contentType, f.name)}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block' }}>{f.name}</span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>
                    {size(f.size)} · {personById(d, f.createdBy)?.name ?? ''} · {new Date(f.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })}
                    {found && ` · ${pathTo(tree, f.folderId).map((p) => p.name).join(' › ') || scopeName}`}
                  </span>
                </span>
                <span className="drive-more" onClick={(e) => { e.stopPropagation(); (e.currentTarget.parentElement as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })); }}>⋯</span>
              </button>
            ))}
          </div>
          {drag && <div className="drive-drop">{t('files.dropHere', { name: crumbs.at(-1)?.name ?? scopeName })}</div>}
        </section>
      </div>
      {moving && tree && <MoveDialog tree={tree} scopeName={scopeName} moving={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); void load(scope); }} />}
    </div></div>
  );
}

function TreeRow({ depth, label, icon, active, open, hasChildren, onToggle, onOpen }: {
  depth: number; label: string; icon: string; active: boolean; open: boolean; hasChildren: boolean; onToggle: () => void; onOpen: () => void;
}) {
  return (
    <div className={`drive-node ${active ? 'active' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
      <button className="drive-caret" aria-label={open ? t('files.collapse') : t('files.expand')} style={{ visibility: hasChildren ? 'visible' : 'hidden' }} onClick={onToggle}>{open ? '▾' : '▸'}</button>
      <button className="drive-label" onClick={onOpen}><span>{icon}</span><span className="ellipsis">{label}</span></button>
    </div>
  );
}

function Branch({ tree, parentId, depth, expanded, toggle, activeId, onOpen, exclude }: {
  tree: DriveTreeDTO | undefined; parentId: string | null; depth: number; expanded: Set<string>; toggle: (id: string) => void;
  activeId: string | null; onOpen: (id: string) => void; exclude?: string;
}) {
  if (!tree) return <div className="hint" style={{ paddingLeft: 12 + depth * 14 }}>…</div>;
  const kids = tree.folders.filter((f) => f.parentId === parentId && f.id !== exclude);
  return (
    <>
      {kids.map((f) => {
        const has = tree.folders.some((x) => x.parentId === f.id && x.id !== exclude);
        return (
          <div key={f.id}>
            <TreeRow depth={depth} label={f.name} icon={expanded.has(f.id) ? '📂' : '📁'} active={activeId === f.id} open={expanded.has(f.id)} hasChildren={has}
              onToggle={() => toggle(f.id)} onOpen={() => onOpen(f.id)} />
            {expanded.has(f.id) && has && <Branch tree={tree} parentId={f.id} depth={depth + 1} expanded={expanded} toggle={toggle} activeId={activeId} onOpen={onOpen} exclude={exclude} />}
          </div>
        );
      })}
    </>
  );
}

function MoveDialog({ tree, scopeName, moving, onClose, onDone }: {
  tree: DriveTreeDTO; scopeName: string; moving: { kind: 'folder'; item: DriveFolderDTO } | { kind: 'file'; item: DriveFileDTO };
  onClose: () => void; onDone: () => void;
}) {
  const current = moving.kind === 'folder' ? moving.item.parentId : moving.item.folderId;
  const [target, setTarget] = useState<string | null>(current);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(pathTo(tree, current).map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function go() {
    setBusy(true);
    try {
      if (moving.kind === 'folder') await api.patchFolder(moving.item.id, { parentId: target });
      else await api.patchFile(moving.item.id, { folderId: target });
      toast(t('files.moved'));
      onDone();
    } catch (e) { toast(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('files.moveTitle', { name: moving.item.name })} onClose={onClose}>
      <div className="card drive-tree" style={{ maxHeight: 320, overflow: 'auto' }}>
        <TreeRow depth={0} label={scopeName} icon="▦" active={target === null} open hasChildren={false} onToggle={() => {}} onOpen={() => setTarget(null)} />
        {/* Una carpeta no puede ir dentro de sí misma: se oculta su rama. */}
        <Branch tree={tree} parentId={null} depth={1} expanded={expanded} toggle={toggle} activeId={target} onOpen={setTarget}
          exclude={moving.kind === 'folder' ? moving.item.id : undefined} />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || target === current} onClick={go}>{t('files.moveHere')}</button>
      </div>
    </Modal>
  );
}

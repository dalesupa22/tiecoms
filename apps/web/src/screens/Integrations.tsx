import { useEffect, useState } from 'react';
import type { ConversationDTO, IntegrationDTO, IntegrationSecretDTO } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { errorText, locale, t } from '../i18n.ts';
import { copyText, toast } from '../menu.tsx';
import { Modal } from '../ui.tsx';

/**
 * Integraciones del grupo (información del grupo). Las ven sus admins; las configura quien administra el espacio
 * o la empresa. El token y el secreto de salida se muestran una sola vez, al crear o rotar.
 */
export function IntegrationsPanel({ conv }: { conv: ConversationDTO }) {
  const [list, setList] = useState<IntegrationDTO[] | null>(null);
  const [canConfigure, setCanConfigure] = useState(false);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; data: Partial<IntegrationSecretDTO> & { webhookUrl?: string } } | null>(null);
  const [editing, setEditing] = useState<IntegrationDTO | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    client.listIntegrations(conv.id)
      .then((r) => { if (live) { setList(r.integrations); setCanConfigure(r.canConfigure); } })
      .catch(() => { if (live) setList(null); });
    return () => { live = false; };
  }, [conv.id, reload]);

  if (list === null || (!list.length && !canConfigure)) return null;
  const refresh = () => setReload((n) => n + 1);
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : t('integ.never'));

  const rotate = (i: IntegrationDTO) => {
    if (!confirm(t('integ.rotateConfirm', { name: i.name }))) return;
    client.rotateIntegrationToken(i.id).then((r) => { setSecret({ title: t('integ.rotated'), data: r }); refresh(); }).catch((e) => toast(errorText(e)));
  };
  const revoke = (i: IntegrationDTO) => {
    if (!confirm(t('integ.revokeConfirm', { name: i.name }))) return;
    client.revokeIntegration(i.id).then(refresh).catch((e) => toast(errorText(e)));
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="eyebrow grow">{t('integ.title')} · {list.length}</span>
        {canConfigure && <button className="btn small" onClick={() => setCreating(true)}>{t('integ.new')}</button>}
      </div>
      {!list.length && <div className="small muted">{t('integ.empty')}</div>}
      {list.map((i) => (
        <div key={i.id} className="card" style={{ padding: 10, marginBottom: 6 }}>
          <div className="row">
            <span className="grow ellipsis" style={{ fontWeight: 600 }}>🔌 {i.name}</span>
            <span className="small muted">…{i.tokenHint}</span>
          </div>
          <div className="small muted">{t('integ.lastUsed', { when: date(i.lastUsedAt) })}</div>
          {i.outgoingUrl && <div className="small muted ellipsis" title={i.outgoingUrl}>↩ {i.outgoingUrl}</div>}
          {i.failingDeliveries > 0 && <div className="small" style={{ color: 'var(--danger, #C53030)' }}>{t('integ.failing', { n: i.failingDeliveries })}</div>}
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn ghost small" onClick={() => void copyText(i.webhookUrl).then(() => toast(t('integ.copied')))}>{t('integ.copyUrl')}</button>
            {canConfigure && <>
              <button className="btn ghost small" onClick={() => setEditing(i)}>{t('integ.edit')}</button>
              <button className="btn ghost small" onClick={() => rotate(i)}>{t('integ.rotate')}</button>
              <button className="btn ghost small" onClick={() => revoke(i)}>{t('integ.revoke')}</button>
            </>}
          </div>
        </div>
      ))}
      {creating && <IntegrationForm conv={conv} onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); setSecret({ title: t('integ.created'), data: r }); refresh(); }} />}
      {editing && <IntegrationForm conv={conv} current={editing} onClose={() => setEditing(null)}
        onSaved={(r) => { setEditing(null); if (r.outgoingSecret) setSecret({ title: t('integ.updated'), data: r }); refresh(); }} />}
      {secret && <SecretDialog title={secret.title} data={secret.data} onClose={() => setSecret(null)} />}
    </div>
  );
}

function IntegrationForm({ conv, current, onClose, onSaved }: {
  conv: ConversationDTO; current?: IntegrationDTO; onClose: () => void;
  onSaved: (r: Partial<IntegrationSecretDTO> & { integration: IntegrationDTO; outgoingSecret: string | null }) => void;
}) {
  const [name, setName] = useState(current?.name ?? '');
  const [url, setUrl] = useState(current?.outgoingUrl ?? '');
  const [rotateSecret, setRotateSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const outgoingUrl = url.trim() || null;
      const r = current
        ? await client.updateIntegration(current.id, { name: name.trim(), outgoingUrl, ...(rotateSecret ? { rotateOutgoingSecret: true } : {}) })
        : await client.createIntegration(conv.id, { name: name.trim(), outgoingUrl });
      onSaved(r);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={current ? t('integ.editTitle') : t('integ.newTitle')} onClose={onClose}>
      <label className="field"><span>{t('integ.name')}</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('integ.namePh')} maxLength={80} />
      </label>
      <label className="field"><span>{t('integ.outgoing')}</span>
        <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" maxLength={500} />
      </label>
      <p className="small muted">{t('integ.outgoingHint')}</p>
      {current?.outgoingUrl && (
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={rotateSecret} onChange={(e) => setRotateSecret(e.target.checked)} /> {t('integ.rotateSecret')}</label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || name.trim().length < 2} onClick={() => void submit()}>{current ? t('common.save') : t('integ.create')}</button>
      </div>
    </Modal>
  );
}

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="eyebrow">{label}</div>
      <div className="row" style={{ gap: 6 }}>
        <code className="grow" style={{ wordBreak: 'break-all', fontSize: 12 }}>{value}</code>
        <button className="btn ghost small" onClick={() => void copyText(value).then(() => toast(t('integ.copied')))}>{t('integ.copy')}</button>
      </div>
    </div>
  );
}

function SecretDialog({ title, data, onClose }: { title: string; data: Partial<IntegrationSecretDTO>; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="small">{t('integ.onceWarning')}</p>
      {data.integration && <SecretRow label={t('integ.webhookUrl')} value={data.integration.webhookUrl} />}
      {data.token && <SecretRow label={t('integ.token')} value={data.token} />}
      {data.webhookUrlWithToken && <SecretRow label={t('integ.urlWithToken')} value={data.webhookUrlWithToken} />}
      {data.outgoingSecret && <SecretRow label={t('integ.outgoingSecret')} value={data.outgoingSecret} />}
      <p className="small muted">{t('integ.slackHint')}</p>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn primary" onClick={onClose}>{t('integ.saved')}</button>
      </div>
    </Modal>
  );
}

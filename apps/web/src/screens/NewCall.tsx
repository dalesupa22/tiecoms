/**
 * «Nueva llamada» con enlace para invitados (docs/LLAMADAS.md › Nueva llamada, pedido de Danny 30-sep-2026):
 * un clic crea la llamada (POST /calls/instant), entra y muestra «Comparte el enlace» para mandarlo a quien sea,
 * aunque no tenga cuenta ni app. El enlace sirve solo mientras la llamada esté abierta.
 */
import { useEffect, useState } from 'react';
import type { CallDTO, CallLinkDTO } from '@tiecoms/contracts';
import { client } from '../app-client.ts';
import { inviteText, mailtoHref, whatsappHref } from '../call-link.ts';
import { callLinkOf, forgetCallLink, rememberCallLink, startInstantCall } from '../call.ts';
import { errorText, t } from '../i18n.ts';
import { toast } from '../menu.tsx';
import { openDialog } from '../actions.tsx';
import { Modal } from '../ui.tsx';

const KIND_KEY = 'chaggu:newcall-kind';
const readKind = (): 'audio' | 'video' => { try { return localStorage.getItem(KIND_KEY) === 'audio' ? 'audio' : 'video'; } catch { return 'video'; } };

/** Abre «Nueva llamada» (pestaña Llamadas, riel, ＋ Crear y ⌘K). */
export const openNewCall = () => openDialog((close) => <NewCallDialog onClose={close} />);


function NewCallDialog({ onClose }: { onClose: () => void }) {
  const me = client.getState().data?.me;
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'audio' | 'video'>(readKind);
  const [busy, setBusy] = useState(false);
  const pick = (k: 'audio' | 'video') => { setKind(k); try { localStorage.setItem(KIND_KEY, k); } catch { /* sin almacenamiento */ } };
  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await startInstantCall({ title, video: kind === 'video' });
      onClose();
      openShareLink(r.call, r.link);
    } catch (e) {
      setBusy(false);
      toast(errorText(e));
    }
  };
  return (
    <Modal title={t('newcall.title')} onClose={onClose}>
      <form className="grid newcall" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <p className="small muted" style={{ margin: 0 }}>{t('newcall.hint')}</p>
        <label className="field"><span>{t('newcall.name')}</span>
          <input className="input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('newcall.namePh', { name: me?.name.split(' ')[0] ?? '' })} />
        </label>
        <div className="seg newcall-kind" role="radiogroup" aria-label={`${t('newcall.voice')} / ${t('newcall.video')}`}>
          <button type="button" role="radio" aria-checked={kind === 'audio'} className={kind === 'audio' ? 'on' : ''} onClick={() => pick('audio')}>📞 {t('newcall.voice')}</button>
          <button type="button" role="radio" aria-checked={kind === 'video'} className={kind === 'video' ? 'on' : ''} onClick={() => pick('video')}>🎥 {t('newcall.video')}</button>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn accent" autoFocus disabled={busy}>{busy ? t('newcall.starting') : t('newcall.start')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** «Comparte el enlace»: con el de la «Nueva llamada» o, desde 🔗, el que ya se creó aquí (o uno nuevo). */
export const openShareLink = (call: CallDTO, link?: CallLinkDTO) => openDialog((close) => <ShareLinkDialog call={call} initial={link} onClose={close} />);

export function ShareLinkDialog({ call, initial, onClose }: { call: CallDTO; initial?: CallLinkDTO; onClose: () => void }) {
  const [link, setLink] = useState<CallLinkDTO | null>(() => initial ?? callLinkOf(call.id));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (link) return;
    client.createCallLink(call.id).then((l) => { rememberCallLink(call.id, l); setLink(l); }, (e) => setError(errorText(e)));
  }, [call.id]);
  const url = link?.url ?? '';
  const copy = (text: string, done: string) => void navigator.clipboard?.writeText(text).then(() => toast(done)).catch(() => {});
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <Modal title={t('share.linkTitle')} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{t('share.linkHelp')}</p>
      {error ? <div className="error" role="alert">{error}</div> : <>
        <div className="row share-link-row" style={{ gap: 8 }}>
          <input className="input grow share-link-url" readOnly aria-label={t('share.linkTitle')} value={url || t('call.connecting')} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn accent" disabled={!url} onClick={() => copy(url, t('call.linkCopied'))}>{t('share.copyLink')}</button>
        </div>
        <div className="share-link-actions">
          <a className={`btn share-wa ${url ? '' : 'is-disabled'}`} href={url ? whatsappHref(url) : undefined} target="_blank" rel="noopener noreferrer">💬 {t('share.whatsapp')}</a>
          <a className={`btn ${url ? '' : 'is-disabled'}`} href={url ? mailtoHref(url) : undefined}>✉ {t('share.email')}</a>
          {canShare && <button className="btn" disabled={!url} onClick={() => void navigator.share({ title: t('call.linkShareTitle'), text: inviteText(url), url }).catch(() => {})}>↗ {t('share.more')}</button>}
        </div>
        <div className="share-link-text">
          <div className="row" style={{ gap: 8 }}>
            <span className="eyebrow grow">{t('share.linkSuggested')}</span>
            <button className="btn ghost small" disabled={!url} onClick={() => copy(inviteText(url), t('share.textCopied'))}>{t('share.copyText')}</button>
          </div>
          <p className="small" style={{ margin: '4px 0 0' }}>{url ? inviteText(url) : '…'}</p>
        </div>
      </>}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn ghost small" onClick={() => void client.revokeCallLinks(call.id).then(() => { forgetCallLink(call.id); toast(t('call.linkRevoked')); onClose(); }).catch((e) => toast(errorText(e)))}>{t('call.linkRevoke')}</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>{t('common.done')}</button>
      </div>
    </Modal>
  );
}

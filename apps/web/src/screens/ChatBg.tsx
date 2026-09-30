/**
 * «Fondo del chat» (chat-bg.ts): 8 tonos, 4 patrones, «Automático» y «Sin fondo». Se aplica al tocar (el chat de
 * atrás cambia en vivo) y el cuadrito de muestra enseña cómo se leen los mensajes encima.
 */
import { useClient } from '../app-client.ts';
import { openDialog } from '../actions.tsx';
import { CHAT_BGS, bgClass, effectiveBg, setChatBg, useChatBgs, type ChatBg } from '../chat-bg.ts';
import { t } from '../i18n.ts';
import { Modal, conversationTitle } from '../ui.tsx';

export const openChatBgDialog = (id: string, multi: boolean) => openDialog((close) => <ChatBgDialog id={id} multi={multi} onClose={close} />);

const swatchStyle = (bg: ChatBg | null) => (bg ? { ['--chat-bg' as never]: `var(--cbg-${bg.tone})`, ['--pane-fg' as never]: `var(--gc-${bg.tone}-fg)` } : {});

function ChatBgDialog({ id, multi, onClose }: { id: string; multi: boolean; onClose: () => void }) {
  const d = useClient((s) => s.data);
  const choice = useChatBgs()[id];
  const conv = d?.conversations.find((c) => c.id === id);
  const shown = effectiveBg(choice, id, true);
  const auto = effectiveBg(undefined, id, true);
  const opt = (key: string | null, label: string, bg: ChatBg | null, on: boolean) => (
    <button key={key ?? 'auto'} className={`bg-swatch ${bgClass(bg)} ${on ? 'is-on' : ''}`} style={swatchStyle(bg)} aria-pressed={on} title={label} onClick={() => setChatBg(id, key)}>
      <span className="bg-swatch-name">{label}</span>
    </button>
  );
  return (
    <Modal title={t('bg.title', { name: conv && d ? conversationTitle(d, conv) : '' })} onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{t(multi ? 'bg.helpMulti' : 'bg.help')}</p>
      {/* Muestra: dos mensajes sobre el fondo elegido (el de verdad cambia detrás). */}
      <div className={`bg-preview ${bgClass(shown)}`} style={swatchStyle(shown)} aria-hidden>
        <div className="bg-preview-msg"><b>Laura</b><span>{t('bg.sample1')}</span><i>9:41</i></div>
        <div className="bg-preview-msg"><b>{t('common.youShort')}</b><span>{t('bg.sample2')}</span><i>9:42</i></div>
      </div>
      <div className="bg-grid">
        {opt(null, t('bg.auto'), auto, !choice)}
        {opt('none', t('bg.none'), null, choice === 'none')}
        {CHAT_BGS.map((b) => opt(b.id, t(b.label as never), b, choice === b.id))}
      </div>
      <div className="modal-actions"><button className="btn primary" onClick={onClose}>{t('common.done')}</button></div>
    </Modal>
  );
}

/**
 * Seleccionar texto de un mensaje desde el inicio (pedido de Danny, 5-oct-2026: «no me deja copiar el texto desde el inicio»).
 * Mientras arrastras para seleccionar, o mientras hay texto seleccionado en un chat, la barra de acciones del mensaje se
 * esconde (.msgs.is-selecting en MsgActions.css) para no tapar la primera línea. Un solo juego de escuchas para todos los paneles.
 */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [contenteditable="true"], .msg-actions';
let installed = false;

export function installHideActionsWhileSelecting() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let pressed: HTMLElement | null = null;
  const selectedIn = () => {
    const s = getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const n = s.getRangeAt(0).commonAncestorContainer;
    return (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('.msgs') ?? null;
  };
  const sync = () => {
    const keep = pressed ?? selectedIn();
    document.querySelectorAll<HTMLElement>('.msgs.is-selecting').forEach((el) => { if (el !== keep) el.classList.remove('is-selecting'); });
    keep?.classList.add('is-selecting');
  };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element | null;
    pressed = e.button === 0 && t?.closest && !t.closest(INTERACTIVE) ? t.closest<HTMLElement>('.msgs') : null;
    sync();
  }, true);
  const up = () => { if (pressed) { pressed = null; sync(); } };
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  document.addEventListener('selectionchange', sync);
}

import { createContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { locale } from '../i18n.ts';
import './ChatHeader.css';

/** null keeps standalone resource bars unchanged. */
export const ChatHeaderVisibility = createContext<boolean | null>(null);

/** Secondary chat controls stay mounted; opening this layer never changes header height. */
export function ChatHeaderPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId(), english = locale().startsWith('en');
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  const closeAfterCommand = () => {
    const commandFocus = document.activeElement;
    setOpen(false);
    requestAnimationFrame(() => {
      const current = document.activeElement;
      // Search, dialogs and context menus may have already taken focus deliberately.
      if (current instanceof HTMLElement && current !== document.body && current !== commandFocus && current.getClientRects().length) return;
      const dialog = [...document.querySelectorAll<HTMLElement>('.modal, .ctx-menu')].find((element) => element.getClientRects().length);
      if (dialog) (dialog.querySelector<HTMLElement>('button:not([disabled]), input, [tabindex]') ?? dialog).focus();
      else trigger.current?.focus();
    });
  };
  const place = () => {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8)) });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place(); panel.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !trigger.current?.contains(target) && !panel.current?.contains(target) && !(target instanceof Element && target.closest('.ctx-menu'))) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.modal, .ctx-menu')) return;
      event.preventDefault(); event.stopImmediatePropagation(); close(true);
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !trigger.current?.contains(target) && !panel.current?.contains(target) && !(target instanceof Element && target.closest('.ctx-menu, .modal'))) close();
    };
    const navigated = () => close();
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place); window.addEventListener('chaggu:navigate', navigated); document.addEventListener('focusin', focus);
    return () => { observer.disconnect(); window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); window.removeEventListener('chaggu:navigate', navigated); document.removeEventListener('focusin', focus); };
  }, [open]);
  return <>
    <button ref={trigger} className="icon-btn chat-header-more" aria-label={english ? 'More chat options' : 'Más opciones del chat'} title={english ? 'More chat options' : 'Más opciones del chat'} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>⋯</button>
    {createPortal(<div ref={panel} id={id} className="chat-header-popover" role="dialog" aria-label={english ? 'Chat options and resources' : 'Opciones y recursos del chat'} hidden={!open} style={position} onClick={(event) => { if (event.target instanceof Element && event.target.closest('[data-close-header]')) closeAfterCommand(); }}>
      <div className="chat-header-popover-title"><b>{english ? 'Chat options' : 'Opciones del chat'}</b><button className="icon-btn" aria-label={english ? 'Close chat options' : 'Cerrar opciones del chat'} onClick={() => close(true)}>×</button></div>
      <ChatHeaderVisibility.Provider value={open}>{children}</ChatHeaderVisibility.Provider>
    </div>, document.body)}
  </>;
}

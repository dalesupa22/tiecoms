/**
 * Abre el visor/editor de código (screens/CodeSheet.tsx) desde cualquier lugar: burbujas de chat, tareas, WhatsApp,
 * correo. Monta su propia raíz y la quita al cerrar; CodeMirror se descarga solo la primera vez.
 */
import { createRoot } from 'react-dom/client';
import type { AttachmentDTO } from '@tiecoms/contracts';

export function openCodeViewer(a: AttachmentDTO, conversationId?: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); };
  void import('./screens/CodeSheet.tsx').then(({ default: CodeSheet }) => root.render(<CodeSheet a={a} conversationId={conversationId} onClose={close} />))
    .catch(() => close());
}

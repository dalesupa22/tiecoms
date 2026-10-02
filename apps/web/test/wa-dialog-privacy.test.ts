import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const dialogs = vi.hoisted(() => ({ current: null as null | ((close: () => void) => ReactNode) }));
vi.mock('../src/actions.tsx', () => ({
  openDialog: (render: (close: () => void) => ReactNode) => { dialogs.current = render; },
  getDialogIdentity: () => dialogs.current,
}));
vi.mock('../src/app-client.ts', async () => {
  const { MemoryStorage, TieComsClient } = await import('@tiecoms/client-core');
  return { client: new TieComsClient({ baseUrl: '', platform: 'web', deviceName: 'dialog-fixture', storage: new MemoryStorage() }), useClient: vi.fn() };
});
vi.mock('../src/split.ts', () => ({ currentPaneReferences: () => [], removePanes: vi.fn() }));
vi.mock('../src/menu.tsx', () => ({ closeMenu: vi.fn(), getMenuIdentity: () => null, menuProps: vi.fn(), openMenuAt: vi.fn() }));
vi.mock('../src/i18n.ts', () => ({ locale: () => 'es' }));
import { openWaDialog, showWaDialogUntilClosed } from '../src/wa-privacy-ui.tsx';

function renderCurrent(close: () => void) { return dialogs.current!(close) as ReactElement<{ onClose: () => void }>; }
beforeEach(() => { dialogs.current = null; });

describe('scoped WhatsApp dialog ownership', () => {
  it('closes its own visible dialog through the registered privacy callback', () => {
    const close = vi.fn();
    openWaDialog({ accountId: 'a', jid: 'private@g.us' }, () => null);
    renderCurrent(close).props.onClose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close a replacement dialog before the old React subscription cleans up', () => {
    const closeA = vi.fn(); let lateCompletion!: () => void;
    openWaDialog({ accountId: 'a', jid: 'private@g.us' }, (close) => { lateCompletion = close; return null; });
    const oldBoundary = renderCurrent(closeA);
    openWaDialog({ accountId: 'b', jid: 'visible@g.us' }, () => null);
    const replacement = dialogs.current;
    oldBoundary.props.onClose(); lateCompletion();
    expect(closeA).not.toHaveBeenCalled(); expect(dialogs.current).toBe(replacement);
  });

  it('settles the old workflow promise without closing the replacement dialog', async () => {
    const closeA = vi.fn();
    const completion = showWaDialogUntilClosed({ accountId: 'a', jid: 'private@g.us' }, () => null);
    const oldBoundary = renderCurrent(closeA);
    openWaDialog({ accountId: 'b', jid: 'visible@g.us' }, () => null);
    const replacement = dialogs.current;
    oldBoundary.props.onClose();
    await completion;
    expect(closeA).not.toHaveBeenCalled(); expect(dialogs.current).toBe(replacement);
  });
});

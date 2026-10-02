import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { client, useClient } from './app-client.ts';
import { getDialogIdentity, openDialog } from './actions.tsx';
import { closeMenu, getMenuIdentity, menuProps, openMenuAt, type MenuItem } from './menu.tsx';
import { parseKey } from './grid-keys.ts';
import { currentPaneReferences, removePanes } from './split.ts';
import { locale } from './i18n.ts';
import { waPrivacyAffected, waPrivacyLease, waSourceScope, type WaPrivacyEvent, type WaPrivacyScope } from './wa-privacy.ts';

let privacyRevision = 0;
let menuScope: WaPrivacyScope | null = null;
let menuIdentity: object | null = null;
client.subscribeWaPrivacy((event) => {
  privacyRevision++;
  removePanes(currentPaneReferences().filter((key) => { const ref = parseKey(key); return ref.kind === 'wa' && waPrivacyAffected(event, ref); }));
  if (menuScope && waPrivacyAffected(event, menuScope)) { menuScope = null; if (menuIdentity === getMenuIdentity()) closeMenu(); menuIdentity = null; }
});

export const waPrivacySyncing = () => locale().startsWith('en') ? 'Synchronizing privacy' : 'Sincronizando privacidad';
export const waPrivacyUnavailable = () => locale().startsWith('en') ? 'This WhatsApp conversation is unavailable.' : 'Esta conversación de WhatsApp no está disponible.';
export const captureWaPrivacy = (accountId?: string, jid?: string) => waPrivacyLease(client, accountId ? { accountId, jid } : undefined, accountId ? undefined : () => privacyRevision);
export const captureGgPrivacy = (source: string) => waPrivacyLease(client, waSourceScope(source) ?? undefined);

/** The callback runs synchronously on revocation, including while a request is pending. */
export function useWaPrivacy(onPurge: (event: WaPrivacyEvent) => void, scope?: WaPrivacyScope) {
  const callback = useRef(onPurge); callback.current = onPurge;
  useLayoutEffect(() => client.subscribeWaPrivacy((event) => {
    if (!scope || waPrivacyAffected(event, scope)) callback.current(event);
  }), [scope?.accountId, scope?.jid]);
  useClient((s) => s.waPrivacy);
  return scope ? client.isWaChatVisible(scope.accountId, scope.jid) : true;
}

/** Session/source changes invalidate existing callbacks even when their promise resolved before unmount. */
export function useGgPrivacy(source: string, onPurge: () => void) {
  const scope = waSourceScope(source);
  const visible = useWaPrivacy(() => { if (scope) onPurge(); }, scope ?? { accountId: '' });
  const life = useRef(0);
  useEffect(() => { life.current++; return () => { life.current++; }; }, [source]);
  const capture = () => { const generation = life.current; const valid = captureGgPrivacy(source); return () => life.current === generation && valid(); };
  return { visible: scope ? visible : true, capture };
}

/** Guard actions held by contextual menus through a lock and later unlock. */
export function guardWaMenu(scope: WaPrivacyScope, items: MenuItem[]): MenuItem[] {
  const valid = captureWaPrivacy(scope.accountId, scope.jid);
  return items.map((item) => ({ ...item,
    ...(item.items ? { items: guardWaMenu(scope, item.items) } : {}),
    ...(item.onSelect ? { onSelect: () => { if (valid()) item.onSelect?.(); } } : {}),
  }));
}
export function waMenuProps(scope: WaPrivacyScope, build: () => MenuItem[]) {
  return menuProps(() => {
    if (!client.isWaChatVisible(scope.accountId, scope.jid)) return [];
    menuScope = scope;
    // menuProps opens its menu immediately after build() returns.
    queueMicrotask(() => { menuIdentity = getMenuIdentity(); });
    return guardWaMenu(scope, build());
  });
}
export function openWaMenuAt(scope: WaPrivacyScope, x: number, y: number, items: MenuItem[]) {
  if (!client.isWaChatVisible(scope.accountId, scope.jid)) return;
  menuScope = scope; openMenuAt(x, y, guardWaMenu(scope, items)); menuIdentity = getMenuIdentity();
}

function WaDialogBoundary({ scope, onClose, children }: { scope: WaPrivacyScope; onClose: () => void; children: ReactNode }) {
  const visible = useWaPrivacy(onClose, scope);
  useEffect(() => { if (!visible) onClose(); }, [visible]);
  return visible ? <>{children}</> : null;
}
export function openWaDialog(scope: WaPrivacyScope, render: (close: () => void) => ReactNode) {
  if (!client.isWaChatVisible(scope.accountId, scope.jid)) return;
  const owned = (close: () => void) => {
    const done = () => { if (getDialogIdentity() === owned) close(); };
    return <WaDialogBoundary scope={scope} onClose={done}>{render(done)}</WaDialogBoundary>;
  };
  openDialog(owned);
}
export function showWaDialogUntilClosed(scope: WaPrivacyScope, render: (close: () => void) => ReactNode): Promise<void> {
  if (!client.isWaChatVisible(scope.accountId, scope.jid)) return Promise.resolve();
  return new Promise((resolve) => {
    const owned = (close: () => void) => {
      const done = () => { if (getDialogIdentity() === owned) close(); resolve(); };
      return <WaDialogBoundary scope={scope} onClose={done}>{render(done)}</WaDialogBoundary>;
    };
    openDialog(owned);
  });
}

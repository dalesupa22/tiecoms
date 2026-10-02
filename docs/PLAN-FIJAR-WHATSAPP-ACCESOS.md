# Plan para Codex: fijar WhatsApp en Grupos/DMs, cabecera móvil más compacta, acceso en 1 toque a Correo y WhatsApp

Fecha: 1-oct-2026. Lo pidió Danny. Base: `origin/principal` 1102667. El worktree local `tiecoms-principal` va atrás (5d44521) y tiene cambios de GIFs sin guardar de otra sesión: **no trabajar ahí**. Abrir un worktree nuevo desde `origin/principal`.
Ramas sugeridas:
- `web-fijar-wa`: API y web.
- `ios-fijar-wa`, desde `ios-temas-orden` (1.7.5 b44).
- `android-fijar-wa`, desde `android-temas-orden` (1.7.5 vc44).

Migración libre: **081** (hay hasta la 080; la 047 y la 048 se usan en ramas WIP).

---

## 1. Fijar chats de WhatsApp en la bandeja de chaggu

### Lo que ya existe (no reinventar)
- `wa_chats.pinned boolean` (migr. 007). Solo ordena la lista de la pantalla WhatsApp (`listChats`: `ORDER BY c.pinned DESC`).
- `PATCH /whatsapp/chats/:accountId/:jid` ya acepta `{ pinned }` (`apps/api/src/modules/whatsapp.ts` › `updateChat`).
- La web tiene el botón «📌 Fijar / Quitar fijado» en el detalle del chat (`apps/web/src/screens/WhatsApp.tsx:358`).
- iOS (`WaChatSheet`, `UI/MoreViews.swift:397`) y Android (`ui/WhatsAppScreen.kt:354`) lo tienen solo dentro de la hoja del chat, no en la fila.
- Ya hay un panel por chat de WhatsApp: `WaPane` / `WaChatView`, clave `wa:<accountId>:<jid>` en `apps/web/src/screens/Panes.tsx:187-240`.
- El orden y los separadores de la bandeja (Fijados · Sin leer · Recientes) salen de `apps/web/src/home-order.ts` (`compareConversations`, `bucketOf`, `withSeparators`). En iOS están en `Core/Groups.swift:382` (`InboxBucket`) y en Android en `core/HomeTree.kt:66-83`.

### Modelo (migración 081_wa_inbox_pin.sql)
```sql
ALTER TABLE wa_chats
  ADD COLUMN inbox_pinned_at timestamptz,
  ADD COLUMN inbox_place text CHECK (inbox_place IN ('groups','dms'));
```
- No reusar `pinned`, que sigue siendo «fijado dentro de WhatsApp». Así el cambio no rompe las apps publicadas.
- **Dos acciones distintas (pedido de Danny, 1-oct):**
  - **«Mover a mi lista principal»** (`inbox_place` no NULL). El chat de WhatsApp vive en la bandeja de chaggu como una conversación más: se ordena por actividad y sube a «Sin leer» cuando llega algo, sin fijarlo.
  - **«Fijar»** (`inbox_pinned_at`). Además lo deja arriba, en «Fijados». Si se fija sin haberlo movido, se mueve solo.
- `inbox_place` NULL significa que no está en la bandeja (solo se ve en la pantalla WhatsApp). Al moverlo, la sugerencia es automática: un grupo de WhatsApp va a **Grupos** y un chat 1 a 1 va a **DMs**. La persona puede elegir la otra sección.
- **Grupos y DMs siguen separados.** No se fusionan en una sola lista; Danny dice que eso nos diferencia. El chat de WhatsApp entra en una de las dos, nunca en una lista nueva mezclada. «Todo/Hoy» ya mezcla ambas, como hoy.
- Quitar = «Sacar de mi lista principal», que vuelve `inbox_place` y `inbox_pinned_at` a NULL. El chat sigue en la pantalla WhatsApp.
- Es personal, porque cada `wa_account` es de un solo usuario.

### API
- `updateChat` acepta `inboxPinned?: boolean` (true pone `now()`, false pone NULL) e `inboxPlace?: 'groups'|'dms'|null`.
- `WaChatDTO` agrega `inboxPinnedAt` e `inboxPlace` (contrato en `packages/contracts`).
- El bootstrap agrega `waInbox: WaChatDTO[]`: los chats movidos a la bandeja (`inbox_place` no NULL), fijados o no, de cuentas no removidas y no ocultos, con `unread`, `lastPreview` y `lastMessageAt`. Así la barra no tiene que pedir `/whatsapp/chats` aparte.
- Al recibir mensajes de un chat fijado, el sync ya sube `waRevision` en el cliente. Además hay que emitir `wa.pinned.updated` (o reusar el evento existente) para refrescar `waInbox` sin recargar el bootstrap.
- Si la cuenta se desconecta, la fila se muestra atenuada con «WhatsApp desconectado». No se borra.
- Pruebas en `apps/api/test/whatsapp*.test.ts`:
  - fijar y quitar
  - colocación automática por `is_group`
  - cambiar de sección
  - no se ve en el bootstrap de otra persona
  - un chat oculto no sale

### Web
- Agregar `waInbox` como **filas mezcladas** en `DmsList` (si `place='dms'`), en `GroupsList` (si `place='groups'`) y en `AllList` (`apps/web/src/screens/Groups.tsx:411-500`). Pasan por el mismo orden: si están fijadas van en «Fijados», si tienen no leídos en «Sin leer» y si no en «Recientes».
  - Truco limpio: adaptar a `ConversationDTO` sintético (`id: 'wa:'+accountId+':'+jid`, `pinnedAt: inboxPinnedAt`, `unread`, `lastMessageAt`) para pasar por `compareConversations`/`withSeparators` sin tocarlos.
  - Renderizar `WaRow` en vez de `ConvItem`.
- `WaRow`:
  - avatar con el **logo verde de WhatsApp** en la esquina (el mismo `WaIcon`)
  - nombre, y debajo «WhatsApp · {accountLabel}» en gris (como hoy sale «Xertify»)
  - contador verde de no leídos
  - 📌
- Clic: abre el chat de WhatsApp en el área principal (crear la ruta `/whatsapp/:accountId/:jid` que monte `WaChatView` a pantalla, o reusar `WaPane`). Que se pueda arrastrar a la cuadrícula con la clave `wa:...`, igual que hoy.
- Menú contextual (clic derecho o pulsación larga) en la fila:
  - «Fijar» / «Quitar de fijados»
  - «Mover a Grupos» / «Mover a DMs»
  - «Sacar de mi lista principal»
  - «Abrir en WhatsApp»
  - «Vincular a un chat de chaggu» (lo que ya existe)
- En la pantalla WhatsApp (lista y detalle) agregar al menú de cada fila: **«Mover a mi lista principal»** (con submenú Grupos / DMs y uno sugerido) y **«📌 Fijar arriba»**. Si ya está movido, mostrar «Sacar de mi lista principal».
- Los filtros «Sin leer» y «Menciones» de la barra: un WhatsApp fijado con no leídos cuenta en «Sin leer» y no cuenta en «Menciones».
- i18n es/en en `apps/web/src/i18n.ts`: `wa.pinInbox`, `wa.unpinInbox`, `wa.moveGroups`, `wa.moveDms`, `wa.disconnected`.

### iOS / Android
- Mismo modelo: leer `waInbox` del bootstrap y mezclarlo en Grupos o DMs con el mismo orden.
  - iOS: `InboxBucket.split`, `Naming.groupsList`, `Groups.dms`.
  - Android: `HomeTree.comparator` / `GroupsTree.buildList` / `HomeScreen.kt:468`.
- La fila lleva el `WaIcon` en el avatar (iOS `UI/MailViews.swift:10-59`, Android `ui/MailIcons.kt:69`). Al tocarla abre el `WaChatSheet` / la pantalla de chat de WhatsApp.
- Pulsación larga con el mismo menú que la web.
- **Agregar deslizar para fijar/quitar en todas las filas** (chaggu y WhatsApp). Hoy en iOS y Android solo se puede con pulsación larga, y hacen falta 2 toques.
- En la lista de WhatsApp móvil, el menú largo de la fila hoy solo cambia la categoría (`MoreViews.swift:170`). Agregarle «Mover a mi lista principal» y «Fijar».

---

## 2. Cabecera de Grupos/DMs en móvil: se pierde mucho espacio

Hoy, en iOS (`UI/HomeView.swift`), hay de arriba abajo:
1. barra con ≡, ＋ y ✎
2. título «Grupos»
3. Lista | Árbol (segmentado)
4. chips Todo · Sin leer · Menciones · Asuntos
5. fila «Recordatorios (3)»

Son unos 5 renglones (≈260 pt) antes del primer chat. Android es parecido (`ui/HomeScreen.kt:201-257`).

Propuesta:
- **Quitar el segmentado Lista | Árbol** y pasarlo a un ícono de alternar junto a ≡ (`list.bullet` ↔ `list.bullet.indent`), o dentro del menú ≡. Ahorra un renglón.
- **Recordatorios como chip** al final de la fila de filtros («🔔 3»), no como fila propia. Si es 0, no sale. Ahorra otro renglón.
- Título inline más pequeño: dejarlo en la barra al lado de ≡ (iOS ya es `.inline`; no volver a `.large`, que congela iOS 26). Android: `TopAppBar` compacto.
- La barra de búsqueda solo aparece al bajar o al tocar 🔍. En iOS hoy está siempre visible por el arreglo del cuelgue; probar `searchable(... placement: .navigationBarDrawer(displayMode: .automatic))` y, si vuelve el cuelgue, dejar un 🔍 en la barra que abra la búsqueda.
- Resultado: barra (≡ · Grupos · 🔍 ＋ ✎) + **una sola fila** de chips (accesos de canales + filtros + 🔔). Se ganan unos 2,5 renglones de chats.

## 3. Correo y WhatsApp en 1 toque, con su logo

Hoy en el móvil son 2 toques (Tú → WhatsApp / Correo, o Todo → píldora) más la cuenta. En la web el riel ya los deja a 1 clic.

Propuesta (es lo de los «loguitos»):
- **Fila de accesos con logo** al inicio de la fila de chips de Grupos y DMs. Solo salen los canales conectados:
  - `[🟢 WhatsApp 99+]` y `[Gmail 12]` / `[Outlook 3]`, cada uno con su logo dibujado (`WaIcon`, `MailProviderIcon`) y su contador
  - un toque abre directo la lista de WhatsApp o la bandeja de correo
  - si hay varias cuentas, abre la última usada; con pulsación larga se elige la cuenta
- Contadores: WhatsApp de `GET /whatsapp/chats?limit=1` (`categories[*].unread`, como `useWaUnread` en `Rail.tsx:41`). Correo de `GET /mail/unread`, con caché de 60 s como en la web.
- Así, cuando la persona tiene correo, WhatsApp y chaggu conectados a la vez, ve los tres logos arriba y salta entre ellos con un toque.
- Opcional, solo si Danny lo aprueba: cambiar la pestaña «Todo» o «Llamadas» de la barra inferior por «Bandeja» (correo + WhatsApp). La decisión del 27-sep fue no tocar la barra de pestañas, así que **no hacerlo sin preguntar**.

## 4. Orden de trabajo sugerido
1. Hacer la migración 081, la API, los contratos y las pruebas.
2. Hacer la web: filas de WhatsApp en Grupos/DMs, menú (mover, fijar, sacar) y ruta del chat.
3. Mostrarle la web a Danny en local antes de desplegar. Se despliega con `npm run deploy` desde la punta de `principal`; antes, revisar `/opt/tiecoms/RELEASE`.
4. Hacer iOS y Android: filas fijadas, deslizar, cabecera compacta y accesos con logo. Subir build: 1.7.6 (o la siguiente libre; `ios/android-llamada-rapida` ya usan la 45). Nada va a las tiendas sin que Danny lo diga.

Nota: la «›» gris del borde izquierdo en la captura de iOS no es de chaggu (no hay cajón en el código). Es de iOS o de otra app, así que no hay que tocarla.

# Cuadrícula: correos, WhatsApp y chats en paralelo

Hasta **4 paneles** a la vez (`apps/web/src/split.ts`). Un panel es un **chat de chaggu**, un **correo** de tu buzón (con su diseño) o una **conversación de WhatsApp** (sus mensajes). Pedido de Danny, 30-sep-2026.

## Qué es un panel

Un chat de chaggu, un correo, una conversación de WhatsApp o una **sección entera**: **Tareas** (la lista con sus filtros), **Correo** (la bandeja completa con búsqueda y filtros; al tocar un correo se abre ahí mismo, con «← Bandeja») y **WhatsApp** (todas las conversaciones; se abre una adentro, con «← Conversaciones»). Las secciones se arrastran desde el **riel** (Tareas, Correo, WhatsApp), o con el botón Fijar de su página.

## Responder desde el panel

- **Correo:** botón *Responder* en el correo abierto; sale ya, desde tu Gmail u Outlook, en el mismo hilo (`POST /api/v1/mail/messages/:provider/:id/reply`, sin traerlo antes a un chat; copia a quien tú elijas).
- **WhatsApp:** caja de texto bajo los mensajes. Solo si la cuenta tiene **Responder desde chaggu** (apagado por defecto: el panel lo ofrece con el aviso del riesgo). Ver `docs/WHATSAPP.md`.

## Las dos acciones

| | Qué se lleva | A dónde | Resultado |
|---|---|---|---|
| **1 · A un chat** | un correo, o un mensaje de WhatsApp | un chat | tarjeta en ese chat (`POST /mail/share`, `POST /whatsapp/share`) |
| **2 · A un cuadrito** | un correo, una conversación de WhatsApp o un chat | un cuadrito de la cuadrícula | panel **fijado** |

Reglas de sentido común: una conversación de WhatsApp no se suelta sobre un chat; un mensaje suelto no se abre en un cuadrito (solo viaja a un chat); el inbox completo no se arrastra.

## El problema de WhatsApp y Correo

WhatsApp (`/whatsapp`) y Correo (`/correo`) son páginas completas: la cuadrícula no se ve ahí. Tres formas de llegar a ella sin salir:

1. **Bandeja** (`screens/Tray.tsx`, `DragTray`): al arrastrar algo que tiene destino, sube desde abajo con dos zonas: *1 · Llevar a un chat* (los chats recientes y fijados) y *2 · Llevar a un cuadrito* (mapa 2×2 con lo que hay en cada uno). La zona que no aplica se apaga y dice por qué. No aparece si la cuadrícula ya se ve.
2. **Riel**: el ítem *Cuadrícula* es un 2×2 vivo con contador (n/4); fijados en naranja. Entrar guarda de dónde vienes para el «← Volver» (`/cuadricula`).
3. **Cuadrícula al lado**: botón en WhatsApp y Correo (`GridSideButton`); parte la pantalla. Ahí los paneles van uno sobre otro.

Sin arrastrar: el botón **Fijar** de cada fila (`PinToGrid`) abre un mini mapa para elegir el cuadrito. El ⠿ de un mensaje de WhatsApp o «Llevar a un chat» de un correo abren el diálogo de siempre.

## Cómo está hecho

- `grid-keys.ts` (puro, con pruebas): claves de los paneles. Un chat conserva su id; `mail:<google|microsoft>:<id>` y `wa:<cuenta>:<jid>`. `placeInto` y `replaceIndex` deciden dónde cae algo y qué panel cede (un fijado nunca cede).
- `split.ts`: paneles, fijados, nombres, cuadrícula al lado, arrastre en curso y «volver». Todo en `localStorage` (`chaggu:split*`, `chaggu:grid-side`).
- `grid-actions.ts`: lo que se hace al soltar (`shareToChat`, `openInGrid`, `pinToSlot`).
- Tipos de arrastre (`dataTransfer`): `application/x-chaggu-conversation|mail|wa|wamsg`. El tipo dice qué es mientras se arrastra, así la bandeja sabe qué zona apagar.
- `screens/Split.tsx` (`GridArea`): vive en `/c/:id`, `/cuadricula` y al lado de WhatsApp/Correo. `screens/Panes.tsx`: `MailPane` y `WaPane`.
- API: `GET /api/v1/mail/messages/:provider/:id/html` (HTML limpio del correo en vivo, para verlo con su diseño en la vista previa y en el panel).

## Pendiente a propósito

Arrastrar una tarea suelta a un chat; adjuntos al responder un correo en vivo; la bandeja en pantallas táctiles (hoy la cuadrícula solo existe desde 860 px de ancho).

## Recoger paneles (2-oct-2026)

Botón **▁** en la cabecera de cada panel (aparece con 2 o más a la vista): el panel sale del dibujo pero sigue abierto (no pierde lugar, color ni fijado) y queda como pestaña en la barra **Recogidos** de arriba, con sus no leídos. Un clic en la pestaña lo devuelve; **Mostrar todos** devuelve todos; **Recoger los demás** (en la barra de Diseño) deja solo el activo. Siempre queda uno a la vista, y abrir un chat recogido desde la lista lo devuelve. En «Paneles a tu medida», mientras haya recogidos los demás se reacomodan y el que queda solo en su columna crece a lo alto (solo el dibujo: las posiciones guardadas vuelven al devolverlos). Código: `apps/web/src/grid-collapse.ts` (aparte de split.ts), `GridDock` en `screens/Split.tsx`, estilos en `screens/GridDock.css`. Se guarda en `localStorage` (`chaggu:split-collapsed`).

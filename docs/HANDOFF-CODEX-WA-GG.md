# Para Codex: lo que sigue después de «WhatsApp en la bandeja + gg de este chat» (1-oct-2026)

## Ya está hecho (no repetir)
- **Web + API en producción**: release `20261002005838-d28eca8`, migraciones 081 (`wa_chats.inbox_place`, `inbox_pinned_at`) y 082 (`gg_side_messages`, `gg_side_state`). `principal` = `main` = `b9140f3` (incluye la fusión de `temporal/desktop-gifs-035`).
- Contrato: `docs/CONTRATO-GG-CHAT-WA-INBOX.md`. Lo implementado y las desviaciones están en `docs/WA-BANDEJA-GG-CHAT.md`, ambos en el repo.
- **WhatsApp en Grupos/DMs**:
  - Acciones: «Mover a mi lista principal», «Fijar arriba», «Mover a Grupos/DMs», «Sacar». Grupos y DMs siguen separados.
  - Ruta `/whatsapp/:accountId/:jid`.
  - Código web: `apps/web/src/screens/WaInbox.tsx`.
- **gg de este chat** (`apps/api/src/modules/gg-side.ts`, `apps/web/src/screens/GgSide.tsx`):
  - Botón gg con pendientes en el encabezado y un hilo privado por persona + chat (chaggu o WhatsApp).
  - Chips de seguimiento, citar y Nueva conversación.
  - Responder por mí, con 3 borradores y chips de tono.
  - Seleccionar varios → «Pedir a gg (N)», con sugerencias que se marcan con casilla.
  - Nada se ejecuta solo: los borradores van al compositor y las tareas o recordatorios abren su diálogo ya lleno.
- **Escritorio 0.3.6 PUBLICADO**: dmg firmado+notarizado, exe y msi (es-ES) en `/opt/tiecoms/downloads`, `latest.json` y `ops.js app-version` mac/windows 0.3.6 (build 306). Tag `desktop-v0.3.6`; archivos en `release-assets/desktop-0.3.6`.
  - Ojo: la 0.3.5 ya era pública (la de GIFs de otra sesión); por eso esta es la 0.3.6. Siguiente: **0.3.7**.
- **iOS / Android 1.7.7**:
  - Ramas `ios-wa-gg` y `android-wa-gg`. Traen la bandeja de WhatsApp, deslizar para fijar, la cabecera compacta, los logos de WhatsApp/Gmail/Outlook a un toque y gg de este chat.
  - **iOS 1.7.7 (47)** en TestFlight (VALID), rama `ios-wa-gg` 832ad08 (incluye `ios-sin-insignia`). IPA en `release-assets/1.7.7/ios/`. NO enviado a revisión.
  - **Android 1.7.7 (47)** en prueba interna de Play, rama `android-wa-gg` cb4657f (incluye `android-sin-insignia`). AAB en `release-assets/1.7.7/android/`. Producción sigue en 1.7.5 (44).
  - Se saltó el build 46 a propósito (podía estar en uso en otra rama). Siguiente libre: **48**.
  - `app_releases` (aviso de actualización) sigue sin subir a 1.7.7/47: solo cuando Danny decida sacarlo a tiendas.

## Lo que sigue (tu tanda)
1. **Workflows de la empresa por cargo**, del mockup «Mockup invitación por mensaje»:
   - Ejemplos de workflow: radicar factura, abrir ticket, propuesta comercial, lead al CRM y llenar documento.
   - Matriz de workflows × cargos. Antes hay que decidir qué es un «cargo»: un campo nuevo o los grupos que ya existen. Hay que preguntarle a Danny.
   - Tipos de paso: prompt con salida fija, MCP (solo las herramientas permitidas), API, «Preguntar a una IA» (Claude / ChatGPT / ambos como segunda opinión), llenar documento, condición, aprobación humana, firma (ya existe firmar PDF) y responder en el hilo.
   - Registro de ejecuciones, «corre como» la persona o una cuenta de servicio, y desde dónde se puede lanzar. Desde chats con otras empresas va apagado por defecto, salvo abrir ticket.
   - Seguridad: el texto de correos y mensajes es dato, nunca instrucción. Todo lo que escriba afuera (Siigo, CRM, firma) pasa por aprobación humana.
   - En la lámpara «Pedir a gg», los workflows que encajan suben con la etiqueta «Encaja». Si tu cargo no lo tiene, sale «Pasarle a Finanzas: …».
2. **Proponer 3 horarios** desde gg con el calendario de Google, que todavía no está conectado en chaggu. Al enviar, gg aparta los horarios.
3. **Pendientes chicos de la web**:
   - «Hacer estas N» con dos tareas abre solo el último diálogo, porque los diálogos no hacen cola.
   - Los contadores del riel de Grupos/DMs no suman los no leídos de WhatsApp de la bandeja; es a propósito, para no contarlos dos veces.
4. **Pendientes chicos del móvil**:
   - iOS: «Mover a mi lista principal» desde la pantalla WhatsApp está hecho pero la prueba automática no llegó ahí; probarlo a mano.
   - iOS/Android: en WhatsApp, «Responder por mí» copia al portapapeles (las apps no envían WhatsApp). El recordatorio sin chat de chaggu vinculado se vuelve tarea personal con fecha.
   - Android: no se vio en pantalla con sesión real (emulador sin login); toca recorrerlo en un teléfono. `HubShortcuts` (pestaña Todo) aún pide `/whatsapp/chats` completo en vez de `?limit=1`.
   - Bug viejo iOS: el aviso dentro del chat muestra «1 sin leer en «{name}»» crudo.
5. **Ventana de Windows sin firma** hasta que Microsoft apruebe la identidad de XERTI, INC.

## Reglas
- La rama canónica es `principal` (main va igual).
- Antes de desplegar, mira `/opt/tiecoms/RELEASE`; si hay un sha que no está en origin, tráelo primero.
- Nada va a la App Store ni a producción en Play sin que Danny lo diga.
- **No metas nada del video para VCs** que hace otra sesión. Lo pidió Danny.

## Entorno de prueba que quedó prendido
- Postgres de pruebas en Docker `chaggu-wa-gg-pg`, puerto 55481, con las migraciones hasta la 082 y cuentas de prueba (no es el 55432 de otro agente). Worktrees: `tiecoms-web-wa-gg`, `tiecoms-ios-wa-gg` y `tiecoms-android-wa-gg`. `.claude/launch.json` tiene `wa-gg-web` (5481).
- `principal` es la base de todo. Las ramas nativas *-wa-gg son la punta de la línea móvil 1.7.7: arranca ahí las mejoras de iOS/Android, no en *-temas-orden.

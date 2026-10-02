# Contrato aditivo de la tanda nocturna

Implementación autorizada por Danny. Base `origin/principal` 2aba921; conserva contratos WA inbox/gg de migraciones 081/082. API, contracts y client-core tienen un único dueño. Móvil solo TestFlight/Play interno; este documento no acredita despliegue ni dispositivos físicos.

## N02: procedencia de adjuntos

`AttachmentDTO.provenance?`: `{ version: 1, provider: 'openverse'|'memegen'|'klipy', title: string, attribution: string, sourceUrl: string|null, author?: string|null, license?: string|null, licenseUrl?: string|null }`. Solo el servidor la genera desde el token firmado/cifrado de catálogo. `SendGifResult.attribution` sigue completo para clientes anteriores. `MessageDTO.displayBody?` es el comentario original generado por servidor; `body` conserva créditos completos para clientes legados. Render/copy/edit usa displayBody ?? body. Nuevos clientes muestran créditos compactos y ficha completa; ocultan atribución del body únicamente si coincide exactamente con `provenance.attribution`, nunca por prefijo GIF. Edición/reenvío conservan metadata, una sola vista la sella. Fotos comunes no tienen procedencia ficticia.

## N11/N17: preferencias de Tareas

`PersonalPreferencesDTO.issues?`: `{ view?: 'list'|'cards'|'board', grouping?: 'group'|'assignee', filter?: 'mine'|'open'|'completed' }`. `PATCH /api/v1/me/personal-preferences` aplica merge atómico por campo; devuelve preferencias completas. PUT legado conserva claves nuevas no presentes y mantiene reemplazo de sections/conversations cuando el cliente las envía explícitamente. No enviar un documento completo viejo para guardar una preferencia nueva. Cada cuenta conserva su propia configuración.

## N20: disponibilidad efectiva

`me.availability?` y `PersonDTO.availability?`: `{ mode: 'available'|'busy'|'focus'|'dnd'|'rest'|null, until: string|null, silent: boolean, revision: number }`. Ausente o mode=null es desconocido, no online. `PUT /api/v1/me/availability { mode, until? }` establece modo manual; los modos silenciosos requieren duración futura explícita. `mode:null` termina modo manual; disponible/ocupado no levanta DND/sueño vigentes. DND/sleep legados siguen activos; prioridad efectiva DND/manual silencioso/horario sueño/manual informativo. Evento `person.availability { userId, availability }` solo llega a la audiencia visible actual. Worker revisa vencimientos y límites de sueño cada minuto, emite revisión nueva solo al cambiar; UI respeta until localmente durante ese margen. Estado público no contiene horarios ni motivos privados. Mantener política de sueño/DND en avisos y llamadas entrantes, sin detener llamadas activas.

## N22: multimedia WA privada y copia al destino

`WaMessageDTO.media?`: `{ status: 'pending'|'ready'|'failed'|'unavailable'|'restricted', attachment?: AttachmentDTO|null, error?: string|null }`; attachment del inbox tiene URL autenticada `GET /api/v1/whatsapp/media/:accountId/:jid/:messageId`, solo dueño. No son IDs canónicos exportables ni contienen claves/URLs del proveedor. `POST` en la misma ruta reintenta una descarga fallida si conserva sobre original y cuenta propia.

`SharedMailDTO.chagguAttachments?: AttachmentDTO[]` contiene únicamente copias canónicas asociadas al mensaje compartido; `SharedMailDTO.mediaStatus?` usa los estados anteriores. `ShareWaInput.clientMessageId?` es clave de idempotencia de 1–64 caracteres. Compartir foto/PTT lista descarga original privada, valida origen/destino, crea objeto/asociación independiente; destinatario usa `/attachments/:id` y no requiere WA de origen. PTT es kind=voice, durationMs, aiConsent=false; originales legacy sin sobre siguen unavailable. Vista única/efímero restringidos no se vuelven archivos permanentes.

## N24: recencia y páginas WA

`GET /whatsapp/chats` admite `cursor?` opaco y devuelve además `next?: string|null`, `hasMore?: boolean`, `syncPartial?: boolean`. Orden existente pinned DESC, lastMessageAt DESC NULLS LAST añade desempate accountId/JID. Cursor conserva mismo alcance de usuario/filtros. Clientes anteriores ignoran campos nuevos. No tocar orden unread-first de WA incorporado a Grupos/DMs por contrato 081; Recientes/Todos aplica solo pantalla WA. Reconnect invalida snapshot WA. Envío confirmado se reconcilia con eco usando ID/timestamp proveedor.

## N25: carga dirigida y lectura

`GET /api/v1/conversations/:id/messages/around?messageId=UUID&limit=50 (o seq=entero)` devuelve página autorizada alrededor del ID; nunca contenido anterior a historyFromSeq. El cliente resuelve primer pendiente pertinente de su filtro y usa carga dirigida, con guard de cuenta/chat después de awaits. `read.updated` y los ACK de read/unread/read-tree agregan revisión opcional `readRevision`; el cursor puede disminuir con markUnread deliberado. Sin revisión, conservar compatibilidad mediante resync; no tratar ACK fallido como confirmado.

## N16: texto íntegro generado por gg

Body sigue string y dialecto existente. Respuesta gg mayor que 8.000 caracteres se publica como archivo UTF-8 canónico con caption corto; conserva original íntegro y permisos existentes, sin añadir gg al grupo. Los clientes usan AttachmentDTO normal y descarga autenticada. Conversión local del compositor mantiene cero red hasta Enviar; máximo inicial 1 MiB UTF-8 para conversión automática, diez adjuntos y límites generales existentes. No permitir acceso implícito de gg a todos los archivos.

La implementación y pruebas de cada sección se registrarán con commit y límites reales al concluir; no inferir soporte de proveedor/licencia ni pruebas físicas desde este contrato.

## N29: propuestas de calendario con datos reales

`POST /api/v1/gg/calendar/slots {source,messageIds?,from,to,durationMin,timezone}` devuelve `{status:'ready'|'needs_connect'|'reconnect'|'error',provider:'google'|'microsoft'|null,checkedAt:string|null,timezone,slots:[{startsAt,endsAt}]}`. Hasta tres opciones tras consultar agenda Chaggu propia y calendario del proveedor conectado (Reuniones existente, primary owned events); sin conexión/error no hay slots ni afirmar calendario verificado. Ventana máxima 31 días y duración 15–240 minutos. Fuente c:/wa: y selección se reautorizan; no se interpreta texto de terceros como orden.

`POST /api/v1/gg/calendar/confirm {source,messageIds?,provider,idempotencyKey,title,startsAt,endsAt,timezone,conversationId?,shareToChat?}` devuelve MeetingDTO. El usuario confirma el diálogo; recheck fresco bajo lock por dueño evita solapamientos de confirmaciones propias. Reutiliza creación/recuperación idempotente de Reuniones. Solo `shareToChat:true` publica al chat/calendario Chaggu explícitamente elegido. Campos opcionales: description≤4000, attendeeEmails≤20 correos explícitamente capturados en el diálogo, inviteeIds≤20 usuarios explícitos que deben ser miembros del chat elegido. No inferir destinatarios por nombres WA. El proveedor invita solo attendeeEmails explícitos; agenda Chaggu compartida usa inviteeIds, ausente implica solo organizador para este flujo. Reuniones legadas conservan su semántica y fingerprint original cuando no contienen estos campos.


`slots` ready también devuelve calendar:'primary', scope:'owned-primary-and-chaggu'. No promete revisar calendarios compartidos/secundarios ni la agenda de invitados. `GgSideAskInput` y `GgSideSuggestInput` admiten calendar?:{from,to,durationMin,timezone}: un único check fresco por gesto, resultado persistido en extra.calendar y devuelto en calendar para suggest. Sin ventana estructurada pero con intención de agenda se devuelve needs_clarification, checkedAt:null, slots:[], sin inferir fechas ni ejecutar. La ausencia de consentimiento IA sigue prohibiendo ask/suggest.

## Validación y límites de esta entrega

Migraciones 083/084 aditivas, sin secretos/datos privados de producción. Pruebas aisladas API/core verifican preferencia por cuenta/merge concurrente; tres responsables y tarea hija/ACL; metadata y comentario; carga dirigida/historial/revisiones; 1003 conversaciones WA con páginas estables; copia de foto/PTT con bytes originales, opt-out IA, variante local AAC, restricciones temporales e idempotencia; calendario falso a través del adaptador real con busy/recheck/invitados explícitos; texto UTF-8 completo gg y reintento; invitados únicos y capacidad atómica, heartbeat compartiendo IP, salida sin expulsar otros.

La descarga automática WA conserva cifrado el sobre original autorizado; dos originales máximo por trabajo, una cuenta descargando en segundo plano, límite25MiB y tiempo acotado. No bloquea envíos, leases o reconexión. Desconectar elimina originales por jobs propios de ese prefijo; copias ya compartidas permanecen sujetas a ACL/retención del destino. Legacy sin original sigue unavailable; no se promete recuperar contenidos caducados. Validación mock no acredita animación/audio físico, OAuth real, conexión Google de Danny, envío de invitación real, ni llamada Amazon Chime en dispositivo.

Resultado local registrado: 14/14 pruebas nuevas API, 3/3 core, 10/10 GIFs existentes (27 total); typecheck API/contracts/core y diff-check correctos. Migraciones001–084 aplicadas a base vacía dedicada tiecoms_nocturna_20261001_fresh en PostgreSQL Docker localhost55481, sin mutar fixture previo ni producción. Las pruebas de proveedor son explícitamente falsas; no enviar invitaciones ni audios reales. Despliegue y prueba visual/distribución pertenecen al proceso de publicación, siguen pendientes de sus recibos.

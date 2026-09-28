# gg — el asistente de chaggu

gg (se pronuncia «yiyi») responde, reporta y actúa por la persona, por texto o por voz. Rama del API y la web: `asistente`. Móviles: `ios-asistente` y `android-asistente`.

## Dónde vive (igual en web, iOS y Android)
- Burbuja pequeña (≈42 pt) abajo a la derecha, justo encima de la barra de pestañas, como Meta AI en WhatsApp.
  - Solo aparece en las listas: Grupos, DMs, Asuntos, Calendario y Tú/Ajustes. **Dentro de un chat no aparece.**
  - Fondo claro, borde fino y el símbolo ✦ en el color de acento. No tapa las filas: el final de la lista tiene margen.
- **Tocar** abre el panel: hoja inferior al 86 % de alto en el móvil; panel derecho de 400 px en la web de escritorio.
- **Mantener presionado** (0,45 s) abre el panel y empieza a escuchar. Al soltar, envía lo dicho.
- La barra de 5 pestañas no cambia.

## Panel
- Encabezado: ✦ gg · botón de voz alta (🔊/🔇, se guarda en el dispositivo) · «Nueva conversación» (⟲) · cerrar.
- Vacío, al abrir: «Hola, {nombre}. Soy gg, ¿en qué te ayudo?», una línea de ayuda y **chips de sugerencias**:
  - Se envían de una vez: «Dame un reporte de lo que hay», «Responde mis pendientes», «¿Qué vence hoy?».
  - Rellenan el campo para completarlo: «Escríbele a…», «Crea un grupo con…», «Agenda una reunión mañana a las 10 con…», «Crea un asunto para…» y «Cancela la reunión de…».
  - Debajo, un tip: «mantén presionada la burbuja ✦ para hablar».
- Burbujas de conversación: las de la persona a la derecha, en tinta; las de gg a la izquierda, en gris. Mientras piensa, tres puntos.
- Tarjetas de acción debajo de cada respuesta de gg (ver «Acciones»). Si hay más de un borrador pendiente, aparece el botón «Enviar todos (N)».
- Abajo: un campo «Pídele algo a gg». Con texto muestra el botón ↑; vacío, muestra 🎤.
- Si la persona dice o escribe «envíalos», «mándalos», «dale» o «sí, envía» con borradores pendientes, se confirman todos en el dispositivo, sin llamar al API de turn, y gg responde «Listo, envié N.».
- Voz de entrada: iOS con Speech (SFSpeechRecognizer, es-CO / en-US); Android con SpeechRecognizer. Mientras escucha: franja con onda, el texto parcial y el botón «Listo».
- Voz de salida: si la entrada fue por voz o el 🔊 está activo, lee la respuesta (AVSpeechSynthesizer / TextToSpeech). **Antes de leer, cambia la palabra «gg» por «yiyi».**
- Historial: solo en el dispositivo, por usuario (clave `assistant:<userId>`), últimos 40 turnos. Se borra al cerrar sesión, y el de otra cuenta se descarta al abrir.

## API (misma sesión Bearer de siempre)
`POST /api/v1/assistant/turn` (30 por minuto)
```json
{ "messages": [{ "role": "user|assistant", "content": "…" }], "timezone": "America/Bogota", "lang": "es" }
```
- Se mandan los últimos 20 turnos.
- Si un turno de gg tuvo acciones, se agrega a su `content` un resumen `\n[estado: tipo → destino: texto | …]`, sin tokens.
- Respuesta: `{ "reply": "texto para mostrar y leer", "actions": [AssistantActionDTO] }`.
- Errores: 503 `assistant_unavailable` («gg no está disponible ahora mismo») y 502 `assistant_failed`.

`POST /api/v1/assistant/run` con `{ "token": "…", "text": "opcional: texto editado de un mensaje" }`
- Con `token` confirma una acción pendiente; con `undoToken`, la deshace.
- Devuelve el `AssistantActionDTO` actualizado (`status` done o undone; `undoToken` y `link` cuando aplican).
- 403: el token es de otra persona. 410: venció (30 min los pendientes, 10 min los de deshacer).

`AssistantActionDTO` (en packages/contracts):
```
id, kind: send_message | create_group | create_issue | update_issue | create_event | cancel_event | mark_read,
status: pending | done | failed | undone, target (a quién o dónde), text, detail?, token?, undoToken?, link? (/c/<id>, /agenda), error?
```

## Acciones (tarjetas)
- **pending** (send_message, create_group, cancel_event):
  - Borde de acento; en cancel_event, borde rojo y texto tachado.
  - Botones: principal (Enviar / Crear / Cancelar reunión), «Editar» solo en mensajes (el texto se vuelve un campo y se manda como `text`) y «Descartar», que es local.
- **done**: etiqueta verde «Hecho», botón «Abrir» si trae `link` (/c/<id> abre el chat; /agenda abre Calendario) y «Deshacer» si trae `undoToken`.
- **undone**: atenuada, con «Deshecho». **failed**: «No se pudo» y el mensaje de error.
- Íconos por tipo: ✉ mensaje, ▦ grupo, ◆ asunto, ✓ actualizar asunto, ▤ reunión, ⊘ cancelar y ◉ leído.

## Skills del servidor (DeepSeek)
- **Solo consultan:** reporte, leer_conversacion, listar_asuntos y listar_eventos.
- **Piden confirmación:** enviar_mensaje, crear_grupo y cancelar_evento.
- **Se hacen de una vez, con Deshacer:** crear_asunto, actualizar_asunto (completar, reasignar o cambiar fecha), crear_evento y marcar_leido.
- Lo que no puede hacer lo dice: «todavía no puedo ayudarte con eso».

## Aislamiento
- Todo corre con el `userId` de la sesión.
- El modelo solo ve el bootstrap de esa persona. Cada id se valida contra ese directorio y luego contra los permisos normales de la app.
- Los tokens van firmados con el `userId`.
- El texto de los chats se trata como datos, no como órdenes.
- Pruebas: `apps/api/test/assistant.test.ts`, con un DeepSeek falso «atacante».

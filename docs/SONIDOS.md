# Sonidos

Pedido de Danny (29-sep-2026).

## Qué se puede elegir

- **10 sonidos de mensaje**: `pop`, `gota`, `campana`, `marimba`, `burbuja`, `cristal`, `acorde`, `silbido`, `tambor` y `brisa`. También está `none`, que es sin sonido.
  - Una mención suena con el mismo sonido, una quinta más aguda.
- **3 tonos de llamada**: `clasico`, `suave` y `marimba`. El tono se repite cada 2,2 s mientras suena el aviso de llamada entrante, y para al contestar, al rechazar, a los 45 s o cuando la llamada termina.
- Los nombres viven en `@tiecoms/contracts`, en `MESSAGE_SOUNDS` y `RINGTONES`.

## Dónde se elige

Todo se guarda en el servidor, así que se ve igual en todos los dispositivos.

- **Por chat:** en el panel **Detalles › Sonido** o con clic derecho sobre el chat › **Sonido**. Se va a `PUT /conversations/:id/prefs {sound}`, donde `null` significa usar el predeterminado.
  - Llega en `ConversationDTO.sound`.
- **Predeterminado y tono de llamada:** en **Ajustes › Notificaciones**. Se va a `PUT /me/sounds {messageSound, ringtone}`.
  - Llegan en `UserDTO.messageSound` y `UserDTO.ringtone`. Los de fábrica son `pop` y `clasico`.
- La casilla «Sonido de mensajes» sigue apagando todos los sonidos de mensaje en este dispositivo. El tono de llamada no depende de esa casilla.

## Implementación

- **Web:** WebAudio, sin archivos. Las recetas de notas están en `apps/web/src/sound.ts` (`MESSAGE_RECIPES` y `RINGTONE_RECIPES`).
- **Móvil:** un archivo por nombre (`<nombre>.caf` en iOS y `res/raw/<nombre>.ogg` en Android), generado con las mismas notas. La notificación push local usa el sonido del chat.
- **Push remoto:** queda pendiente mandar el nombre del sonido en el push, para que suene con la app cerrada.

La migración es `035_sounds.sql`.

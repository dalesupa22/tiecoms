# Temas del chat

Pedido de Danny (28-sep-2026). Un chat sigue siendo un solo chat. Los **temas** son etiquetas que se le ponen a los mensajes, y se muestran como banderitas en una fila arriba del chat.

Los temas no son hilos ni tareas:
- Un **hilo** es una conversación aparte que se abre desde un mensaje, y sigue igual que antes.
- Una **tarea** es lo que antes se llamaba «asunto». En la interfaz ahora dice «Tareas».

## Reglas (iguales en web, iOS y Android)

- No hay límite práctico de temas activos. Danny lo pidió el 28-sep-2026, después de probar con 5. `TOPIC_LIMIT` = 50 es solo un tope técnico, y los archivados no cuentan.
- Cualquiera que pueda escribir en el chat puede crear, renombrar, cambiar de color, archivar o quitar un tema.
- Cualquiera también puede etiquetar **cualquier mensaje**, sea suyo o de otra persona. Queda registrado quién le puso el tema (`topicBy`), y la interfaz muestra «tema puesto por X» cuando no fue el autor del mensaje.
- **Fila de banderitas**: va debajo de los chips (Fijados, Tareas, Hilos, Agenda, Enlaces) y tiene scroll horizontal.
  - La primera es «💬 General» y la segunda «☰ Todo» (sin temas activos, una sola banderita «Todo»).
  - Después van los temas activos y «＋ Nuevo». Orden (Danny, 30-sep-2026): primero los temas con algo **sin leer para mí**, y luego el resto; los dos grupos en el **orden guardado del chat** (por defecto el de llegada; se cambia arrastrando, `PUT /conversations/:id/topics/order`). Entre los no leídos no se ordena por hora. Un tema nunca sale dos veces, y al leerse vuelve a su lugar. El bloque de no leídos es solo presentación: arrastrar mueve el tema dentro del orden guardado. En web el cálculo vive en `apps/web/src/topic-order.ts` (`orderTopicsForDock`), con los mensajes que tiene el cliente (seq > lo leído y `topicId`); no hace falta nada del API.
  - Al final va «Archivados N», si hay alguno.
- **Tres vistas** (pedido de Danny, 29-sep-2026, reemplaza la regla anterior de «Todo» con los no leídos):
  - **General** (así abre el chat): solo los mensajes **sin tema**, sin las tarjetas de tareas de un tema. Los mensajes de temas archivados cuentan como sin tema.
  - **Todo**: todos los mensajes, cada uno con su etiqueta.
  - **Un tema**: solo sus mensajes y las tarjetas de sus tareas. Tocar la misma banderita otra vez vuelve a General.
- **Lo que se escribe** en General o en Todo sale sin tema. Dentro de un tema sale con ese tema, y el campo lo indica con «Mensaje en X».
- **Abrir o saltar a un mensaje concreto** (burbuja de mensaje nuevo, notificación del navegador o del escritorio, mención, búsqueda, enlace o `?m=`) deja el chat filtrado en el tema de ese mensaje, con scroll y resaltado en él. Si el mensaje no tiene tema (o su tema está archivado), queda en **Todo**, no en General (Danny, 30-sep-2026). Si ya estaba en Todo, no cambia nada. Los temas se esperan antes de decidir: antes, si no habían llegado todavía, el chat siempre quedaba en General.
- **El número de cada banderita** es lo que tiene **sin leer**. En General es lo sin leer que no tiene tema. Así no se pierde lo que llega a un tema mientras estás en General. Sin pendientes, no sale número. Los mensajes propios y los de sistema no cuentan.
- **Al abrir un chat desde la lista con no leídos** (sin un mensaje concreto): abre en el tema del **primer no leído**, en ese mensaje y con la línea «N mensajes nuevos». Si ese primer no leído no tiene tema, abre en General. Sin no leídos, abre en General como siempre.
- **Mantener presionada una banderita** (o clic derecho) abre: Renombrar, Cambiar color, Archivar y Quitar tema.
  - **Archivar** saca la banderita de la fila. Los mensajes conservan la etiqueta en gris y el tema se puede restaurar si hay espacio.
  - **Quitar** borra el tema y deja sus mensajes sin tema. Pide confirmación y no borra ningún mensaje.
- **Etiquetar un mensaje**: desde la barra al pasar el mouse («🏷 Tema»), desde el menú del mensaje (submenú «Tema») o tocando la etiqueta que ya tiene. Solo se puede usar un tema activo del mismo chat.

## API

| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/conversations/:id/topics` | Lista activos y archivados |
| POST | `/conversations/:id/topics` | Crea un tema con `{ name, color?, icon? }`. Responde 409 si el nombre está repetido o se llega al tope técnico |
| PATCH | `/topics/:id` | Cambia `{ name?, color?, icon?, archived?, position? }`. Restaurar también respeta el límite |
| DELETE | `/topics/:id` | Quita el tema. Sus mensajes quedan con `topicId: null` |
| PUT | `/messages/:id/topic` | Pone `{ topicId }` o `{ topicId: null }` |

`SendMessageInput.topicId` manda el mensaje directamente con ese tema. Cualquier cambio de temas emite el evento `topics.changed`, que lleva la lista completa. Etiquetar un mensaje emite `message.updated`.

Los cambios de base de datos están en la migración `032_conversation_topics.sql`. Crea la tabla `conversation_topics`, agrega `messages.topic_id` y `messages.topic_by`, y agrega `issues.topic_id`. Una tarea lleva el tema del mensaje del que sale, o el filtro activo al crearla; en la lista, la ✕ se lo quita y el menú de la tarea lo cambia (`PATCH /issues/:id { topicId }`).

## Tarjeta de tarea en el chat

Cuando alguien crea una tarea (el mensaje de sistema `issue.created`, sin `parentIssueId`), el chat ya no muestra la línea «Creó la tarea…». En su lugar muestra una **tarjeta completa**, como un evento:
- Encabezado «☑ TAREA DE <nombre>», con la etiqueta del tema a la derecha y la ✕ para quitarlo.
- Casilla para marcar hecha, título (al tocarlo se abre la tarea), responsable con avatar, fecha (en rojo si está vencida), estado y 💬 con el número de comentarios.
- Los 2 últimos comentarios y «Ver los N comentarios».
- Un campo «Comenta esta tarea…» para comentar desde el chat (`POST /issues/:id/comments`). No aparece si la tarea está cerrada.
- El borde izquierdo es naranja, rojo si está vencida y verde si está hecha. Clic derecho o pulsación larga abre el menú rápido de la tarea.
- Al filtrar por un tema se ven también las tarjetas de las tareas de ese tema.

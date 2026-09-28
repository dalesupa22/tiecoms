# Temas del chat

Pedido de Danny (28-sep-2026). Un chat sigue siendo un solo chat. Los **temas** son etiquetas que se le ponen a los mensajes, y se muestran como banderitas en una fila arriba del chat.

Los temas no son hilos ni tareas:
- Un **hilo** es una conversación aparte que se abre desde un mensaje, y sigue igual que antes.
- Una **tarea** es lo que antes se llamaba «asunto». En la interfaz ahora dice «Tareas».

## Reglas (iguales en web, iOS y Android)

- Cada conversación tiene como máximo **5 temas activos** (`TOPIC_LIMIT`). Los archivados no cuentan para el límite.
- Cualquiera que pueda escribir en el chat puede crear, renombrar, cambiar de color, archivar o quitar un tema.
- Cualquiera también puede etiquetar **cualquier mensaje**, sea suyo o de otra persona. Queda registrado quién le puso el tema (`topicBy`), y la interfaz muestra «tema puesto por X» cuando no fue el autor del mensaje.
- **Fila de banderitas**: va debajo de los chips (Fijados, Tareas, Hilos, Agenda, Enlaces) y tiene scroll horizontal.
  - La primera es «Todo».
  - Después van los temas activos y «＋ Nuevo · N libres».
  - Al final va «Archivados N», si hay alguno.
- **Tocar una banderita** filtra el chat a ese tema. Lo que se escribe mientras tanto sale con ese tema, y el campo lo indica con «Mensaje en X». Tocar «Todo» o la misma banderita otra vez quita el filtro.
- **Mantener presionada una banderita** (o clic derecho) abre: Renombrar, Cambiar color, Archivar y Quitar tema.
  - **Archivar** saca la banderita de la fila. Los mensajes conservan la etiqueta en gris y el tema se puede restaurar si hay espacio.
  - **Quitar** borra el tema y deja sus mensajes sin tema. Pide confirmación y no borra ningún mensaje.
- **Etiquetar un mensaje**: desde la barra al pasar el mouse («🏷 Tema»), desde el menú del mensaje (submenú «Tema») o tocando la etiqueta que ya tiene. Solo se puede usar un tema activo del mismo chat.

## API

| Método | Ruta | Qué hace |
| --- | --- | --- |
| GET | `/conversations/:id/topics` | Lista activos y archivados |
| POST | `/conversations/:id/topics` | Crea un tema con `{ name, color?, icon? }`. Responde 409 si ya hay 5 activos o si el nombre está repetido |
| PATCH | `/topics/:id` | Cambia `{ name?, color?, icon?, archived?, position? }`. Restaurar también respeta el límite |
| DELETE | `/topics/:id` | Quita el tema. Sus mensajes quedan con `topicId: null` |
| PUT | `/messages/:id/topic` | Pone `{ topicId }` o `{ topicId: null }` |

`SendMessageInput.topicId` manda el mensaje directamente con ese tema. Cualquier cambio de temas emite el evento `topics.changed`, que lleva la lista completa. Etiquetar un mensaje emite `message.updated`.

Los cambios de base de datos están en la migración `032_conversation_topics.sql`. Crea la tabla `conversation_topics`, agrega `messages.topic_id` y `messages.topic_by`, y agrega `issues.topic_id`, que queda lista para etiquetar tareas en una próxima entrega.

# iOS 1.7.16 (56): fluidez y acciones del chat

Base: `ios-gg-abajo` / `06f170f`. Entrega prevista: TestFlight interno; este cambio no modifica la versión pública pendiente de revisión.

- Se conservan Grupos, DMs, Todo, Agenda, Llamadas y Tú, los árboles/listas, atajos, temas, fijados y gestos nativos.
- La entrada al chat se posiciona tras recibir geometría del ancla, sin las pausas fijas de 200 + 350 ms. La paginación inicial ya no cancela su propia tarea al cambiar `loading`; la lectura se reconoce después de medir el divisor visible.
- Reservar un borrador no espera el bloqueo de escritura a disco. Directorios y protección de respaldo se preparan en la escritura de fondo. Se mantiene aislamiento por servidor/cuenta/conversación y rechazo de generaciones antiguas.
- El `+` abre una hoja nativa con cuadrícula adaptable. Conserva todas las opciones y permisos existentes. WhatsApp tiene acceso visible; el borrador de solo texto ofrece además compartir hacia WhatsApp, conservándolo y sin enviar automáticamente. Una sola vista, archivos/GIF/voz no pasan por esta acción.
- gg conserva contexto, historial bajo demanda, contador, ocultar/recuperar y purga; la píldora tiene marca estable. Recalcular pendientes tiene límite local de diez minutos por fuente, además del límite del servidor.
- Tareas combina responsables y estados: OR dentro de una dimensión y AND entre ellas. Completadas y Canceladas son independientes. Se conserva el orden, agrupación y atajos; las hijas usan el mismo conjunto autorizado y filtrado. Preferencias aisladas por cuenta.
- La carga global usa `limit=200&offset=...` y `nextOffset`, deduplica IDs, conserva eventos vivos más recientes y no reinserta una tarea ocultada mientras llegan páginas. Un servidor anterior sin `nextOffset` conserva su respuesta histórica.

## Evidencia local

Simulador iPhone 13 mini, iOS 26.1; API sintética de solo lectura en 127.0.0.1:3196 (`tools/fixtures/fluidez1716-api.mjs`), sin base de datos ni proveedores. No se enviaron mensajes ni llamadas reales.

61 pruebas unitarias dirigidas aprobaron: NightContractTests, TopicDockOpenTests, TreeReadTests y ChatRecoveryTests. Incluyen filtros combinados, corresponsables, hijas, paginación y eventos de ocultación/actualización, límite de gg y generaciones de borrador.

La prueba Fluidez1716UITests comprueba las seis pestañas, las opciones del +, gg, Lorena + Completadas excluyendo pendientes/canceladas, WhatsApp desde borrador y restauración del borrador al salir/entrar. Las capturas y clip local quedan en `/tmp/chaggu-ios-fluidez-shots` para copiar al recibo de distribución:

- `ios-chat-gg.png`
- `ios-plus-grid.png`
- `ios-whatsapp-draft-action.png`
- `ios-lorena-completed.png`
- `ios-native-motion.mp4`

Una apertura con caché en esta fixture registró `chat.loaded=175 ms` y `chat.positioned=189 ms` desde abrir. Son mediciones Debug de simulador, no un benchmark de hardware real ni comparación controlada con WhatsApp. El clip muestra el movimiento nativo del menú y navegación.

No se probó aquí instalación física, envío real a WhatsApp ni distribución de tiendas. La publicación interna y preservación de las revisiones públicas se verifican en el recibo de release.

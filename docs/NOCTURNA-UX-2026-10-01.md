# Seguimiento de experiencia: web y escritorio 0.3.8

Cambios adicionales N33–N40 sobre la tanda nocturna. El código conserva los contratos API existentes y no cambia las revisiones públicas móviles.

- Cada panel puede ocupar una o dos filas; Agenda y Tareas pueden estar altas simultáneamente. Se conservan orden, borradores y preferencias al expandir, volver y recargar. Los cinco paneles tienen representación visible.
- Arrastrar un panel existente mueve o intercambia el destino solicitado; los destinos vacíos conservan el orden de los demás y los fijados siguen protegidos.
- Agenda distribuye coincidencias en carriles, muestra eventos cortos legibles y conserva los límites temporales reales y los eventos de todo el día.
- Correo y WhatsApp admiten ancho lateral ajustable por proveedor, con teclado, cancelación y persistencia al terminar el gesto. Redimensionar no remonta la bandeja ni solicita mensajes.
- El correo lateral abre el mensaje a la derecha conservando la lista. Una bandeja dentro de la cuadrícula abre su lector en ese mismo panel. Destinatarios compactos, cuerpo completo y ancho de lectura acotado; las mediciones del HTML no confiable se agrupan y tienen un presupuesto finito.
- WhatsApp muestra y permite modificar fijados: primero fijados, luego recencia por fecha completa y desempate estable. Cambiar un pin reinicia una vez la paginación.
- La cabecera de chat conserva gg y voz visibles, y todas las opciones secundarias en un menú accesible. Zoom y fijados conservan el foco; Escape cierra una capa y limpia modales internos. Abrir el menú no cambia la altura del chat.

## Verificación del código

35 archivos de pruebas web, 218 pruebas aprobadas y typecheck. Regresión de navegador con datos sintéticos: 11 escenarios originales, cuadrícula de cuatro/cinco paneles, arrastre y persistencia, fijados WA, ocho grupos de cabecera, siete grupos de ancho lateral, lectura de correo y agenda estrecha. Sin llamadas, envíos ni modificaciones de calendarios reales durante estas pruebas. Capturas y recibos se mantienen fuera del repositorio público.

La publicación se verifica aparte con el commit de origen, la release del servidor y hashes de los instaladores. Este documento por sí solo no acredita distribución, aceptación en dispositivos físicos ni OAuth de proveedores reales.

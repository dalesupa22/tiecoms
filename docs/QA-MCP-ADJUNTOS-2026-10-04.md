# CH003-MCP-ATTACHMENTS-20261004

Estado: implementado y probado localmente. No desplegado en producción.

## Pedido y alcance

Pedido: añadir al MCP de Chaggu imágenes y archivos en mensajes de chats existentes, reutilizando almacenamiento/permisos, validando tipo/tamaño/acceso, evitando duplicados en reintentos y devolviendo el ID del mensaje y sus adjuntos. `read_messages` debe verificar la asociación. Probar PNG y PDF en un DM autorizado.

Ampliación literal: «lo mismo para las tareas si es que ya no existe bro y agregar comentarios a tareas y cambiar estados».

Se implementaron `upload_chat_attachment`, adjuntos en `send_message` y metadatos adicionales en `read_messages`; `upload_task_attachment` añade archivos conservando los existentes. `comment_task` y `update_task` ya existían y ahora admiten idempotencia. `get_task`/`list_tasks` devuelven adjuntos. El contrato y ejemplos están en [MCP.md](MCP.md).

Solo API/MCP y límite de transporte Nginx. No cambia OAuth, credenciales, conexiones de Claude/ChatGPT, web, aplicaciones móviles o tiendas. Parte de `be9d4fb10159ace974355a5ce8907377dd2fab2a` en la rama `feat/mcp-attachments`.

## Evidencia local

Entorno: API HTTP real, PostgreSQL 16 aislado en loopback y almacenamiento S3 simulado. Actores sintéticos Ana/Beto en un DM autorizado y un tercero sin acceso. No hubo mensajes ni comentarios a personas reales. El PDF válido supera 128 KiB; el PNG es de 1 × 1.

| Verificación | Resultado |
|---|---|
| E2E de adjuntos MCP (`mcp-attachments.test.ts`) | 10/10 |
| Regresión MCP existente | 10/10 |
| Regresión MCP de integraciones | 17/17 |
| Regresión de adjuntos del producto | 10/10 |
| Validación de entrada de archivos | 26/26 |
| Transacciones y limpieza de idempotencia | 5/5 |
| Persistencia/privacidad de tareas (`lorena-tasks.test.ts`, DB aislada propia) | 7/7 |
| Typecheck y build API | Pasan |
| Nginx en contenedor aislado (`infra/test-nginx-oauth.py`) | Pasa |
| Revisión independiente de ACL y reintentos | Sin bloqueantes |

Total: 85 pruebas. Los E2E prueban asociación por ID mediante `read_messages`, descarga byte a byte de PNG/PDF, concurrencia sin duplicados, comentarios/estados sin repetir, conservación de adjuntos de tareas, conflictos de llave/contenido, scope insuficiente, tamaño/tipo inválidos, rollback de recibo y revocación de acceso. Los casos de privacidad cubren mensajes de una sola vista, historial restringido incluso tras limpiar recibos y tareas que pasan a privadas.

Nginx admite un cuerpo MCP de 256 KiB, rechaza 37 MiB y mantiene el límite anterior de OAuth y del resto del API. Esa prueba usa un upstream simulado; la asociación y descarga se verifican por separado contra el API real local.

Recibos locales sanitizados: `../outputs/mcp-attachments-2026-10-04/` en el directorio de trabajo del proyecto (fuera de este repositorio): `final-vitest.json`, `lorena-regression-vitest.json`, `nginx-verification.json` y `verification.json`.

Para repetir, iniciar una API con DB local `mcp_attachments_test`, S3 simulado (`apps/api/test/fake-s3.mjs`) y migraciones existentes. `mcp-integraciones.test.ts` requiere `INTEGRATIONS_ALLOW_LOCAL=true` únicamente en el fixture. La suite Lorena exige su propia DB `chaggu_lorena_test`. Ejecutar Vitest desde `apps/api` con el mismo entorno que su API. La suite nueva rechaza hosts no locales y otra base de datos.

## Límites y siguiente paso

- Archivos de hasta 25 MiB, enviados en base64; JSON MCP de hasta 36 MiB. Hasta 10 adjuntos por mensaje y 20 por tarea.
- La ventana garantizada de idempotencia es 24 horas, usando la tabla y limpieza existentes. No requiere migración.
- Un fallo después del PUT a S3 y antes del commit puede dejar un objeto sin fila si nunca se reintenta. Reintentar reutiliza el mismo objeto determinista; no se amplían permisos de borrado S3.
- Falta autorización de promoción para esta candidata y seleccionar el DM/tarea reales antes de la comprobación en la cuenta del usuario. Los resultados locales no acreditan un despliegue ni una llamada desde la conexión corporativa.

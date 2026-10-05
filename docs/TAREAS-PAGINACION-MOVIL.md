# Paginación del listado de tareas

Los filtros combinables de los móviles 1.7.16 necesitan recorrer tareas visibles más allá del límite histórico de 500. `GET /api/v1/issues?limit=200&offset=0` responde `{ issues, nextOffset }`; `nextOffset` es `null` al terminar. El límite permitido es de 1 a 200 y el offset es un entero no negativo. Los clientes deduplican por ID y conservan los eventos en vivo recibidos durante la carga.

Sin `limit`, el endpoint mantiene la respuesta histórica `{ issues }` y el máximo de 500. No cambia los permisos, los filtros existentes ni la cabecera de compatibilidad para tareas personales. El orden conserva estado/fecha/creación y añade ID para resolver empates. Como antes, la lista refleja datos vivos; no representa una instantánea transaccional entre solicitudes.

Validación: 8 pruebas locales de paginación y reportes; typecheck y compilación API. El despliegue necesario es solo API, sin migraciones ni cambios de web, worker, puente WhatsApp o manifest de versiones públicas.

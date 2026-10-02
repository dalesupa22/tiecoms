# Campos y columnas de las tareas + webhook de tareas (2-oct-2026)

Migración `097_issue_fields.sql`. Todo es aditivo: `IssueDTO.fields` falta si la tarea no tiene campos.

## Campos dinámicos
- `IssueDTO.fields?: Record<string, string | number | boolean>`; hasta 30 por tarea.
- Crear: `fields` en `POST /conversations/{id}/issues`. Editar: `PATCH /issues/{id}` `{ fields }` **mezcla**; `null` o `""` borra.
- Cada cambio deja un evento `fields` `{ changed: [...], removed: [...] }`.

## Columnas del grupo (lista desplegable)
- `GET /api/v1/conversations/{id}/task-columns` → `{ columns: TaskColumnDTO[], canEdit }`.
- `PUT` igual `{ columns: [{ name, type: 'text'|'select'|'number'|'checkbox', options? }] }` (reemplaza; solo admins del grupo/espacio).
- `select` solo acepta sus opciones (sin importar mayúsculas ni tildes; se guarda la opción tal cual). Un valor fuera de la
  lista responde 400 con las opciones. `number` convierte "3" → 3; `checkbox` acepta sí/true/1.
- Web: vista **Tabla** en Tareas (una columna por cada columna del grupo y por cada campo libre; las listas se cambian en la
  celda), botón «⚙ Columnas», y en el detalle de la tarea la sección «Campos».

## Webhook de tareas
`POST https://app.chaggu.com/api/hooks/{id}/{token}/tasks` (o `/api/hooks/{id}/tasks` con `Authorization: Bearer chg_…`;
o `POST /api/integration/v1/tasks`).

```json
{
  "title": "No pude emitir el certificado",
  "description": "Falta implementar estos servicios: firma-otp, reportes-pdf",
  "fields": { "Tipo": "Funcionalidad nueva", "Resultado": "No pudo", "Servicios": "firma-otp, reportes-pdf" },
  "assigneeEmails": ["alguien@xertify.co"],
  "dueDate": "2026-10-09",
  "status": "open",
  "externalId": "opcional, idempotente por ticket"
}
```
- `description` también puede venir como `body` o `text`. Llaves desconocidas se ignoran: los datos extra van en `fields`.
- Sin `externalId`, cada llamada crea una tarea; con `Idempotency-Key` los reintentos no duplican.
- `assigneeEmails` solo asigna a quien está en el grupo; los demás vuelven en `ignoredAssignees`.
- Respuesta: `{ issue, created }`. El bot avisa en el chat con el título y los campos.

## MCP
- `create_task` y `update_task` aceptan `fields` (y `description` al crear).
- `list_tasks` filtra por `chat`, `field` + `field_value` y devuelve `columns` / `columnTypes`.
- `get_task_columns` y `set_task_columns` (definir listas desplegables).

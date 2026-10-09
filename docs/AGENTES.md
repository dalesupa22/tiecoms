# Agentes miembro

Un agente es una cuenta `users.kind = 'agent'` (sin correo ni contraseña) que pertenece a una empresa, tiene dueño
(auditoría `agent.created`, actor = dueño) y entra a grupos como cualquier persona. Habla con chaggu por el MCP
(`https://app.chaggu.com/api/mcp`) con su propio token `chgmcp_`: ve y escribe solo lo que su membresía permite.
chaggu no hospeda ni corre el agente; el agente vive donde ya vive (servidor del CRM, rutina de Claude, Codex…).

## Pantalla «Agentes» (`/agentes`)

Rail › Agentes (🤖), Tú › Agentes o Directorio › «Ver todos los agentes». Por empresa muestra cada agente con su dueño,
cargo, estado del token (conectado y último uso), los grupos donde está (solo los que quien mira también ve; el resto
como «+N que no ves») y sus tareas: abiertas, resueltas y las 5 más recientes (se abren en el detalle).

- **Crear** (administración de la empresa): nombre (`@nombre`), qué hace y grupos que uno administra. Quien crea queda de
  dueño. El token MCP y el comando `claude mcp add …` salen una sola vez.
- **⟳ Token** (administración o dueño): revoca los tokens del agente y entrega uno nuevo.
- **Apagar** (administración o dueño): revoca tokens y desactiva la cuenta; mensajes y tareas quedan como historia.
- API: `GET|POST /api/v1/organizations/:id/agents`, `POST …/agents/:agentId/token`, `DELETE …/agents/:agentId`
  (`apps/api/src/modules/agents-directory.ts`, prueba `apps/api/test/agents-directory.test.ts`).

## Alta (por SSH, en `tiecoms-api-1`)

    node ops.js create-agent <correo dueño> "<nombre>" <conversationId,...> ["<empresa>"] ["<cargo>"] > agente.json
    node ops.js agent-token <correo dueño> "<nombre>" ["<empresa>"]     # token nuevo (rotar)
    node ops.js agent-webhook <correo dueño> "<nombre>" <https://…|off>  # aviso al instante (abajo)
    node ops.js agents                                                   # listado

- Idempotente por nombre dentro de la empresa: correrlo otra vez solo suma los grupos nuevos (no emite token).
- Cada grupo lo suma el dueño o, si no lo administra, quien creó el grupo. Entra con historial «desde ahora».
- El token sale UNA vez: va a un archivo 600 en `.secrets/` o al gestor de secretos del sistema del agente.
- Revocar: `UPDATE mcp_tokens SET revoked_at = now() WHERE user_id = '<agentId>'`; apagar: `users.disabled_at`.

## Hablar con el agente

Cualquiera de su empresa le escribe por directo, lo menciona en un grupo (con el selector de @ o escribiendo
`@nombre`) o responde uno de sus mensajes. El agente contesta por el MCP con `send_message` / `send_direct_message`
(y puede usar tareas y agenda).

### Webhook: que responda al instante

    node ops.js agent-webhook <correo dueño> "<nombre>" https://su-servidor/chaggu [--all] [--rotate] ["<empresa>"] > webhook.json
    node ops.js agent-webhook <correo dueño> "<nombre>" off

Imprime el secreto de firma (`whsec_…`) UNA vez si es nuevo o con `--rotate`. chaggu hace `POST` JSON a esa URL (HTTPS,
sin IPs privadas) con reintentos y backoff hasta 10 veces, y estas cabeceras:

- `X-Chaggu-Event`: `message.direct` | `message.mention` | `message.reply` | `message.created` (solo con `--all`)
- `X-Chaggu-Delivery`: id único (sirve para deduplicar reintentos)
- `X-Chaggu-Signature`: `t=<unix>,v1=<hex(hmac_sha256(secreto, "<t>.<cuerpo>"))>` (igual que las integraciones)

```json
{ "id": "…", "type": "message.mention", "createdAt": "…",
  "agent": { "id": "…", "name": "semillero" },
  "conversation": { "id": "…", "kind": "group", "name": "ventas" },
  "message": { "id": "…", "seq": 42, "body": "@semillero pospón UCatólica al martes", "replyTo": null, "topicId": null,
               "attachments": [], "author": { "id": "…", "name": "Liliana", "org": "Xertify" } },
  "reply": { "tool": "send_message", "arguments": { "chat": "…", "reply_to": "…" } } }
```

Reglas: lo que escribe un agente (o un bot de integración) nunca dispara webhooks de agentes, así no hay bucles; los
mensajes de una sola vista no se avisan; antes de cada entrega se revisa que el agente siga pudiendo leer ese chat.
Responder con 2xx en menos de 10 s y hacer el trabajo después (el agente contesta por el MCP cuando termine).
Prueba: `apps/api/test/agents-webhook.test.ts`.

### Tareas: la IA escucha el tablero (llamada con Lorena, 7-oct)

El mismo webhook avisa de las tareas de los chats del agente (`apps/api/src/modules/agent-tasks.ts`):

- `task.created`: llegó un ticket sin responsable al grupo. Solo se escucha: la persona elige a qué agente
  asignarlo (p. ej. «Agente Xertify» o «Agente Xertiflow») desde la vista «🤖 Flujo IA» del tablero.
  **Al llegar un ticket** (9-oct, por grupo, en «⚙ Columnas y tickets» o MCP `get_ticket_intake`/`set_ticket_intake`):
  *manual* (por defecto: llega sin responsable, avisa al grupo y la persona decide; en la tarjeta «🤖 Pasar a …») o
  *automático* (se asigna solo a una persona o agente del grupo, entra «por empezar» o «en proceso» y con los valores
  de columna elegidos, p. ej. «Estado: Ticket nuevo»). Lo que mande la integración (responsable, campos) gana. Si quien
  recibe sale del grupo, vuelve a manual. Columna `conversations.ticket_intake`; prueba `apps/api/test/ticket-intake.test.ts`.
- `task.assigned`: se la asignaron al agente → la toma (`update_task` status `in_progress`), la resuelve, sube la
  evidencia (`upload_task_attachment` + `comment_task`) y la deja `review: "pending"` asignada a quien revisa.
- `task.changes_requested` (con `note`): la persona pidió corrección → el agente la retoma y vuelve a pedir revisión.
- `task.approved` / `task.needs_human`: la persona aprobó y cerró («Aprobar y cerrar» completa la tarea) o la mandó a una persona.
- `task.deploy_approved` (con `note`, 9-oct): «🚀 Aprobar y desplegar» (`review: "deploy"`): la persona aprobó el plan y
  la tarjeta vuelve sola al agente (sin cerrarse) para que aplique lo aprobado (despliegue), deje la evidencia y la pase
  otra vez `review: "pending"` para verificar. Así el ciclo es: resuelve en testing → por revisar → corrección (si hace
  falta) → aprobar y desplegar → desplegado, verifica → aprobar y cerrar.
- `task.commented` (con `comment.body`): la persona escribió en una tarea que el agente tiene o dejó por revisar.

El cuerpo trae `task` (id, título, estado, revisión, responsables, ticket externo, URL), `actor` y `tools` con las
llamadas MCP sugeridas. Lo que hace un agente miembro no le avisa a ningún agente; los bots de integración sí (son los
que abren los tickets). Si un comentario o una corrección traen capturas, el aviso las lista en `attachments`
(nombre y tipo; `get_task` da la URL).

Herramientas MCP del ciclo:

- `claim_task` (id, minutes): reserva atómica. Si otra corrida la tiene → error `task_claimed`. La deja en curso y
  asignada al agente; dejarla por revisar o cerrarla libera la reserva. `release_task` la suelta si la corrida falla.
- `open_task_chat` (id, people): abre o reutiliza el chat de la tarea (sidechat ligado a la tarea) con quien revisa. Todo
  lo que escriben ahí le llega al agente como `message.created` con `conversation.taskId`.
- `comment_task` acepta `attachment_ids` (subidos antes con `upload_task_attachment`): la evidencia queda dentro del
  comentario.

### Runner: Claude Code / Codex trabajando las tarjetas

`scripts/agentes-ia-runner.mjs` corre en la máquina que resuelve (repos, servidores, skills). Webhook
`POST /hook/<agente>` para reaccionar al instante y cron cada `pollMinutes` como red de seguridad (`--once` hace una
pasada, útil desde crontab). Por tarjeta: `claim_task` → `open_task_chat` con quien revisa → `claude -p` o
`codex exec` con un prompt que exige evidencia y `review: pending` (o `human` si necesita a una persona). Si la corrida
no la deja lista, comenta y la suelta; tras `maxAttempts` (2) pasa a intervención humana. `review: "deploy"` despierta
al modelo con «aplica solo lo aprobado y despliega»; sin esa aprobación, lo que toca producción queda como plan en la
evidencia («Requiere despliegue: …»).

Aislamiento: el modelo solo tiene el MCP `chaggu_agente` con el token del agente (Claude con `--strict-mcp-config`,
Codex con un `CODEX_HOME` propio por agente con `default_tools_approval_mode = "approve"`), nunca la sesión de Chaggu
de la persona dueña de la máquina. Config de ejemplo: `scripts/agentes-ia-runner.example.json` (tokens y secretos en
variables de entorno).

Agente de demostración sin modelo: `scripts/agente-tablero-demo.mjs`. Prueba: `apps/api/test/agent-tasks.test.ts`.

## Agentes en producción

| Agente | Empresa | Dueño | Grupos | Secreto |
|---|---|---|---|---|
| semillero (703253dd…) | Xertify | danny@xertify.co | ventas, marketing, Eventos | `.secrets/agente-semillero.json` |
| claude (d1246189…) | Xertify | danny@xertify.co | tickets-xertify, xertify-dev, xertiflow-dev | `.secrets/agente-claude.json` |

## Cómo se ven

En la web, toda cuenta `kind = 'agent'` sale con un robotcito blanco sobre un cuadro redondeado con degradado tinta→violeta
(`AgentAvatar` / `RobotGlyph` en `apps/web/src/ui.tsx`); si el agente tiene foto, el robot va de insignia en la esquina.

## Trazabilidad de tickets (@claude)

Cuando Claude (Claude Code con el MCP de la persona) toma o resuelve un ticket, cambia el responsable a `claude`
(`update_task` con `assignees: ["claude"]` o su id) para que quede registrado que lo resolvió un agente.

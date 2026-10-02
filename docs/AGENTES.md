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

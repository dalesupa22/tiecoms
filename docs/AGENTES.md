# Agentes miembro

Un agente es una cuenta `users.kind = 'agent'` (sin correo ni contraseña) que pertenece a una empresa, tiene dueño
(auditoría `agent.created`, actor = dueño) y entra a grupos como cualquier persona. Habla con chaggu por el MCP
(`https://app.chaggu.com/api/mcp`) con su propio token `chgmcp_`: ve y escribe solo lo que su membresía permite.
chaggu no hospeda ni corre el agente; el agente vive donde ya vive (servidor del CRM, rutina de Claude, Codex…).

## Alta (por SSH, en `tiecoms-api-1`)

    node ops.js create-agent <correo dueño> "<nombre>" <conversationId,...> ["<empresa>"] ["<cargo>"] > agente.json
    node ops.js agent-token <correo dueño> "<nombre>" ["<empresa>"]     # token nuevo (rotar)
    node ops.js agents                                                   # listado

- Idempotente por nombre dentro de la empresa: correrlo otra vez solo suma los grupos nuevos (no emite token).
- Cada grupo lo suma el dueño o, si no lo administra, quien creó el grupo. Entra con historial «desde ahora».
- El token sale UNA vez: va a un archivo 600 en `.secrets/` o al gestor de secretos del sistema del agente.
- Revocar: `UPDATE mcp_tokens SET revoked_at = now() WHERE user_id = '<agentId>'`; apagar: `users.disabled_at`.

## Hablar con el agente

Cualquiera de su empresa le escribe por directo o lo menciona en un grupo. El agente lee con
`unread_summary` / `read_messages` y responde con `send_message` / `send_direct_message` (y puede usar tareas y agenda).
Hoy el agente consulta cada N minutos; falta un webhook de salida por agente (cuando lo mencionan o le escriben) para
que responda al instante.

## Agentes en producción

| Agente | Empresa | Dueño | Grupos | Secreto |
|---|---|---|---|---|
| semillero (703253dd…) | Xertify | danny@xertify.co | ventas, marketing, Eventos | `.secrets/agente-semillero.json` |

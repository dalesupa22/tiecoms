package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/**
 * gg (se pronuncia «yiyi»), el asistente de chaggu (docs/ASISTENTE.md). Reglas puras, sin Android:
 * contrato del API, historial por persona, «envíalos» y el texto que se lee en voz alta.
 */

/** send_message | create_group | create_issue | update_issue | create_event | cancel_event | mark_read */
@Serializable
data class AssistantActionDTO(
    val id: String = "",
    val kind: String = "",
    /** pending | done | failed | undone */
    val status: String = "pending",
    val target: String = "",
    val text: String = "",
    val detail: String? = null,
    val token: String? = null,
    val undoToken: String? = null,
    /** /c/<id>, /agenda, /asuntos… */
    val link: String? = null,
    val error: String? = null,
)

@Serializable
data class AssistantTurnDTO(
    val reply: String = "",
    val actions: List<AssistantActionDTO> = emptyList(),
    /** 2 o 3 frases cortas para el siguiente paso (chips bajo la última respuesta). */
    val suggestions: List<String> = emptyList(),
)

@Serializable
data class AssistantMessage(val role: String, val content: String)

/** Un turno guardado en el dispositivo. role: user | assistant. */
@Serializable
data class AssistantTurn(
    val role: String,
    val content: String,
    val actions: List<AssistantActionDTO> = emptyList(),
    val at: Long = 0,
    val suggestions: List<String> = emptyList(),
)

object Assistant {
    const val KEY_PREFIX = "assistant:"
    /** Dueño del historial guardado: si entra otra cuenta, lo anterior se descarta. */
    const val OWNER_KEY = "assistant:owner"
    const val SPEAK_KEY = "gg:speak"
    const val MAX_KEEP = 40
    const val MAX_SEND = 20
    const val MAX_CONTENT = 4000

    val PENDING_KINDS = setOf("send_message", "create_group", "cancel_event")

    fun key(userId: String) = KEY_PREFIX + userId

    /** Historial de [userId]; si lo guardado es de otra cuenta, se borra antes de leer. */
    fun load(storage: KeyValueStorage, userId: String): List<AssistantTurn> {
        val owner = storage.get(OWNER_KEY)
        if (owner != userId) {
            storage.clearPrefix(KEY_PREFIX)
            storage.set(OWNER_KEY, userId)
        }
        val raw = storage.get(key(userId)) ?: return emptyList()
        return runCatching { TcJson.decodeFromString(ListSerializer(AssistantTurn.serializer()), raw) }.getOrElse { emptyList() }
    }

    fun save(storage: KeyValueStorage, userId: String, turns: List<AssistantTurn>) {
        storage.set(OWNER_KEY, userId)
        storage.set(key(userId), TcJson.encodeToString(ListSerializer(AssistantTurn.serializer()), turns.takeLast(MAX_KEEP)))
    }

    /** Al cerrar sesión no queda nada de gg en el dispositivo. */
    fun clear(storage: KeyValueStorage) = storage.clearPrefix(KEY_PREFIX)

    /** Lo que se manda a /assistant/turn: últimos 20 turnos; los de gg con acciones llevan su resumen, sin tokens. */
    fun history(turns: List<AssistantTurn>): List<AssistantMessage> = turns.takeLast(MAX_SEND).map { t ->
        val content = if (t.actions.isNotEmpty())
            t.content + "\n[" + t.actions.joinToString(" | ") { "${it.status}: ${it.kind} → ${it.target}: ${it.text}" } + "]"
        else t.content
        AssistantMessage(t.role, content.take(MAX_CONTENT))
    }

    fun pending(turns: List<AssistantTurn>): List<AssistantActionDTO> = turns.flatMap { it.actions }.filter { it.status == "pending" }

    fun patch(turns: List<AssistantTurn>, id: String, f: AssistantActionDTO.() -> AssistantActionDTO): List<AssistantTurn> =
        turns.map { t -> if (t.actions.any { it.id == id }) t.copy(actions = t.actions.map { if (it.id == id) it.f() else it }) else t }

    private val SEND_ALL = Regex(
        "^\\s*(s[ií],?\\s*)?(env[ií]a(los|las|lo|la)?|m[aá]nda(los|las|lo|la)?|dale|send( them| it)?)\\s*[.!]?\\s*$",
        RegexOption.IGNORE_CASE,
    )

    /** «envíalos», «mándalos», «dale», «sí, envía»: con borradores pendientes se confirman en el dispositivo. */
    fun isSendAll(text: String): Boolean = SEND_ALL.matches(text)

    private val GG = Regex("\\bgg\\b", RegexOption.IGNORE_CASE)

    /** gg se pronuncia «yiyi»: se cambia antes de leer en voz alta. */
    fun spoken(text: String): String = GG.replace(text, "yiyi")

    /** Íconos por tipo (igual que la web). */
    fun icon(kind: String): String = when (kind) {
        "send_message" -> "✉"
        "create_group" -> "▦"
        "create_issue" -> "◆"
        "update_issue" -> "✓"
        "create_event" -> "▤"
        "cancel_event" -> "⊘"
        "mark_read" -> "◉"
        else -> "✦"
    }

    /** Destino de «Abrir»: la conversación de /c/<id> o una pantalla. */
    sealed interface Target {
        data class Conversation(val id: String) : Target
        data class Screen(val name: String) : Target
    }

    fun linkTarget(link: String?): Target? {
        val l = link?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val path = l.substringBefore('?').substringBefore('#').trimEnd('/')
        return when {
            path.startsWith("/c/") -> path.removePrefix("/c/").substringBefore('/').takeIf { it.isNotBlank() }?.let { Target.Conversation(it) }
            path == "/agenda" || path.startsWith("/agenda/") -> Target.Screen("agenda")
            path == "/asuntos" || path.startsWith("/asuntos/") || path == "/issues" -> Target.Screen("issues")
            else -> null
        }
    }
}

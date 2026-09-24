package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** Versión del contrato que habla esta app (packages/contracts CONTRACT_VERSION). */
const val CONTRACT_VERSION = "2026-09-23"
const val PLATFORM = "android"

@Serializable
data class BlocksResult(val userIds: List<String> = emptyList())

/**
 * Decodificación TOLERANTE: la app instalada debe seguir funcionando cuando el API
 * agregue campos o valores nuevos (regla del contrato: cambios aditivos).
 * Todos los campos tienen valor por defecto; nulos inesperados caen al defecto.
 */
val TcJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = true
}

@Serializable
data class DeviceInfo(
    val deviceId: String,
    val name: String,
    val platform: String = PLATFORM,
    val contract: String = CONTRACT_VERSION,
)

@Serializable
data class UserDTO(
    val id: String = "",
    val name: String = "",
    val email: String? = null,
    val kind: String = "human",
    val title: String? = null,
    val area: String? = null,
    val primaryOrgId: String? = null,
    /** Ruta relativa de la foto (/api/v1/avatars/<uuid>), pública; null = iniciales. */
    val avatarUrl: String? = null,
)

@Serializable
data class AuthResult(
    val accessToken: String = "",
    val accessExpiresAt: String = "",
    val refreshToken: String? = null,
    val sessionId: String = "",
    val user: UserDTO = UserDTO(),
)

@Serializable
data class OrganizationDTO(
    val id: String = "",
    val name: String = "",
    val mark: String = "",
    val colorBg: String = "#FF7A00",
    val colorFg: String = "#FFFFFF",
    val myRole: String? = null,
    /** none | idp | dns */
    val verification: String = "none",
    val verifiedDomain: String? = null,
)

@Serializable
data class PersonDTO(
    val id: String = "",
    val name: String = "",
    val kind: String = "human",
    val orgId: String? = null,
    val title: String? = null,
    val area: String? = null,
    val guest: Boolean = false,
    val guestUntil: String? = null,
    /** Ruta relativa de la foto (/api/v1/avatars/<uuid>), pública; null = iniciales. */
    val avatarUrl: String? = null,
)

@Serializable
data class WorkspaceDTO(
    val id: String = "",
    val name: String = "",
    val department: String? = null,
    val glyph: String? = null,
    val owningOrgId: String = "",
    val organizationIds: List<String> = emptyList(),
    val memberIds: List<String> = emptyList(),
    val myRole: String = "member",
    val createdAt: String = "",
    val pinnedAt: String? = null,
)

@Serializable
data class ConversationDTO(
    val id: String = "",
    val workspaceId: String? = null,
    /**
     * group | internal | direct | multi (valores futuros se tratan como group).
     * `multi` = chat grupal entre personas (de una o varias empresas), sin espacio (workspaceId null).
     */
    val kind: String = "group",
    val level: String? = null,
    val name: String? = null,
    val internalOrgId: String? = null,
    val memberIds: List<String> = emptyList(),
    val lastMessageSeq: Long = 0,
    val lastEventSeq: Long = 0,
    val lastMessageAt: String? = null,
    val lastMessagePreview: String? = null,
    val lastReadSeq: Long = 0,
    val unread: Int = 0,
    val canPost: Boolean = true,
    val canManage: Boolean = false,
    val historyFromSeq: Long = 0,
    /** Bifurcación: de qué conversación y mensaje se derivó. */
    val parentId: String? = null,
    val parentMessageId: String? = null,
    val parentMessageSeq: Long? = null,
    /** same | internal | directive */
    val deriveKind: String? = null,
    val deriveReason: String? = null,
    val returnedAt: String? = null,
    val openIssues: Int = 0,
    /** Preferencias personales. */
    val pinnedAt: String? = null,
    val mutedUntil: String? = null,
) {
    /** Directos y chats grupales van juntos en la lista: no pertenecen a un espacio. */
    val isChat: Boolean get() = kind == "direct" || kind == "multi"

    fun mutedAt(nowMs: Long): Boolean =
        mutedUntil?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() > nowMs }.getOrDefault(false) } ?: false
}

/** whatsapp | slack | email | teams | tiecoms | other */
@Serializable
data class ForwardedInfo(
    val source: String = "other",
    val author: String? = null,
    val sentAt: String? = null,
    val fromConversationId: String? = null,
)

@Serializable
data class MessageDTO(
    val id: String = "",
    val conversationId: String = "",
    val seq: Long = 0,
    val authorId: String = "",
    val clientMessageId: String? = null,
    /** text | system */
    val kind: String = "text",
    val body: String = "",
    val replyTo: String? = null,
    val createdAt: String = "",
    val editedAt: String? = null,
    val deletedAt: String? = null,
    val mergedFrom: String? = null,
    val forwarded: ForwardedInfo? = null,
    /** Vista previa del primer enlace; llega después del envío con `message.updated`. */
    val linkPreview: LinkPreviewDTO? = null,
)

/** Vista previa de un enlace. `imageUrl` es relativa al API (/api/v1/previews/<uuid>), pública y cacheable. */
@Serializable
data class LinkPreviewDTO(
    val url: String = "",
    val title: String? = null,
    val description: String? = null,
    val siteName: String? = null,
    val imageUrl: String? = null,
) {
    /** Sitio para mostrar: siteName o el host sin «www.». */
    val host: String get() {
        siteName?.takeIf { it.isNotBlank() }?.let { return it }
        val h = runCatching { java.net.URI(url).host }.getOrNull() ?: url
        return h.removePrefix("www.")
    }
    /** Solo se pinta si trae una URL http(s). */
    val usable: Boolean get() = url.startsWith("http://") || url.startsWith("https://")
}

@Serializable
data class BootstrapDTO(
    val contract: String = "",
    val serverTime: String = "",
    val me: UserDTO = UserDTO(),
    val organizations: List<OrganizationDTO> = emptyList(),
    val workspaces: List<WorkspaceDTO> = emptyList(),
    val conversations: List<ConversationDTO> = emptyList(),
    val people: List<PersonDTO> = emptyList(),
)

@Serializable
data class MessagesPage(
    val messages: List<MessageDTO> = emptyList(),
    val hasMore: Boolean = false,
    val lastEventSeq: Long = 0,
)

/** Los eventos se decodifican uno a uno (ver [decodeConversationEvent]). */
@Serializable
data class EventsPageRaw(
    val events: List<JsonElement> = emptyList(),
    val resetRequired: Boolean = false,
    val lastEventSeq: Long = 0,
)

@Serializable
data class SendResult(val message: MessageDTO? = null, val duplicate: Boolean = false)

@Serializable
data class InvitationPreviewDTO(
    val workspaceName: String = "",
    val invitedByName: String = "",
    val invitedByOrg: String = "",
    val role: String = "member",
    val email: String? = null,
    val expiresAt: String = "",
    val valid: Boolean = false,
)

@Serializable
data class OrgInvitationPreviewDTO(
    val orgName: String = "",
    val invitedByName: String = "",
    val email: String? = null,
    val expiresAt: String = "",
    val valid: Boolean = false,
)

@Serializable
data class AcceptInvitationResult(val workspaceId: String = "", val conversationIds: List<String> = emptyList())

@Serializable
data class ApiErrorInner(val code: String = "", val message: String = "", val details: JsonElement? = null)

@Serializable
data class ApiErrorBody(val error: ApiErrorInner? = null)

// ---------- Cuerpos de petición ----------
@Serializable
data class LoginBody(val email: String, val password: String, val device: DeviceInfo)

@Serializable
data class SignupBody(
    val name: String,
    val email: String,
    val password: String,
    val orgName: String? = null,
    val orgInviteToken: String? = null,
    val title: String? = null,
    val device: DeviceInfo,
)

@Serializable
data class RefreshBody(val refreshToken: String)

@Serializable
data class SendBody(val clientMessageId: String, val body: String, val replyTo: String? = null, val forwarded: ForwardedInfo? = null)

@Serializable
data class SocketSendBody(
    val conversationId: String, val clientMessageId: String, val body: String,
    val replyTo: String? = null, val forwarded: ForwardedInfo? = null,
)

@Serializable
data class ReadBody(val seq: Long)

/** Mensaje propio aún no confirmado por el servidor; vive en la cola persistente. */
@Serializable
data class PendingMessage(
    val clientMessageId: String,
    val conversationId: String,
    val body: String,
    val replyTo: String? = null,
    val forwarded: ForwardedInfo? = null,
    val createdAt: String,
    val attempts: Int = 0,
    /** pending | sending | failed */
    val status: String = "pending",
    val error: String? = null,
    val nextAttemptAt: Long = 0,
)

// ---------- Recordatorios, agenda, asuntos, dominios, WhatsApp ----------
@Serializable
data class ReminderDTO(
    val id: String = "",
    val conversationId: String = "",
    val messageId: String? = null,
    val messageSeq: Long? = null,
    val note: String? = null,
    val remindAt: String = "",
    val firedAt: String? = null,
    val doneAt: String? = null,
)

@Serializable
data class Invitee(val userId: String = "", val rsvp: String = "pending")

@Serializable
data class CalendarEventDTO(
    val id: String = "",
    val workspaceId: String = "",
    val conversationId: String = "",
    val originMessageId: String? = null,
    val title: String = "",
    val description: String? = null,
    val location: String? = null,
    val startsAt: String = "",
    val endsAt: String = "",
    val timezone: String = "UTC",
    val organizerId: String = "",
    val invitees: List<Invitee> = emptyList(),
    val cancelledAt: String? = null,
    val updatedAt: String = "",
)

@Serializable
data class IssueDTO(
    val id: String = "",
    val workspaceId: String = "",
    val conversationId: String = "",
    val originMessageId: String? = null,
    val originMessageSeq: Long? = null,
    val title: String = "",
    /** open | in_progress | waiting | done | cancelled */
    val status: String = "open",
    val waitingOnOrgId: String? = null,
    val ownerId: String? = null,
    val requestedBy: String? = null,
    val dueDate: String? = null,
    val createdBy: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val statusSince: String = "",
    val closedAt: String? = null,
    val commentCount: Int = 0,
) {
    val closed: Boolean get() = status == "done" || status == "cancelled"
}

@Serializable
data class IssueEventDTO(
    val id: Long = 0,
    val issueId: String = "",
    val actorId: String = "",
    /** created | status | owner | due | title | comment | waiting */
    val kind: String = "",
    val payload: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val createdAt: String = "",
)

@Serializable data class IssueDetail(val issue: IssueDTO = IssueDTO(), val events: List<IssueEventDTO> = emptyList())
@Serializable data class IssuesPage(val issues: List<IssueDTO> = emptyList())
@Serializable data class RemindersPage(val reminders: List<ReminderDTO> = emptyList())
@Serializable data class CalendarPage(val events: List<CalendarEventDTO> = emptyList())
@Serializable data class PinsResult(val messageIds: List<String> = emptyList())
@Serializable data class PinnedMessages(val messages: List<MessageDTO> = emptyList())
@Serializable data class ReadResult(val lastReadSeq: Long = 0)
@Serializable data class IdResult(val id: String = "")
@Serializable data class ReturnResult(val parentId: String = "", val messageId: String = "")

@Serializable
data class OrgDomainDTO(
    val domain: String = "",
    /** pending | idp | dns */
    val status: String = "pending",
    val txtName: String = "",
    val txtValue: String = "",
    val verifiedAt: String? = null,
    val lastCheckedAt: String? = null,
)
@Serializable data class DomainsPage(val domains: List<OrgDomainDTO> = emptyList())

@Serializable
data class WaAccountDTO(
    val id: String = "",
    val label: String = "",
    /** personal | business */
    val kind: String = "personal",
    /** pending | qr | connected | reconnecting | expired | logged_out | error */
    val status: String = "pending",
    val phone: String? = null,
    val pushName: String? = null,
    val platform: String? = null,
    val qr: String? = null,
    val pairingCode: String? = null,
    val lastError: String? = null,
    val connectedAt: String? = null,
    val lastSyncAt: String? = null,
    val chats: Int = 0,
    val groups: Int = 0,
    val createdAt: String = "",
)
@Serializable data class WaAccountsPage(val accounts: List<WaAccountDTO> = emptyList(), val max: Int = 5)

@Serializable
data class WaChatDTO(
    val accountId: String = "",
    val accountLabel: String = "",
    val accountKind: String = "personal",
    val jid: String = "",
    val name: String = "",
    val isGroup: Boolean = false,
    val participants: Int? = null,
    val description: String? = null,
    val lastMessageAt: String? = null,
    val lastPreview: String? = null,
    val unread: Int = 0,
    val category: String = "otros",
    val categoryManual: Boolean = false,
    val pinned: Boolean = false,
    val hidden: Boolean = false,
    val archivedInWhatsApp: Boolean = false,
    val linkedConversationId: String? = null,
)
@Serializable data class WaCount(val total: Int = 0, val unread: Int = 0)
@Serializable data class WaChatsPage(val chats: List<WaChatDTO> = emptyList(), val categories: Map<String, WaCount> = emptyMap())
@Serializable data class WaMessageDTO(val id: String = "", val fromMe: Boolean = false, val author: String? = null, val kind: String = "text", val body: String = "", val sentAt: String = "")
@Serializable data class WaMessagesPage(val messages: List<WaMessageDTO> = emptyList())
@Serializable data class WaOrganizeResult(val reviewed: Int = 0, val changed: Int = 0)

// ---------- Chats, perfil y archivos ----------
/** Resultado de POST /chats: con una persona, el directo (existente o nuevo); con varias, un chat `multi`. */
@Serializable data class CreateChatResult(val id: String = "", val kind: String = "multi")

@Serializable
data class DriveFolderDTO(
    val id: String = "",
    val parentId: String? = null,
    val name: String = "",
    val createdBy: String? = null,
    val createdAt: String = "",
)

@Serializable
data class DriveFileDTO(
    val id: String = "",
    val folderId: String? = null,
    val name: String = "",
    val contentType: String = "application/octet-stream",
    val size: Long = 0,
    val createdBy: String? = null,
    val createdAt: String = "",
    val updatedAt: String? = null,
)

/** Un árbol completo: «Mis archivos» (workspaceId null) o el de un espacio. */
@Serializable
data class DriveTreeDTO(
    val workspaceId: String? = null,
    val folders: List<DriveFolderDTO> = emptyList(),
    val files: List<DriveFileDTO> = emptyList(),
    val canManageAll: Boolean = false,
) {
    fun foldersIn(parent: String?): List<DriveFolderDTO> = folders.filter { it.parentId == parent }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    fun filesIn(folder: String?): List<DriveFileDTO> = files.filter { it.folderId == folder }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })

    /** Ruta de carpetas desde la raíz hasta [id] (migas de pan). */
    fun pathTo(id: String?): List<DriveFolderDTO> {
        val byId = folders.associateBy { it.id }
        val out = ArrayDeque<DriveFolderDTO>()
        var cur = id?.let { byId[it] }
        while (cur != null && out.size < 50) { out.addFirst(cur); cur = cur.parentId?.let { byId[it] } }
        return out.toList()
    }

    /** Búsqueda en todo el árbol (como la web: carpetas y archivos cuyo nombre contiene el texto). */
    fun search(q: String): Pair<List<DriveFolderDTO>, List<DriveFileDTO>> {
        val n = q.trim()
        if (n.isEmpty()) return emptyList<DriveFolderDTO>() to emptyList()
        return folders.filter { it.name.contains(n, ignoreCase = true) } to files.filter { it.name.contains(n, ignoreCase = true) }
    }
}

@Serializable data class LinkResult(val url: String = "")

const val MAX_AVATAR_BYTES = 3 * 1024 * 1024
const val MAX_DRIVE_FILE_BYTES = 25 * 1024 * 1024
const val MAX_FORWARD_TARGETS = 10

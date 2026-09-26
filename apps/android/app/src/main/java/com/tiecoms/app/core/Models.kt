package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** Versión del contrato que habla esta app (packages/contracts CONTRACT_VERSION). */
const val CONTRACT_VERSION = "2026-09-25"
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
    /** Espacio casa de una empresa («Tu organización»): sus grupos van sin cabecera de espacio. Ausente = false. */
    val isOrgHome: Boolean = false,
    /** Relación nueva cuya empresa aún no entra: se muestra en «Relaciones» con este nombre, como pendiente. */
    val counterpartName: String? = null,
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
    /** same | internal | directive | side (conversación lateral privada; valores futuros → derivada genérica) */
    val deriveKind: String? = null,
    val deriveReason: String? = null,
    val returnedAt: String? = null,
    val openIssues: Int = 0,
    /** Preferencias personales. */
    val pinnedAt: String? = null,
    val mutedUntil: String? = null,
    /** Foto del grupo: ruta /api/v1/avatars/<fileId> (null = ícono # / candado / iniciales). */
    val avatarUrl: String? = null,
    /** Último mensaje de una persona (SPEC-v4 §C): se prefiere sobre lastMessagePreview cuando lo último es de sistema. */
    val lastHumanPreview: LastHumanPreviewDTO? = null,
    /** Menciones a mí (o @todos) sin leer (SPEC-v4 §H). */
    val unreadMentions: Int = 0,
) {
    /** Directos y chats grupales van juntos en la lista: no pertenecen a un espacio. */
    val isChat: Boolean get() = kind == "direct" || kind == "multi"
    /** Conversación lateral: consulta privada que cuelga de un mensaje de [parentId]. */
    val isSide: Boolean get() = deriveKind == "side" && parentId != null

    fun mutedAt(nowMs: Long): Boolean =
        mutedUntil?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() > nowMs }.getOrDefault(false) } ?: false
}

@Serializable
data class LastHumanPreviewDTO(
    val messageId: String = "",
    val seq: Long = 0,
    val authorId: String = "",
    /** Puede ser '' si el mensaje solo trae adjuntos. */
    val body: String = "",
    val attachments: AttachmentSummaryDTO? = null,
    val createdAt: String = "",
)

@Serializable
data class AttachmentSummaryDTO(
    val count: Int = 0, val images: Int = 0, val videos: Int = 0, val files: Int = 0, val firstName: String? = null,
    val voices: Int = 0, val voiceDurationMs: Long? = null,
)

/** whatsapp | slack | email | teams | tiecoms | other */
@Serializable
data class ForwardedInfo(
    val source: String = "other",
    val author: String? = null,
    val sentAt: String? = null,
    val fromConversationId: String? = null,
    /** Respuesta en privado: el mensaje original al que responde. */
    val messageId: String? = null,
    /** Los pone el servidor cuando hay messageId: número del original (enlace ?m=) y extracto (≤ 200). */
    val messageSeq: Long? = null,
    val excerpt: String? = null,
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
    /** side | same | internal | directive: de qué tipo de derivada volvió («Desde un sidechat»). */
    val mergedKind: String? = null,
    val forwarded: ForwardedInfo? = null,
    /** Vista previa del primer enlace; llega después del envío con `message.updated`. */
    val linkPreview: LinkPreviewDTO? = null,
    /** Adjuntos (SPEC-v4): vacío o ausente en mensajes viejos. */
    val attachments: List<AttachmentDTO> = emptyList(),
    /** Menciones con @ (SPEC-v4 §H): solo las válidas, ordenadas por start (UTF-16 sobre body). */
    val mentions: List<MentionDTO> = emptyList(),
)

/** Mención: userId o 'all', y el tramo [start, start + length) de body, que empieza con «@». */
@Serializable
data class MentionDTO(val userId: String = "", val start: Int = 0, val length: Int = 0)

/** Archivo adjunto a un mensaje. `url` y `thumbUrl` son relativas al API y piden Bearer. */
@Serializable
data class AttachmentDTO(
    val id: String = "",
    val name: String = "",
    val contentType: String = "application/octet-stream",
    val sizeBytes: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    val url: String = "",
    val thumbUrl: String? = null,
    /** file | voice (SPEC-v4 §F); ausente en adjuntos viejos. */
    val kind: String? = null,
    val durationMs: Long? = null,
    /** ≤ 64 valores 0–1 para dibujar la onda. */
    val waveform: List<Float>? = null,
    val transcript: TranscriptDTO? = null,
) {
    val isVoice: Boolean get() = kind == "voice"
    val isImage: Boolean get() = !isVoice && contentType.startsWith("image/")
    val isVideo: Boolean get() = !isVoice && contentType.startsWith("video/")
}

/** Transcripción de una nota de voz: pending | done | failed | disabled. */
@Serializable
data class TranscriptDTO(
    val status: String = "pending",
    val text: String? = null,
    val language: String? = null,
    val summary: String? = null,
    /** Posible asunto detectado («Crear asunto: …»), si el servidor lo sugiere. */
    val suggestedIssue: String? = null,
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
data class SendResult(val message: MessageDTO? = null, val duplicate: Boolean = false, val droppedMentions: List<String> = emptyList())

/** Bandeja de menciones: GET /api/v1/mentions?before&limit. */
@Serializable
data class MentionItemDTO(val message: MessageDTO = MessageDTO(), val conversationId: String = "", val all: Boolean = false, val read: Boolean = false, val createdAt: String = "")
@Serializable
data class MentionsPage(val mentions: List<MentionItemDTO> = emptyList(), val hasMore: Boolean = false)

@Serializable
data class InvitationPreviewDTO(
    val workspaceName: String = "",
    val invitedByName: String = "",
    val invitedByOrg: String = "",
    val role: String = "member",
    val email: String? = null,
    val expiresAt: String = "",
    val valid: Boolean = false,
    /** Grupos a los que entra la persona (docs/GRUPOS.md). Ausente en servidores viejos. */
    val groupNames: List<String> = emptyList(),
    /** Enlace o código para varias personas. */
    val multiUse: Boolean = false,
    /** Invitación a un grupo interno de una empresa: se entra como invitado de fuera. */
    val orgHome: Boolean = false,
)

@Serializable
data class OrgInvitationPreviewDTO(
    val orgName: String = "",
    val invitedByName: String = "",
    val email: String? = null,
    val expiresAt: String = "",
    val valid: Boolean = false,
)

/** Respuesta de POST /workspaces/:id/invitations: `url` para compartir y, sin correo, `code` (K7QM-4XPA). */
@Serializable
data class InvitationCreatedDTO(
    val id: String = "",
    val token: String = "",
    val url: String = "",
    val code: String? = null,
    val expiresAt: String = "",
    val emailSent: Boolean = false,
    val emailStatus: String? = null,
)

/** Respuesta de POST /groups (el «+» de Grupos). Con shareLink trae el enlace y el código. */
@Serializable
data class CreateGroupResultDTO(
    val workspaceId: String = "",
    val conversationId: String = "",
    val invited: Int = 0,
    val inviteUrl: String? = null,
    val inviteCode: String? = null,
)

/** Supervisión: un grupo donde participa gente de mi empresa (solo owner/admin). */
@Serializable
data class OversightGroupDTO(
    val conversationId: String = "",
    val name: String? = null,
    /** group | internal */
    val kind: String = "group",
    val workspaceId: String = "",
    val workspaceName: String = "",
    val owningOrgId: String = "",
    val organizationIds: List<String> = emptyList(),
    val memberCount: Int = 0,
    /** Personas de mi empresa en el grupo. */
    val myOrgMemberIds: List<String> = emptyList(),
    val lastMessageAt: String? = null,
    /** Si ya soy miembro; si no, se abre en solo lectura. */
    val iAmMember: Boolean = false,
)

/** Respuesta de archivar un grupo: si era el último de un espacio que no es casa, el espacio también se archiva. */
@Serializable
data class ArchiveResult(val archived: Boolean = false, val workspaceArchived: Boolean = false)

@Serializable
data class OversightDTO(val orgId: String = "", val groups: List<OversightGroupDTO> = emptyList())

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
data class SendBody(
    val clientMessageId: String, val body: String, val replyTo: String? = null, val forwarded: ForwardedInfo? = null,
    val attachmentIds: List<String>? = null, val forwardAttachmentIds: List<String>? = null, val mentions: List<MentionDTO>? = null,
)

@Serializable
data class SocketSendBody(
    val conversationId: String, val clientMessageId: String, val body: String,
    val replyTo: String? = null, val forwarded: ForwardedInfo? = null, val attachmentIds: List<String>? = null,
    val forwardAttachmentIds: List<String>? = null, val mentions: List<MentionDTO>? = null,
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
    /** Ya subidos (pendientes en el servidor hasta que este mensaje los use). */
    val attachments: List<AttachmentDTO> = emptyList(),
    /** Adjuntos de otro mensaje que se reenvían (el servidor copia la referencia). */
    val forwardAttachments: List<AttachmentDTO> = emptyList(),
    val mentions: List<MentionDTO> = emptyList(),
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
    /** null en directos, chats grupales y laterales (SPEC-v4 §E). */
    val workspaceId: String? = null,
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
    /** null en directos, chats grupales y laterales (SPEC-v4 §E). */
    val workspaceId: String? = null,
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
@Serializable data class ReturnSuggestion(val summary: String = "", val source: String = "fallback")
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
@Serializable data class AvatarResult(val avatarUrl: String? = null)
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

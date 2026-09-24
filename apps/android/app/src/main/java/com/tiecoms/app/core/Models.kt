package com.tiecoms.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** Versión del contrato que habla esta app (packages/contracts CONTRACT_VERSION). */
const val CONTRACT_VERSION = "2026-09-23"
const val PLATFORM = "android"

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
)

@Serializable
data class ConversationDTO(
    val id: String = "",
    val workspaceId: String? = null,
    /** group | internal | direct (valores futuros se tratan como group). */
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
    // Campos nuevos (bifurcaciones): se aceptan y se ignoran en esta versión de la interfaz.
    val parentId: String? = null,
    val deriveKind: String? = null,
    val openIssues: Int = 0,
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
)

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
data class SendBody(val clientMessageId: String, val body: String, val replyTo: String? = null)

@Serializable
data class SocketSendBody(val conversationId: String, val clientMessageId: String, val body: String, val replyTo: String? = null)

@Serializable
data class ReadBody(val seq: Long)

/** Mensaje propio aún no confirmado por el servidor; vive en la cola persistente. */
@Serializable
data class PendingMessage(
    val clientMessageId: String,
    val conversationId: String,
    val body: String,
    val replyTo: String? = null,
    val createdAt: String,
    val attempts: Int = 0,
    /** pending | sending | failed */
    val status: String = "pending",
    val error: String? = null,
    val nextAttemptAt: Long = 0,
)

/**
 * Contrato público de TieComs.
 *
 * Lo comparten el API, la web y las apps (escritorio, Android, iOS). Una app
 * instalada no se actualiza con cada despliegue, así que los cambios aquí son
 * aditivos; un cambio incompatible exige subir API_VERSION y mantener la
 * versión anterior durante la ventana de soporte (MIN_CLIENT_CONTRACT).
 */
import { z } from 'zod';

export const API_VERSION = 1;
export const CONTRACT_VERSION = '2026-09-23';
/** Clientes con un contrato anterior a este deben actualizarse. */
export const MIN_CLIENT_CONTRACT = '2026-09-23';

export const Platform = z.enum(['web', 'macos', 'windows', 'android', 'ios', 'agent']);
export type Platform = z.infer<typeof Platform>;

export const DeviceInfo = z.object({
  deviceId: z.string().min(8).max(64),
  name: z.string().max(120).default('Navegador'),
  platform: Platform.default('web'),
  contract: z.string().max(20).default(CONTRACT_VERSION),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

const email = z.email().max(254).transform((s) => s.trim().toLowerCase());
const password = z.string().min(10).max(200);
const personName = z.string().trim().min(2).max(120);

// ---------- Auth ----------
export const SignupInput = z.object({
  name: personName,
  email,
  password,
  /** Crea una empresa nueva… */
  orgName: z.string().trim().min(2).max(120).optional(),
  /** …o se une a una existente con una invitación de empresa. */
  orgInviteToken: z.string().min(16).max(200).optional(),
  title: z.string().trim().max(120).optional(),
  device: DeviceInfo,
}).refine((v) => !!v.orgName || !!v.orgInviteToken, { message: 'org_required', path: ['orgName'] });
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({ email, password: z.string().min(1).max(200), device: DeviceInfo });
export type LoginInput = z.infer<typeof LoginInput>;

export const RefreshInput = z.object({ refreshToken: z.string().optional() });

// ---------- Inicio de sesión con Google / Microsoft ----------
export const SsoProvider = z.enum(['google', 'microsoft']);
export type SsoProvider = z.infer<typeof SsoProvider>;

/**
 * Flujo para todas las plataformas (web, iOS, Android, escritorio):
 * 1. El cliente abre en el navegador del sistema
 *    GET /api/v1/auth/{provider}/start?platform=&code_challenge=&code_challenge_method=S256[&org=<token>][&org_name=][&next=]
 * 2. El servidor habla con Google/Microsoft y redirige a
 *    web: {origen}/auth/sso?code=…   nativas y escritorio: tiecoms://auth/callback?code=…
 *    (si falla: …?error=<código>&message=<texto>)
 * 3. El cliente canjea el código (60 s, un solo uso) con su code_verifier.
 */
const pkceVerifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
/** Acepta `codeVerifier` (web) y `code_verifier` (apps iOS y Android, estilo RFC 7636). */
export const SsoExchangeInput = z.preprocess(
  (v: any) => (v && typeof v === 'object' && v.codeVerifier === undefined && v.code_verifier !== undefined ? { ...v, codeVerifier: v.code_verifier } : v),
  z.object({ code: z.string().min(16).max(200), codeVerifier: pkceVerifier, device: DeviceInfo }),
);
export type SsoExchangeInput = z.infer<typeof SsoExchangeInput>;

export const UpdateProfileInput = z.object({
  name: personName.optional(),
  title: z.string().trim().max(120).nullable().optional(),
  area: z.string().trim().max(120).nullable().optional(),
});
export const AddDomainInput = z.object({ domain: z.string().trim().min(3).max(253) });

export interface AuthResult {
  accessToken: string;
  accessExpiresAt: string;
  /** Solo para clientes nativos; la web lo recibe en cookie httpOnly. */
  refreshToken?: string;
  sessionId: string;
  user: UserDTO;
}

// ---------- Entidades ----------
export type OrgRole = 'owner' | 'admin' | 'member';
export type WorkspaceRole = 'lead' | 'admin' | 'member' | 'guest';
/** multi = chat grupal entre personas (de una o varias empresas) que no vive en un espacio. */
export type ConversationKind = 'group' | 'internal' | 'direct' | 'multi';
export type ConversationLevel = 'directivo' | 'operativo' | null;

export interface UserDTO {
  id: string;
  name: string;
  email?: string;
  kind: 'human' | 'agent';
  title?: string | null;
  area?: string | null;
  primaryOrgId: string | null;
  /** Ruta de la foto (/api/v1/avatars/…) o null. */
  avatarUrl?: string | null;
}

export interface OrganizationDTO {
  id: string;
  name: string;
  mark: string;
  colorBg: string;
  colorFg: string;
  /** Solo presente en organizaciones donde el usuario es miembro. */
  myRole?: OrgRole;
  /** none: sin verificar; idp: dominio confirmado por Google Workspace o Microsoft Entra; dns: registro TXT verificado. */
  verification?: 'none' | 'idp' | 'dns';
  verifiedDomain?: string | null;
}

export interface OrgDomainDTO {
  domain: string;
  status: 'pending' | 'idp' | 'dns';
  /** Registro TXT que el administrador debe crear en su DNS. */
  txtName: string;
  txtValue: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
}

export interface PersonDTO {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  orgId: string | null;
  title: string | null;
  area: string | null;
  guest: boolean;
  guestUntil: string | null;
  avatarUrl?: string | null;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  department: string | null;
  glyph: string | null;
  owningOrgId: string;
  organizationIds: string[];
  /** Participantes activos del espacio (vacío para terceros: solo ven sus grupos). */
  memberIds: string[];
  myRole: WorkspaceRole;
  createdAt: string;
  pinnedAt: string | null;
}

export interface ConversationDTO {
  id: string;
  workspaceId: string | null;
  kind: ConversationKind;
  level: ConversationLevel;
  name: string | null;
  internalOrgId: string | null;
  memberIds: string[];
  lastMessageSeq: number;
  lastEventSeq: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastReadSeq: number;
  unread: number;
  canPost: boolean;
  canManage: boolean;
  /** Mensajes visibles para mí a partir de este seq (exclusivo). */
  historyFromSeq: number;
  /** Bifurcación: de qué conversación y mensaje se derivó. El nombre del origen solo se conoce si también lo puedo leer. */
  parentId: string | null;
  parentMessageId: string | null;
  parentMessageSeq: number | null;
  deriveKind: DeriveKind | null;
  deriveReason: string | null;
  returnedAt: string | null;
  openIssues: number;
  /** Preferencias personales. */
  pinnedAt: string | null;
  mutedUntil: string | null;
}

export type ForwardSource = 'whatsapp' | 'slack' | 'email' | 'teams' | 'tiecoms' | 'other';
/** imageUrl es una ruta del API (/api/v1/previews/…): la miniatura ya está en TieComs. */
export interface LinkPreviewDTO { url: string; title: string | null; description: string | null; siteName: string | null; imageUrl: string | null }
export interface ForwardedInfo { source: ForwardSource; author?: string | null; sentAt?: string | null; fromConversationId?: string | null }

export interface ReminderDTO {
  id: string;
  conversationId: string;
  messageId: string | null;
  messageSeq: number | null;
  note: string | null;
  remindAt: string;
  firedAt: string | null;
  doneAt: string | null;
}

export type Rsvp = 'pending' | 'yes' | 'no' | 'maybe';
export interface CalendarEventDTO {
  id: string;
  workspaceId: string;
  conversationId: string;
  originMessageId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  organizerId: string;
  invitees: { userId: string; rsvp: Rsvp }[];
  cancelledAt: string | null;
  updatedAt: string;
}

export type DeriveKind = 'same' | 'internal' | 'directive';
export type IssueStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'cancelled';

export interface IssueDTO {
  id: string;
  workspaceId: string;
  conversationId: string;
  originMessageId: string | null;
  originMessageSeq: number | null;
  title: string;
  status: IssueStatus;
  waitingOnOrgId: string | null;
  ownerId: string | null;
  requestedBy: string | null;
  dueDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Desde cuándo está en el estado actual (para detectar cuellos de botella). */
  statusSince: string;
  closedAt: string | null;
  commentCount: number;
}

export interface IssueEventDTO {
  id: number;
  issueId: string;
  actorId: string;
  kind: 'created' | 'status' | 'owner' | 'due' | 'title' | 'comment' | 'waiting';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  seq: number;
  authorId: string;
  clientMessageId: string | null;
  kind: 'text' | 'system';
  body: string;
  replyTo: string | null;
  /** Si este mensaje trae de vuelta el resultado de una conversación derivada. */
  mergedFrom: string | null;
  /** Mensaje traído desde WhatsApp, Slack, correo u otra conversación. */
  forwarded: ForwardedInfo | null;
  /** Vista previa del primer enlace; llega después con message.updated. Clientes viejos pueden no traerla. */
  linkPreview?: LinkPreviewDTO | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface BootstrapDTO {
  contract: string;
  serverTime: string;
  me: UserDTO;
  organizations: OrganizationDTO[];
  workspaces: WorkspaceDTO[];
  conversations: ConversationDTO[];
  people: PersonDTO[];
}

// ---------- Espacios y conversaciones ----------
export const CreateWorkspaceInput = z.object({
  name: z.string().trim().min(2).max(120),
  department: z.string().trim().max(160).optional(),
  glyph: z.string().trim().max(4).optional(),
  orgId: z.uuid().optional(),
});

export const CreateConversationInput = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['group', 'internal']).default('group'),
  level: z.enum(['directivo', 'operativo']).nullable().default(null),
  memberIds: z.array(z.uuid()).max(500).default([]),
});

export const AddMembersInput = z.object({
  userIds: z.array(z.uuid()).min(1).max(200),
  /** 'now' = ven solo lo nuevo (por defecto); 'all' = concesión explícita del historial. */
  history: z.enum(['now', 'all']).default('now'),
});

export const CreateDirectInput = z.object({ userId: z.uuid() });
/** Nuevo chat: con una persona abre (o reutiliza) el directo; con varias crea un chat grupal. */
export const CreateChatInput = z.object({ userIds: z.array(z.uuid()).min(1).max(50), name: z.string().trim().min(2).max(120).optional() });

export const CreateInvitationInput = z.object({
  email: email.optional(),
  role: z.enum(['member', 'guest', 'admin']).default('member'),
  conversationIds: z.array(z.uuid()).max(50).default([]),
  expiresInDays: z.number().int().min(1).max(60).default(7),
  /** Para terceros (guest): fecha de salida del espacio. */
  accessUntil: z.iso.datetime().optional(),
  history: z.enum(['now', 'all']).default('now'),
  /** Idioma del correo de invitación (si hay `email`). */
  lang: z.enum(['es', 'en']).default('es'),
});

export const CreateOrgInvitationInput = z.object({
  email: email.optional(),
  role: z.enum(['member', 'admin']).default('member'),
  expiresInDays: z.number().int().min(1).max(60).default(14),
  lang: z.enum(['es', 'en']).default('es'),
});

export interface OrgInvitationPreviewDTO {
  orgName: string;
  invitedByName: string;
  email: string | null;
  expiresAt: string;
  valid: boolean;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const CreateIssueInput = z.object({
  title: z.string().trim().min(2).max(200),
  ownerId: z.uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  originMessageId: z.uuid().nullable().optional(),
});
export const UpdateIssueInput = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
  ownerId: z.uuid().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  waitingOnOrgId: z.uuid().nullable().optional(),
});
export const IssueCommentInput = z.object({ body: z.string().trim().min(1).max(4000) });

export const DeriveInput = z.object({
  messageId: z.uuid(),
  kind: z.enum(['same', 'internal', 'directive']),
  name: z.string().trim().min(2).max(120).optional(),
  reason: z.string().trim().max(300).optional(),
});
export const ReturnResultInput = z.object({ summary: z.string().trim().min(2).max(4000) });

export const AcceptInvitationInput = z.object({ orgId: z.uuid().optional() });

/** Invitación con correo que aún no se acepta (lista de pendientes para reenviar o revocar). */
export interface PendingInvitationDTO {
  id: string;
  email: string;
  role: string;
  invitedById: string;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  /** Resultado del último envío: null si nunca se intentó. */
  emailStatus: 'sent' | 'failed' | 'skipped' | null;
  emailSentAt: string | null;
  sendCount: number;
  /** Quien invitó o quien administra puede reenviar y revocar. */
  canManage: boolean;
}

export interface InvitationPreviewDTO {
  workspaceName: string;
  invitedByName: string;
  invitedByOrg: string;
  role: WorkspaceRole;
  email: string | null;
  expiresAt: string;
  valid: boolean;
}

// ---------- Mensajes ----------
export const ForwardedInput = z.object({
  source: z.enum(['whatsapp', 'slack', 'email', 'teams', 'tiecoms', 'other']),
  author: z.string().trim().max(120).nullable().optional(),
  sentAt: z.string().max(40).nullable().optional(),
  fromConversationId: z.uuid().nullable().optional(),
});
export const SendMessageInput = z.object({
  clientMessageId: z.string().min(8).max(64),
  body: z.string().trim().min(1).max(8000),
  replyTo: z.uuid().nullable().optional(),
  forwarded: ForwardedInput.nullable().optional(),
});
export const EditMessageInput = z.object({ body: z.string().trim().min(1).max(8000) });
export const ConversationPrefsInput = z.object({ pinned: z.boolean().optional(), mutedUntil: z.iso.datetime().nullable().optional() });
export const WorkspacePrefsInput = z.object({ pinned: z.boolean() });
export const MarkUnreadInput = z.object({ seq: z.number().int().min(1) });
export const CreateReminderInput = z.object({
  conversationId: z.uuid(), messageId: z.uuid().nullable().optional(), note: z.string().trim().max(300).nullable().optional(), remindAt: z.iso.datetime(),
});
export const CreateEventInput = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  location: z.string().trim().max(500).nullable().optional(),
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  timezone: z.string().min(1).max(64),
  inviteeIds: z.array(z.uuid()).max(200).optional(),
  originMessageId: z.uuid().nullable().optional(),
});
export const UpdateEventInput = CreateEventInput.partial();
export const RsvpInput = z.object({ rsvp: z.enum(['yes', 'no', 'maybe']) });
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const MarkReadInput = z.object({ seq: z.number().int().min(0) });

export const PageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const EventsQuery = z.object({
  after: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ---------- Archivos (árbol de carpetas) ----------
export interface DriveFolderDTO { id: string; parentId: string | null; name: string; createdBy: string; createdAt: string }
export interface DriveFileDTO { id: string; folderId: string | null; name: string; contentType: string; size: number; createdBy: string; createdAt: string; updatedAt: string }
/** Un árbol completo: «Mis archivos» (workspaceId null) o el de un espacio. */
export interface DriveTreeDTO { workspaceId: string | null; folders: DriveFolderDTO[]; files: DriveFileDTO[]; canManageAll: boolean }
const driveName = z.string().trim().min(1).max(120);
export const CreateFolderInput = z.object({ workspaceId: z.uuid().nullable().optional(), parentId: z.uuid().nullable().optional(), name: driveName });
export const UpdateFolderInput = z.object({ name: driveName.optional(), parentId: z.uuid().nullable().optional() });
export const UpdateFileInput = z.object({ name: driveName.optional(), folderId: z.uuid().nullable().optional() });
export const UploadFileQuery = z.object({ workspaceId: z.uuid().optional(), folderId: z.uuid().optional(), name: z.string().min(1).max(400) });

// ---------- Conectar WhatsApp ----------
export const WaKind = z.enum(['personal', 'business']);
export type WaKind = z.infer<typeof WaKind>;
export const WaCategory = z.enum(['trabajo', 'clientes', 'familia', 'amigos', 'comunidad', 'otros']);
export type WaCategory = z.infer<typeof WaCategory>;
export type WaStatus = 'pending' | 'qr' | 'connected' | 'reconnecting' | 'expired' | 'logged_out' | 'error';

/** Número con indicativo para vincular con código de 8 letras en vez de QR (útil desde el mismo teléfono). */
const PairPhone = z.string().trim().max(24).regex(/^[+\d\s()-]*$/, 'Solo números').nullable().optional();
export const CreateWaAccountInput = z.object({ label: z.string().trim().min(1).max(60), kind: WaKind, pairPhone: PairPhone });
export const UpdateWaAccountInput = z.object({ label: z.string().trim().min(1).max(60).optional(), kind: WaKind.optional() });
export const RelinkWaAccountInput = z.object({ pairPhone: PairPhone });
export const WaChatsQuery = z.object({
  accountId: z.uuid().optional(),
  category: WaCategory.optional(),
  groups: z.enum(['1', '0']).optional(),
  q: z.string().max(100).optional(),
  hidden: z.enum(['1', '0']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export const UpdateWaChatInput = z.object({
  /** null = volver a la categoría sugerida. */
  category: WaCategory.nullable().optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  /** Conversación de TieComs a la que llegan los mensajes nuevos de este chat (null = desvincular). */
  linkedConversationId: z.uuid().nullable().optional(),
});
export const WaMessagesQuery = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) });

export interface WaAccountDTO {
  id: string;
  label: string;
  kind: WaKind;
  status: WaStatus;
  phone: string | null;
  pushName: string | null;
  platform: string | null;
  /** data:image/png del QR mientras status = 'qr'. */
  qr: string | null;
  pairingCode: string | null;
  lastError: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  chats: number;
  groups: number;
  createdAt: string;
}
export interface WaChatDTO {
  accountId: string;
  accountLabel: string;
  accountKind: WaKind;
  jid: string;
  name: string;
  isGroup: boolean;
  participants: number | null;
  description: string | null;
  lastMessageAt: string | null;
  lastPreview: string | null;
  unread: number;
  category: WaCategory;
  categoryManual: boolean;
  pinned: boolean;
  hidden: boolean;
  archivedInWhatsApp: boolean;
  linkedConversationId: string | null;
}
export interface WaMessageDTO { id: string; fromMe: boolean; author: string | null; kind: string; body: string; sentAt: string }

// ---------- Eventos en tiempo real ----------
/** Evento durable de una conversación, ordenado por eventSeq. */
export type ConversationEvent =
  | { type: 'message.created'; conversationId: string; eventSeq: number; message: MessageDTO }
  | { type: 'message.updated'; conversationId: string; eventSeq: number; message: MessageDTO }
  | { type: 'members.changed'; conversationId: string; eventSeq: number; memberIds: string[] }
  | { type: 'issue.updated'; conversationId: string; eventSeq: number; issue: IssueDTO }
  | { type: 'pins.changed'; conversationId: string; eventSeq: number; messageIds: string[] }
  | { type: 'calendar.updated'; conversationId: string; eventSeq: number; event: CalendarEventDTO }
  /** Evento fuera de tu historial visible: solo avanza el cursor. */
  | { type: 'redacted'; conversationId: string; eventSeq: number };

/** Aviso a una cuenta: algo cambió en su alcance; el cliente vuelve a pedir /bootstrap. */
export type AccountEvent =
  | { type: 'scope.changed'; reason: string }
  | { type: 'read.updated'; conversationId: string; seq: number }
  | { type: 'reminder.due'; reminder: ReminderDTO }
  | { type: 'prefs.updated'; conversationId?: string; workspaceId?: string }
  | { type: 'whatsapp.updated'; accountId: string }
  | { type: 'drive.updated'; workspaceId: string | null };

export interface EventsPage {
  events: ConversationEvent[];
  /** true si el cursor es demasiado antiguo: el cliente debe pedir un snapshot nuevo. */
  resetRequired: boolean;
  lastEventSeq: number;
}

export const SOCKET_EVENTS = {
  conversationEvent: 'conv.event',
  accountEvent: 'account.event',
  send: 'message.send',
  typing: 'typing',
} as const;

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

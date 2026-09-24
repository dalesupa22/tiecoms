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
const password = z.string().min(10, 'Mínimo 10 caracteres').max(200);
const personName = z.string().trim().min(2).max(120);

// ---------- Auth ----------
export const SignupInput = z.object({
  name: personName,
  email,
  password,
  orgName: z.string().trim().min(2).max(120),
  title: z.string().trim().max(120).optional(),
  device: DeviceInfo,
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({ email, password: z.string().min(1).max(200), device: DeviceInfo });
export type LoginInput = z.infer<typeof LoginInput>;

export const RefreshInput = z.object({ refreshToken: z.string().optional() });

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
export type ConversationKind = 'group' | 'internal' | 'direct';
export type ConversationLevel = 'directivo' | 'operativo' | null;

export interface UserDTO {
  id: string;
  name: string;
  email?: string;
  kind: 'human' | 'agent';
  title?: string | null;
  area?: string | null;
  primaryOrgId: string | null;
}

export interface OrganizationDTO {
  id: string;
  name: string;
  mark: string;
  colorBg: string;
  colorFg: string;
  /** Solo presente en organizaciones donde el usuario es miembro. */
  myRole?: OrgRole;
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

export const CreateInvitationInput = z.object({
  email: email.optional(),
  role: z.enum(['member', 'guest', 'admin']).default('member'),
  conversationIds: z.array(z.uuid()).max(50).default([]),
  expiresInDays: z.number().int().min(1).max(60).default(7),
  /** Para terceros (guest): fecha de salida del espacio. */
  accessUntil: z.iso.datetime().optional(),
  history: z.enum(['now', 'all']).default('now'),
});

export const AcceptInvitationInput = z.object({ orgId: z.uuid().optional() });

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
export const SendMessageInput = z.object({
  clientMessageId: z.string().min(8).max(64),
  body: z.string().trim().min(1).max(8000),
  replyTo: z.uuid().nullable().optional(),
});
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

// ---------- Eventos en tiempo real ----------
/** Evento durable de una conversación, ordenado por eventSeq. */
export type ConversationEvent =
  | { type: 'message.created'; conversationId: string; eventSeq: number; message: MessageDTO }
  | { type: 'message.updated'; conversationId: string; eventSeq: number; message: MessageDTO }
  | { type: 'members.changed'; conversationId: string; eventSeq: number; memberIds: string[] }
  /** Evento fuera de tu historial visible: solo avanza el cursor. */
  | { type: 'redacted'; conversationId: string; eventSeq: number };

/** Aviso a una cuenta: algo cambió en su alcance; el cliente vuelve a pedir /bootstrap. */
export type AccountEvent =
  | { type: 'scope.changed'; reason: string }
  | { type: 'read.updated'; conversationId: string; seq: number };

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

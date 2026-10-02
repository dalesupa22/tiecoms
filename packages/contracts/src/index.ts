/**
 * Contrato público de chaggu.
 *
 * Lo comparten el API, la web y las apps (escritorio, Android, iOS). Una app
 * instalada no se actualiza con cada despliegue, así que los cambios aquí son
 * aditivos; un cambio incompatible exige subir API_VERSION y mantener la
 * versión anterior durante la ventana de soporte (MIN_CLIENT_CONTRACT).
 */
import { z } from 'zod';
import type { DriveFileDTO } from './drive.ts';

export const API_VERSION = 1;
export const CONTRACT_VERSION = '2026-09-29.2';
/** Clientes con un contrato anterior a este deben actualizarse. */
export const MIN_CLIENT_CONTRACT = '2026-09-23';

/** GET /api/v1/app-version?platform=ios|android (público): última versión publicada (docs/ACTUALIZAR.md). */
export interface AppVersionDTO {
  platform: 'ios' | 'android';
  latestVersion: string;
  latestBuild: number;
  /** Builds menores que este deben actualizar para seguir usando la app (0 = ninguno). */
  minBuild: number;
  /** Dónde se actualiza: TestFlight/App Store o Google Play. */
  url: string;
  notes: string | null;
}

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
  orgInviteToken: z.string().min(8).max(200).optional(),
  title: z.string().trim().max(120).optional(),
  device: DeviceInfo,
});
/** Sin empresa ni invitación solo con correo corporativo: se suma a la del dominio o la crea con su nombre (el API lo valida). */
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({ email, password: z.string().min(1).max(200), device: DeviceInfo });
/** POST /auth/signup/confirm: el enlace del correo de confirmación (registro con correo corporativo). */
export const SignupConfirmInput = z.object({ token: z.string().min(20).max(100), device: DeviceInfo });
export interface SignupConfirmPreviewDTO { email: string; name: string; orgName: string | null; joining: boolean }
export type LoginInput = z.infer<typeof LoginInput>;

export const RefreshInput = z.object({ refreshToken: z.string().optional() });

// ---------- Inicio de sesión con Google / Microsoft ----------
export const SsoProvider = z.enum(['google', 'microsoft']);

// ---------- Reuniones con proveedores (Meet, Teams, Zoom) ----------
export const MeetingProvider = z.enum(['google', 'microsoft', 'zoom']);
export type MeetingProvider = z.infer<typeof MeetingProvider>;
/** Estado de mi conexión con un proveedor. available=false: falta configurarlo en el servidor (unavailableReason). */
export interface MeetingConnectionDTO {
  provider: MeetingProvider; label: string; available: boolean; unavailableReason: string | null;
  status: 'none' | 'active' | 'reconnect'; accountEmail: string | null;
}
export interface MeetingDTO {
  id: string; provider: MeetingProvider; status: 'creating' | 'created' | 'failed'; title: string;
  startsAt: string; endsAt: string; timezone: string;
  /** Enlace real devuelto por el proveedor (nunca inventado). */
  joinUrl: string | null; conversationId: string | null; calendarEventId: string | null; messageId: string | null; error: string | null;
}
/** The client retains a random verifier (32+ bytes); only its S256 challenge leaves at start.
 * Callback returns a one-use receipt, NOT an active connection. Confirm on the original authenticated client. */
export const MeetingConnectInput = z.object({
  platform: z.enum(['web', 'ios', 'android', 'desktop']).default('web'),
  redirectScheme: z.enum(['chaggu', 'tiecoms']).optional(),
  proofChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const MeetingConfirmInput = z.object({
  receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  proofVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
/** POST /meetings: sin startsAt = reunión ahora. share=true la publica en la conversación y el calendario. */
export const CreateMeetingInput = z.object({
  provider: MeetingProvider,
  conversationId: z.uuid().nullable().optional(),
  idempotencyKey: z.string().min(8).max(80),
  title: z.string().trim().min(2).max(200),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  durationMin: z.number().int().min(15).max(480).default(30),
  timezone: z.string().min(1).max(64),
  share: z.boolean().default(true),
});
export type SsoProvider = z.infer<typeof SsoProvider>;

// ---------- Llamadas (Amazon Chime SDK) ----------
export const CallKind = z.enum(['audio', 'video']);
export type CallKind = z.infer<typeof CallKind>;
/**
 * Dispositivo dentro de una llamada (1.7.1, docs/LLAMADAS.md › Varios dispositivos): los primeros 8 caracteres del
 * id de sesión o de dispositivo. El attendee de Chime queda con ExternalUserId = "{userId}#{deviceKey}"; los
 * clientes toman el id de la persona con externalUserId.split('#')[0]. Sin deviceKey (clientes 1.7.0) = 'legacy'.
 */
export const CallDeviceKey = z.string().regex(/^[A-Za-z0-9_-]{1,16}$/);
export const LEGACY_DEVICE_KEY = 'legacy';
/** La persona de un externalUserId de Chime ("{userId}#{deviceKey}" o solo "{userId}"). */
export const callUserId = (externalUserId: string) => externalUserId.split('#')[0]!;
/** POST /conversations/:id/call: empieza la llamada o entra a la que ya está en curso. */
export const StartCallInput = z.object({ kind: CallKind.default('audio'), deviceKey: CallDeviceKey.optional() });
/** POST /calls/:id/join y /heartbeat: desde qué dispositivo. POST /calls/:id/leave: qué dispositivo mío sale («Pasar aquí» = el otro). */
export const CallDeviceInput = z.object({ deviceKey: CallDeviceKey.optional() });
/** Un dispositivo mío que está dentro de la llamada. platform y label vienen de la sesión («iPhone», «Navegador»). */
export interface CallDeviceDTO { deviceKey: string; platform: string; label: string }
/** GET /calls/active: llamadas sin terminar de mis conversaciones (y a las que me agregaron). */
export interface ActiveCallDTO { call: CallDTO; title: string | null }
export interface CallDTO {
  id: string;
  conversationId: string;
  kind: CallKind;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  /** Quienes están dentro ahora mismo. */
  activeUserIds: string[];
  /** La transcripción está prendida (todos lo ven en la llamada). */
  transcribing: boolean;
  /** Hay transcripción guardada para leer. */
  hasTranscript: boolean;
  /** Personas agregadas a la llamada que no están en el chat. */
  invitedUserIds?: string[];
  /** Nombres de quienes están o fueron agregados (para quien no los tiene en su lista de personas). */
  names?: Record<string, string>;
  /**
   * 1.7.1: mis dispositivos dentro de la llamada. Solo llega en eventos de MI cuenta (call.updated por la cuenta),
   * en /calls/active y en BootstrapDTO.myActiveCall; el call.updated de la conversación no lo trae (el cliente
   * conserva el último que recibió para esa llamada).
   */
  myDevices?: CallDeviceDTO[];
  /**
   * 1.7.1: a quién se llamó con «＋ Agregar» (POST /calls/:id/invite), del chat o de fuera, y si ya entró después de
   * esa llamada. Los clientes muestran «Llamando…» y, pasados 45 s sin entrar, «No contestó» con «Volver a llamar».
   */
  invited?: { userId: string; at: string; joined: boolean }[];
  /** Invitados por enlace que están dentro ahora (sin cuenta). En Chime su externalUserId es "guest:{id}". */
  guests?: CallGuestDTO[];
}
export interface CallGuestDTO { id: string; name: string }
/** externalUserId de Chime de un invitado por enlace. */
export const guestExternalId = (guestId: string) => `guest:${guestId}`;
export const isGuestExternalId = (id: string | null | undefined) => !!id && id.startsWith('guest:');
/** POST /calls/:id/link: enlace para que terceros entren sin cuenta (vale mientras la llamada siga abierta). */
export interface CallLinkDTO { url: string; token: string }
/** GET /api/v1/call-links/:token (público): qué llamada es, antes de pedir el nombre. */
export interface GuestCallPreviewDTO { title: string | null; hostName: string; orgName: string | null; kind: CallKind; active: boolean }
export const GuestJoinInput = z.object({ name: z.string().trim().min(1).max(60) });
/** Lo que ve el invitado de la llamada (sin ids de la conversación ni del resto de chaggu). */
export interface GuestCallStateDTO {
  callId: string; kind: CallKind; active: boolean; transcribing: boolean;
  /** Personas con cuenta que están dentro (ids solo para asociar los recuadros de video). */
  activeUserIds: string[];
  guests: CallGuestDTO[];
  names: Record<string, string>;
}
/** Sala de reunión abierta: un enlace permanente que cualquiera con el enlace puede usar (docs/LLAMADAS.md › Salas). */
export interface RoomDTO { id: string; code: string; title: string; url: string; live: boolean; guests: number; createdAt: string }
export const CreateRoomInput = z.object({ title: z.string().trim().max(120).default('') });
export interface GuestJoinDTO { guestId: string; secret: string; call: GuestCallStateDTO; meeting: unknown; attendee: unknown }
export const GuestSecretInput = z.object({ secret: z.string().min(20).max(100) });
/** POST /calls/:id/invite: suma personas a la llamada en curso (les suena aunque no estén en el chat). */
export const CallInviteInput = z.object({ userIds: z.array(z.uuid()).min(1).max(20) });
/** aiSummary: quien la prende autoriza que DeepSeek resuma la transcripción al colgar. */
export const CallTranscriptionInput = z.object({ on: z.boolean(), aiSummary: z.boolean().default(false) });
/** Frases finales que el cliente recibió del SDK (TranscriptEvent con isPartial=false). */
export const CallTranscriptInput = z.object({
  segments: z.array(z.object({
    resultId: z.string().min(1).max(128),
    attendeeId: z.string().max(128).nullable().optional(),
    externalUserId: z.string().max(128).nullable().optional(),
    language: z.string().max(16).nullable().optional(),
    text: z.string().trim().min(1).max(4000),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
  })).min(1).max(50),
});
export type CallTranscriptSegmentInput = z.input<typeof CallTranscriptInput>['segments'][number];
export interface CallTranscriptSegmentDTO { resultId: string; speakerUserId: string | null; speakerName: string | null; language: string | null; text: string; startMs: number; endMs: number }
/** Una fila del historial de llamadas (pestaña «Llamadas»). */
export interface CallHistoryItemDTO {
  call: CallDTO;
  /** Todos los que entraron alguna vez, en orden de llegada. */
  participantIds: string[];
  durationSec: number | null;
  hasSummary: boolean;
  /** Me sonó, no la rechacé y no entré (llamada perdida). */
  missed?: boolean;
}
export const CallHistoryQuery = z.object({ before: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
/** Compartir el resumen o la transcripción en otra conversación (como mensaje mío). */
export const CallShareInput = z.object({ conversationId: z.uuid(), what: z.enum(['summary', 'transcript', 'both']).default('both') });
export interface CallTranscriptDTO { call: CallDTO; summary: string | null; segments: CallTranscriptSegmentDTO[] }
/**
 * Lo que el cliente pasa tal cual al SDK de Chime (MeetingSessionConfiguration(meeting, attendee)).
 * `meeting` es la respuesta de CreateMeeting y `attendee` la de CreateAttendee (con JoinToken): no se guardan
 * en el cliente ni se reenvían.
 */
export interface CallJoinDTO {
  call: CallDTO;
  meeting: { Meeting: Record<string, unknown> };
  attendee: { Attendee: { AttendeeId: string; ExternalUserId: string; JoinToken: string } };
}

/**
 * Flujo para todas las plataformas (web, iOS, Android, escritorio):
 * 1. El cliente abre en el navegador del sistema
 *    GET /api/v1/auth/{provider}/start?platform=&code_challenge=&code_challenge_method=S256[&org=<token>][&org_name=][&next=]
 * 2. El servidor habla con Google/Microsoft y redirige a
 *    web: {origen}/auth/sso?code=…   nativas y escritorio: chaggu://auth/callback?code=… si /start recibe
 *    redirect_scheme=chaggu (apps com.chaggu.app); sin ese parámetro, tiecoms://auth/callback (apps anteriores).
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

/** Eliminar la cuenta: se confirma escribiendo el correo; con contraseña, también se pide. */
export const DeleteAccountInput = z.object({ confirmEmail: email, password: z.string().max(200).optional() });
export const UpdateProfileInput = z.object({
  phone: z.string().trim().max(40).regex(/^[+\d\s().-]*$/, 'Teléfono inválido').nullable().optional(),
  company: z.string().trim().max(120).nullable().optional(),
  bio: z.string().trim().max(1000).nullable().optional(),
  name: personName.optional(),
  title: z.string().trim().max(120).nullable().optional(),
  area: z.string().trim().max(120).nullable().optional(),
  /** Resumen semanal de enlaces por correo (opt-in). */
  linkDigest: z.boolean().optional(),
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
  phone?: string | null;
  company?: string | null;
  bio?: string | null;
  id: string;
  name: string;
  email?: string;
  kind: 'human' | 'agent';
  title?: string | null;
  area?: string | null;
  primaryOrgId: string | null;
  /** Ruta de la foto (/api/v1/avatars/…) o null. */
  avatarUrl?: string | null;
  /** Solo en bootstrap.me: recibe el resumen semanal de enlaces por correo. */
  linkDigest?: boolean;
  /**
   * Solo en bootstrap.me: «No molestar» activo hasta esta fecha (ISO), o null si está apagado.
   * Ausente = servidor anterior a «No molestar».
   */
  dndUntil?: string | null;
  /** Sonido predeterminado de los chats y tono de llamada (null = los de fábrica: pop y clasico). */
  messageSound?: SoundChoice | null;
  ringtone?: Ringtone | null;
  /** Solo en bootstrap.me: mi modo sueño (horario de descanso diario). Ausente = servidor anterior. */
  sleep?: SleepDTO;
  /** Solo en bootstrap.me: autorizó usar IA con gg (su chat y @gg). */
  aiConsent?: boolean;
  availability?: AvailabilityDTO;
}

/** Modo sueño: todas las noches, de `start` a `end` (HH:MM en `tz`), no suena nada. */
export const AvailabilityMode = z.enum(['available', 'busy', 'focus', 'dnd', 'rest']);
export type AvailabilityMode = z.infer<typeof AvailabilityMode>;
export interface AvailabilityDTO { mode: AvailabilityMode | null; until: string | null; silent: boolean; revision: number }
export const AvailabilityInput = z.object({ mode: AvailabilityMode.nullable(), until: z.iso.datetime({ offset: true }).nullable().optional() });

export interface SleepDTO { on: boolean; start: string; end: string; tz: string; tzAuto: boolean }

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
  /**
   * Solo para owner/admin: 'auto' = quien entra con Google Workspace o Microsoft Entra del dominio verificado
   * queda en la empresa sin invitación; 'invite' = hace falta invitación.
   */
  joinPolicy?: 'invite' | 'auto';
  /**
   * Reacciones con acción para la gente de esta empresa (👀 = «lo reviso» crea un recordatorio personal,
   * ✅ = «hecho» lo cierra). Solo presente para miembros. Clientes viejos: ausente (= true).
   */
  reactionActions?: boolean;
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
  phone?: string | null;
  company?: string | null;
  bio?: string | null;
  id: string;
  name: string;
  kind: 'human' | 'agent';
  orgId: string | null;
  title: string | null;
  area: string | null;
  guest: boolean;
  guestUntil: string | null;
  availability?: AvailabilityDTO;
  avatarUrl?: string | null;
  /** Horario de descanso de la persona (solo si lo tiene encendido): a quien escribe se le avisa que no le sonará. */
  sleep?: { start: string; end: string; tz: string } | null;
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
  /**
   * Espacio casa de una empresa: sus grupos internos se muestran en «Tu organización» sin cabecera de espacio.
   * Clientes viejos: ausente (se trata como false).
   */
  isOrgHome?: boolean;
  /**
   * Empresa invitada que aún no entra (el nombre que escribió quien creó la relación). Mientras el espacio
   * no tenga otra empresa, se muestra en «Relaciones» con este nombre y como pendiente. Clientes viejos: ausente.
   */
  counterpartName?: string | null;
}

export interface ConversationDTO {
  id: string;
  workspaceId: string | null;
  kind: ConversationKind;
  level: ConversationLevel;
  name: string | null;
  internalOrgId: string | null;
  memberIds: string[];
  /**
   * Admins del grupo (como WhatsApp): pueden sumar, sacar y nombrar o quitar admins. Quien administra el espacio
   * también puede hacerlo aunque no esté aquí (eso se ve en canManage). Ausente = servidor anterior.
   */
  adminIds?: string[];
  /** Quién creó el grupo: no se le puede sacar ni quitar el admin. Ausente = servidor anterior. */
  createdBy?: string;
  lastMessageSeq: number;
  lastEventSeq: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastReadSeq: number;
  readRevision?: number;
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
  /** Sidechat abierto desde un asunto: las tareas creadas aquí son hijas de él. */
  sideIssueId?: string | null;
  deriveReason: string | null;
  returnedAt: string | null;
  openIssues: number;
  /** Preferencias personales. */
  pinnedAt: string | null;
  mutedUntil: string | null;
  /** Foto del grupo o chat (/api/v1/avatars/…) o null. Clientes viejos pueden no traerla. */
  avatarUrl?: string | null;
  /**
   * Vista previa preferida para la lista: el último mensaje de texto (de una persona o un agente) entre los
   * últimos 20 visibles, aunque después haya mensajes de sistema. null si no hay ninguno. Clientes viejos: ausente.
   */
  lastHumanPreview?: MessagePreviewDTO | null;
  /** Menciones a mí (o @todos) sin leer: con seq mayor que lo que ya leí. Clientes viejos: ausente. */
  unreadMentions?: number;
  /** Preferencia personal de vista previa de enlaces en esta conversación (ausente = 'large'). */
  linkPreviews?: LinkPreviewMode;
  /** Sonido de este chat para mí (ausente o null = mi predeterminado). */
  sound?: SoundChoice | null;
  /** Enlaces compartidos en la conversación (visibles para mí). Clientes viejos: ausente. */
  linkCount?: number;
}

/** Una entrada de la bandeja «Menciones» (GET /mentions). */
export interface MentionItemDTO {
  message: MessageDTO;
  conversationId: string;
  /** true si fue @todos y no una mención directa. */
  all: boolean;
  read: boolean;
  createdAt: string;
}

/** Resumen de adjuntos para vistas previas: «📷 Foto», «📷 3 fotos», «🎬 Video», «📎 nombre». */
export interface AttachmentSummaryDTO {
  count: number; images: number; videos: number; files: number; firstName: string | null;
  /** Notas de voz (no cuentan en files) y la duración de la primera. Clientes viejos: ausentes. */
  voices?: number; voiceDurationMs?: number | null;
}
export interface MessagePreviewDTO {
  messageId: string;
  seq: number;
  authorId: string;
  /** Texto (puede ser '' si el mensaje solo trae adjuntos). */
  body: string;
  attachments: AttachmentSummaryDTO | null;
  createdAt: string;
  /** Una sola vista (tanda 1.7): mostrar «① Foto», «① Mensaje» o «① Nota de voz», nunca el contenido. */
  viewOnce?: boolean;
}

/**
 * Adjunto de un mensaje. url y thumbUrl son rutas del API que exigen Bearer (quien puede leer el mensaje).
 * width/height solo en imágenes cuyo formato el servidor sabe leer; thumbUrl solo si alguien subió la miniatura.
 */
export interface AttachmentProvenanceDTO { version: 1; provider: 'openverse' | 'memegen' | 'klipy'; title: string; attribution: string; sourceUrl: string | null; author?: string | null; license?: string | null; licenseUrl?: string | null }
export interface AttachmentDTO {
  provenance?: AttachmentProvenanceDTO | null;
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbUrl: string | null;
  /** 'voice' = nota de voz. Ausente en adjuntos viejos (= 'file'). */
  kind?: 'file' | 'voice';
  durationMs?: number | null;
  /** ≤ 64 valores entre 0 y 1 para dibujar la onda. */
  waveform?: number[] | null;
  transcript?: VoiceTranscriptDTO | null;
  /** Solo en PDFs firmados con Chaggu (POST /attachments/:id/sign): quién firmó, cuándo y la huella del resultado. */
  signing?: AttachmentSigningDTO | null;
  /**
   * Solo en videos (contentType video/*, kind sigue siendo 'file' para no romper apps viejas): ruta del API que,
   * con Bearer, responde { url, expiresIn } con una URL prefirmada de S3 para reproducir en streaming (Range directo
   * a S3). En videos, durationMs, width y height vienen del cliente que lo subió (docs/VIDEO.md).
   */
  playUrl?: string | null;
}

/** GET /attachments/:id/play: URL prefirmada de S3 (inline, o attachment con ?download=1) válida expiresIn segundos. */
export interface VideoPlayDTO { url: string; expiresIn: number; contentType: string }

/** Bytes por categoría. Cada objeto de S3 cuenta una sola vez (los reenvíos comparten el objeto). */
export interface StorageBreakdownDTO { videos: number; photos: number; files: number; voice: number }
/** GET /me/storage y GET /organizations/:id/storage: solo medición, todavía no hay cupo ni cobro. */
export interface StorageUsageDTO {
  scope: 'user' | 'organization';
  id: string;
  totalBytes: number;
  objects: number;
  breakdown: StorageBreakdownDTO;
  /** De dónde viene: adjuntos del chat o archivos del árbol (Drive). */
  bySource: { chat: number; drive: number };
  /** Solo en organization: cuántas personas con esa empresa principal suman algo. */
  people?: number;
  measuredAt: string;
}

/** Referencia corta de una firma (8 caracteres): va impresa en el sello del PDF y sirve para buscarla en el historial. */
export const signingRef = (signingId: string) => signingId.replace(/-/g, '').slice(0, 8).toUpperCase();

export interface AttachmentSigningDTO {
  id: string;
  signerId: string;
  signerName: string;
  signedAt: string;
  /** SHA-256 en hexadecimal del PDF original y del firmado. */
  originalSha256: string;
  signedSha256: string;
}

// ---------- Firmar PDFs ----------
/** Límite de firmas guardadas por persona y tamaño de cada PNG. */
export const MAX_SAVED_SIGNATURES = 12;
export const MAX_SIGNATURE_BYTES = 512 * 1024;
export const MAX_SIGN_PLACEMENTS = 300;

/**
 * Firma guardada: PNG con fondo transparente. url es una ruta del API que solo sirve a su dueño.
 * kind: firma completa o iniciales (rúbrica). source: cómo se hizo (solo informativo).
 */
export interface SignatureDTO {
  id: string;
  kind: 'signature' | 'initials';
  source: 'drawn' | 'typed' | 'uploaded';
  width: number;
  height: number;
  url: string;
  createdAt: string;
}

/**
 * Una marca sobre una página, en proporciones (0–1) de la página tal como se ve (ya girada),
 * con el origen arriba a la izquierda. page empieza en 1. La imagen llena la caja: el cliente
 * conserva la proporción de la firma.
 */
const PlacementBox = {
  page: z.number().int().min(1).max(5000),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  w: z.number().min(0.004).max(1), h: z.number().min(0.004).max(1),
};
export const SignPlacementInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('signature'), signatureId: z.uuid(), ...PlacementBox }),
  /** Texto libre, nombre o fecha ya formateada por el cliente. La letra se ajusta a la caja. */
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(300), ...PlacementBox }),
]).refine((p) => p.x + p.w <= 1.001 && p.y + p.h <= 1.001, { message: 'outside_page' });
export type SignPlacementInput = z.infer<typeof SignPlacementInput>;

export const SignPdfInput = z.object({
  clientMessageId: z.string().min(8).max(64),
  /** Texto del mensaje que acompaña al PDF firmado ('' = el servidor pone «✍️ Documento firmado»). */
  body: z.string().trim().max(2000).default(''),
  placements: z.array(SignPlacementInput).min(1).max(MAX_SIGN_PLACEMENTS),
  /** Sello pequeño bajo cada firma: «Firmado electrónicamente por … · fecha». */
  stamp: z.boolean().default(true),
  /** Agrega al final una hoja de constancia con las huellas y los datos de la firma. */
  certificate: z.boolean().default(false),
  /** El PDF ya trae una firma digital que se invalidaría: hay que confirmarlo (si no, 409 has_digital_signature). */
  acceptBreakingSignatures: z.boolean().default(false),
  /** Zona horaria IANA para las fechas del sello y la constancia. */
  timeZone: z.string().max(64).optional(),
});
export type SignPdfInput = z.input<typeof SignPdfInput>;
export interface SignInfoDTO {
  attachmentId: string; name: string; sizeBytes: number;
  hasDigitalSignature: boolean; encrypted: boolean;
  /** Si este adjunto ya es un PDF firmado con Chaggu. */
  signing: AttachmentSigningDTO | null;
  /** Firmas hechas en Chaggu sobre este documento (como original o como resultado). */
  history: AttachmentSigningDTO[];
}
/**
 * Historial «Documentos que firmé» (GET /me/signings). attachment es el PDF firmado si todavía puedo
 * leerlo (null si salí de la conversación o se borró); la constancia se conserva igual.
 */
export interface SigningHistoryItemDTO extends AttachmentSigningDTO {
  ref: string;
  documentName: string;
  conversationId: string;
  conversationName: string | null;
  messageId: string | null;
  sourceAttachmentId: string;
  resultAttachmentId: string;
  /** Quién mandó el PDF a firmar (autor del mensaje original), si no fui yo. */
  requestedById: string | null;
  requestedByName: string | null;
  /** Total de marcas (firmas, iniciales, textos) y en cuántas páginas del total. */
  marks: number;
  signatureMarks: number;
  pagesMarked: number;
  pages: number;
  stamp: boolean;
  certificate: boolean;
  attachment: AttachmentDTO | null;
}
export interface SigningHistoryPageDTO { signings: SigningHistoryItemDTO[]; nextBefore: string | null; total: number }
export const SigningHistoryQuery = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Busca en el nombre del documento, en quién lo pidió o por referencia (REF). */
  q: z.string().trim().max(120).optional(),
});
export interface SignPdfResult { message: MessageDTO; attachment: AttachmentDTO; signing: AttachmentSigningDTO; duplicate: boolean }

/**
 * Transcripción de una nota de voz. pending: en proceso; disabled: el servidor no tiene transcripción configurada
 * (la nota se escucha igual); failed: se puede reintentar con POST /attachments/:id/transcribe.
 * summary: una línea si la nota dura más de 45 s; suggestedIssue: título sugerido si la nota pide algo.
 */
export interface VoiceTranscriptDTO {
  status: 'pending' | 'done' | 'failed' | 'disabled';
  text?: string | null;
  language?: string | null;
  summary?: string | null;
  suggestedIssue?: string | null;
}
export const MAX_VOICE_MS = 15 * 60_000;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Videos (POST /conversations/:id/videos, subida por stream): la web y las apps los comprimen antes a H.264 720p. */
export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export type ForwardSource = 'whatsapp' | 'slack' | 'email' | 'teams' | 'tiecoms' | 'other';
/** Qué es el enlace (lo decide el servidor por dominio y ruta; 'link' si no se sabe). */
export type LinkKind = 'video' | 'short' | 'post' | 'article' | 'audio' | 'image' | 'doc' | 'code' | 'link';
export type LinkProvider = 'youtube' | 'tiktok' | 'instagram' | 'x' | 'linkedin' | 'facebook' | 'vimeo' | 'spotify' | 'google' | 'github';
export type LinkPreviewMode = 'large' | 'compact' | 'none';
/**
 * imageUrl es una ruta del API (/api/v1/previews/…): la miniatura ya está en chaggu.
 * kind, provider, author y durationSec son aditivos (clientes viejos los ignoran).
 */
export interface LinkPreviewDTO {
  url: string; title: string | null; description: string | null; siteName: string | null; imageUrl: string | null;
  kind?: LinkKind; provider?: LinkProvider | null;
  /** Canal o cuenta que publicó (YouTube, TikTok, Instagram, X). */
  author?: string | null;
  /** Duración del video o audio en segundos, si la página la declara. */
  durationSec?: number | null;
  /** Solo en MessageDTO.linkPreview(s): id del enlace en la biblioteca (PUT /links/:id/state, POST /links/:id/summary). */
  linkId?: string;
}

/** Reacción agregada: quién reaccionó con ese emoji (orden de la primera reacción). */
export interface ReactionDTO {
  emoji: string;
  userIds: string[];
  /** Reacciones que llegaron por un puente (WhatsApp): nombre visible, sin cuenta en chaggu. */
  external?: { name: string; source: ForwardSource }[];
}
/** Máximo de emojis distintos por mensaje. */
export const MAX_REACTIONS_PER_MESSAGE = 20;
/** Barra rápida (mismo orden en web, iOS y Android). 👀 y ✅ tienen acción si la empresa la tiene activa. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '👀', '✅', '🙏'] as const;
export const REACTION_ACTIONS = { look: '👀', done: '✅' } as const;

/**
 * Forma canónica de un emoji para reaccionar: sin selectores de variación sobrantes y con U+FE0F
 * donde hace falta para verse como emoji (❤ → ❤️, 👍️ → 👍). null si no es exactamente un emoji.
 * Web, iOS y Android deben mandar esta forma; el servidor la vuelve a aplicar de todos modos.
 */
export function normalizeEmoji(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 32) return null;
  const parts = raw.replace(/\uFE0F/g, '').split('\u200D').map((part) => {
    if (/^[0-9#*]\u20E3$/u.test(part)) return `${part[0]}\uFE0F\u20E3`;
    const first = String.fromCodePoint(part.codePointAt(0)!);
    const rest = part.slice(first.length);
    const needs = /\p{Extended_Pictographic}/u.test(first) && !/\p{Emoji_Presentation}/u.test(first) && !/^[\u{1F3FB}-\u{1F3FF}]/u.test(rest);
    return needs ? `${first}\uFE0F${rest}` : part;
  });
  const out = parts.join('\u200D');
  const Seg = (Intl as any).Segmenter;
  if (Seg && [...new Seg(undefined, { granularity: 'grapheme' }).segment(out)].length !== 1) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(out)) return null;
  return out;
}

/** Un enlace de la biblioteca del chat (GET /conversations/:id/links, GET /links/saved). */
export interface LinkItemDTO {
  id: string;
  conversationId: string;
  messageId: string;
  messageSeq: number;
  authorId: string | null;
  url: string;
  host: string;
  kind: LinkKind;
  provider: LinkProvider | null;
  preview: LinkPreviewDTO | null;
  createdAt: string;
  /** Estado personal (solo mío). */
  savedAt: string | null;
  seenAt: string | null;
}
export interface LinksPageDTO { links: LinkItemDTO[]; hasMore: boolean }
export const LinkKindFilter = z.enum(['all', 'video', 'social', 'article', 'doc', 'other']);
export const LinksQuery = z.object({
  kind: LinkKindFilter.default('all'),
  q: z.string().trim().max(120).optional(),
  /** createdAt del último que ya tienes. */
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export const SavedLinksQuery = z.object({
  state: z.enum(['pending', 'seen', 'all']).default('pending'),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const LinkStateInput = z.object({ saved: z.boolean().optional(), seen: z.boolean().optional() })
  .refine((v) => v.saved !== undefined || v.seen !== undefined, { message: 'saved_or_seen' });
/** PUT /messages/:id/reactions/:emoji (cuerpo opcional). remindAt: hora del recordatorio de 👀 (el cliente sabe la zona horaria). */
export const ReactInput = z.object({ remindAt: z.iso.datetime().optional() });
export const ReactionActionsInput = z.object({ reactionActions: z.boolean() });
/** Resumen con IA bajo pedido. basis = de qué salió: el texto del artículo o solo la descripción (videos, redes). */
export interface LinkSummaryDTO { summary: string; basis: 'article' | 'description'; lang: 'es' | 'en' }
/**
 * messageId: mensaje original (p. ej. «Responder en privado»); el enlace solo abre si el lector puede leer el origen.
 * messageSeq y excerpt (≤ 200) los pone el servidor a partir del original cuando llega messageId.
 */
export interface ForwardedInfo {
  source: ForwardSource; author?: string | null; sentAt?: string | null; fromConversationId?: string | null;
  messageId?: string | null; messageSeq?: number | null; excerpt?: string | null;
}

/** Mensaje programado: solo lo ve quien lo escribió, hasta que sale. */
export interface ScheduledMessageDTO {
  id: string;
  conversationId: string;
  body: string;
  mentions: { userId: string; start: number; length: number }[];
  replyTo: string | null;
  sendAt: string;
  status: 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
  messageId: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

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
  /** null en reuniones de directos y chats grupales (multi, laterales). */
  workspaceId: string | null;
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
  /** Comentarios del evento (tanda 1.7). Ausente = servidor anterior. */
  commentCount?: number;
  /** Los 2 últimos comentarios, del más viejo al más nuevo. */
  lastComments?: EventCommentDTO[];
}

/** Comentario de un evento del calendario (GET/POST /events/:id/comments). */
export interface EventCommentDTO {
  id: string;
  eventId: string;
  authorId: string;
  body: string;
  createdAt: string;
}
export const EventCommentInput = z.object({ body: z.string().trim().min(1).max(4000) });

// ---------- Correo en el chat (docs/CORREO.md) ----------
/** Proveedor de correo: Gmail (google) u Outlook (microsoft). */
export const MailProvider = z.enum(['google', 'microsoft']);
export type MailProvider = z.infer<typeof MailProvider>;
export interface MailConnectionDTO {
  provider: MailProvider; label: 'Gmail' | 'Outlook'; available: boolean; unavailableReason: string | null;
  status: 'none' | 'active' | 'reconnect'; accountEmail: string | null;
}
export interface MailAddressDTO { name: string | null; email: string }
export interface MailAttachmentInfoDTO { id: string; name: string; size: number; contentType: string }
/** Fila de la lista (en vivo, no se guarda). */
export interface MailListItemDTO {
  provider: MailProvider; id: string; threadId: string | null; from: MailAddressDTO | null; to: MailAddressDTO[];
  subject: string; snippet: string; date: string | null; unread: boolean; hasAttachments: boolean; box: 'inbox' | 'sent';
}
export interface MailListDTO { items: MailListItemDTO[]; nextPage: string | null; accountEmail: string | null }
/**
 * Conversación de correo fijada (2-oct-2026). Dos pines independientes, como WhatsApp:
 * mainPinnedAt = arriba en la pantalla principal; mailPinnedAt = arriba en la pantalla Correo.
 */
export interface MailPinDTO {
  provider: MailProvider; threadKey: string; messageId: string; subject: string; from: MailAddressDTO | null; date: string | null;
  mainPinnedAt: string | null; mailPinnedAt: string | null;
}
/** PUT /mail/pins. threadKey = threadId del proveedor (o el id del correo si no tiene hilo). main/mail: true fija, false quita, ausente no cambia. */
export const MailPinInput = z.object({
  provider: z.enum(['google', 'microsoft']), threadKey: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
  subject: z.string().max(300).default(''), from: z.object({ name: z.string().max(200).nullable().optional(), email: z.string().max(254) }).nullable().optional(),
  date: z.iso.datetime({ offset: true }).nullable().optional(), main: z.boolean().optional(), mail: z.boolean().optional(),
});
/** Correo completo leído en vivo (vista previa antes de compartir). */
export interface MailMessageDTO extends MailListItemDTO { cc: MailAddressDTO[]; body: string; attachments: MailAttachmentInfoDTO[] }
export const MailListQuery = z.object({
  provider: MailProvider,
  box: z.enum(['inbox', 'sent', 'all']).default('inbox'),
  /** Pestaña de Recibidos: Gmail primary/promotions/updates/social/forums; Outlook focused/other. any = todas. */
  category: z.enum(['primary', 'promotions', 'updates', 'social', 'forums', 'focused', 'other', 'any']).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.string().trim().max(200).optional(),
  to: z.string().trim().max(200).optional(),
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  attachments: z.enum(['1', 'true']).optional(),
  unread: z.enum(['1', 'true']).optional(),
  label: z.string().trim().max(100).optional(),
  page: z.string().max(2000).optional(),
});
export const ShareMailInput = z.object({
  provider: MailProvider,
  messageId: z.string().min(1).max(500),
  /** Un chat (clientes anteriores) o varios a la vez (conversationIds, hasta 10). */
  conversationId: z.uuid().optional(),
  conversationIds: z.array(z.uuid()).min(1).max(10).optional(),
  comment: z.string().trim().max(4000).optional(),
  topicId: z.uuid().nullable().optional(),
}).refine((x) => x.conversationId || x.conversationIds?.length, { message: 'Elige al menos un chat' });
export type SharedMailStatus = 'pending' | 'scheduled' | 'replied';
export interface SharedMailCommentDTO { id: string; emailId: string; authorId: string; body: string; createdAt: string }
export interface SharedMailDTO {
  /** provider 'whatsapp': un mensaje de WhatsApp llevado al chat (sin responder desde chaggu; datos en wa). */
  id: string; conversationId: string; sharedBy: string; provider: MailProvider | 'whatsapp'; accountEmail: string | null;
  wa?: { chatName: string | null; isGroup: boolean; accountKind: 'personal' | 'business'; accountId: string; jid: string } | null;
  direction: 'in' | 'out'; from: MailAddressDTO | null; to: MailAddressDTO[]; cc: MailAddressDTO[];
  /** body solo llega con full=true (GET /mail/shared/:id?full=1); en tarjetas y en vivo va ''. */
  subject: string; snippet: string; body: string; full?: boolean;
  /** Se guardó solo lo nuevo: el historial citado y la firma se ven con GET /mail/shared/:id/original (en vivo). */
  trimmed?: boolean;
  sentAt: string | null; attachments: MailAttachmentInfoDTO[];
  chagguAttachments?: AttachmentDTO[];
  mediaStatus?: WaMediaDTO['status'];
  messageId: string | null; comment: string | null; status: SharedMailStatus; repliedAt: string | null; repliedBy: string | null;
  /** Respuesta programada pendiente (solo la ve quien la programó). */
  scheduledReply: { id: string; sendAt: string } | null;
  issueId: string | null; commentCount: number; lastComments: SharedMailCommentDTO[]; createdAt: string;
  /** Abrir en Gmail/Outlook (solo para quien lo compartió; null para los demás y en vivo). */
  webLink?: string | null;
}
/** Responder un correo de tu buzón en vivo (sin traerlo antes a un chat). */
export const MailLiveReplyInput = z.object({ body: z.string().trim().min(1).max(20000), cc: z.array(z.email()).max(20).optional() });
export const MailReplyInput = z.object({
  body: z.string().trim().min(1).max(20000),
  cc: z.array(z.email()).max(20).optional(),
  /** Adjuntos que ya están en el chat (se envían con la respuesta). */
  attachmentIds: z.array(z.uuid()).max(10).optional(),
  /** Programar: si no llega, sale ya. */
  sendAt: z.iso.datetime({ offset: true }).optional(),
  notifyChat: z.boolean().default(true),
});
export const MailTaskInput = z.object({
  title: z.string().trim().min(2).max(200),
  ownerId: z.uuid().nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  closeOnReply: z.boolean().default(true),
});
/** «Comentar en chaggu» desde un mensaje de WhatsApp. */
/** Reenviar una tarjeta de correo o WhatsApp a otros chats: cada chat recibe su copia con hilo propio. */
export const ForwardSharedInput = z.object({ conversationIds: z.array(z.uuid()).min(1).max(10), comment: z.string().trim().max(4000).optional() });
export const ShareWaInput = z.object({
  clientMessageId: z.string().min(1).max(64).optional(),
  accountId: z.uuid(), jid: z.string().min(3).max(200), messageId: z.string().min(1).max(200),
  conversationId: z.uuid().optional(), conversationIds: z.array(z.uuid()).min(1).max(10).optional(),
  comment: z.string().trim().max(4000).optional(),
}).refine((x) => x.conversationId || x.conversationIds?.length, { message: 'Elige al menos un chat' });

/** side = conversación lateral: consulta privada desde un mensaje (chat multi que cuelga de su origen). */
export type DeriveKind = 'same' | 'internal' | 'directive' | 'side';
export type IssueStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'cancelled';

export interface IssueDTO {
  id: string;
  /** null en asuntos de directos y chats grupales (multi, laterales) y en los personales. */
  workspaceId: string | null;
  /** null = asunto personal (solo lo ve su dueño; solo lo reciben clientes con contrato ≥ 2026-09-28). */
  conversationId: string | null;
  originMessageId: string | null;
  originMessageSeq: number | null;
  title: string;
  status: IssueStatus;
  waitingOnOrgId: string | null;
  ownerId: string | null;
  /** Todos los responsables; ownerId conserva el primero para clientes anteriores. */
  assigneeIds?: string[];
  /** Imágenes y documentos de la tarea, con el mismo acceso que la tarea. */
  attachments?: AttachmentDTO[];
  requestedBy: string | null;
  dueDate: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Desde cuándo está en el estado actual (para detectar cuellos de botella). */
  statusSince: string;
  closedAt: string | null;
  commentCount: number;
  /** Tarea derivada de este asunto (null = asunto principal). Ausente = servidor anterior. */
  parentIssueId?: string | null;
  /** Quién la ve: 'all' (todo el chat), 'org' (solo visibleOrgId + viewerIds), 'private' (solo viewerIds). */
  visibility?: IssueVisibility;
  visibleOrgId?: string | null;
  /** Personas con acceso explícito (solo en 'org' y 'private'). */
  viewerIds?: string[];
  /** Tema del chat (docs/TEMAS.md). null = sin tema; ausente = servidor anterior. */
  topicId?: string | null;
  /** Asunto que viene de una integración (p. ej. un ticket de la mesa de ayuda). Ausente = servidor anterior. */
  integrationId?: string | null;
  externalId?: string | null;
  /** Datos del sistema externo para mostrar (cliente, correo, prioridad, categoría…): pares texto→texto. */
  externalMeta?: Record<string, string> | null;
}
export type IssueVisibility = 'all' | 'org' | 'private';

export interface IssueEventDTO {
  id: number;
  issueId: string;
  actorId: string;
  kind: 'created' | 'status' | 'owner' | 'due' | 'title' | 'comment' | 'waiting' | 'visibility' | 'assignees' | 'attachments' | 'moved';
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
  /** Server-authored comment without verified automatic credits; absent on legacy. Never disclosed before one-view opening. */
  displayBody?: string | null;
  replyTo: string | null;
  /** Si este mensaje trae de vuelta el resultado de una conversación derivada. */
  mergedFrom: string | null;
  /** Tipo de la conversación que devolvió el resultado ('side' = «Desde un sidechat»). Ausente en mensajes viejos. */
  mergedKind?: DeriveKind | null;
  /** Mensaje traído desde WhatsApp, Slack, correo u otra conversación. */
  forwarded: ForwardedInfo | null;
  /** Vista previa del primer enlace; llega después con message.updated. Clientes viejos pueden no traerla. */
  linkPreview?: LinkPreviewDTO | null;
  /** Vistas previas de hasta 3 enlaces (la primera = linkPreview). Ausente en mensajes viejos. */
  linkPreviews?: LinkPreviewDTO[];
  /** Reacciones (llegan con message.updated; no cuentan como no leído ni editan el mensaje). */
  reactions?: ReactionDTO[];
  /** Adjuntos en el orden de envío ([] o ausente si no hay; [] si el mensaje se eliminó). */
  attachments?: AttachmentDTO[];
  /** Menciones válidas (ya filtradas por el servidor); [] o ausente si no hay. */
  mentions?: MentionDTO[];
  /** Tema del mensaje (docs/TEMAS.md). null = sin tema; ausente = servidor anterior. */
  topicId?: string | null;
  /** Quién le puso el tema (cualquiera del chat puede). */
  topicBy?: string | null;
  /** Etiquetas #Nombre a otras conversaciones (tanda 1.7). name = el nombre al enviar. Ausente = sin refs. */
  refs?: MessageRefDTO[];
  /**
   * Mensaje de una sola vista (tanda 1.7). body llega '' y los adjuntos con url '' y thumbUrl null (conservan
   * kind, contentType, name y durationMs): el contenido solo sale por POST /messages/:id/open.
   */
  viewOnce?: boolean;
  /**
   * Para quien no es autor: 'unopened' | 'opened'. Para el autor: 'sent'. En los eventos en vivo (iguales para
   * todos) llega 'unopened': el cliente calcula 'sent' si authorId soy yo, y 'opened' si estoy en openedBy.
   */
  viewOnceState?: ViewOnceState;
  /** Quién lo abrió y cuándo (el autor lo muestra como «Visto por …»). */
  openedBy?: { userId: string; at: string }[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

/** Tema fijo de una conversación: banderita con color e ícono. TOPIC_LIMIT es solo un tope técnico. */
export interface TopicDTO {
  id: string;
  conversationId: string;
  name: string;
  color: TopicColor;
  icon: string;
  position: number;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
}
export const TOPIC_LIMIT = 50;
export const TOPIC_COLORS = ['blue', 'green', 'orange', 'violet', 'magenta', 'aqua', 'red', 'yellow'] as const;
export type TopicColor = (typeof TOPIC_COLORS)[number];
export const CreateTopicInput = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.enum(TOPIC_COLORS).optional(),
  icon: z.string().trim().min(1).max(8).optional(),
});
export const UpdateTopicInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.enum(TOPIC_COLORS).optional(),
  icon: z.string().trim().min(1).max(8).optional(),
  archived: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export const SetMessageTopicInput = z.object({ topicId: z.uuid().nullable() });
/** PUT /conversations/:id/topics/order: el orden nuevo de las banderitas (arrastrar). */
export const ReorderTopicsInput = z.object({ ids: z.array(z.uuid()).min(1).max(100) });

export interface BootstrapDTO {
  contract: string;
  serverTime: string;
  me: UserDTO;
  organizations: OrganizationDTO[];
  workspaces: WorkspaceDTO[];
  conversations: ConversationDTO[];
  people: PersonDTO[];
  /** Funciones que el servidor tiene prendidas (aditivo: clientes viejos lo ignoran). */
  features?: { calls: boolean; mail?: boolean };
  /** Id de gg (participante bot): su chat es el directo con este id; «Tú» es el directo con uno mismo. */
  assistantId?: string;
  /** 1.7.1: la llamada en la que estoy desde algún dispositivo (con myDevices), o null. Ausente = servidor anterior. */
  myActiveCall?: CallDTO | null;
  /** Llamadas perdidas desde la última vez que abrí Llamadas (número rojo). POST /calls/seen lo pone en 0. */
  missedCalls?: number;
  /** Chats de WhatsApp movidos a la bandeja (inboxPlace no null), de cuentas no removidas y sin ocultar. */
  waInbox?: WaChatDTO[];
  /** Conversaciones de correo fijadas (en la principal, en Correo o en las dos). Ausente = servidor anterior. */
  mailPins?: MailPinDTO[];
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

/**
 * Nuevo grupo (el «+» de Grupos). Tres destinos:
 *  - org: grupo interno de mi empresa (va al espacio casa de la empresa; se crea si falta).
 *  - workspace: grupo dentro de una relación existente (espacio con otra empresa).
 *  - company: relación nueva: crea el espacio con esa empresa, el grupo y las invitaciones.
 * Un tercero invitado (guest) no puede crear grupos.
 */
export const CreateGroupInput = z.object({
  name: z.string().trim().min(2).max(120),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('org'), orgId: z.uuid().optional() }),
    z.object({ kind: z.literal('workspace'), workspaceId: z.uuid() }),
    z.object({ kind: z.literal('company'), companyName: z.string().trim().min(2).max(120), orgId: z.uuid().optional() }),
  ]),
  memberIds: z.array(z.uuid()).max(500).default([]),
  /** Correos a invitar al grupo (personas de la otra empresa o terceros). */
  inviteEmails: z.array(email).max(50).default([]),
  /** guest = tercero a título propio (asesor, mentor): no suma su empresa al espacio. */
  inviteRole: z.enum(['member', 'guest']).default('member'),
  /** Grupo solo de mi empresa dentro de la relación (su propio canal); no aplica a target org, que ya es interno. */
  internal: z.boolean().default(false),
  /** Además, un enlace directo con código corto para compartir por WhatsApp o donde sea (varias personas, 14 días). */
  shareLink: z.boolean().default(false),
  lang: z.enum(['es', 'en']).default('es'),
});
/** Lo que envía un cliente (los campos con valor por defecto son opcionales). */
export type CreateGroupRequest = z.input<typeof CreateGroupInput>;
export interface CreateGroupResultDTO {
  workspaceId: string; conversationId: string; invited: number;
  /** Con shareLink: el enlace y el código para compartir. */
  inviteUrl?: string; inviteCode?: string | null;
}

/** Supervisión: los grupos donde participa gente de mi empresa (solo owner/admin de la empresa). */
export interface OversightGroupDTO {
  conversationId: string;
  name: string | null;
  kind: 'group' | 'internal';
  workspaceId: string;
  workspaceName: string;
  owningOrgId: string;
  organizationIds: string[];
  memberCount: number;
  /** Personas de mi empresa en el grupo. */
  myOrgMemberIds: string[];
  lastMessageAt: string | null;
  /** Si ya soy miembro; si no, lo abro en solo lectura. */
  iAmMember: boolean;
}
export interface OversightDTO { orgId: string; groups: OversightGroupDTO[] }

export const SetAdminInput = z.object({ admin: z.boolean() });

// ---------- Integraciones por grupo ----------
// Las crea quien administra el espacio (lead/admin) o la empresa dueña (owner/admin). Publican como un bot del grupo.

export interface IntegrationDTO {
  id: string;
  workspaceId: string;
  conversationId: string;
  botUserId: string;
  name: string;
  /** Últimos 4 caracteres del token, para reconocerlo. */
  tokenHint: string;
  /** URL del webhook entrante (formato Slack). El token va en `Authorization: Bearer`. */
  webhookUrl: string;
  outgoingUrl: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Entregas de salida que siguen fallando (para avisar al admin). */
  failingDeliveries: number;
}
/** Respuesta al crear o rotar: el token (y el secreto de salida) se muestran una sola vez. */
export interface IntegrationSecretDTO {
  integration: IntegrationDTO;
  token: string;
  /** URL con el token incluido, para sistemas que solo aceptan una URL (como un Incoming Webhook de Slack). */
  webhookUrlWithToken: string;
  outgoingSecret: string | null;
}

const OutgoingUrl = z.url().max(500).refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), 'Debe ser https');

export const CreateIntegrationInput = z.object({
  name: z.string().trim().min(2).max(80),
  outgoingUrl: OutgoingUrl.nullable().optional(),
});
export const UpdateIntegrationInput = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  outgoingUrl: OutgoingUrl.nullable().optional(),
  /** true = generar un secreto de salida nuevo (se muestra una vez). */
  rotateOutgoingSecret: z.boolean().optional(),
});

/** Webhook entrante con el formato de Slack (Incoming Webhooks): basta cambiar la URL. */
export const IncomingWebhookInput = z.object({
  text: z.string().max(12_000).optional(),
  blocks: z.array(z.any()).max(50).optional(),
  attachments: z.array(z.any()).max(20).optional(),
  username: z.string().max(80).optional(),
  mrkdwn: z.boolean().optional(),
}).passthrough();

const ExternalMeta = z.record(z.string().max(60), z.string().max(500)).refine((m) => Object.keys(m).length <= 20, 'Máximo 20 campos');

/** API de asuntos para integraciones (token del grupo). */
export const IntegrationCreateIssueInput = z.object({
  title: z.string().trim().min(2).max(200),
  /** Primer comentario (la descripción del ticket). */
  description: z.string().max(20_000).optional(),
  externalId: z.string().trim().min(1).max(120),
  externalMeta: ExternalMeta.optional(),
  status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
  /** Avisar en el chat con un mensaje del bot (por defecto sí). */
  announce: z.boolean().default(true),
  /** Comentarios anteriores (migración): se guardan en orden con su autor y fecha como texto. */
  history: z.array(z.object({ author: z.string().max(120), body: z.string().max(20_000), at: z.string().max(40).optional() })).max(200).optional(),
});
export const IntegrationUpdateIssueInput = z.object({
  status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  externalMeta: ExternalMeta.optional(),
});
export const IntegrationCommentInput = z.object({
  body: z.string().trim().min(1).max(20_000),
  /** Quién lo escribió en el sistema externo (p. ej. «Ana Pérez (cliente)»). */
  author: z.string().trim().max(120).optional(),
});

/** Lo que recibe el webhook de salida (firmado: X-Chaggu-Signature: t=<unix>,v1=<hex hmac-sha256 de "t.body">). */
export interface IntegrationEventDTO {
  id: string;
  type: 'issue.status_changed' | 'issue.commented' | 'issue.updated';
  createdAt: string;
  integrationId: string;
  issue: { id: string; externalId: string | null; title: string; status: IssueStatus; url: string };
  actor: { id: string; name: string };
  /** issue.status_changed */
  from?: IssueStatus;
  to?: IssueStatus;
  /** issue.commented */
  comment?: { body: string };
}

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
  /** Sin correo: el enlace (y su código corto) sirve a varias personas hasta vencer. */
  multiUse: z.boolean().optional(),
});
/** Respuesta de crear una invitación: `url` para compartir y, si no lleva correo, `code` (K7QM-4XPA) para escribir en la app. */
export interface InvitationCreatedDTO { id: string; token: string; url: string; code: string | null; expiresAt: string; emailSent: boolean; emailStatus: string | null }

export const JoinPolicyInput = z.object({ joinPolicy: z.enum(['invite', 'auto']) });

/**
 * Invitar a un colega a mi empresa. Con `conversationIds` (grupos donde participo, de un mismo espacio de mi
 * empresa: el de «Tu organización» o una relación) la persona, al aceptar, entra a la empresa y además a esos
 * grupos con el historial `history`. Así cualquier miembro (no solo owner/admin) puede invitar colegas desde un
 * grupo. `workspaceId` es opcional (se deduce de los grupos; si viene, debe coincidir). `multiUse` = enlace y
 * código para varias personas, sin correo. Clientes viejos: sin estos campos, igual que antes.
 */
export const CreateOrgInvitationInput = z.object({
  email: email.optional(),
  role: z.enum(['member', 'admin']).default('member'),
  expiresInDays: z.number().int().min(1).max(60).default(14),
  lang: z.enum(['es', 'en']).default('es'),
  workspaceId: z.uuid().optional(),
  conversationIds: z.array(z.uuid()).max(50).default([]),
  history: z.enum(['now', 'all']).default('now'),
  multiUse: z.boolean().optional(),
});
/** Respuesta de crear una invitación a la empresa. `url` y `code` son nuevos (28-sep-2026); `code` solo sin correo. */
export interface OrgInvitationCreatedDTO { id: string; token: string; url?: string; code?: string | null; expiresAt: string; emailSent: boolean; emailStatus: string | null }

export interface OrgInvitationPreviewDTO {
  orgName: string;
  invitedByName: string;
  email: string | null;
  expiresAt: string;
  valid: boolean;
  /** Grupos a los que entra además de la empresa. Clientes viejos: ausente. */
  groupNames?: string[];
  multiUse?: boolean;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const CreateIssueInput = z.object({
  title: z.string().trim().min(2).max(200),
  ownerId: z.uuid().nullable().optional(),
  assigneeIds: z.array(z.uuid()).max(20).optional(),
  attachmentIds: z.array(z.uuid()).max(20).optional(),
  dueDate: isoDate.nullable().optional(),
  originMessageId: z.uuid().nullable().optional(),
  visibility: z.enum(['all', 'org', 'private']).optional(),
  /** Personas extra con acceso (solo 'org' y 'private'). Pueden no estar en la conversación. */
  viewerIds: z.array(z.uuid()).max(50).optional(),
  /** Tarea hija de este asunto: en su misma conversación o en un sidechat que salió de ella. */
  parentIssueId: z.uuid().nullable().optional(),
  /** Tema activo del chat. Si no llega y la tarea sale de un mensaje con tema, hereda ese tema. */
  topicId: z.uuid().nullable().optional(),
});
/** POST /issues/:id/children: tarea derivada. Por defecto la ve solo mi empresa si en el chat hay más de una. */
/** POST /issues: asunto personal (sin conversación, solo para mí). */
export const CreatePersonalIssueInput = z.object({ title: z.string().trim().min(2).max(200), dueDate: isoDate.nullable().optional() });
export const CreateChildIssueInput = z.object({
  title: z.string().trim().min(2).max(200),
  /** Sidechat que salió del chat del asunto (si no, la tarea queda en el mismo chat). */
  conversationId: z.uuid().optional(),
  ownerId: z.uuid().nullable().optional(),
  assigneeIds: z.array(z.uuid()).max(20).optional(),
  attachmentIds: z.array(z.uuid()).max(20).optional(),
  dueDate: isoDate.nullable().optional(),
  visibility: z.enum(['all', 'org', 'private']).optional(),
  viewerIds: z.array(z.uuid()).max(50).optional(),
});
export const UpdateIssueInput = z.object({
  /** Mover la tarea a otro chat donde puedo escribir. */
  conversationId: z.uuid().optional(),
  visibility: z.enum(['all', 'org', 'private']).optional(),
  viewerIds: z.array(z.uuid()).max(50).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
  ownerId: z.uuid().nullable().optional(),
  assigneeIds: z.array(z.uuid()).max(20).optional(),
  attachmentIds: z.array(z.uuid()).max(20).optional(),
  dueDate: isoDate.nullable().optional(),
  waitingOnOrgId: z.uuid().nullable().optional(),
  topicId: z.uuid().nullable().optional(),
});
export const IssueCommentInput = z.object({ body: z.string().trim().min(1).max(4000) });

export const DeriveInput = z.object({
  messageId: z.uuid(),
  kind: z.enum(['same', 'internal', 'directive']),
  name: z.string().trim().min(2).max(120).optional(),
  reason: z.string().trim().max(300).optional(),
});
/**
 * Conversación lateral desde un mensaje: pregunta en privado a colegas de tu empresa o a
 * participantes del origen. No publica nada en el origen. Más adelante userIds podrá incluir agentes.
 */
export const SideConversationInput = z.object({
  /** Desde un mensaje visible, o desde un asunto (issueId): sus tareas nacen ahí como hijas del asunto. */
  messageId: z.uuid().optional(),
  issueId: z.uuid().optional(),
  userIds: z.array(z.uuid()).min(1).max(20),
  question: z.string().trim().min(1).max(4000).optional(),
}).refine((v) => !!v.messageId !== !!v.issueId, { message: 'message_or_issue', path: ['messageId'] });
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
  /** Grupos a los que entra al aceptar (para filtrar las pendientes de un grupo). Servidores viejos: ausente. */
  conversationIds?: string[];
}

export interface InvitationPreviewDTO {
  workspaceName: string;
  invitedByName: string;
  invitedByOrg: string;
  role: WorkspaceRole;
  email: string | null;
  expiresAt: string;
  valid: boolean;
  /** Grupos a los que entra la persona. Clientes viejos: ausente. */
  groupNames?: string[];
  /** Enlace o código para varias personas. */
  multiUse?: boolean;
  /** Invitación a un grupo interno de una empresa (se entra como invitado de fuera). */
  orgHome?: boolean;
  /**
   * 'org' = invitación a unirse a una empresa como colega (y a sus grupos), resuelta por el mismo
   * `/invitations/:token` (token o código). Ausente o 'workspace' = invitación a un espacio.
   * Si es 'org' y no hay sesión, el registro va por `/signup?org={token}`.
   */
  kind?: 'workspace' | 'org';
  /** Con kind 'org': la empresa a la que entra. */
  orgName?: string;
}

// ---------- Mensajes ----------
export const ForwardedInput = z.object({
  source: z.enum(['whatsapp', 'slack', 'email', 'teams', 'tiecoms', 'other']),
  author: z.string().trim().max(120).nullable().optional(),
  sentAt: z.string().max(40).nullable().optional(),
  fromConversationId: z.uuid().nullable().optional(),
  /** Mensaje original dentro de fromConversationId (exige fromConversationId). */
  messageId: z.uuid().nullable().optional(),
});
/**
 * Mención con @: tramo del body (offsets en unidades UTF-16, como String.length de JS/Kotlin y NSString.length)
 * que empieza con «@». userId 'all' = @todos / @all.
 */
export const MentionInput = z.object({
  userId: z.union([z.uuid(), z.literal('all')]),
  start: z.number().int().min(0).max(8000),
  length: z.number().int().min(2).max(200),
});
export interface MentionDTO { userId: string | 'all'; start: number; length: number }

/**
 * Etiqueta #Nombre a una conversación (tanda 1.7): tramo del body (offsets UTF-16, como las menciones) que
 * empieza con «#». El servidor descarta sin error las que el autor no puede leer. Máximo 20.
 */
export const RefInput = z.object({
  conversationId: z.uuid(),
  start: z.number().int().min(0).max(8000),
  length: z.number().int().min(2).max(200),
});
export interface MessageRefDTO { conversationId: string; name: string; start: number; length: number }
export const MAX_REFS_PER_MESSAGE = 20;

export type ViewOnceState = 'unopened' | 'opened' | 'sent';
/** POST /messages/:id/open (una vez por persona; 410 already_opened la segunda). URLs firmadas de 60 s. */
export interface ViewOnceOpenDTO { body: string; displayBody?: string | null; attachments: AttachmentDTO[] }

export const SendMessageInput = z.object({
  clientMessageId: z.string().min(8).max(64),
  /** Puede ir vacío ('') si el mensaje lleva adjuntos. */
  body: z.string().trim().max(8000),
  replyTo: z.uuid().nullable().optional(),
  forwarded: ForwardedInput.nullable().optional(),
  /** Adjuntos subidos por mí a esta conversación y aún sin usar (POST /conversations/:id/attachments). */
  attachmentIds: z.array(z.uuid()).max(10).optional(),
  /** Reenvío: adjuntos de mensajes que puedo leer; el servidor crea copias que apuntan al mismo archivo. */
  forwardAttachmentIds: z.array(z.uuid()).max(10).optional(),
  /** Menciones sobre el body. Las inválidas se descartan (droppedMentions en la respuesta), no dan error. */
  mentions: z.array(MentionInput).max(50).optional(),
  /** Tema activo de esta conversación (docs/TEMAS.md). */
  topicId: z.uuid().nullable().optional(),
  /** #grupos etiquetados (tanda 1.7). */
  refs: z.array(RefInput).max(MAX_REFS_PER_MESSAGE).optional(),
  /** Una sola vista: texto, imágenes y notas de voz; no con archivos ni reenvíos (400). */
  viewOnce: z.boolean().optional(),
}).refine((v) => v.body.length > 0 || !!v.attachmentIds?.length || !!v.forwardAttachmentIds?.length, { message: 'body_or_attachments', path: ['body'] })
  .refine((v) => (v.attachmentIds?.length ?? 0) + (v.forwardAttachmentIds?.length ?? 0) <= 10, { message: 'max_10_attachments', path: ['attachmentIds'] });
export const EditMessageInput = z.object({ body: z.string().trim().min(1).max(8000), mentions: z.array(MentionInput).max(50).optional(), refs: z.array(RefInput).max(MAX_REFS_PER_MESSAGE).optional() });

// ---------- Buscar dentro del chat (tanda 1.7) ----------
/** GET /conversations/:id/search?q=&before=&limit= — before = seq del último resultado que ya tienes. */
export const ChatSearchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export interface ChatSearchResultDTO {
  message: MessageDTO;
  /** Fragmento de texto alrededor de la coincidencia (cuerpo, nombre del adjunto o transcripción). */
  snippet: string;
  /** Coincidencias dentro de snippet: [inicio, largo] en unidades UTF-16. */
  matches: [number, number][];
  /** Dónde coincidió. */
  field?: 'body' | 'attachment' | 'transcript' | 'mail';
}
/** GET /search/messages: buscar en todos mis chats (más recientes primero). before = createdAt ISO del último recibido. */
export const GlobalSearchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export interface GlobalSearchPageDTO { results: ChatSearchResultDTO[]; hasMore: boolean }
export interface ChatSearchPageDTO { results: ChatSearchResultDTO[]; hasMore: boolean }

// ---------- Mensajes de sistema nuevos (tanda 1.7): body = JSON.stringify({ k, ... }) ----------
export const SYSTEM_KEYS_17 = ['event.today', 'issue.done', 'issue.overdue', 'issue.comments', 'event.comments'] as const;
export type SystemBody17 =
  | { k: 'event.today'; eventId: string; title: string; startsAt: string; timezone: string }
  | { k: 'issue.done'; issueId: string; title: string; byId: string; byName: string }
  /** dueDate = AAAA-MM-DD. */
  | { k: 'issue.overdue'; issueId: string; title: string; ownerId: string | null; ownerName: string | null; dueDate: string }
  /** Se actualiza con message.updated (count + 1) mientras esté entre los últimos 15 mensajes del chat. */
  | { k: 'issue.comments'; issueId: string; title: string; count: number; lastById: string; lastByName: string; lastExcerpt: string }
  | { k: 'event.comments'; eventId: string; title: string; count: number; lastById: string; lastByName: string; lastExcerpt: string };
// ---------- Sonidos (docs/SONIDOS.md) ----------
/** Sonidos de mensaje: se generan en cada cliente (web con WebAudio; móvil con archivos del mismo nombre). */
export const MESSAGE_SOUNDS = ['pop', 'gota', 'campana', 'marimba', 'burbuja', 'cristal', 'acorde', 'silbido', 'tambor', 'brisa', 'energy', 'spark', 'portal', 'victory'] as const;
export type MessageSound = (typeof MESSAGE_SOUNDS)[number];
/** 'none' = sin sonido. */
export const SoundChoice = z.enum([...MESSAGE_SOUNDS, 'none']);
export type SoundChoice = z.infer<typeof SoundChoice>;
export const RINGTONES = ['clasico', 'suave', 'marimba'] as const;
export type Ringtone = (typeof RINGTONES)[number];
/** PUT /me/sounds: el sonido predeterminado de los chats y el tono de llamada (null = el de fábrica). */
export const SoundsInput = z.object({ messageSound: SoundChoice.nullable().optional(), ringtone: z.enum(RINGTONES).nullable().optional() });
/** sound: el de este chat (null = el predeterminado de la persona). */
export const ConversationPrefsInput = z.object({ pinned: z.boolean().optional(), mutedUntil: z.iso.datetime().nullable().optional(), linkPreviews: z.enum(['large', 'compact', 'none']).optional(), sound: SoundChoice.nullable().optional() });
export const WorkspacePrefsInput = z.object({ pinned: z.boolean() });
/** Constante para «Hasta que lo reactive» (chat silenciado o «No molestar»). */
export const MUTE_FOREVER = '9999-12-31T00:00:00Z';
/** PUT /me/dnd: «No molestar» hasta `until` (ISO; MUTE_FOREVER = hasta que lo reactive); null lo apaga. */
export const DndInput = z.object({ until: z.iso.datetime({ offset: true }).nullable() });
export interface DndDTO { dndUntil: string | null }
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** PUT /me/sleep: cualquier campo; `tz` explícito fija la zona (tzAuto=false) salvo que venga `tzAuto: true`. */
export const SleepInput = z.object({ on: z.boolean().optional(), start: HHMM.optional(), end: HHMM.optional(), tz: z.string().min(1).max(64).optional(), tzAuto: z.boolean().optional() });
export const MarkUnreadInput = z.object({ seq: z.number().int().min(1) });
export const CreateScheduledInput = z.object({
  body: z.string().trim().min(1).max(8000),
  mentions: z.array(MentionInput).max(50).optional(),
  replyTo: z.uuid().nullable().optional(),
  sendAt: z.iso.datetime({ offset: true }),
});
export const UpdateScheduledInput = z.object({
  body: z.string().trim().min(1).max(8000).optional(),
  mentions: z.array(MentionInput).max(50).optional(),
  sendAt: z.iso.datetime({ offset: true }).optional(),
});
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
/** POST /conversations/:id/read-tree: el grupo y sus derivadas, cada una hasta el seq que el cliente vio. */
export const MarkTreeReadInput = z.object({ items: z.array(z.object({ conversationId: z.uuid(), seq: z.number().int().min(0) })).min(1).max(200) });

export const PageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const EventsQuery = z.object({
  after: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ---------- Notificaciones push ----------
/** Token del dispositivo de ESTA sesión (reemplaza el anterior). sandbox = compilación Debug de Xcode. */
export const PushTokenInput = z.object({
  provider: z.enum(['apns', 'fcm']),
  token: z.string().trim().min(8).max(4096),
  environment: z.enum(['sandbox', 'production']).default('production'),
  /** Idioma de los textos que arma el servidor (recordatorios, reuniones). Por defecto, Accept-Language. */
  lang: z.enum(['es', 'en']).optional(),
});

/**
 * Datos que acompañan cada push (APNs: junto a `aps`; FCM: mensaje de datos, todos los valores como texto).
 * type: message | reminder | event. Clientes: ignorar campos y tipos desconocidos.
 */
export interface PushData {
  /** side = mensaje de un sidechat (categoría TC_SIDE; trae sideOf). reaction = reaccionaron a mi mensaje (abre el mensaje). */
  /** call = llamada entrante (categoría TC_CALL; trae callId y kind). */
  type: 'message' | 'reminder' | 'event' | 'side' | 'mention' | 'reaction' | 'issue' | 'call';
  conversationId: string;
  callId?: string;
  kind?: 'audio' | 'video';
  /** type 'issue': me asignaron esta tarea. Abrir el asunto; si inChat es false, sin abrir el chat (no lo puedo leer). */
  issueId?: string;
  inChat?: boolean;
  messageId?: string;
  authorId?: string;
  authorName?: string;
  /** Ruta relativa (/api/v1/avatars/…) como en los DTO, o vacío. */
  authorAvatarUrl?: string;
  reminderId?: string;
  eventId?: string;
  /** Solo en el aviso «empieza pronto» de una reunión (type 'event'): minutos que faltan. */
  minutes?: number;
  /**
   * Solo en sidechats: de qué conversación y mensaje cuelga y su extracto (≤ 60). En FCM llega como JSON en `sideOf`
   * y aplanado en sideOfConversationId, sideOfMessageId y sideOfExcerpt.
   */
  sideOf?: { conversationId: string | null; messageId: string | null; excerpt: string | null };
}

// ---------- Archivos (árbol de carpetas) ----------
export * from './drive.ts';

// ---------- Conectar WhatsApp ----------
export const WaKind = z.enum(['personal', 'business']);
export type WaKind = z.infer<typeof WaKind>;
export const WaCategory = z.enum(['trabajo', 'clientes', 'familia', 'amigos', 'comunidad', 'otros']);
export type WaCategory = z.infer<typeof WaCategory>;
export type WaStatus = 'pending' | 'qr' | 'connected' | 'reconnecting' | 'expired' | 'logged_out' | 'error';

/** Número con indicativo para vincular con código de 8 letras en vez de QR (útil desde el mismo teléfono). */
const PairPhone = z.string().trim().max(24).regex(/^[+\d\s()-]*$/, 'Solo números').nullable().optional();
export const CreateWaAccountInput = z.object({ label: z.string().trim().min(1).max(60), kind: WaKind, pairPhone: PairPhone });
export const UpdateWaAccountInput = z.object({ label: z.string().trim().min(1).max(60).optional(), kind: WaKind.optional(), /** Permitir responder desde chaggu con esta cuenta (apagado por defecto: solo lectura). */ sendEnabled: z.boolean().optional() });
/** Responder un chat de WhatsApp desde chaggu: solo si la cuenta lo tiene activado. */
export const WaSendInput = z.object({ text: z.string().trim().min(1).max(4000) });
export const RelinkWaAccountInput = z.object({ pairPhone: PairPhone });
export const WaChatsQuery = z.object({
  cursor: z.string().max(4096).optional(),
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
  /** Conversación de chaggu a la que llegan los mensajes nuevos de este chat (null = desvincular). */
  linkedConversationId: z.uuid().nullable().optional(),
  /**
   * WhatsApp en la bandeja (docs/WA-BANDEJA-GG-CHAT.md). 'auto' = grupo → 'groups', 1 a 1 → 'dms'.
   * null = sacarlo de la bandeja (también lo desfija de ahí).
   */
  inboxPlace: z.enum(['groups', 'dms', 'auto']).nullable().optional(),
  /** true = fijarlo arriba en la bandeja (si no estaba, lo mueve con 'auto'); false = quitar de fijados. */
  inboxPinned: z.boolean().optional(),
});
export const WaMessagesQuery = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) });

export interface WaAccountDTO {
  id: string;
  /** False mientras el puente comprueba los chats bloqueados de WhatsApp. */
  privacyReady?: boolean;
  /** ¿Se puede responder desde chaggu con esta cuenta? Por defecto no. */
  sendEnabled: boolean;
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
  /** En qué lista de la bandeja de chaggu vive (null = solo en la pantalla WhatsApp). */
  inboxPlace?: 'groups' | 'dms' | null;
  /** Fijado arriba en la bandeja (hace de pinnedAt). No es `pinned`, que es el fijado dentro de WhatsApp. */
  inboxPinnedAt?: string | null;
  /** Estado de la cuenta: si no es 'connected', la fila sale atenuada con «WhatsApp desconectado». */
  accountStatus?: WaStatus;
}
export interface WaMediaDTO { status: 'pending' | 'ready' | 'failed' | 'unavailable' | 'restricted'; attachment?: AttachmentDTO | null; error?: string | null }
export interface WaMessageDTO { media?: WaMediaDTO; id: string; fromMe: boolean; author: string | null; kind: string; body: string; sentAt: string; reactions?: { emoji: string; name: string }[] }

// ---------- Eventos en tiempo real ----------
/** Evento durable de una conversación, ordenado por eventSeq. */
export type ConversationEvent =
  | { type: 'message.created'; conversationId: string; eventSeq: number; message: MessageDTO }
  | { type: 'message.updated'; conversationId: string; eventSeq: number; message: MessageDTO }
  | { type: 'members.changed'; conversationId: string; eventSeq: number; memberIds: string[]; adminIds?: string[] }
  | { type: 'issue.updated'; conversationId: string; eventSeq: number; issue: IssueDTO }
  | { type: 'pins.changed'; conversationId: string; eventSeq: number; messageIds: string[] }
  /** Lista completa de temas (activos y archivados) tras crear, editar, archivar o quitar uno. */
  | { type: 'topics.changed'; conversationId: string; eventSeq: number; topics: TopicDTO[] }
  | { type: 'calendar.updated'; conversationId: string; eventSeq: number; event: CalendarEventDTO }
  | { type: 'mail.updated'; conversationId: string; eventSeq: number; email: SharedMailDTO }
  /** Empezó, cambió quién está dentro o terminó una llamada de la conversación. */
  | { type: 'call.updated'; conversationId: string; eventSeq: number; call: CallDTO }
  /** Evento fuera de tu historial visible: solo avanza el cursor. */
  | { type: 'redacted'; conversationId: string; eventSeq: number };

/** Aviso a una cuenta: algo cambió en su alcance; el cliente vuelve a pedir /bootstrap. */
export type AccountEvent =
  | { type: 'scope.changed'; reason: string }
  | { type: 'read.updated'; conversationId: string; seq: number; readRevision?: number }
  | { type: 'reminder.due'; reminder: ReminderDTO }
  /** Mis recordatorios cambiaron desde otro dispositivo (p. ej. una reacción 👀): volver a pedirlos. */
  | { type: 'reminders.changed' }
  /** Un mensaje programado mío cambió (creado, editado, enviado, cancelado o fallido), en cualquier dispositivo. */
  | { type: 'scheduled.updated'; scheduled: ScheduledMessageDTO }
  /** Una reunión a la que voy (sí, quizá o sin responder) empieza en `minutes` minutos (10 por defecto). */
  | { type: 'event.soon'; event: CalendarEventDTO; minutes: number }
  | { type: 'prefs.updated'; conversationId?: string; workspaceId?: string }
  /** Cambió mi «No molestar» (desde este u otro dispositivo). */
  | { type: 'me.dnd'; dndUntil: string | null }
  /** Me están llamando en una conversación (no llega a quien la empezó ni a quien tiene No molestar). */
  | { type: 'call.ringing'; call: CallDTO; conversationTitle: string | null; callerName: string }
  /**
   * La llamada a la que me agregaron cambió (no estoy en su chat), o (1.7.1) cambiaron mis dispositivos en ella:
   * entonces trae myDevices.
   */
  | { type: 'call.updated'; call: CallDTO }
  /** Perdidas sin ver (el número rojo de Llamadas): al colgar una que me perdí (callId) o al abrir Llamadas en otro dispositivo (0). */
  | { type: 'calls.missed'; callId: string | null; missedCalls: number }
  /** 1.7.1: contesté desde un dispositivo: los demás dejan de sonar y cierran el aviso (ignorar si deviceKey es el mío). */
  | { type: 'call.answered'; callId: string; conversationId: string; deviceKey: string; platform: string; label: string }
  /** 1.7.1: rechacé en un dispositivo (POST /calls/:id/decline): todos mis dispositivos dejan de sonar. */
  | { type: 'call.declined'; callId: string; conversationId: string }
  /** Un pedazo de audio de `userId` se está transcribiendo: los clientes muestran «Procesando…». */
  | { type: 'call.processing'; callId: string; userId: string; segId: string }
  /** Frases de ese pedazo ya guardadas (vacío si no tenía voz; failed si Groq falló). */
  | { type: 'call.transcript'; callId: string; userId: string; segId: string; segments: CallTranscriptSegmentDTO[]; failed?: boolean }
  /** Un asunto restringido (visibilidad 'org' o 'private') que puedo ver cambió: no viaja por la conversación. */
  | { type: 'issue.updated'; issue: IssueDTO }
  /** Mi asunto personal cambió (no tiene conversación). */
  | { type: 'issue.personal'; issue: IssueDTO }
  /** Perdí acceso a un asunto (cambió su visibilidad o me quitaron): sacarlo de la lista. */
  | { type: 'issue.hidden'; issueId: string; conversationId: string }
  /** Cambió mi modo sueño (desde este u otro dispositivo). */
  | { type: 'me.sleep'; sleep: SleepDTO }
  | { type: 'person.availability'; userId: string; availability: AvailabilityDTO }
  | { type: 'whatsapp.updated'; accountId: string }
  /** Revoca de inmediato la vista local; reset invalida toda la cuenta durante su verificación. */
  | { type: 'wa.privacy'; accountId: string; jids?: string[]; reset?: boolean }
  /** Cambió un chat de WhatsApp de la bandeja (se movió, fijó o sacó, o le entró un mensaje): reemplazar la fila por accountId+jid. */
  | { type: 'wa.inbox'; chat: WaChatDTO }
  | { type: 'drive.updated'; workspaceId: string | null; conversationId?: string | null };

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

// ---------- Asistente (IA) ----------
/** Una vuelta de la conversación con el asistente. El historial vive en el cliente (últimos 20 turnos). */
export const AssistantTurnInput = z.object({
  aiConsent: z.boolean().optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) })).min(1).max(20),
  timezone: z.string().min(1).max(64).default('America/Bogota'),
  lang: z.enum(['es', 'en']).default('es'),
});
/** Confirmar una acción pendiente (token firmado por el servidor) o deshacer una hecha. `text` = texto editado de un mensaje. */
export const AssistantRunInput = z.object({ token: z.string().min(10).max(8000), text: z.string().trim().min(1).max(8000).optional() });

export type AssistantActionKind = 'send_message' | 'create_group' | 'create_issue' | 'update_issue' | 'create_event' | 'cancel_event' | 'mark_read' | 'save_note' | 'remind';
export interface AssistantActionDTO {
  id: string;
  kind: AssistantActionKind;
  /** pending = espera tu confirmación; done = hecho (quizá con undoToken); failed = no se pudo; undone = deshecho. */
  status: 'pending' | 'done' | 'failed' | 'undone';
  /** A quién o dónde: «Laura Méndez», «Andes · Operación». */
  target: string;
  /** Texto del mensaje, título del asunto o de la reunión. */
  text: string;
  /** Línea secundaria: fecha, responsable, invitados… */
  detail?: string | null;
  /** Para confirmar (status pending). */
  token?: string;
  /** Para deshacer (status done). */
  undoToken?: string;
  /** Ruta de la app para abrirlo (/c/…, /asuntos, /agenda). */
  link?: string | null;
  error?: string | null;
}
// ---------- «gg de este chat» (docs/WA-BANDEJA-GG-CHAT.md) ----------
/** 'c:<conversationId>' o 'wa:<accountId>:<jid>'. */
export const GgSideSource = z.string().regex(/^(c:[0-9a-f-]{36}|wa:[0-9a-f-]{36}:[^\s]{3,200})$/i, 'Fuente inválida');
export const GgSideQuery = z.object({ source: GgSideSource });
export const GgSideSourceInput = z.object({ source: GgSideSource });
export const GgCalendarWindow = z.object({from:z.iso.datetime({offset:true}),to:z.iso.datetime({offset:true}),durationMin:z.number().int().min(15).max(240),timezone:z.string().min(1).max(64),startHour:z.number().int().min(0).max(23).optional(),endHour:z.number().int().min(1).max(24).optional()}).refine(v=>(v.endHour ?? 18)>(v.startHour ?? 9),'Invalid daily hours');
export interface GgCalendarSlotsDTO {status:'ready'|'needs_connect'|'reconnect'|'error'|'needs_clarification';provider:'google'|'microsoft'|null;checkedAt:string|null;timezone:string|null;slots:{startsAt:string;endsAt:string}[];calendar?:'primary'|null;scope?:'owned-primary-and-chaggu'|null;startHour?:number;endHour?:number}
export const GgSideAskInput = z.object({ source: GgSideSource, text: z.string().trim().min(1).max(2000), quotedMessageIds: z.array(z.string().min(1).max(200)).max(20).optional(), calendar:GgCalendarWindow.optional() });
export const GgSideTone = z.enum(['me', 'shorter', 'formal', 'more']);
export const GgSideReplyInput = z.object({ source: GgSideSource, tone: GgSideTone.optional(), quotedMessageIds: z.array(z.string().min(1).max(200)).max(20).optional() });
export const GgSideSuggestInput = z.object({ source: GgSideSource, messageIds: z.array(z.string().min(1).max(200)).min(1).max(30),calendar:GgCalendarWindow.optional() });
export const GgSidePendingQuery = z.object({ sources: z.string().min(1).max(8000) });
export interface GgSideDraft {
  style: 'short' | 'warm' | 'action';
  text: string;
  action?: { kind: 'task' | 'reminder'; title: string; assigneeName?: string | null; due?: string | null } | null;
}
export interface GgSideSuggestion {
  id: string;
  kind: 'reply' | 'task' | 'reminder' | 'message_person' | 'summary';
  title: string;
  detail?: string | null;
  draft?: string | null;
  /** p. ej. { assigneeName, due, personName }. */
  params?: Record<string, string | null> | null;
  forMessageIds: string[];
}
export interface GgSideMessageDTO {
  id: string;
  role: 'user' | 'gg';
  body: string;
  quoted?: { id: string; author: string; text: string }[] | null;
  extra?: { calendar?:GgCalendarSlotsDTO; followUps?: string[]; drafts?: GgSideDraft[]; suggestions?: GgSideSuggestion[]; pending?: { text: string; messageId?: string }[] } | null;
  createdAt: string;
}
export interface GgSideThreadDTO { session: number; messages: GgSideMessageDTO[]; pending: number }

export interface AssistantTurnDTO { reply: string; actions: AssistantActionDTO[]; /** 2-3 respuestas rápidas que el usuario probablemente dirá después (chips). */ suggestions?: string[] }


// ---------- Citas por enlace, tipo Calendly (docs/CITAS.md) ----------
export const BookingMode = z.enum(['collective', 'round_robin']);
export type BookingMode = z.infer<typeof BookingMode>;
/** Horario de atención: día de la semana (0 = domingo … 6) → tramos «HH:MM». */
const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const BookingHours = z.record(z.string().regex(/^[0-6]$/), z.array(z.tuple([HhMm, HhMm])).max(6));
export type BookingHours = z.infer<typeof BookingHours>;
export const BookingSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);

export interface BookingHostDTO { id: string; name: string; avatarUrl: string | null }
/** Lo que ve cualquier persona en la página pública. */
export interface BookingPagePublicDTO {
  slug: string; title: string; description: string; durationMin: number; timezone: string; orgName: string | null;
  hosts: BookingHostDTO[]; mode: BookingMode; minNoticeMin: number; horizonDays: number;
  /** false: nadie tiene un calendario conectado todavía; no hay horarios que ofrecer. */
  ready: boolean;
}
export interface BookingSlotsDTO { slots: string[]; timezone: string }
export const BookingCreateInput = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  note: z.string().trim().max(2000).optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
  lang: z.enum(['es', 'en']).default('es'),
  /** Campo trampa: las personas no lo ven ni lo llenan. */
  website: z.string().max(200).optional(),
});
export const BookingRescheduleInput = z.object({ startsAt: z.iso.datetime({ offset: true }) });
export interface BookingDTO {
  status: 'confirmed' | 'cancelled'; startsAt: string; endsAt: string; guestName: string; guestEmail: string; note: string;
  joinUrl: string | null; hosts: BookingHostDTO[]; page: BookingPagePublicDTO;
  /** Solo al crear: el enlace para cambiar o cancelar (no se puede recuperar después). */
  manageToken?: string;
}

/** Administración (autenticado). */
export interface BookingHostStatusDTO extends BookingHostDTO { email: string; calendar: 'google' | 'microsoft' | 'none' | 'reconnect' }
export interface BookingPageDTO extends BookingPagePublicDTO {
  id: string; ownerId: string; titleEn: string | null; descriptionEn: string | null; bufferMin: number; stepMin: number; hours: BookingHours; active: boolean;
  hostsStatus: BookingHostStatusDTO[]; url: string; upcoming: number;
}
export const BookingPageInput = z.object({
  slug: BookingSlug,
  title: z.string().trim().min(2).max(120), titleEn: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(1000).default(''), descriptionEn: z.string().trim().max(1000).nullable().optional(),
  mode: BookingMode,
  durationMin: z.number().int().min(10).max(240),
  bufferMin: z.number().int().min(0).max(120).default(0),
  stepMin: z.number().int().min(5).max(240).default(30),
  minNoticeMin: z.number().int().min(0).max(43200).default(240),
  horizonDays: z.number().int().min(1).max(180).default(30),
  timezone: z.string().min(1).max(64).default('America/Bogota'),
  hours: BookingHours,
  hostIds: z.array(z.uuid()).min(1).max(12),
  active: z.boolean().default(true),
});
export const BookingPagePatch = BookingPageInput.partial();
export interface BookingHostBookingDTO { id: string; pageId: string; pageTitle: string; startsAt: string; endsAt: string; guestName: string; guestEmail: string; note: string; joinUrl: string | null; status: 'confirmed' | 'cancelled'; hostIds: string[] }

// ---------- Private notes and personal chat organization ----------
export const NoteTagInput = z.object({ kind: z.enum(['label', 'conversation', 'issue']), label: z.string().trim().min(1).max(120), id: z.uuid().optional() }).refine((tag) => tag.kind === 'label' || !!tag.id, 'Falta la referencia');
export type NoteTagDTO = z.infer<typeof NoteTagInput>;
export const NoteInput = z.object({
  title: z.string().trim().min(1).max(200), body: z.string().max(50000).default(''),
  tags: z.array(NoteTagInput).max(50).default([]), fileIds: z.array(z.uuid()).max(50).default([]),
  links: z.array(z.url().refine((url) => /^https?:\/\//i.test(url), 'Usa un enlace http o https')).max(50).default([]),
});
export type NoteInput = z.infer<typeof NoteInput>;
export interface NoteDTO extends NoteInput { id: string; createdAt: string; updatedAt: string; files: DriveFileDTO[] }
export const ChatPersonalPreferenceInput = z.object({
  favorite: z.boolean().optional(), archived: z.boolean().optional(), sectionId: z.uuid().nullable().optional(),
  background: z.enum(['default', 'sand', 'mint', 'sky', 'rose', 'dusk']).optional(),
  font: z.enum(['system', 'serif', 'mono', 'rounded']).optional(), hideBar: z.boolean().optional(),
});
export type ChatPersonalPreferenceDTO = z.infer<typeof ChatPersonalPreferenceInput>;
export const IssuePersonalPreferencesInput = z.object({ view: z.enum(['list', 'cards', 'board']).optional(), grouping: z.enum(['group', 'assignee']).optional(), filter: z.enum(['mine', 'open', 'completed']).optional() });
export const PersonalPreferencesInput = z.object({
  issues: IssuePersonalPreferencesInput.optional(),
  appearance: z.object({ mode: z.enum(['system', 'light', 'dark']), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }).optional(),
  sections: z.array(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80) })).max(100).default([]),
  conversations: z.record(z.uuid(), ChatPersonalPreferenceInput).default({}),
}).refine((value) => Object.keys(value.conversations).length <= 5000, 'Demasiados chats').refine((value) => new Set(value.sections.map((s) => s.id)).size === value.sections.length, 'Secciones duplicadas').refine((value) => Object.values(value.conversations).every((p) => !p.sectionId || value.sections.some((s) => s.id === p.sectionId)), 'La sección no existe');
export type PersonalPreferencesDTO = z.infer<typeof PersonalPreferencesInput>;
// GIFs y memes (docs/GIFS.md).
export * from './gifs.ts';

/** Atomic partial merge; a legacy full PUT does not erase additive preferences. */
export const PersonalPreferencesPatchInput = z.object({ appearance: z.object({ mode: z.enum(['system', 'light', 'dark']).optional(), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }).optional(), issues: IssuePersonalPreferencesInput.optional() });

import AVFoundation
import AudioToolbox
import Foundation
import Observation
import UIKit
import UserNotifications

// Llamadas de voz y video con Amazon Chime SDK (docs/LLAMADAS.md). Paridad con apps/web/src/call.ts y screens/Call.tsx:
// - el API crea la reunión y el attendee; aquí solo se conecta el audio y el video (CallMedia);
// - latido cada 30 s (si responde 409 not_in_call, la llamada se cierra);
// - transcripción: el SDK entrega frases parciales (subtítulos) y finales; las finales van al API en lotes cada ~3 s.

// MARK: - DTOs

/// Lo que se pasa tal cual al SDK: `meeting.Meeting` (CreateMeeting) y `attendee.Attendee` (CreateAttendee, con JoinToken).
/// No se guarda ni se reenvía.
struct CallJoinDTO: Decodable, Sendable {
    struct MediaPlacement: Decodable, Equatable, Sendable {
        var audioHostUrl: String
        var audioFallbackUrl: String
        var signalingUrl: String
        var turnControlUrl: String
        var eventIngestionUrl: String?
        init(from decoder: Decoder) throws {
            let c = try container(decoder)
            audioHostUrl = c.v("AudioHostUrl", "")
            audioFallbackUrl = c.v("AudioFallbackUrl", "")
            signalingUrl = c.v("SignalingUrl", "")
            turnControlUrl = c.v("TurnControlUrl", "")
            eventIngestionUrl = c.o("EventIngestionUrl")
        }
    }
    struct Meeting: Decodable, Equatable, Sendable {
        var meetingId: String
        var externalMeetingId: String?
        var mediaRegion: String
        var mediaPlacement: MediaPlacement
        /// MeetingFeatures.Video.MaxResolution ("HD", "FHD", "None"), si viene.
        var videoMaxResolution: String?
        init(from decoder: Decoder) throws {
            let c = try container(decoder)
            meetingId = c.v("MeetingId", "")
            externalMeetingId = c.o("ExternalMeetingId")
            mediaRegion = c.v("MediaRegion", "us-east-1")
            mediaPlacement = try c.decode(MediaPlacement.self, forKey: AnyKey("MediaPlacement"))
            let features = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("MeetingFeatures"))
            let video = features.flatMap { try? $0.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("Video")) }
            videoMaxResolution = video?.o("MaxResolution")
        }
    }
    struct Attendee: Decodable, Equatable, Sendable {
        var attendeeId: String
        var externalUserId: String
        var joinToken: String
        init(from decoder: Decoder) throws {
            let c = try container(decoder)
            attendeeId = c.v("AttendeeId", "")
            externalUserId = c.v("ExternalUserId", "")
            joinToken = c.v("JoinToken", "")
        }
    }

    var call: CallDTO
    var meeting: Meeting
    var attendee: Attendee

    /// Proveedor falso del API (CALLS_PROVIDER=fake): no hay servidor de medios al que conectarse.
    var isFake: Bool { meeting.meetingId.hasPrefix("fake-") || meeting.mediaPlacement.audioHostUrl.contains("fake.invalid") }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        call = try c.decode(CallDTO.self, forKey: AnyKey("call"))
        let m = try c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("meeting"))
        meeting = try m.decode(Meeting.self, forKey: AnyKey("Meeting"))
        let a = try c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("attendee"))
        attendee = try a.decode(Attendee.self, forKey: AnyKey("Attendee"))
    }
}

/// GET /calls/active → { calls }.
struct ActiveCallDTO: Decodable, Identifiable, Sendable {
    var call: CallDTO
    var title: String?
    var id: String { call.id }
    init(call: CallDTO, title: String?) { self.call = call; self.title = title }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        call = try c.decode(CallDTO.self, forKey: AnyKey("call"))
        title = c.o("title")
    }
}
struct ActiveCallsPage: Decodable, Sendable {
    var calls: [ActiveCallDTO]
    init(from decoder: Decoder) throws { calls = try container(decoder).lossyArray("calls") }
}

/// Quita la notificación push de una llamada (collapseId `call-{id}`) cuando otro dispositivo contesta o rechaza.
enum CallPushCleanup {
    static func remove(callId: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ["call-\(callId)"])
        center.getDeliveredNotifications { list in
            let ids = list.filter { ($0.request.content.userInfo["callId"] as? String) == callId }.map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }
}

/// `{ call }` de GET /conversations/:id/call, leave, end y transcription.
struct CallResult: Decodable, Sendable {
    var call: CallDTO?
    init(from decoder: Decoder) throws { call = try container(decoder).o("call") }
}

/// Una fila del historial (pestaña «Llamadas»).
struct CallHistoryItemDTO: Decodable, Equatable, Identifiable, Sendable {
    var call: CallDTO
    /// Todos los que entraron alguna vez, en orden de llegada.
    var participantIds: [String]
    var durationSec: Int?
    var hasSummary: Bool
    var id: String { call.id }

    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        call = try c.decode(CallDTO.self, forKey: AnyKey("call"))
        participantIds = c.v("participantIds", [])
        durationSec = c.intOpt("durationSec")
        hasSummary = c.v("hasSummary", false)
    }
    init(call: CallDTO, participantIds: [String], durationSec: Int?, hasSummary: Bool) {
        self.call = call; self.participantIds = participantIds; self.durationSec = durationSec; self.hasSummary = hasSummary
    }
}

struct CallHistoryPage: Decodable, Sendable {
    var calls: [CallHistoryItemDTO]
    var hasMore: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        calls = c.lossyArray("calls")
        hasMore = c.v("hasMore", false)
    }
}

struct CallTranscriptDTO: Decodable, Equatable, Sendable {
    var call: CallDTO
    var summary: String?
    var segments: [CallTranscriptSegmentDTO]
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        call = try c.decode(CallDTO.self, forKey: AnyKey("call"))
        summary = c.o("summary")
        segments = c.lossyArray("segments")
    }
    init(call: CallDTO, summary: String?, segments: [CallTranscriptSegmentDTO]) {
        self.call = call; self.summary = summary; self.segments = segments
    }
}

/// Frase del SDK (TranscriptResult) ya aplanada: la primera alternativa y quién habló.
struct TranscriptPiece: Equatable, Sendable {
    var resultId: String
    var isPartial: Bool
    var text: String
    var attendeeId: String?
    var externalUserId: String?
    var language: String?
    var startMs: Int
    var endMs: Int
}

/// Frase final para POST /calls/:id/transcript (CallTranscriptInput).
struct CallSegmentInput: Equatable, Sendable {
    var resultId: String
    var attendeeId: String?
    var externalUserId: String?
    var language: String?
    var text: String
    var startMs: Int
    var endMs: Int
    var json: [String: Any] {
        ["resultId": resultId, "attendeeId": attendeeId ?? NSNull(), "externalUserId": externalUserId ?? NSNull(),
         "language": language ?? NSNull(), "text": text, "startMs": startMs, "endMs": endMs]
    }
}

struct Caption: Equatable, Identifiable, Sendable {
    var resultId: String
    var userId: String?
    var text: String
    var partial: Bool
    /// Pedazo de audio en Groq: «⏳ Procesando…».
    var processing = false
    var id: String { resultId }
}

struct CallTile: Equatable, Identifiable, Sendable {
    var tileId: Int
    var local: Bool
    var userId: String?
    var active: Bool
    var id: Int { tileId }
}

/// Qué se comparte de una llamada terminada.
enum CallShareWhat: String, CaseIterable, Identifiable, Sendable {
    case summary, transcript, both
    var id: String { rawValue }
    var label: String { L(self == .summary ? "calls.shareSummary" : self == .transcript ? "calls.shareTranscript" : "calls.shareBoth") }
    var icon: String { self == .summary ? "sparkles" : self == .transcript ? "text.quote" : "doc.on.doc" }
}

// MARK: - Reglas puras (paridad con la web; las usan la vista y las pruebas)

enum CallRules {
    static let heartbeatSeconds: UInt64 = 30
    static let ringSeconds: UInt64 = 45
    static let flushSeconds: Double = 3
    static let maxBatch = 50
    static let maxCaptions = 6

    /// m:ss
    static func clock(_ seconds: Int) -> String { L10n.clockDuration(seconds) }

    /// 1.7.1: el ExternalUserId es «{userId}#{deviceKey}» (un attendee por dispositivo); la persona es lo de antes del «#».
    static func personId(_ externalUserId: String) -> String {
        String(externalUserId.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? Substring(externalUserId))
    }

    /// Sin respuesta: terminó y nunca entraron dos personas.
    static func isMissed(_ item: CallHistoryItemDTO) -> Bool { item.call.endedAt != nil && item.participantIds.count < 2 }

    /// Grupal: la conversación no es un directo (o, si no la conozco, hubo más de otro participante).
    static func isGroup(_ item: CallHistoryItemDTO, conv: ConversationDTO?, me: String) -> Bool {
        if let conv { return conv.kind != .direct }
        return item.participantIds.filter { $0 != me }.count > 1
    }

    /// Qué se puede compartir: resumen, transcripción o ambas (en ese orden).
    static func shareOptions(_ t: CallTranscriptDTO) -> [CallShareWhat] {
        let s = !(t.summary ?? "").isEmpty, tr = !t.segments.isEmpty
        return (s ? [.summary] : []) + (tr ? [.transcript] : []) + (s && tr ? [.both] : [])
    }

    /// Texto plano para copiar o compartir con el sistema (como asText de la web).
    static func shareText(_ t: CallTranscriptDTO, _ what: CallShareWhat, speaker: (CallTranscriptSegmentDTO) -> String) -> String {
        var parts: [String] = []
        if what != .transcript, let s = t.summary, !s.isEmpty { parts.append("\(L("call.summary")):\n\(s)") }
        if what != .summary, !t.segments.isEmpty {
            parts.append("\(L("call.transcriptTitle")):\n" + t.segments.map { "[\(clock($0.startMs / 1000))] \(speaker($0)): \($0.text)" }.joined(separator: "\n"))
        }
        return parts.joined(separator: "\n\n")
    }

    /// Aplica frases del SDK: subtítulos (últimos 6, reemplazando por resultId) y las finales para mandar.
    static func applyTranscript(_ captions: [Caption], _ pieces: [TranscriptPiece]) -> (captions: [Caption], finals: [CallSegmentInput]) {
        var out = captions
        var finals: [CallSegmentInput] = []
        for p in pieces {
            let text = p.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            out.removeAll { $0.resultId == p.resultId }
            out.append(Caption(resultId: p.resultId, userId: p.externalUserId, text: text, partial: p.isPartial))
            if out.count > maxCaptions { out.removeFirst(out.count - maxCaptions) }
            if !p.isPartial {
                finals.append(CallSegmentInput(resultId: p.resultId, attendeeId: p.attendeeId, externalUserId: p.externalUserId,
                                               language: p.language, text: String(text.prefix(4000)),
                                               startMs: max(0, p.startMs), endMs: max(0, p.endMs)))
            }
        }
        return (out, finals)
    }

    /// «Llamando…» los primeros 45 s; después, «No contestó».
    static func inviteState(since: Date, now: Date = Date()) -> CallCenter.InviteState {
        now.timeIntervalSince(since) < TimeInterval(ringSeconds) ? .ringing : .noAnswer
    }

    /// Salida por defecto al conectar: auricular en voz y altavoz en video; Bluetooth o audífonos conectados mandan.
    static func defaultOutput(_ devices: [CallAudioDevice], video: Bool) -> String? {
        if let ext = devices.first(where: { $0.kind == .bluetooth || $0.kind == .wired }) { return ext.id }
        return devices.first { $0.kind == (video ? .speaker : .receiver) }?.id
    }

    /// Estoy en esta llamada desde otro dispositivo (myDevices) y no desde este.
    static func onOtherDevice(_ call: CallDTO, inCallHere: String?, myKey: String = CallRules.deviceKey) -> CallDTO.MyDevice? {
        guard call.endedAt == nil, call.id != inCallHere else { return nil }
        return call.myDevices.first { $0.deviceKey != myKey }
    }

    /// Este dispositivo en la llamada (contrato 1.7.1): los primeros 8 caracteres del id del dispositivo.
    static var deviceKey: String {
        let k = Prefs.deviceId.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }.prefix(8)
        return k.isEmpty ? "ios" : String(k)
    }

    /// Una llamada terminada no pisa a otra más nueva que ya esté en curso (putCall de client-core).
    static func merge(_ current: CallDTO?, _ incoming: CallDTO) -> CallDTO? {
        if incoming.endedAt != nil, let current, current.id != incoming.id { return current }
        return incoming.endedAt == nil ? incoming : nil
    }

    /// Error que no se arregla reintentando un lote de frases (apagada o fuera de la llamada): se descarta.
    static func dropBatch(_ error: Error) -> Bool {
        guard let e = error as? ApiRequestError else { return false }
        return !e.isNetwork && e.status < 500
    }
}

// MARK: - Medios (SDK)

/// Lo que la sesión de medios le cuenta a la llamada.
@MainActor
protocol CallMediaDelegate: AnyObject {
    func mediaDidStart()
    func mediaDidStop(error: String?)
    func mediaMuteChanged(_ muted: Bool)
    func mediaTileAdded(_ tile: CallTile)
    func mediaTileRemoved(_ tileId: Int)
    func mediaSpeaking(_ userIds: [String])
    func mediaTranscript(_ pieces: [TranscriptPiece])
    /// Alguien silenció o activó su micrófono (ids de persona).
    func mediaRemoteMute(_ userIds: [String], muted: Bool)
}

/// Sesión de audio y video. `ChimeCallMedia` usa el SDK; `NullCallMedia` sirve para el proveedor falso del API y las pruebas.
@MainActor
protocol CallMedia: AnyObject {
    var delegate: CallMediaDelegate? { get set }
    /// Conecta el audio (y el video remoto). Llama a mediaDidStart cuando hay audio.
    func start() throws
    func stop()
    func setMuted(_ muted: Bool)
    func startCamera() throws
    func stopCamera()
    func switchCamera()
    func bind(_ view: UIView, tileId: Int)
    func unbind(tileId: Int)
    /// Vista para pintar un video (DefaultVideoRenderView con el SDK).
    func makeVideoView() -> UIView
    /// Salidas de audio disponibles y la activa (1.7.1).
    func audioDevices() -> [CallAudioDevice]
    func activeAudioDevice() -> String?
    func chooseAudioDevice(_ id: String)
}

/// Una salida de audio de la llamada.
struct CallAudioDevice: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable {
        case receiver, speaker, bluetooth, wired, other
        init(_ t: MediaKindRaw) { self = t.kind }
        var symbol: String {
            switch self {
            case .receiver: return "iphone"
            case .speaker: return "speaker.wave.3.fill"
            case .bluetooth: return "airpodspro"
            case .wired: return "headphones"
            case .other: return "hifispeaker"
            }
        }
    }
    var id: String
    var label: String
    var kind: Kind
}

/// Tipo del SDK sin importar AmazonChimeSDK aquí (lo adapta ChimeCallMedia).
protocol MediaKindRaw { var kind: CallAudioDevice.Kind { get } }

/// Sin conexión real: la llamada queda «en vivo» al instante. Para CALLS_PROVIDER=fake y pruebas.
@MainActor
final class NullCallMedia: CallMedia {
    weak var delegate: CallMediaDelegate?
    private(set) var started = false
    private(set) var camera = false
    private(set) var muted = false
    func start() throws {
        started = true
        DispatchQueue.main.async { [weak self] in self?.delegate?.mediaDidStart() }
    }
    func stop() { started = false }
    func setMuted(_ m: Bool) { muted = m; delegate?.mediaMuteChanged(m) }
    /// Con cámara, un recuadro local (vacío) para ver la cuadrícula en pruebas.
    func startCamera() throws { camera = true; delegate?.mediaTileAdded(CallTile(tileId: 1, local: true, userId: nil, active: true)) }
    func stopCamera() { if camera { delegate?.mediaTileRemoved(1) }; camera = false }
    func switchCamera() {}
    func bind(_ view: UIView, tileId: Int) {}
    func unbind(tileId: Int) {}
    func makeVideoView() -> UIView { UIView() }
    private(set) var active = "receiver"
    func audioDevices() -> [CallAudioDevice] {
        [CallAudioDevice(id: "receiver", label: L("call.out.receiver"), kind: .receiver), CallAudioDevice(id: "speaker", label: L("call.out.speaker"), kind: .speaker)]
    }
    func activeAudioDevice() -> String? { active }
    func chooseAudioDevice(_ id: String) { active = id }
}

// MARK: - La llamada en curso

/// Aviso de llamada entrante (evento de cuenta `call.ringing`).
struct IncomingCall: Equatable, Identifiable, Sendable {
    var call: CallDTO
    var callerName: String
    var title: String?
    var id: String { call.id }
}

/// Estado de la llamada de este dispositivo (una a la vez).
struct CallView: Equatable {
    enum Phase: Equatable { case connecting, live, ended }
    var call: CallDTO
    var phase: Phase = .connecting
    var muted = false
    var camera = false
    var tiles: [CallTile] = []
    var captions: [Caption] = []
    /// Quién suena ahora (ids de persona).
    var speaking: [String] = []
    var error: String?
    /// Salida de audio (1.7.1): la elegida y las disponibles.
    var audioOut: String?
    var audioDevices: [CallAudioDevice] = []
    /// Personas con el micrófono silenciado (indicador por persona).
    var mutedUsers: Set<String> = []
    /// Agregados que aún no entran: cuándo se les llamó («Llamando…»; a los 45 s, «No contestó»).
    var invites: [String: Date] = [:]
}

@MainActor
@Observable
final class CallCenter: CallMediaDelegate {
    private(set) var view: CallView? { didSet { syncRecorder() } }
    private(set) var ringing: IncomingCall?
    /// Pantalla completa de la llamada (si no, la píldora de arriba).
    var expanded = false

    @ObservationIgnored weak var store: AppStore?
    /// Fábrica de la sesión de medios (las pruebas ponen NullCallMedia).
    @ObservationIgnored var makeMedia: (CallJoinDTO) -> CallMedia = { j in
        if j.isFake || AppConfig.launchFlag("TCFakeCallMedia") { return NullCallMedia() }
        return ChimeCallMedia(join: j)
    }
    /// Solo pruebas (CALLS_STT_PROVIDER=fake): en vez del micrófono se manda un pedazo «texto:…».
    @ObservationIgnored var fakeCaptions = AppConfig.launchFlag("TCFakeCaptions")
    /// Grabador de pedazos para Groq (docs/LLAMADAS.md); las pruebas lo cambian.
    @ObservationIgnored var makeRecorder: (CallCenter, CallDTO) -> CallChunkRecorder = { center, call in
        let upload: (AudioChunk) -> Void = { [weak center] chunk in
            guard let store = center?.store else { return }
            Task { await store.sendCallAudio(call.id, chunk) }
        }
        if center.fakeCaptions || center.media is NullCallMedia && !AppConfig.launchFlag("TCRealMic") { return FakeChunkRecorder(upload: upload) }
        return MicChunkRecorder(callStartedAt: ISODate.parse(call.startedAt) ?? Date(), isMuted: { [weak center] in center?.view?.muted ?? true }, upload: upload)
    }
    @ObservationIgnored private(set) var recorder: CallChunkRecorder?
    @ObservationIgnored private(set) var media: CallMedia?
    @ObservationIgnored private var beat: Task<Void, Never>?
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var ringTask: Task<Void, Never>?
    @ObservationIgnored private(set) var outbox: [CallSegmentInput] = []
    @ObservationIgnored private var leaving = false
    /// «Pasar aquí»: dispositivo mío que sale cuando este conecta.
    @ObservationIgnored var handOffFrom: String?
    @ObservationIgnored private var attendeeUsers: [String: String] = [:]
    /// Lotes enviados (pruebas y diagnóstico).
    @ObservationIgnored private(set) var sentBatches = 0

    var inCall: Bool { view != nil && view?.phase != .ended }

    /// Llama o entra a la llamada en curso de la conversación.
    func start(_ conversationId: String, kind: String) async throws {
        if let v = view, v.call.conversationId == conversationId, v.phase != .ended { expanded = true; return }
        if view != nil { await hangUp() }
        guard let store else { return }
        let j = try await store.startCallRequest(conversationId, kind: kind)
        await connect(j, camera: kind == "video")
    }

    /// Entrar desde el aviso o la franja «Unirse».
    func join(_ callId: String, camera: Bool) async throws {
        if view?.call.id == callId, view?.phase != .ended { expanded = true; return }
        if view != nil { await hangUp() }
        guard let store else { return }
        let j = try await store.joinCallRequest(callId)
        await connect(j, camera: camera)
    }

    private func connect(_ j: CallJoinDTO, camera: Bool) async {
        leaving = false
        outbox = []
        attendeeUsers = [j.attendee.attendeeId: CallRules.personId(j.attendee.externalUserId)]
        view = CallView(call: j.call, camera: false)
        expanded = true
        let m = makeMedia(j)
        media = m
        m.delegate = self
        do {
            if !(m is NullCallMedia) {
                guard await Self.microphoneAllowed() else { throw CallMediaError.microphone }
                try Self.activateAudioSession(video: camera)
            }
            try m.start()
            if camera { await startCamera() }
            startHeartbeat(j.call.id)
        } catch {
            view?.error = (error as? CallMediaError)?.text ?? error.localizedDescription
            let id = j.call.id
            await teardown(keepError: true)
            _ = try? await store?.leaveCallRequest(id)
        }
    }

    // MARK: Controles

    func toggleMute() {
        guard let v = view, let media else { return }
        media.setMuted(!v.muted)
    }

    func toggleCamera() async {
        guard let v = view, let media else { return }
        if v.camera { media.stopCamera(); view?.camera = false; view?.tiles.removeAll { $0.local } }
        else { await startCamera() }
    }

    func switchCamera() { media?.switchCamera() }

    private func startCamera() async {
        guard let media else { return }
        if !(media is NullCallMedia) {
            guard await AVCaptureDevice.requestAccess(for: .video) else { view?.error = L("call.noCamera"); return }
        }
        do { try media.startCamera(); view?.camera = true } catch { view?.error = L("call.noCamera") }
    }

    func bind(_ v: UIView, tileId: Int) { media?.bind(v, tileId: tileId) }
    func unbind(tileId: Int) { media?.unbind(tileId: tileId) }
    func makeVideoView() -> UIView { media?.makeVideoView() ?? UIView() }

    /// Prender (tras la confirmación) o apagar la transcripción.
    func setTranscription(_ on: Bool, aiSummary: Bool = false) async throws {
        guard let v = view, let store else { return }
        if !on { await flush() }
        let call = try await store.setCallTranscriptionRequest(v.call.id, on: on, aiSummary: aiSummary)
        if let call { view?.call = call }
        if !on { view?.captions = [] }
    }

    /// Graba el micrófono propio mientras la llamada está en vivo y se transcribe (como syncRecorder de la web).
    private func syncRecorder() {
        let want = view.map { $0.phase == .live && $0.call.transcribing } ?? false
        if want, recorder == nil, let call = view?.call {
            let r = makeRecorder(self, call)
            recorder = r
            r.start()
        } else if !want, let r = recorder {
            r.stop()
            recorder = nil
        }
    }

    /// `call.processing` / `call.transcript` (por la cuenta): «⏳ Procesando…» con el nombre y luego las frases.
    func onTranscriptEvent(callId: String, userId: String, segId: String, segments: [CallTranscriptSegmentDTO]?) {
        guard var v = view, v.call.id == callId else { return }
        let key = "p:\(segId)"
        var caps = v.captions.filter { $0.resultId != key }
        if let segments {
            for s in segments {
                caps.removeAll { $0.resultId == s.resultId }
                caps.append(Caption(resultId: s.resultId, userId: s.speakerUserId ?? userId, text: s.text, partial: false))
            }
        } else {
            caps.append(Caption(resultId: key, userId: userId, text: "", partial: true, processing: true))
        }
        v.captions = Array(caps.suffix(8))
        view = v
    }

    /// Sumar personas a la llamada en curso (o a la de mi otro dispositivo, `callId`).
    func invite(_ userIds: [String], callId: String? = nil) async throws {
        guard let id = callId ?? view?.call.id, let store, !userIds.isEmpty else { return }
        try await store.inviteToCall(id, userIds: userIds)
        if view?.call.id == id { let now = Date(); for u in userIds { view?.invites[u] = now } }
    }

    /// Estado de un agregado que aún no entra.
    enum InviteState: Equatable { case ringing, noAnswer }
    func inviteState(_ userId: String, now: Date = Date()) -> InviteState? {
        guard let v = view, !v.call.activeUserIds.contains(userId), let at = v.invites[userId] else { return nil }
        return CallRules.inviteState(since: at, now: now)
    }

    // MARK: Colgar

    func hangUp(forAll: Bool = false) async {
        guard let v = view else { return }
        let id = v.call.id
        await flush()
        await teardown()
        _ = try? await store?.leaveCallRequest(id, forAll: forAll)
    }

    private func teardown(keepError: Bool = false) async {
        leaving = true
        beat?.cancel(); beat = nil
        flushTask?.cancel(); flushTask = nil
        let m = media
        media = nil
        m?.stopCamera()
        m?.stop()
        if m != nil && !(m is NullCallMedia) { Self.deactivateAudioSession() }
        let err = keepError ? view?.error : nil
        view = nil
        expanded = false
        if let err { store?.show(err) }
    }

    /// Cerrar sesión o cambiar de cuenta: se cuelga sin esperar.
    func reset() {
        if let id = view?.call.id, let store { Task { _ = try? await store.leaveCallRequest(id) } }
        leaving = true
        beat?.cancel(); beat = nil
        flushTask?.cancel(); flushTask = nil
        ringTask?.cancel(); ringTask = nil
        media?.stop(); media = nil
        view = nil; ringing = nil; expanded = false; outbox = []
    }

    // MARK: Latido

    private func startHeartbeat(_ callId: String) {
        beat?.cancel()
        beat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: CallRules.heartbeatSeconds * 1_000_000_000)
                guard !Task.isCancelled, let self, self.view?.call.id == callId, let store = self.store else { return }
                do { try await store.callHeartbeatRequest(callId) } catch {
                    if (error as? ApiRequestError)?.code == "not_in_call" { await self.teardown(); return }
                }
            }
        }
    }

    // MARK: Estado desde el socket

    /// `call.updated` / respuestas del API: quién está, si transcribe, si terminó.
    func callChanged(_ c: CallDTO) {
        if var v = view, v.call.id == c.id {
            // Los agregados sin chat (invitedUserIds) que aún no entran cuentan como «Llamando…» desde que se ven.
            let now = Date()
            for u in c.invitedUserIds where v.invites[u] == nil && !c.activeUserIds.contains(u) { v.invites[u] = now }
            // 1.7.1: el servidor manda cuándo se llamó a cada agregado y si ya entró.
            for i in c.invited {
                if i.joined { v.invites[i.userId] = nil } else if let at = ISODate.parse(i.at), !c.activeUserIds.contains(i.userId) { v.invites[i.userId] = at }
            }
            for u in c.activeUserIds { v.invites[u] = nil }
            if c.endedAt != nil, v.phase != .ended { Task { await teardown() }; return }
            v.call = c
            if v != view { view = v }
        }
        if let r = ringing, r.call.id == c.id, c.endedAt != nil || (store?.me.map { c.activeUserIds.contains($0.id) } ?? false) { dismissRing() }
    }

    // MARK: Llamada entrante

    func showIncoming(_ call: CallDTO, callerName: String, title: String?) {
        guard view?.call.id != call.id, call.endedAt == nil else { return }
        ringing = IncomingCall(call: call, callerName: callerName, title: title)
        ringTask?.cancel()
        ringTask = Task { @MainActor [weak self] in
            // Suena y vibra hasta 45 s o hasta que se conteste, se rechace o termine.
            let until = Date().addingTimeInterval(TimeInterval(CallRules.ringSeconds))
            while !Task.isCancelled, Date() < until {
                RingTone.play(self?.store?.me?.ringtone)
                try? await Task.sleep(nanoseconds: UInt64(ChatSounds.ringEvery * 1_000_000_000))
            }
            if !Task.isCancelled, self?.ringing?.call.id == call.id { self?.ringing = nil }
        }
    }

    /// «Ahora no»: deja de sonar en todos mis dispositivos (POST /calls/:id/decline → call.declined).
    func decline() {
        guard let r = ringing else { return }
        dismissRing()
        if let store { Task { try? await store.declineCallRequest(r.call.id) } }
    }

    /// Otro dispositivo mío contestó o rechazó (call.answered / call.declined): deja de sonar y quita el aviso.
    func stopRinging(callId: String) {
        if ringing?.call.id == callId { dismissRing() }
        CallPushCleanup.remove(callId: callId)
    }

    /// «Pasar aquí» desde la franja de llamada en otro dispositivo.
    func handOff(_ call: CallDTO, from deviceKey: String?) {
        handOffFrom = deviceKey
        Task { do { try await join(call.id, camera: false) } catch { store?.show(L10n.errorText(error)) } }
    }

    func dismissRing() {
        ringTask?.cancel(); ringTask = nil
        RingTone.stop(store?.me?.ringtone)
        ringing = nil
    }

    func answer(camera: Bool) {
        guard let r = ringing else { return }
        dismissRing()
        Task {
            do { try await join(r.call.id, camera: camera) } catch { store?.show(L10n.errorText(error)) }
        }
    }

    // MARK: Transcripción

    private func queue(_ finals: [CallSegmentInput]) {
        guard !finals.isEmpty else { return }
        outbox.append(contentsOf: finals)
        scheduleFlush(CallRules.flushSeconds)
    }

    private func scheduleFlush(_ seconds: Double) {
        guard flushTask == nil else { return }
        flushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.flushTask = nil
            await self.flush()
        }
    }

    /// Manda las frases finales pendientes (lotes de hasta 50). Sin red se reintenta; fuera de la llamada se descartan.
    func flush() async {
        flushTask?.cancel(); flushTask = nil
        guard let id = view?.call.id, let store, !outbox.isEmpty else { return }
        let batch = Array(outbox.prefix(CallRules.maxBatch))
        outbox.removeFirst(batch.count)
        do {
            try await store.sendCallTranscriptRequest(id, batch)
            sentBatches += 1
        } catch {
            if !CallRules.dropBatch(error) { outbox.insert(contentsOf: batch, at: 0); scheduleFlush(5); return }
        }
        if !outbox.isEmpty { scheduleFlush(0.5) }
    }

    // MARK: CallMediaDelegate

    func mediaDidStart() {
        guard view?.phase == .connecting else { return }
        view?.phase = .live
        // Auricular por defecto en voz, altavoz en video (si hay Bluetooth o audífonos, se quedan esos).
        refreshAudio()
        if let v = view, let target = CallRules.defaultOutput(v.audioDevices, video: v.camera || v.call.isVideo) { chooseAudio(target) }
        // «Pasar aquí»: ya conectado, se saca a mi otro dispositivo.
        if let key = handOffFrom, let id = view?.call.id, let store {
            handOffFrom = nil
            Task { _ = try? await store.leaveCallRequest(id, deviceKey: key) }
        }
    }

    /// Lee las salidas de audio disponibles y la activa.
    func refreshAudio() {
        guard let media else { return }
        view?.audioDevices = media.audioDevices()
        view?.audioOut = media.activeAudioDevice()
    }

    func chooseAudio(_ id: String) {
        media?.chooseAudioDevice(id)
        view?.audioOut = id
        refreshAudio()
        if view?.audioOut == nil { view?.audioOut = id }
    }

    /// 🔊: con solo auricular y altavoz, alterna; con más salidas la vista muestra la lista.
    func toggleSpeaker() {
        guard let v = view else { return }
        let onSpeaker = v.audioDevices.first { $0.id == v.audioOut }?.kind == .speaker
        let target = v.audioDevices.first { $0.kind == (onSpeaker ? .receiver : .speaker) }
        if let target { chooseAudio(target.id) }
    }
    func mediaDidStop(error: String?) {
        guard !leaving, let v = view else { return }
        if let error { view?.error = error }
        let id = v.call.id
        Task { await teardown(keepError: error != nil); _ = try? await store?.leaveCallRequest(id) }
    }
    func mediaMuteChanged(_ muted: Bool) { view?.muted = muted }
    func mediaTileAdded(_ tile: CallTile) {
        guard var v = view else { return }
        v.tiles.removeAll { $0.tileId == tile.tileId }
        v.tiles.append(tile)
        view = v
    }
    func mediaTileRemoved(_ tileId: Int) { view?.tiles.removeAll { $0.tileId == tileId } }
    func mediaSpeaking(_ userIds: [String]) { if view?.speaking != userIds { view?.speaking = userIds } }
    func mediaRemoteMute(_ userIds: [String], muted: Bool) {
        guard var v = view else { return }
        if muted { v.mutedUsers.formUnion(userIds) } else { v.mutedUsers.subtract(userIds) }
        view = v
    }
    func mediaTranscript(_ pieces: [TranscriptPiece]) {
        guard let v = view else { return }
        let r = CallRules.applyTranscript(v.captions, pieces)
        view?.captions = r.captions
        queue(r.finals)
    }

    // MARK: Audio del sistema

    enum CallMediaError: Error {
        case microphone
        var text: String { L("call.micDenied") }
    }

    static func microphoneAllowed() async -> Bool {
        await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    /// playAndRecord / voiceChat: cancelación de eco y la llamada sigue en segundo plano (UIBackgroundModes audio).
    static func activateAudioSession(video: Bool) throws {
        let s = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
        if video { options.insert(.defaultToSpeaker) }
        try s.setCategory(.playAndRecord, mode: video ? .videoChat : .voiceChat, options: options)
        try s.setActive(true)
    }

    static func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        // De vuelta al modo de los sonidos de la app (no interrumpen otra música y respetan el modo silencio).
        try? AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
    }
}

/// Tono de llamada elegido (docs/SONIDOS.md), un ciclo cada 2,2 s, con vibración. No depende de «Sonido de mensajes».
@MainActor
enum RingTone {
    static func play(_ ringtone: String?) {
        guard !AppConfig.isRunningUnitTests else { return }
        ChoiceSoundPlayer.shared.play(ChatSounds.ringFile(ringtone), force: true)
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }
    static func stop(_ ringtone: String?) { ChoiceSoundPlayer.shared.stop(ChatSounds.ringFile(ringtone)) }
}

// MARK: - Red

extension AppStore {
    /// Estado local de la llamada activa de una conversación (null en el API = no hay).
    /// `keepDevices`: el call.updated de la conversación no trae myDevices: se conserva el último conocido.
    func putCall(_ call: CallDTO, keepDevices: Bool = false) {
        let cid = call.conversationId
        var call = call
        if keepDevices, call.myDevices.isEmpty, let prev = liveCalls[cid], prev.id == call.id { call.myDevices = prev.myDevices }
        let next = CallRules.merge(liveCalls[cid], call)
        // Sin cambios no sube la revisión (la pestaña Llamadas recarga con ella: evita recargar sin fin).
        if next == liveCalls[cid], callsChecked.contains(cid) { callCenter.callChanged(call); return }
        liveCalls[cid] = next
        callsChecked.insert(cid)
        callsRevision += 1
        callCenter.callChanged(call)
    }

    func loadCall(_ conversationId: String) async {
        guard data?.callsEnabled == true else { return }
        let stamp = sessionStamp
        guard let r: CallResult = try? await api.request("/conversations/\(conversationId)/call"), (try? requireSession(stamp)) != nil else { return }
        callsChecked.insert(conversationId)
        if let c = r.call { putCall(c) } else if liveCalls[conversationId] != nil { liveCalls[conversationId] = nil; callsRevision += 1 }
    }

    func startCallRequest(_ conversationId: String, kind: String) async throws -> CallJoinDTO {
        let j: CallJoinDTO = try await api.request("/conversations/\(conversationId)/call", method: "POST", json: ["kind": kind, "deviceKey": CallRules.deviceKey])
        putCall(j.call)
        return j
    }

    func joinCallRequest(_ callId: String) async throws -> CallJoinDTO {
        let j: CallJoinDTO = try await api.request("/calls/\(callId)/join", method: "POST", json: ["deviceKey": CallRules.deviceKey])
        putCall(j.call)
        return j
    }

    func callHeartbeatRequest(_ callId: String) async throws {
        try await api.requestData("/calls/\(callId)/heartbeat", method: "POST", json: ["deviceKey": CallRules.deviceKey])
    }

    /// «Ahora no»: deja de sonar en todos mis dispositivos (los demás no se enteran).
    func declineCallRequest(_ callId: String) async throws {
        try await api.requestData("/calls/\(callId)/decline", method: "POST", json: [:])
    }

    /// Llamadas sin terminar de mis conversaciones (y a las que me invitaron): «En curso ahora».
    func activeCalls() async throws -> [ActiveCallDTO] {
        let r: ActiveCallsPage = try await api.request("/calls/active")
        for c in r.calls { putCall(c.call) }
        return r.calls
    }

    /// `deviceKey`: saca solo a ese dispositivo mío («Pasar aquí»).
    @discardableResult
    func leaveCallRequest(_ callId: String, forAll: Bool = false, deviceKey: String? = nil) async throws -> CallDTO? {
        let body: [String: Any] = ["deviceKey": deviceKey ?? CallRules.deviceKey]
        let r: CallResult = try await api.request("/calls/\(callId)/\(forAll ? "end" : "leave")", method: "POST", json: body)
        if let c = r.call { putCall(c) }
        return r.call
    }

    func setCallTranscriptionRequest(_ callId: String, on: Bool, aiSummary: Bool) async throws -> CallDTO? {
        let r: CallResult = try await api.request("/calls/\(callId)/transcription", method: "POST", json: ["on": on, "aiSummary": aiSummary])
        if let c = r.call { putCall(c) }
        return r.call
    }

    func sendCallTranscriptRequest(_ callId: String, _ segments: [CallSegmentInput]) async throws {
        try await api.requestData("/calls/\(callId)/transcript", method: "POST", json: ["segments": segments.map(\.json)])
    }

    func callTranscript(_ callId: String) async throws -> CallTranscriptDTO {
        try await api.request("/calls/\(callId)/transcript")
    }

    func callHistory(before: String? = nil) async throws -> CallHistoryPage {
        var path = "/calls?limit=30"
        if let before, let q = before.addingPercentEncoding(withAllowedCharacters: .alphanumerics) { path += "&before=\(q)" }
        return try await api.request(path)
    }

    /// Enviar el resumen o la transcripción a otro chat (sale como mensaje mío).
    func shareCall(_ callId: String, to conversationId: String, what: CallShareWhat) async throws {
        try await api.requestData("/calls/\(callId)/share", method: "POST", json: ["conversationId": conversationId, "what": what.rawValue])
    }
}

import AmazonChimeSDK
import Foundation
import UIKit

/// Sesión real con el SDK de Amazon Chime (AmazonChimeSDK + AmazonChimeSDKMedia, por SPM).
/// La respuesta de POST /conversations/:id/call se pasa tal cual a MeetingSessionConfiguration.
@MainActor
final class ChimeCallMedia: NSObject, CallMedia {
    weak var delegate: CallMediaDelegate?
    private let session: DefaultMeetingSession
    private var attendeeUsers: [String: String] = [:]
    private var localAttendee: String

    init(join j: CallJoinDTO) {
        let p = j.meeting.mediaPlacement
        let placement = MediaPlacement(audioFallbackUrl: p.audioFallbackUrl, audioHostUrl: p.audioHostUrl,
                                       signalingUrl: p.signalingUrl, turnControlUrl: p.turnControlUrl, eventIngestionUrl: p.eventIngestionUrl)
        let meeting = Meeting(externalMeetingId: j.meeting.externalMeetingId, mediaPlacement: placement,
                              mediaRegion: j.meeting.mediaRegion, meetingId: j.meeting.meetingId)
        let attendee = Attendee(attendeeId: j.attendee.attendeeId, externalUserId: j.attendee.externalUserId, joinToken: j.attendee.joinToken)
        let config = MeetingSessionConfiguration(createMeetingResponse: CreateMeetingResponse(meeting: meeting),
                                                 createAttendeeResponse: CreateAttendeeResponse(attendee: attendee))
        session = DefaultMeetingSession(configuration: config, logger: ConsoleLogger(name: "chime", level: .ERROR))
        localAttendee = j.attendee.attendeeId
        attendeeUsers[j.attendee.attendeeId] = CallRules.personId(j.attendee.externalUserId)
        super.init()
    }

    private var av: AudioVideoFacade { session.audioVideo }

    func start() throws {
        av.addAudioVideoObserver(observer: self)
        av.addRealtimeObserver(observer: self)
        av.addVideoTileObserver(observer: self)
        av.addActiveSpeakerObserver(policy: DefaultActiveSpeakerPolicy(), observer: self)
        // La transcripción va por Groq (pedazos del micrófono, CallRecorder.swift): no se usa el TranscriptEvent de Chime.
        try av.start(audioVideoConfiguration: AudioVideoConfiguration(audioMode: .mono48K, callKitEnabled: false))
        av.startRemoteVideo()
    }

    func stop() {
        av.stopLocalVideo()
        av.stopRemoteVideo()
        av.stop()
    }

    func setMuted(_ muted: Bool) {
        let ok = muted ? av.realtimeLocalMute() : av.realtimeLocalUnmute()
        if ok { delegate?.mediaMuteChanged(muted) }
    }

    func startCamera() throws { try av.startLocalVideo() }

    // Salida de audio (1.7.1): auricular, altavoz, Bluetooth o audífonos, con la lista de Chime.
    func audioDevices() -> [CallAudioDevice] {
        av.listAudioDevices().map { CallAudioDevice(id: $0.label + "|\($0.type.rawValue)", label: $0.label, kind: CallAudioDevice.Kind($0.type)) }
    }
    func activeAudioDevice() -> String? { av.getActiveAudioDevice().map { $0.label + "|\($0.type.rawValue)" } }
    func chooseAudioDevice(_ id: String) {
        guard let d = av.listAudioDevices().first(where: { $0.label + "|\($0.type.rawValue)" == id }) else { return }
        av.chooseAudioDevice(mediaDevice: d)
    }
    func stopCamera() { av.stopLocalVideo() }
    func switchCamera() { av.switchCamera() }

    func bind(_ view: UIView, tileId: Int) {
        guard let v = view as? DefaultVideoRenderView else { return }
        av.bindVideoView(videoView: v, tileId: tileId)
    }
    func unbind(tileId: Int) { av.unbindVideoView(tileId: tileId) }
    func makeVideoView(fit: Bool) -> UIView {
        let v = DefaultVideoRenderView()
        // Pantallas compartidas completas (sin recortar); cámaras llenando el recuadro.
        v.contentMode = fit ? .scaleAspectFit : .scaleAspectFill
        v.clipsToBounds = true
        return v
    }

    /// Los observadores del SDK pueden llegar fuera del hilo principal.
    nonisolated private func main(_ f: @escaping @MainActor () -> Void) {
        if Thread.isMainThread { MainActor.assumeIsolated(f) } else { DispatchQueue.main.async { MainActor.assumeIsolated(f) } }
    }
}

extension ChimeCallMedia: AudioVideoObserver {
    nonisolated func audioSessionDidStartConnecting(reconnecting: Bool) {}
    nonisolated func audioSessionDidStart(reconnecting: Bool) { main { self.delegate?.mediaDidStart() } }
    nonisolated func audioSessionDidDrop() {}
    nonisolated func audioSessionDidStopWithStatus(sessionStatus: MeetingSessionStatus) {
        let code = sessionStatus.statusCode
        main { self.delegate?.mediaDidStop(error: code == .ok || code == .audioCallEnded ? nil : "\(code)") }
    }
    nonisolated func audioSessionDidCancelReconnect() {}
    nonisolated func connectionDidRecover() {}
    nonisolated func connectionDidBecomePoor() {}
    nonisolated func videoSessionDidStartConnecting() {}
    nonisolated func videoSessionDidStartWithStatus(sessionStatus: MeetingSessionStatus) {}
    nonisolated func videoSessionDidStopWithStatus(sessionStatus: MeetingSessionStatus) {}
    nonisolated func remoteVideoSourcesDidBecomeAvailable(sources: [RemoteVideoSource]) {}
    nonisolated func remoteVideoSourcesDidBecomeUnavailable(sources: [RemoteVideoSource]) {}
    nonisolated func cameraSendAvailabilityDidChange(available: Bool) {}
}

extension ChimeCallMedia: RealtimeObserver {
    nonisolated func volumeDidChange(volumeUpdates: [VolumeUpdate]) {}
    nonisolated func signalStrengthDidChange(signalUpdates: [SignalUpdate]) {}
    nonisolated func attendeesDidJoin(attendeeInfo: [AttendeeInfo]) {
        // 1.7.1: un attendee por dispositivo («{userId}#{deviceKey}»): la persona es lo de antes del «#».
        let pairs = attendeeInfo.map { ($0.attendeeId, CallRules.personId($0.externalUserId)) }
        main { for (a, u) in pairs { self.attendeeUsers[a] = u } }
    }
    nonisolated func attendeesDidLeave(attendeeInfo: [AttendeeInfo]) {}
    nonisolated func attendeesDidDrop(attendeeInfo: [AttendeeInfo]) {}
    nonisolated func attendeesDidMute(attendeeInfo: [AttendeeInfo]) {
        let ids = attendeeInfo.map { CallRules.personId($0.externalUserId) }
        main { self.delegate?.mediaRemoteMute(ids, muted: true) }
    }
    nonisolated func attendeesDidUnmute(attendeeInfo: [AttendeeInfo]) {
        let ids = attendeeInfo.map { CallRules.personId($0.externalUserId) }
        main { self.delegate?.mediaRemoteMute(ids, muted: false) }
    }
}

extension ChimeCallMedia: VideoTileObserver {
    /// Persona del recuadro. Una pantalla compartida es el attendee «{attendeeId}#content» (externalUserId «{ext}#content»).
    private func tileUser(_ attendee: String) -> String? {
        attendeeUsers[attendee] ?? attendeeUsers[CallRules.baseAttendee(attendee)]
    }
    /// Se copian los datos del estado (el observador llega fuera del hilo principal).
    nonisolated private func report(_ t: VideoTileState, active: Bool) {
        let id = t.tileId, local = t.isLocalTile, attendee = t.attendeeId, content = t.isContent
        main { self.delegate?.mediaTileAdded(CallTile(tileId: id, local: local, userId: self.tileUser(attendee), active: active, content: content)) }
    }
    nonisolated func videoTileDidAdd(tileState: VideoTileState) {
        // Solo pantallas de otros (iOS no comparte la suya).
        if tileState.isContent && tileState.isLocalTile { return }
        let active = tileState.pauseState == .unpaused
        report(tileState, active: active)
    }
    nonisolated func videoTileDidRemove(tileState: VideoTileState) {
        let id = tileState.tileId
        main { self.av.unbindVideoView(tileId: id); self.delegate?.mediaTileRemoved(id) }
    }
    nonisolated func videoTileDidPause(tileState: VideoTileState) {
        if tileState.isContent && tileState.isLocalTile { return }
        report(tileState, active: false)
    }
    nonisolated func videoTileDidResume(tileState: VideoTileState) {
        if tileState.isContent && tileState.isLocalTile { return }
        report(tileState, active: true)
    }
    nonisolated func videoTileSizeDidChange(tileState: VideoTileState) {}
}

extension ChimeCallMedia: ActiveSpeakerObserver {
    nonisolated var observerId: String { "chaggu.call.speaker" }
    nonisolated func activeSpeakerDidDetect(attendeeInfo: [AttendeeInfo]) {
        var seen = Set<String>()
        let ids = attendeeInfo.map { CallRules.personId($0.externalUserId) }.filter { seen.insert($0).inserted }
        main { self.delegate?.mediaSpeaking(ids) }
    }
}

extension ChimeCallMedia: TranscriptEventObserver {
    nonisolated func transcriptEventDidReceive(transcriptEvent: TranscriptEvent) {
        guard let t = transcriptEvent as? Transcript else { return }
        let pieces: [TranscriptPiece] = t.results.compactMap { r in
            guard let alt = r.alternatives.first else { return nil }
            let who = alt.items.first?.attendee
            return TranscriptPiece(resultId: r.resultId, isPartial: r.isPartial, text: alt.transcript,
                                   attendeeId: who?.attendeeId, externalUserId: who.map { CallRules.personId($0.externalUserId) }, language: r.languageCode,
                                   startMs: Int(r.startTimeMs), endMs: Int(r.endTimeMs))
        }
        guard !pieces.isEmpty else { return }
        main { self.delegate?.mediaTranscript(pieces) }
    }
}


extension MediaDeviceType: MediaKindRaw {
    var kind: CallAudioDevice.Kind {
        switch self {
        case .audioHandset: return .receiver
        case .audioBuiltInSpeaker: return .speaker
        case .audioBluetooth: return .bluetooth
        case .audioWiredHeadset: return .wired
        default: return .other
        }
    }
}

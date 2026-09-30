import XCTest
@testable import TieComs

private func dec<T: Decodable>(_ t: T.Type, _ s: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(s.utf8)) }

private let callJSON = #"{"id":"call1","conversationId":"c1","kind":"video","startedBy":"b","startedAt":"2026-09-29T10:00:00.000Z","endedAt":null,"activeUserIds":["b"],"transcribing":false,"hasTranscript":false}"#
private let joinJSON = #"""
{"call":\#(callJSON),
 "meeting":{"Meeting":{"MeetingId":"fake-call1","ExternalMeetingId":"call1","MediaRegion":"us-east-1",
   "MediaPlacement":{"AudioHostUrl":"fake.invalid:3478","SignalingUrl":"wss://fake.invalid/control","TurnControlUrl":"https://fake.invalid/turn"}}},
 "attendee":{"Attendee":{"AttendeeId":"att-1","ExternalUserId":"a","JoinToken":"tok-1"}}}
"""#

private func msg(_ seq: Int, topic: String? = nil, author: String = "b", kind: String = "text", deleted: Bool = false) -> MessageDTO {
    var m = MessageDTO(id: "m\(seq)", conversationId: "c1", seq: seq, authorId: author, clientMessageId: nil, kind: kind, body: "x", createdAt: "")
    m.topicId = topic
    if deleted { m.deletedAt = "2026-09-29T00:00:00Z" }
    return m
}

/// Llamadas (docs/LLAMADAS.md) y la regla nueva de «Todo» en temas (docs/TEMAS.md).
@MainActor
final class CallsTests: XCTestCase {
    // MARK: Decodificación

    func testDecodesCallDTOsAndBootstrapFeature() throws {
        let c = try dec(CallDTO.self, callJSON)
        XCTAssertEqual(c.id, "call1"); XCTAssertTrue(c.isVideo); XCTAssertTrue(c.isLive); XCTAssertEqual(c.activeUserIds, ["b"])
        let partial = try dec(CallDTO.self, #"{"id":"x","activeUserIds":null,"transcribing":"yes"}"#)
        XCTAssertEqual(partial.kind, "audio"); XCTAssertEqual(partial.activeUserIds, []); XCTAssertFalse(partial.transcribing)

        let j = try dec(CallJoinDTO.self, joinJSON)
        XCTAssertEqual(j.meeting.meetingId, "fake-call1")
        XCTAssertEqual(j.meeting.mediaPlacement.signalingUrl, "wss://fake.invalid/control")
        XCTAssertEqual(j.meeting.mediaPlacement.audioFallbackUrl, "", "falta en el falso: queda vacío")
        XCTAssertEqual(j.attendee.joinToken, "tok-1")
        XCTAssertTrue(j.isFake)

        let page = try dec(CallHistoryPage.self, #"{"calls":[{"call":\#(callJSON),"participantIds":["b","a"],"durationSec":83,"hasSummary":true},{"broken":1}],"hasMore":true}"#)
        XCTAssertEqual(page.calls.count, 1, "una fila defectuosa se descarta"); XCTAssertEqual(page.calls[0].durationSec, 83); XCTAssertTrue(page.hasMore)

        let t = try dec(CallTranscriptDTO.self, #"{"call":\#(callJSON),"summary":null,"segments":[{"resultId":"r1","speakerUserId":"b","speakerName":"Bruno","language":"es-US","text":"Hola","startMs":1500,"endMs":2000}]}"#)
        XCTAssertNil(t.summary); XCTAssertEqual(t.segments.first?.speakerName, "Bruno")

        let on = try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"},"features":{"calls":true}}"#)
        XCTAssertTrue(on.callsEnabled)
        let old = try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"A"}}"#)
        XCTAssertFalse(old.callsEnabled, "servidor sin features: sin llamadas")
    }

    func testDecodesCallEvents() throws {
        let e = try dec(ConversationEvent.self, #"{"type":"call.updated","conversationId":"c1","eventSeq":12,"call":\#(callJSON)}"#)
        guard case .callUpdated(let cid, let seq, let call) = e else { return XCTFail("\(e)") }
        XCTAssertEqual(cid, "c1"); XCTAssertEqual(seq, 12); XCTAssertEqual(call.id, "call1")
        XCTAssertEqual(e.eventSeq, 12); XCTAssertEqual(e.conversationId, "c1")
        let broken = try dec(ConversationEvent.self, #"{"type":"call.updated","conversationId":"c1","eventSeq":13}"#)
        XCTAssertEqual(broken, .other(type: "call.updated", conversationId: "c1", eventSeq: 13), "sin llamada solo avanza el cursor")

        let r = try dec(AccountEvent.self, #"{"type":"call.ringing","call":\#(callJSON),"conversationTitle":"Obra","callerName":"Bruno Ortega"}"#)
        guard case .callRinging(let rc, let title, let caller) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(rc.id, "call1"); XCTAssertEqual(title, "Obra"); XCTAssertEqual(caller, "Bruno Ortega")
    }

    // MARK: Textos de sistema

    func testCallSystemTextsEsEn() {
        let saved = L10n.choice
        defer { L10n.choice = saved }
        let bodies = [#"{"k":"call.started","kind":"audio","callId":"c"}"#, #"{"k":"call.ended","callId":"c","durationSec":83}"#,
                      #"{"k":"call.transcription.on","name":"Ana","callId":"c"}"#, #"{"k":"call.transcription.off","name":"Ana","callId":"c"}"#,
                      #"{"k":"call.transcript","callId":"c"}"#]
        L10n.choice = .es
        XCTAssertEqual(bodies.map(L10n.systemText), ["Empezó una llamada.", "Terminó la llamada · 1:23.", "Ana prendió la transcripción de la llamada.",
                                                      "Ana apagó la transcripción de la llamada.", "Quedó guardada la transcripción de la llamada."])
        L10n.choice = .en
        XCTAssertEqual(bodies.map(L10n.systemText), ["A call started.", "The call ended · 1:23.", "Ana turned on call transcription.",
                                                      "Ana turned off call transcription.", "The call transcript was saved."])
        L10n.choice = .es
        // Vista previa de la lista: el API la corta a 140 caracteres (JSON incompleto), con números completos.
        XCTAssertEqual(L10n.systemText(#"{"k":"call.ended","callId":"8b8c0d7e-6d9a-4a57-9f59-3a5b0e2f1c11","durationSec":605,"#), "Terminó la llamada · 10:05.")
        XCTAssertEqual(L10n.systemText(#"{"k":"call.transcript","callId":"8b8c0d7e-6d9a"#), "Quedó guardada la transcripción de la llamada.")
        XCTAssertFalse(L10n.systemText(#"{"k":"call.started","kind":"video"}"#).hasPrefix("{"))
    }

    // MARK: Reglas

    func testTranscriptCaptionsAndFinals() {
        let p1 = TranscriptPiece(resultId: "r1", isPartial: true, text: "Hol", attendeeId: "att", externalUserId: "b", language: nil, startMs: 10, endMs: 20)
        var r = CallRules.applyTranscript([], [p1])
        XCTAssertEqual(r.captions.map(\.text), ["Hol"]); XCTAssertTrue(r.finals.isEmpty, "una parcial no se manda")
        var p2 = p1; p2.isPartial = false; p2.text = "  Hola a todos "
        r = CallRules.applyTranscript(r.captions, [p2])
        XCTAssertEqual(r.captions.count, 1, "la final reemplaza la parcial del mismo resultId")
        XCTAssertEqual(r.captions[0].text, "Hola a todos"); XCTAssertFalse(r.captions[0].partial)
        XCTAssertEqual(r.finals, [CallSegmentInput(resultId: "r1", attendeeId: "att", externalUserId: "b", language: nil, text: "Hola a todos", startMs: 10, endMs: 20)])
        let many = (0..<9).map { TranscriptPiece(resultId: "x\($0)", isPartial: false, text: "t\($0)", attendeeId: nil, externalUserId: nil, language: "es-US", startMs: -5, endMs: 0) }
        r = CallRules.applyTranscript(r.captions, many)
        XCTAssertEqual(r.captions.count, CallRules.maxCaptions); XCTAssertEqual(r.captions.last?.text, "t8")
        XCTAssertEqual(r.finals.count, 9); XCTAssertEqual(r.finals[0].startMs, 0, "nunca negativo")
        XCTAssertTrue(CallRules.applyTranscript([], [TranscriptPiece(resultId: "e", isPartial: false, text: "  ", attendeeId: nil, externalUserId: nil, language: nil, startMs: 0, endMs: 0)]).finals.isEmpty)
        let json = r.finals[0].json
        XCTAssertTrue(json["attendeeId"] is NSNull); XCTAssertEqual(json["language"] as? String, "es-US")
    }

    func testShareOptionsTextMissedAndMerge() throws {
        let call = try dec(CallDTO.self, callJSON)
        let seg = [CallTranscriptSegmentDTO(resultId: "r1", speakerUserId: "b", speakerName: "Bruno", text: "Hola", startMs: 65_000)]
        let both = CallTranscriptDTO(call: call, summary: "Acordamos X", segments: seg)
        XCTAssertEqual(CallRules.shareOptions(both), [.summary, .transcript, .both])
        XCTAssertEqual(CallRules.shareOptions(CallTranscriptDTO(call: call, summary: nil, segments: seg)), [.transcript])
        XCTAssertEqual(CallRules.shareOptions(CallTranscriptDTO(call: call, summary: "", segments: [])), [])
        let saved = L10n.choice; defer { L10n.choice = saved }
        L10n.choice = .es
        XCTAssertEqual(CallRules.shareText(both, .transcript) { $0.speakerName ?? "?" }, "Transcripción de la llamada:\n[1:05] Bruno: Hola")
        XCTAssertEqual(CallRules.shareText(both, .both) { $0.speakerName ?? "?" }, "Resumen:\nAcordamos X\n\nTranscripción de la llamada:\n[1:05] Bruno: Hola")

        var ended = call; ended.endedAt = "2026-09-29T10:05:00Z"
        XCTAssertTrue(CallRules.isMissed(CallHistoryItemDTO(call: ended, participantIds: ["b"], durationSec: 300, hasSummary: false)))
        XCTAssertFalse(CallRules.isMissed(CallHistoryItemDTO(call: ended, participantIds: ["b", "a"], durationSec: 300, hasSummary: false)))
        XCTAssertFalse(CallRules.isMissed(CallHistoryItemDTO(call: call, participantIds: ["b"], durationSec: nil, hasSummary: false)), "en curso no es sin respuesta")
        XCTAssertTrue(CallRules.isGroup(CallHistoryItemDTO(call: call, participantIds: ["a", "b", "c"], durationSec: nil, hasSummary: false), conv: nil, me: "a"))
        XCTAssertEqual(CallRules.clock(83), "1:23")

        XCTAssertEqual(CallRules.merge(nil, call), call)
        XCTAssertNil(CallRules.merge(call, ended), "la misma llamada terminó")
        var newer = call; newer.id = "call2"
        XCTAssertEqual(CallRules.merge(newer, ended), newer, "una terminada no pisa a otra más nueva en curso")
        XCTAssertTrue(CallRules.dropBatch(ApiRequestError(status: 409, code: "not_in_call", message: "")))
        XCTAssertFalse(CallRules.dropBatch(ApiRequestError.network(URLError(.notConnectedToInternet))), "sin red se reintenta")
        XCTAssertFalse(CallRules.dropBatch(ApiRequestError(status: 500, code: "internal", message: "")))
    }

    // MARK: Flujo con el API (URLProtocol) y medios falsos

    func testStartTranscribeFlushAndHangUp() async throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"features":{"calls":true},"conversations":[{"id":"c1","kind":"direct","memberIds":["a","b"],"canPost":true}]}"#))
        var paths: [String] = []
        var bodies: [String: [String: Any]] = [:]
        ControlledURLProtocol.handler = { req in Task { @MainActor in
            let p = req.request.url!.path
            paths.append(p); bodies[p] = req.json
            switch p {
            case "/api/v1/conversations/c1/call": req.respond(joinJSON)
            case "/api/v1/calls/call1/transcription":
                req.respond(#"{"call":\#(callJSON.replacingOccurrences(of: #""transcribing":false"#, with: #""transcribing":true"#))}"#)
            case "/api/v1/calls/call1/transcript": req.respond(#"{"saved":1}"#)
            case "/api/v1/calls/call1/leave": req.respond(#"{"call":\#(callJSON.replacingOccurrences(of: #""endedAt":null"#, with: #""endedAt":"2026-09-29T10:05:00Z""#))}"#)
            default: req.respond(404, #"{"error":{"code":"not_found","message":"x"}}"#)
            }
        } }
        let center = s.callCenter
        center.fakeCaptions = false
        try await center.start("c1", kind: "audio")
        XCTAssertTrue(center.media is NullCallMedia, "el proveedor falso no abre el SDK")
        XCTAssertEqual(bodies["/api/v1/conversations/c1/call"]?["kind"] as? String, "audio")
        XCTAssertEqual(s.liveCalls["c1"]?.id, "call1")
        try await waitUntil(2, "en vivo") { center.view?.phase == .live }
        XCTAssertTrue(center.expanded)

        try await center.setTranscription(true, aiSummary: true)
        XCTAssertEqual(bodies["/api/v1/calls/call1/transcription"]?["aiSummary"] as? Bool, true)
        XCTAssertEqual(center.view?.call.transcribing, true)
        center.mediaTranscript([TranscriptPiece(resultId: "r1", isPartial: false, text: "Hola", attendeeId: "att-1", externalUserId: "a", language: "es-US", startMs: 1, endMs: 2)])
        XCTAssertEqual(center.outbox.count, 1)
        await center.flush()
        let segs = bodies["/api/v1/calls/call1/transcript"]?["segments"] as? [[String: Any]]
        XCTAssertEqual(segs?.first?["text"] as? String, "Hola"); XCTAssertEqual(segs?.first?["resultId"] as? String, "r1")
        XCTAssertEqual(center.sentBatches, 1); XCTAssertTrue(center.outbox.isEmpty)

        await center.hangUp()
        XCTAssertNil(center.view)
        XCTAssertTrue(paths.contains("/api/v1/calls/call1/leave"))
        XCTAssertNil(s.liveCalls["c1"], "la llamada terminó")
    }

    func testRingingAnsweredEndedAndDnd() throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"features":{"calls":true},"conversations":[{"id":"c1","kind":"direct","memberIds":["a","b"],"canPost":true}]}"#))
        s.socketEventForTesting("account.event", #"{"type":"call.ringing","call":\#(callJSON),"conversationTitle":null,"callerName":"Bruno"}"#)
        XCTAssertEqual(s.callCenter.ringing?.callerName, "Bruno")
        XCTAssertEqual(s.liveCalls["c1"]?.id, "call1")
        // Terminó: el aviso se va.
        s.socketEventForTesting("conv.event", #"{"type":"call.updated","conversationId":"c1","eventSeq":1,"call":\#(callJSON.replacingOccurrences(of: #""endedAt":null"#, with: #""endedAt":"2026-09-29T10:01:00Z""#))}"#)
        XCTAssertNil(s.callCenter.ringing)
        XCTAssertNil(s.liveCalls["c1"])
        // Sin features.calls no suena.
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"conversations":[]}"#))
        s.socketEventForTesting("account.event", #"{"type":"call.ringing","call":\#(callJSON),"callerName":"Bruno"}"#)
        XCTAssertNil(s.callCenter.ringing)
    }

    // MARK: Temas: «Todo», contadores y auto-selección

    func testGeneralShowsOnlyUntopicedAllShowsEverything() {
        let active: Set<String> = ["fin"]
        // «General» (sin filtro): solo lo sin tema, leído o no.
        XCTAssertTrue(TopicRules.hiddenInGeneral(msg(3, topic: "fin"), filter: nil, showAll: false, active: active, revealed: []), "con tema: solo en su banderita")
        XCTAssertTrue(TopicRules.hiddenInGeneral(msg(6, topic: "fin"), filter: nil, showAll: false, active: active, revealed: []), "aunque no esté leído")
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(3), filter: nil, showAll: false, active: active, revealed: []), "sin tema: siempre")
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(3, topic: "old"), filter: nil, showAll: false, active: active, revealed: []), "tema archivado cuenta como sin tema")
        XCTAssertTrue(TopicRules.hiddenInGeneral(msg(4, kind: "system"), filter: nil, showAll: false, active: active, revealed: [], issueTopic: "fin"), "tarjeta de una tarea del tema")
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(4, kind: "system"), filter: nil, showAll: false, active: active, revealed: [], issueTopic: nil), "tarjeta de tarea sin tema")
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(3, topic: "fin"), filter: nil, showAll: false, active: active, revealed: [3]), "mensaje al que se saltó")
        // «Todo» y un tema: nada se esconde aquí.
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(3, topic: "fin"), filter: nil, showAll: true, active: active, revealed: []), "Todo: todo")
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(3, topic: "fin"), filter: "fin", showAll: false, active: active, revealed: []), "con filtro no aplica")
        XCTAssertFalse(TopicRules.hiddenInGeneral(msg(3, topic: "fin"), filter: nil, showAll: false, active: [], revealed: []), "sin temas activos, todo")
        // Saltar a un mensaje (1.7.5): su tema; sin tema (o archivado), «Todo»; sin temas activos, sin filtro.
        XCTAssertEqual(TopicRules.filterForJump(msg(3, topic: "fin"), active: active), "fin")
        XCTAssertEqual(TopicRules.filterForJump(msg(3), active: active), TopicRules.all, "sin tema: a Todo")
        XCTAssertEqual(TopicRules.filterForJump(msg(3, topic: "old"), active: active), TopicRules.all, "tema archivado: a Todo")
        XCTAssertNil(TopicRules.filterForJump(msg(3), active: []), "sin temas activos")
        XCTAssertEqual(TopicRules.filterForJump(msg(3, topic: "fin"), active: active, current: TopicRules.all), TopicRules.all, "en Todo no cambia")
        XCTAssertEqual(TopicRules.filterForJump(msg(3), active: active, current: nil), TopicRules.all, "desde General, sin tema: Todo")
        XCTAssertNil(TopicRules.effectiveFilter(TopicRules.all, in: [TopicDTO(id: "fin", conversationId: "c1", name: "Finanzas")]), "Todo no es un tema: lo escrito va sin tema")
        let list = [TopicDTO(id: "fin", conversationId: "c1", name: "Finanzas"), TopicDTO(id: "old", conversationId: "c1", name: "Viejo", archivedAt: "2026-09-01")]
        XCTAssertEqual(TopicRules.activeIds(list), ["fin"])
    }

    func testUnreadCountsPerFlag() {
        let ms = [msg(1, topic: "fin"), msg(2, topic: "fin"), msg(3, topic: "fin"), msg(4), msg(5, topic: "ops"),
                  msg(6, topic: "fin", author: "a"), msg(7, kind: "system"), msg(8, topic: "fin", deleted: true), msg(9, topic: "old")]
        let n = TopicRules.unreadCounts(ms, read: 2, me: "a", active: ["fin", "ops"])
        XCTAssertEqual(n, ["fin": 1, "": 2, "ops": 1], "propios, de sistema y eliminados no cuentan; el archivado va a «Todo»")
        XCTAssertEqual(TopicRules.unreadCounts(ms, read: 9, me: "a", active: ["fin"]), [:], "sin pendientes, sin número")
    }

    func testOpenFilterIsTopicOfFirstUnread() {
        let active: Set<String> = ["fin", "ops"]
        XCTAssertEqual(TopicRules.openFilter([msg(1), msg(2, topic: "fin"), msg(3, topic: "fin"), msg(4, author: "a")], after: 1, me: "a", active: active), "fin")
        XCTAssertEqual(TopicRules.openFilter([msg(3, topic: "ops"), msg(2, topic: "fin")], after: 1, me: "a", active: active), "fin", "repartido: el del primero (por seq)")
        XCTAssertNil(TopicRules.openFilter([msg(2), msg(3, topic: "fin")], after: 1, me: "a", active: active), "primero sin tema: «General», donde se ve")
        XCTAssertNil(TopicRules.openFilter([msg(2, topic: "old"), msg(3, topic: "fin")], after: 1, me: "a", active: active), "tema archivado = sin tema")
        XCTAssertNil(TopicRules.openFilter([msg(2, topic: "fin")], after: 2, me: "a", active: active), "sin no leídos")
        XCTAssertEqual(TopicRules.openFilter([msg(2, kind: "system"), msg(3, topic: "ops")], after: 1, me: "a", active: active), "ops", "lo de sistema no cuenta")
        XCTAssertEqual(TopicRules.openFilter([msg(2, topic: "fin", author: "a"), msg(3, topic: "ops")], after: 1, me: "a", active: active), "ops", "lo mío no cuenta")
        XCTAssertEqual(TopicRules.openFilter([msg(2, topic: "fin", deleted: true), msg(3, topic: "ops")], after: 1, me: "a", active: active), "ops", "lo borrado no cuenta")
        XCTAssertNil(TopicRules.openFilter([msg(2, topic: "fin")], after: 1, me: "a", active: []), "sin temas activos")
    }

    // MARK: 1.6.8: Groq por pedazos, agregar personas y push de llamada

    func testDecodesInvitesAndTranscriptEvents() throws {
        let c = try dec(CallDTO.self, #"{"id":"x","conversationId":"c9","activeUserIds":["b"],"invitedUserIds":["z"],"names":{"z":"Zoe Ruiz"}}"#)
        XCTAssertEqual(c.invitedUserIds, ["z"]); XCTAssertEqual(c.names["z"], "Zoe Ruiz")
        XCTAssertEqual(try dec(CallDTO.self, #"{"id":"x"}"#).names, [:])
        guard case .callUpdated(let u) = try dec(AccountEvent.self, #"{"type":"call.updated","call":\#(callJSON)}"#) else { return XCTFail() }
        XCTAssertEqual(u.id, "call1")
        guard case .callProcessing(let cid, let uid, let seg) = try dec(AccountEvent.self, #"{"type":"call.processing","callId":"call1","userId":"b","segId":"s1"}"#) else { return XCTFail() }
        XCTAssertEqual([cid, uid, seg], ["call1", "b", "s1"])
        let t = try dec(AccountEvent.self, #"{"type":"call.transcript","callId":"call1","userId":"b","segId":"s1","segments":[{"resultId":"s1:0","speakerUserId":"b","speakerName":"Bruno","text":"Hola","startMs":1000,"endMs":2000}]}"#)
        guard case .callTranscript(_, _, _, let segs, let failed) = t else { return XCTFail() }
        XCTAssertEqual(segs.map(\.text), ["Hola"]); XCTAssertFalse(failed)
    }

    func testProcessingThenPhrasesReplaceCaption() async throws {
        let s = try ControlledURLProtocol.store()
        s.seedForTesting(try dec(BootstrapDTO.self, #"{"me":{"id":"a","name":"Ana"},"features":{"calls":true},"conversations":[{"id":"c1","kind":"direct","memberIds":["a","b"],"canPost":true}]}"#))
        ControlledURLProtocol.handler = { req in Task { @MainActor in req.respond(joinJSON) } }
        try await s.callCenter.start("c1", kind: "audio")
        s.socketEventForTesting("account.event", #"{"type":"call.processing","callId":"call1","userId":"b","segId":"s1"}"#)
        XCTAssertEqual(s.callCenter.view?.captions.map(\.processing), [true])
        s.socketEventForTesting("account.event", #"{"type":"call.transcript","callId":"call1","userId":"b","segId":"s1","segments":[{"resultId":"s1:0","speakerUserId":"b","text":"Hola a todos","startMs":0,"endMs":1}]}"#)
        XCTAssertEqual(s.callCenter.view?.captions.map(\.text), ["Hola a todos"], "las frases reemplazan el «Procesando…»")
        s.socketEventForTesting("account.event", #"{"type":"call.processing","callId":"otra","userId":"b","segId":"s2"}"#)
        XCTAssertEqual(s.callCenter.view?.captions.count, 1, "otra llamada: se ignora")
        s.callCenter.reset()
    }

    func testChunkRules() {
        XCTAssertFalse(ChunkRules.shouldCut(elapsed: 11_900, sinceVoice: 5000), "antes de 12 s no corta")
        XCTAssertTrue(ChunkRules.shouldCut(elapsed: 12_100, sinceVoice: 800), "silencio después de 12 s")
        XCTAssertFalse(ChunkRules.shouldCut(elapsed: 15_000, sinceVoice: 200), "sigue hablando")
        XCTAssertTrue(ChunkRules.shouldCut(elapsed: 20_000, sinceVoice: 0), "máximo 20 s")
        XCTAssertFalse(ChunkRules.shouldSend(voicedMs: 700)); XCTAssertTrue(ChunkRules.shouldSend(voicedMs: 800))
        XCTAssertTrue(ChunkRules.isVoice(rms: 0.05, muted: false)); XCTAssertFalse(ChunkRules.isVoice(rms: 0.05, muted: true), "silenciado no cuenta")
        XCTAssertFalse(ChunkRules.isVoice(rms: ChunkRules.rms(fromDecibels: -50), muted: false))
        XCTAssertTrue(ChunkRules.isVoice(rms: ChunkRules.rms(fromDecibels: -30), muted: false))
        let id = ChunkRules.segId()
        XCTAssertNotNil(id.range(of: #"^[A-Za-z0-9_-]{6,64}$"#, options: .regularExpression)); XCTAssertNotEqual(id, ChunkRules.segId())
    }

    func testCallPushPayloadAndCategory() {
        let p = PushPayload(userInfo: ["aps": ["alert": ["title": "Bruno", "body": "📞 Te está llamando"], "category": "TC_CALL"],
                                       "type": "call", "callId": "call1", "conversationId": "c1", "kind": "video"])
        XCTAssertEqual(p?.kind, .call); XCTAssertEqual(p?.callId, "call1"); XCTAssertEqual(p?.callKind, "video"); XCTAssertEqual(p?.category, PushPayload.callCategory)
        let cat = PushRegistration.categories().first { $0.identifier == PushPayload.callCategory }
        XCTAssertEqual(cat?.actions.map(\.identifier), [PushRegistration.callAnswerAction, PushRegistration.callDeclineAction])
        XCTAssertTrue(cat?.actions.first?.options.contains(.foreground) ?? false, "Contestar abre la app")
    }
}

/// 1.6.9: la barra inferior no se muestra en pantallas empujadas (chat, detalle, tarea…) ni con el teclado.
@MainActor
final class TabBarRuleTests: XCTestCase {
    func testTabBarOnlyAtRootWithoutKeyboard() {
        XCTAssertTrue(TabBarRule.visible(path: [], keyboard: false))
        XCTAssertFalse(TabBarRule.visible(path: [.conversation("c1")], keyboard: false), "dentro de un chat no tapa el compositor")
        XCTAssertFalse(TabBarRule.visible(path: [.callDetail("x")], keyboard: false))
        XCTAssertFalse(TabBarRule.visible(path: [.issue("i")], keyboard: false))
        XCTAssertFalse(TabBarRule.visible(path: [], keyboard: true))
    }
}

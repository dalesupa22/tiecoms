import Foundation

// «Nueva llamada» (1.7.6): desde la pestaña Llamadas, una llamada con enlace para terceros sin cuenta ni app.
// Contrato: POST /api/v1/calls/instant { title?, video? } → 201 { call, conversationId, link: { url, token } }.
// La llamada ya está iniciada con el creador; el cliente entra con el flujo normal (POST /calls/:id/join).
// El invitado entra por la web (https://app.chaggu.com/llamada/<token>) con nombre y correo; el enlace muere al terminar.

/// Enlace para invitados de una llamada.
struct InstantCallLinkDTO: Decodable, Equatable, Sendable {
    var url: String
    var token: String
    init(url: String, token: String) { self.url = url; self.token = token }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        url = try c.decode(String.self, forKey: AnyKey("url"))
        token = c.v("token", "")
    }
}

/// Respuesta de POST /calls/instant.
struct InstantCallDTO: Decodable, Sendable {
    var call: CallDTO
    var conversationId: String
    var link: InstantCallLinkDTO
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        var call = try c.decode(CallDTO.self, forKey: AnyKey("call"))
        let conv: String? = c.o("conversationId")
        conversationId = conv ?? call.conversationId
        if call.conversationId.isEmpty { call.conversationId = conversationId }
        self.call = call
        link = try c.decode(InstantCallLinkDTO.self, forKey: AnyKey("link"))
    }
}

/// El enlace que se puede volver a compartir desde la llamada en curso (🔗). Solo en memoria: muere con la llamada.
struct CallShareLink: Equatable, Sendable {
    var callId: String
    var url: String
    var token: String
    /// Título con que se creó (cabecera de la llamada mientras su conversación no llega).
    var title: String? = nil
}

/// Reglas puras de «Nueva llamada» (las usan la vista y las pruebas).
enum InstantCallRules {
    static let titleMax = 80

    /// «Llamada de Danny»: el título automático con mi primer nombre.
    static func autoTitle(myName: String?) -> String {
        let first = (myName ?? "").split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? L("calls.instant.autoTitleNoName") : L("calls.instant.autoTitle", ["name": first])
    }

    /// El título que se manda: el escrito (recortado) o el automático.
    static func title(_ typed: String, myName: String?) -> String {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? autoTitle(myName: myName) : String(t.prefix(titleMax))
    }

    static func body(title: String, video: Bool) -> [String: Any] { ["title": title, "video": video] }

    /// Texto sugerido para WhatsApp, Mensajes, correo…
    static func shareText(_ url: String) -> String { L("calls.instant.shareText", ["url": url]) }

    /// El servidor aún no tiene llamadas rápidas (404 en la ruta): aviso amable en vez del error genérico.
    static func isOldServer(_ error: Error) -> Bool {
        guard let e = error as? ApiRequestError else { return false }
        return e.status == 404
    }

    static func errorText(_ error: Error) -> String {
        isOldServer(error) ? L("calls.instant.oldServer") : L10n.errorText(error)
    }
}

extension CallRules {
    /// Correo de un invitado por enlace (si lo dejó al entrar).
    static func guestEmail(_ c: CallDTO, _ id: String) -> String? {
        guard isGuest(id) else { return nil }
        return c.guests.first { guestUserId($0.id) == id }?.email
    }
}

extension AppStore {
    /// POST /calls/instant: crea la conversación de la llamada, la inicia conmigo y devuelve el enlace para invitados.
    func startInstantCallRequest(title: String, video: Bool) async throws -> InstantCallDTO {
        let r: InstantCallDTO = try await api.request("/calls/instant", method: "POST", json: InstantCallRules.body(title: title, video: video))
        putCall(r.call)
        return r
    }
}

extension CallCenter {
    /// Entra a la llamada recién creada y deja listo el enlace para compartir (la hoja sale sola al conectar).
    func enterInstant(_ r: InstantCallDTO, video: Bool, title: String? = nil) async throws {
        try await join(r.call.id, camera: video)
        guard view?.call.id == r.call.id else { return }
        shareLink = CallShareLink(callId: r.call.id, url: r.link.url, token: r.link.token, title: r.call.title ?? title)
        // Sobre la pantalla de la llamada, cuando ya terminó de aparecer.
        try? await Task.sleep(nanoseconds: 600_000_000)
        if shareLink?.callId == view?.call.id { linkSheet = true }
    }

    /// El enlace de la llamada en curso (nil si no la creé con «Nueva llamada» o ya terminó).
    var currentShareLink: CallShareLink? {
        guard let l = shareLink, let v = view, v.call.id == l.callId, v.phase != .ended else { return nil }
        return l
    }
}

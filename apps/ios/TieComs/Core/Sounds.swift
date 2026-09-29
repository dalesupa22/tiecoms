import AVFoundation
import Foundation
import SwiftUI

// Sonidos por chat, predeterminado y tono de llamada (docs/SONIDOS.md). Se guardan en el servidor:
// ConversationDTO.sound (PUT /conversations/:id/prefs {sound}) y UserDTO.messageSound/ringtone (PUT /me/sounds).
// Los archivos (snd_<nombre>.caf, snd_<nombre>_m.caf para menciones y ring_<nombre>.caf) salen de tools/gen-sounds.py
// con las mismas notas que la web (apps/web/src/sound.ts).

enum ChatSounds {
    /// MESSAGE_SOUNDS del contrato.
    static let message = ["pop", "gota", "campana", "marimba", "burbuja", "cristal", "acorde", "silbido", "tambor", "brisa"]
    /// RINGTONES del contrato.
    static let ringtones = ["clasico", "suave", "marimba"]
    static let none = "none"
    static let defaultMessage = "pop"
    static let defaultRingtone = "clasico"
    /// El tono se repite cada 2,2 s mientras suena el aviso.
    static let ringEvery: Double = 2.2

    /// Sonido que suena en un chat: el suyo, si no el predeterminado de la persona, si no «pop». Uno desconocido = «pop».
    static func effective(chat: String?, userDefault: String?) -> String {
        let pick = chat ?? userDefault ?? defaultMessage
        return pick == none || message.contains(pick) ? pick : defaultMessage
    }

    static func ringtone(_ r: String?) -> String { r.flatMap { ringtones.contains($0) ? $0 : nil } ?? defaultRingtone }

    /// Nombre del archivo (sin extensión); nil = sin sonido. La mención es la versión una quinta más aguda.
    static func file(_ sound: String, mention: Bool = false) -> String? {
        guard sound != none else { return nil }
        let s = message.contains(sound) ? sound : defaultMessage
        return "snd_\(s)\(mention ? "_m" : "")"
    }

    static func ringFile(_ r: String?) -> String { "ring_\(ringtone(r))" }

    static func label(_ s: String) -> String { s == none ? L("sound.none") : L("sound.n.\(s)") }
    static func ringLabel(_ r: String) -> String { L("ring.n.\(r)") }
}

/// Reproductor de los sonidos elegidos (vista previa, mensajes y el tono en bucle).
@MainActor
final class ChoiceSoundPlayer {
    static let shared = ChoiceSoundPlayer()
    private var players: [String: AVAudioPlayer] = [:]

    /// `force`: ignora «Sonido de mensajes» (vista previa y tono de llamada).
    func play(_ file: String?, force: Bool = false) {
        guard let file, force || Prefs.soundsEnabled, !AppConfig.isRunningUnitTests else { return }
        AppFeedback.shared.sounds.configure()
        if players[file] == nil, let url = Bundle.main.url(forResource: file, withExtension: "caf") {
            players[file] = try? AVAudioPlayer(contentsOf: url)
        }
        guard let p = players[file] else { return }
        p.currentTime = 0
        p.play()
    }

    func stop(_ file: String) { players[file]?.stop() }
}

// MARK: - Red

extension AppStore {
    /// Sonido de este chat (nil = el predeterminado). Optimista; el servidor confirma con prefs.updated.
    func setConversationSound(_ id: String, _ sound: String?) async throws {
        patchMeta(id) { $0.sound = sound }
        try await api.requestData("/conversations/\(id)/prefs", method: "PUT", json: ["sound": sound ?? NSNull()])
    }

    /// Predeterminado de los chats y tono de llamada (en todos mis dispositivos).
    func setMySounds(messageSound: String?? = nil, ringtone: String?? = nil) async throws {
        var body: [String: Any] = [:]
        if let messageSound { body["messageSound"] = messageSound ?? NSNull() }
        if let ringtone { body["ringtone"] = ringtone ?? NSNull() }
        patchMe {
            if let messageSound { $0.messageSound = messageSound }
            if let ringtone { $0.ringtone = ringtone }
        }
        try await api.requestData("/me/sounds", method: "PUT", json: body)
    }

    /// Lo que suena en un chat (para los avisos).
    func soundFor(_ c: ConversationDTO) -> String { ChatSounds.effective(chat: c.sound, userDefault: me?.messageSound) }
}

// MARK: - Vistas

/// Opciones de sonido de un chat: Predeterminado (con cuál es), los 10 y «Sin sonido». Suena al elegir.
struct ChatSoundOptions: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var body: some View {
        let current = conv.sound
        let def = ChatSounds.effective(chat: nil, userDefault: store.me?.messageSound)
        Button { pick(nil) } label: { check("\(L("sound.default")) · \(ChatSounds.label(def))", current == nil) }
        ForEach(ChatSounds.message, id: \.self) { s in
            Button { pick(s) } label: { check(ChatSounds.label(s), current == s) }
                .accessibilityIdentifier("sound.pick.\(s)")
        }
        Button { pick(ChatSounds.none) } label: { check(L("sound.none"), current == ChatSounds.none) }
    }
    private func check(_ text: String, _ on: Bool) -> some View {
        if on { return AnyView(Label(text, systemImage: "checkmark")) }
        return AnyView(Text(text))
    }
    private func pick(_ s: String?) {
        ChoiceSoundPlayer.shared.play(ChatSounds.file(ChatSounds.effective(chat: s, userDefault: store.me?.messageSound)), force: true)
        let id = conv.id
        Task {
            do {
                try await store.setConversationSound(id, s)
                store.show(L("sound.set", ["name": s.map(ChatSounds.label) ?? L("sound.default")]))
            } catch { store.show(L10n.errorText(error)) }
        }
    }
}

/// Submenú «Sonido» (menú contextual del chat).
struct ChatSoundMenu: View {
    let conv: ConversationDTO
    var body: some View {
        Menu { ChatSoundOptions(conv: conv) } label: { Label(L("sound.chat"), systemImage: "speaker.wave.2") }
            .accessibilityIdentifier("menu.sound")
    }
}

/// Fila «Sonido» de Detalles del chat.
struct ChatSoundRow: View {
    @Environment(AppStore.self) private var store
    let conv: ConversationDTO
    var body: some View {
        Section {
            Menu { ChatSoundOptions(conv: conv) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "speaker.wave.2").foregroundStyle(Theme.accentText).frame(width: 28).accessibilityHidden(true)
                    Text(L("sound.chat")).foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Text(conv.sound.map(ChatSounds.label) ?? "\(L("sound.default")) · \(ChatSounds.label(store.soundFor(conv)))")
                        .foregroundStyle(Theme.textSecondary).lineLimit(1)
                }
            }
            .accessibilityIdentifier("details.sound")
        }
    }
}

/// Ajustes › Notificaciones: sonido predeterminado de los chats y tono de llamada (con vista previa).
struct DefaultSoundsRows: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        let def = ChatSounds.effective(chat: nil, userDefault: store.me?.messageSound)
        let ring = ChatSounds.ringtone(store.me?.ringtone)
        Picker(selection: Binding(get: { def }, set: { v in
            ChoiceSoundPlayer.shared.play(ChatSounds.file(v), force: true)
            Task { do { try await store.setMySounds(messageSound: .some(v)) } catch { store.show(L10n.errorText(error)) } }
        })) {
            ForEach(ChatSounds.message + [ChatSounds.none], id: \.self) { Text(ChatSounds.label($0)).tag($0) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("sound.defaultTitle"))
                Text(L("sound.defaultHintIos")).font(.caption).foregroundStyle(Theme.textSecondary)
            }
        }
        .accessibilityIdentifier("settings.defaultSound")
        if store.data?.callsEnabled == true {
            Picker(L("ring.title"), selection: Binding(get: { ring }, set: { v in
                ChoiceSoundPlayer.shared.play(ChatSounds.ringFile(v), force: true)
                Task { do { try await store.setMySounds(ringtone: .some(v)) } catch { store.show(L10n.errorText(error)) } }
            })) {
                ForEach(ChatSounds.ringtones, id: \.self) { Text(ChatSounds.ringLabel($0)).tag($0) }
            }
            .accessibilityIdentifier("settings.ringtone")
        }
    }
}

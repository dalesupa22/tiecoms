import Foundation

// gg como chat y «Tú» (docs/GG-CHAT.md, main 0d12654). Lo mínimo en iOS: el aviso `gg.actions` nunca crudo, el directo
// conmigo mismo se llama «Tú» y gg (bot con id fijo) se ve como «gg» con su marca. Este archivo lo compila también la
// extensión Compartir (Naming); la tarjeta de acciones está en UI/GgViews.swift.

enum GG {
    /// Participante bot único (users.kind = 'agent', migración 041); también llega en `bootstrap.assistantId`.
    static let id = "0a9a9a9a-0000-4000-8000-000000000066"

    /// El directo conmigo mismo («Tú»): un solo miembro, yo.
    static func isSelf(_ d: BootstrapDTO, _ c: ConversationDTO) -> Bool {
        c.kind == .direct && !c.memberIds.isEmpty && c.memberIds.allSatisfy { $0 == d.me.id }
    }
}

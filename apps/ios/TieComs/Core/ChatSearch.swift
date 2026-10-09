import Foundation

// Buscar dentro del chat (docs/TANDA-1.7.md §6): GET /conversations/:id/search?q=&before=&limit=30.
// Sin mayúsculas ni tildes, mínimo 2 caracteres; nunca devuelve mensajes de una sola vista.

struct ChatSearchResult: Decodable, Identifiable, Sendable {
    var message: MessageDTO
    var snippet: String
    var matches: [[Int]]
    var id: String { message.id }
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        message = try c.decode(MessageDTO.self, forKey: AnyKey("message"))
        snippet = c.v("snippet", message.body)
        matches = c.v("matches", [])
    }
}

struct ChatSearchPage: Decodable, Sendable {
    var results: [ChatSearchResult]
    var hasMore: Bool
    init(from decoder: Decoder) throws {
        let c = try container(decoder)
        results = c.lossyArray("results")
        hasMore = c.v("hasMore", false)
    }
}

/// Estado de la barra de búsqueda del chat (resultados del más nuevo al más viejo; `index` 0 = el más nuevo).
struct ChatSearchState: Equatable {
    var active = false
    var query = ""
    var results: [MessageDTO] = []
    var hasMore = false
    var index = 0
    var loading = false

    var current: MessageDTO? { results.indices.contains(index) ? results[index] : nil }
    var matchIds: Set<String> { Set(results.map(\.id)) }
    /// «3 de 17» (contando desde el más nuevo, como WhatsApp).
    var counter: String { results.isEmpty ? L("search.none") : L("search.counter", ["i": index + 1, "n": "\(results.count)\(hasMore ? "+" : "")"]) }
    /// ↑ = más viejo, ↓ = más nuevo.
    mutating func older() { if index < results.count - 1 { index += 1 } }
    mutating func newer() { if index > 0 { index -= 1 } }
    var canOlder: Bool { index < results.count - 1 || hasMore }
    var canNewer: Bool { index > 0 }
}

enum ChatSearch {
    static let minChars = 2
    static let debounceMs: UInt64 = 250

    static func normalized(_ s: String) -> String { s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }

    /// Tramos (NSRange sobre el texto original) donde aparece la búsqueda, sin mayúsculas ni tildes.
    static func ranges(of query: String, in text: String) -> [NSRange] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= minChars else { return [] }
        let ns = text as NSString
        var out: [NSRange] = []
        var from = 0
        while from < ns.length {
            let r = ns.range(of: q, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: from, length: ns.length - from))
            guard r.location != NSNotFound, r.length > 0 else { break }
            out.append(r)
            from = r.location + r.length
        }
        return out
    }
}

extension AppStore {
    /// `before` = seq del último resultado que ya tengo (contrato 1.7).
    func searchConversation(_ id: String, query: String, before: Int? = nil) async throws -> ChatSearchPage {
        var path = "/conversations/\(id)/search?limit=30&q=" + (query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")
        if let before { path += "&before=\(before)" }
        return try await api.request(path)
    }
}

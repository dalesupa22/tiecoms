import Foundation

enum CodeMessages {
    struct Block: Equatable, Identifiable {
        var range: NSRange
        var contentRange: NSRange
        var language: String
        var code: String
        var id: Int { range.location }
    }
    // Anchored, nonrecursive and bounded by the message limit; malformed fences remain visible text.
    private static let fences = try! NSRegularExpression(pattern: #"(?m)^```([A-Za-z0-9_+.#-]{0,32})[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)"#)
    static func blocks(_ text: String) -> [Block] {
        guard text.contains("```"), text.utf16.count <= 64_000 else { return [] }
        let ns = text as NSString
        return fences.matches(in: text, range: NSRange(location: 0, length: ns.length)).map {
            Block(range: $0.range, contentRange: $0.range(at: 2), language: ns.substring(with: $0.range(at: 1)), code: ns.substring(with: $0.range(at: 2)))
        }
    }
    static func mentions(_ mentions: [Mention], range: NSRange) -> [Mention] {
        mentions.filter { $0.start >= range.location && $0.end <= NSMaxRange(range) }.map { Mention(userId: $0.userId, start: $0.start - range.location, length: $0.length) }
    }
}

extension MessageFormat {
    static func compose(_ text: String, selection: NSRange, command: String, mentions: [Mention]) -> (text: String, mentions: [Mention], selection: NSRange)? {
        let ns = text as NSString
        guard selection.location >= 0, NSMaxRange(selection) <= ns.length else { return nil }
        guard !mentions.contains(where: { ($0.start < selection.location && $0.end > selection.location) || ($0.start < NSMaxRange(selection) && $0.end > NSMaxRange(selection)) }) else { return nil }
        if command == "block" {
            let prefix = "```\n", suffix = "\n```"
            let body = ns.substring(with: selection)
            let moved = mentions.filter { $0.end <= selection.location || $0.start >= NSMaxRange(selection) }.map { m in
                m.start >= NSMaxRange(selection) ? Mention(userId: m.userId, start: m.start + prefix.utf16.count + suffix.utf16.count, length: m.length) : m
            }
            return (ns.replacingCharacters(in: selection, with: prefix + body + suffix), moved, NSRange(location: selection.location + prefix.utf16.count, length: body.utf16.count))
        }
        if command == "bullets" || command == "numbered" {
            let whole = ns.lineRange(for: selection)
            let segment = ns.substring(with: whole)
            var offset = whole.location
            var inserts: [(Int, String)] = []
            for (i, line) in segment.components(separatedBy: "\n").enumerated() {
                // A trailing newline does not create an extra phantom list item.
                if offset < NSMaxRange(whole) || whole.length == 0 { inserts.append((offset, command == "bullets" ? "- " : "\(i+1). ")) }
                offset += line.utf16.count + 1
            }
            let out = NSMutableString(string: text)
            for (at, value) in inserts.reversed() { out.insert(value, at: at) }
            let moved = mentions.map { m in Mention(userId: m.userId, start: m.start + inserts.filter { $0.0 <= m.start }.reduce(0) { $0 + $1.1.utf16.count }, length: m.length) }
            return (out as String, moved, NSRange(location: whole.location, length: whole.length + inserts.reduce(0) { $0 + $1.1.utf16.count }))
        }
        return wrap(text, selection: selection, mark: command, mentions: mentions)
    }
}

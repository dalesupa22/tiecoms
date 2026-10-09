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
            let prefix = (selection.location > 0 && ns.character(at: selection.location - 1) != 10 ? "\n" : "") + "```\n"
            let suffix = "\n```" + (NSMaxRange(selection) < ns.length && ns.character(at: NSMaxRange(selection)) != 10 ? "\n" : "")
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
        guard ["**", "_", "~", "`"].contains(command) else { return nil }
        var range = selection
        let width = command.utf16.count
        let kind: Kind = command == "**" ? .bold : command == "_" ? .italic : command == "~" ? .strike : .code
        // A second tap removes matching markers, including legacy single-star bold.
        if let span = spans(in: text).first(where: {
            $0.kind == kind && ($0.inner == range || $0.range == range ||
                (range.length == 0 && range.location >= $0.inner.location && range.location <= NSMaxRange($0.inner)))
        }) {
            let hidden = hiddenOffsets([span])
            let out = NSMutableString(string: text)
            for offset in hidden.reversed() { out.deleteCharacters(in: NSRange(location: offset, length: 1)) }
            let moved = mentions.map { m in Mention(userId: m.userId, start: map(NSRange(location: m.start, length: m.length), hidden: hidden).location, length: m.length) }
            return (out as String, moved, map(range, hidden: hidden))
        }
        if range.length == 0 {
            // At a word, format that word; in empty space insert an editable pair and leave the cursor inside.
            // NSString offsets stay UTF-16, including emoji before the selection.
            (text as NSString).enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: .byWords) { _, word, _, stop in
                if range.location >= word.location && range.location <= NSMaxRange(word) { range = word; stop.pointee = true }
            }
            if range.length == 0 {
                let out = ns.replacingCharacters(in: range, with: command + command)
                let moved = mentions.map { m in m.start >= range.location ? Mention(userId: m.userId, start: m.start + width * 2, length: m.length) : m }
                return (out, moved, NSRange(location: range.location + width, length: 0))
            }
        }
        guard !mentions.contains(where: { NSIntersectionRange(NSRange(location: $0.start, length: $0.length), range).length > 0 }) else { return nil }
        if ns.substring(with: range).contains("\n") {
            if command == "`" { return compose(text, selection: range, command: "block", mentions: mentions) }
            let out = NSMutableString(string: text)
            var currentMentions = mentions
            var added = 0
            // Inline marks do not span paragraphs. Apply each selected line independently.
            var lines: [NSRange] = []
            ns.enumerateSubstrings(in: range, options: [.byLines, .substringNotRequired]) { _, line, _, _ in lines.append(line) }
            for line in lines.reversed() {
                let segment = (out as String as NSString).substring(with: line)
                let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                let local = (segment as NSString).range(of: trimmed)
                let target = NSRange(location: line.location + local.location, length: local.length)
                guard let result = wrap(out as String, selection: target, mark: command, mentions: currentMentions) else { return nil }
                out.setString(result.text); currentMentions = result.mentions; added += width * 2
            }
            return (out as String, currentMentions, NSRange(location: range.location, length: range.length + added))
        }
        let trimmed = ns.substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let local = (ns.substring(with: range) as NSString).range(of: trimmed)
        range = NSRange(location: range.location + local.location, length: local.length)
        // Do not offer formatting that the renderer would leave literal inside another word.
        if range.location > 0, let before = UnicodeScalar(ns.character(at: range.location - 1)), CharacterSet.alphanumerics.contains(before) { return nil }
        if NSMaxRange(range) < ns.length, let after = UnicodeScalar(ns.character(at: NSMaxRange(range))), CharacterSet.alphanumerics.contains(after) { return nil }
        return wrap(text, selection: range, mark: command, mentions: mentions)
    }
}

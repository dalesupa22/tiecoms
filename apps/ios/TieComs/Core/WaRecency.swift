import Foundation

enum WaRecency {
    static func before(_ a: WaChatDTO, _ b: WaChatDTO) -> Bool {
        if a.pinned != b.pinned { return a.pinned }
        let aa = ISODate.parse(a.lastMessageAt ?? "") ?? .distantPast
        let bb = ISODate.parse(b.lastMessageAt ?? "") ?? .distantPast
        return aa == bb ? a.id < b.id : aa > bb
    }
}

import SwiftUI
import UIKit

struct ProvenanceCredits: View {
    let provenance: AttachmentProvenance
    var mine: Bool
    @State private var details = false
    var body: some View {
        Button { details = true } label: {
            Label(L("gifs.credits"), systemImage: "info.circle").font(.caption2).foregroundStyle(mine ? .white.opacity(0.8) : Theme.textSecondary)
        }
        .accessibilityIdentifier("gifs.credits")
        .sheet(isPresented: $details) {
            NavigationStack {
                List {
                    Text(provenance.title).font(.headline)
                    Text(provenance.attribution).textSelection(.enabled)
                    if let u = safeLink(provenance.sourceUrl) { Link(L("gifs.source"), destination: u) }
                    if let u = safeLink(provenance.licenseUrl) { Link(provenance.license ?? L("gifs.license"), destination: u) }
                }
                .navigationTitle(L("gifs.credits"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("common.close")) { details = false } } }
            }
        }
    }
    private func safeLink(_ raw: String?) -> URL? {
        guard let raw, let u = URL(string: raw), u.scheme == "https", u.host != nil else { return nil }; return u
    }
}

struct CodeMessageBody: View {
    @Environment(AppStore.self) private var store
    let text: String
    let mentions: [Mention]
    var mine: Bool
    var linkify = true
    var highlight: String? = nil
    var onMention: (String) -> Void
    @State private var readingCode: String?
    var body: some View {
        let blocks = CodeMessages.blocks(text)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.element.id) { i, block in
                let start = i == 0 ? 0 : NSMaxRange(blocks[i-1].range)
                prose(NSRange(location: start, length: block.range.location - start))
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(block.language.isEmpty ? L("format.code") : block.language).font(.caption2.weight(.semibold))
                        Spacer()
                        Button { MessageCopy.write(block.code, store: store) } label: { Label(L("copy.code"), systemImage: "doc.on.doc").font(.caption2) }
                            .buttonStyle(.plain).disabled(block.code.isEmpty).accessibilityIdentifier("code.copy.\(block.id)")
                    }
                    ScrollView(.horizontal) {
                        Text(block.code).font(.system(.footnote, design: .monospaced)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                    }
                    .frame(maxHeight: 220)
                    if block.code.split(separator: "\n", omittingEmptySubsequences: false).count > 8 {
                        Button(L("msg.readMore")) { readingCode = block.code }.font(.caption)
                    }
                }
                .padding(8).background(RoundedRectangle(cornerRadius: 8).fill(mine ? Color.black.opacity(0.2) : Theme.background))
                .accessibilityIdentifier("code.block.\(block.id)")
            }
            prose(NSRange(location: blocks.last.map { NSMaxRange($0.range) } ?? 0, length: (text as NSString).length - (blocks.last.map { NSMaxRange($0.range) } ?? 0)))
        }
        .sheet(isPresented: Binding(get: { readingCode != nil }, set: { if !$0 { readingCode = nil } })) {
            LongTextSheet(text: readingCode ?? "", author: L("format.code"), monospaced: true)
        }
    }
    @ViewBuilder private func prose(_ range: NSRange) -> some View {
        if range.length > 0 {
            RichMessageText(text: (text as NSString).substring(with: range), mentions: CodeMessages.mentions(mentions, range: range), mine: mine, linkify: linkify, highlight: highlight, onMention: onMention)
        }
    }
}

struct UTF8FileSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let attachment: AttachmentDTO
    @State private var text: String?
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Group {
                if let text { ReaderTextView(text: text, identifier: "fileText.body", monospaced: true) }
                else if let error { ContentUnavailableView(error, systemImage: "exclamationmark.triangle") }
                else { ProgressView() }
            }
            .navigationTitle(attachment.name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(L("copy.fileText")) { if let text { MessageCopy.write(text, store: store) } }.disabled(text == nil || text?.isEmpty == true) }
            }
            .task(id: attachment.id) {
                let stamp = store.sessionStamp
                do {
                    guard attachment.isUTF8Text else { throw CocoaError(.fileReadUnknown) }
                    let data = try await store.api.download(attachment.url)
                    guard stamp == store.sessionStamp, !Task.isCancelled else { return }
                    guard data.count <= LongMessageRules.maxBytes, let decoded = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
                    text = decoded
                } catch { if stamp == store.sessionStamp { self.error = L10n.errorText(error) } }
            }
        }
    }
}

struct AssigneeSelector: View {
    let people: [PersonDTO]
    @Binding var selected: Set<String>
    var me: String
    var body: some View {
        DisclosureGroup {
            ForEach(people) { person in
                Toggle(person.id == me ? L("issue.me") : person.name, isOn: Binding(get: { selected.contains(person.id) }, set: { on in if on { selected.insert(person.id) } else { selected.remove(person.id) } }))
                    .accessibilityIdentifier("issue.assignee.\(person.id)")
            }
        } label: {
            Text(L("issue.owner") + " · \(selected.count)").accessibilityIdentifier("issue.assignees")
        }.fixedSize(horizontal: false, vertical: true)
    }
}

struct AvailabilityLabel: View {
    let availability: AvailabilityDTO?
    var body: some View {
        if let availability, let mode = availability.mode {
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                if availability.active {
                    Label(L("availability.\(mode)"), systemImage: mode == "available" ? "circle.fill" : mode == "rest" ? "moon.fill" : "minus.circle.fill")
                        .font(.caption).foregroundStyle(mode == "available" ? Color.green : Color.orange)
                        .accessibilityIdentifier("person.availability")
                }
            }
        }
    }
}
struct AvailabilityPicker: View {
    @Environment(AppStore.self) private var store
    @State private var saving = false
    var body: some View {
        Menu {
            ForEach(["available", "busy", "focus", "dnd", "rest"], id: \.self) { mode in
                Button(L("availability.\(mode)")) { set(mode) }
            }
            Button(L("availability.end")) { set(nil) }
        } label: {
            HStack {
                Label(L("availability.title"), systemImage: "person.crop.circle.badge.clock")
                Spacer()
                AvailabilityLabel(availability: store.me?.availability)
                if saving { ProgressView() }
            }
        }.disabled(saving).accessibilityIdentifier("availability.pick")
    }
    private func set(_ mode: String?) {
        saving = true
        let stamp = store.sessionStamp
        Task {
            defer { saving = false }
            do {
                var body: [String: Any] = ["mode": mode ?? NSNull()]
                if let mode, ["focus", "dnd", "rest"].contains(mode) { body["until"] = ISODate.string(Date().addingTimeInterval(3600)) }
                struct Result: Decodable { let availability: AvailabilityDTO }
                let result: Result = try await store.api.request("/me/availability", method: "PUT", json: body)
                try store.requireSession(stamp)
                store.patchMe { $0.availability = result.availability }
            } catch { if stamp == store.sessionStamp { store.show(L10n.errorText(error)) } }
        }
    }
}

struct WaNativeMedia: View {
    @Environment(AppStore.self) private var store
    let accountId: String
    let jid: String
    let messageId: String
    let media: WaMessageMedia
    var mine: Bool
    @State private var retried: WaMessageMedia?
    @State private var loading = false
    var body: some View {
        let value = retried ?? media
        Group {
            if value.status == "ready", let attachment = value.attachment {
                AttachmentsBlock(attachments: [attachment], mine: mine)
            } else {
                HStack {
                    Text(L("wa.media.\(value.status)")).font(.caption)
                    if ["failed", "pending"].contains(value.status) {
                        Button(L("common.retry")) { retry() }.disabled(loading)
                    }
                }
            }
        }.accessibilityIdentifier("wa.media.\(messageId)")
    }
    private func pathEncode(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
    private func retry() {
        loading = true
        let stamp = store.sessionStamp
        Task {
            defer { loading = false }
            do {
                let path = "/whatsapp/media/\(accountId)/\(pathEncode(jid))/\(pathEncode(messageId))"
                try await store.api.requestData(path, method: "POST")
                let result: WaMessageMedia = try await store.api.request(path)
                try store.requireSession(stamp); retried = result
            } catch { if stamp == store.sessionStamp { store.show(L10n.errorText(error)) } }
        }
    }
}

/// A standalone native reader owns vertical scrolling; it is never clipped by the chat's row budget.
struct ReaderTextView: UIViewRepresentable {
    let text: String
    var identifier: String
    var monospaced = false
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false; view.isSelectable = true; view.isScrollEnabled = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.showsVerticalScrollIndicator = true
        view.textContainerInset = UIEdgeInsets(top: 12, left: 6, bottom: 24, right: 6)
        view.textContainer.lineBreakMode = .byWordWrapping
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        guard view.text != text else { return }
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textColor = UIColor(Theme.textPrimary)
        view.text = text
        // Literal fences and code stay selectable; no hidden mention/link actions in the reader.
        if monospaced || !CodeMessages.blocks(text).isEmpty { view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 16, weight: .regular)) }
        view.accessibilityIdentifier = identifier
    }
}

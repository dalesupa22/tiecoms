import SwiftUI
import UIKit

/// Reacciones en el chat (docs/REACCIONES_ENLACES.md): chips bajo la burbuja, barra rápida en la pulsación larga
/// y selector completo. Las mismas reglas que la web (Reactions.tsx).

/// Filas que se envuelven (chips de reacciones).
struct ChipFlow: Layout {
    var spacing: CGFloat = 4
    var trailing = false

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let w = rows.map { $0.width }.max() ?? 0
        let h = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = trailing ? bounds.maxX - row.width : bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - s.height) / 2), proposal: ProposedViewSize(s))
                x += s.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (i, v) in subviews.enumerated() {
            let s = v.sizeThatFits(.unspecified)
            let extra = rows[rows.count - 1].items.isEmpty ? s.width : s.width + spacing
            if rows[rows.count - 1].width + extra > maxWidth && !rows[rows.count - 1].items.isEmpty {
                rows.append(Row(items: [i], width: s.width, height: s.height))
            } else {
                rows[rows.count - 1].items.append(i)
                rows[rows.count - 1].width += extra
                rows[rows.count - 1].height = max(rows[rows.count - 1].height, s.height)
            }
        }
        return rows.filter { !$0.items.isEmpty }
    }
}

/// Chips «👍 3» bajo la burbuja: resaltado si reaccioné; tocar pone o quita mi reacción; mantener presionado dice quién.
struct ReactionChips: View {
    let d: BootstrapDTO
    let message: MessageDTO
    var mine: Bool
    var canReact: Bool
    var onToggle: (String) -> Void
    var onMore: () -> Void

    var body: some View {
        let list = message.reactions.filter { $0.count > 0 }
        ChipFlow(spacing: 4, trailing: mine) {
            ForEach(list) { r in chip(r) }
            if canReact {
                Button(action: onMore) {
                    Image(systemName: "face.smiling").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 8).frame(minHeight: 26)
                        .background(Capsule().fill(Theme.surface))
                        .overlay(Capsule().stroke(Theme.textSecondary.opacity(0.25)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("react.add"))
                .accessibilityIdentifier("react.add.\(message.id)")
            }
        }
    }

    private func chip(_ r: ReactionDTO) -> some View {
        let me = r.userIds.contains(d.me.id)
        let names = Reactions.reactorsText(d, r)
        return Button { onToggle(r.emoji) } label: {
            HStack(spacing: 4) {
                Text(r.emoji).font(.system(size: 15))
                Text("\(r.count)").font(.caption.weight(.bold)).monospacedDigit()
                    .foregroundStyle(me ? Theme.accentText : Theme.textSecondary)
            }
            .padding(.leading, 7).padding(.trailing, 9).frame(minHeight: 26)
            .background(Capsule().fill(me ? Theme.orange.opacity(0.16) : Theme.surface))
            .overlay(Capsule().stroke(me ? Theme.orange : Theme.textSecondary.opacity(0.25), lineWidth: me ? 1.2 : 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canReact)
        .contextMenu {
            // Quién reaccionó (Laura (Xertify), Beto y Pedro · WhatsApp).
            Section(names) {
                if canReact {
                    Button { onToggle(r.emoji) } label: {
                        Label(me ? L("react.remove") : L("react.addThis"), systemImage: me ? "minus.circle" : "plus.circle")
                    }
                }
            }
        }
        .accessibilityLabel(L("react.chipLabel", ["emoji": r.emoji, "n": r.count, "names": names]))
        .accessibilityHint(canReact ? (me ? L("react.remove") : L("react.addThis")) : "")
        .accessibilityAddTraits(me ? .isSelected : [])
        .accessibilityIdentifier("react.chip.\(message.id).\(r.emoji)")
    }
}

/// Emoji como imagen (la barra rápida del menú es una paleta de íconos). 👀 y ✅ con acción llevan un punto de acento;
/// el que ya puse va sobre un círculo suave.
enum EmojiImage {
    static func render(_ emoji: String, marker: Bool = false, selected: Bool = false) -> UIImage {
        let size = CGSize(width: 34, height: 34)
        let img = UIGraphicsImageRenderer(size: size).image { _ in
            if selected {
                UIColor(Theme.orange).withAlphaComponent(0.22).setFill()
                UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
            }
            let s = NSAttributedString(string: emoji, attributes: [.font: UIFont.systemFont(ofSize: 24)])
            let b = s.size()
            s.draw(at: CGPoint(x: (size.width - b.width) / 2, y: (size.height - b.height) / 2 - (marker ? 2 : 0)))
            if marker {
                UIColor(Theme.orange).setFill()
                UIBezierPath(ovalIn: CGRect(x: size.width / 2 - 2.5, y: size.height - 5, width: 5, height: 5)).fill()
            }
        }
        return img.withRenderingMode(.alwaysOriginal)
    }
}

/// Barra rápida de reacciones (arriba del menú del mensaje, como WhatsApp / iMessage): 👍 ❤️ 😂 👀 ✅ 🙏 y «＋».
struct QuickReactionBar: View {
    let mineEmojis: Set<String>
    var actions: Bool
    var onPick: (String) -> Void
    var onMore: () -> Void

    var body: some View {
        ControlGroup {
            ForEach(Array(Reactions.quick.enumerated()), id: \.offset) { i, e in
                let hint = actions && e == Reactions.look ? L("react.lookHint") : actions && e == Reactions.done ? L("react.doneHint") : nil
                Button { onPick(e) } label: {
                    Label { Text(hint ?? e) } icon: {
                        Image(uiImage: EmojiImage.render(e, marker: hint != nil, selected: mineEmojis.contains(e)))
                    }
                }
                .accessibilityIdentifier("react.quick.\(i)")
            }
            Button(action: onMore) { Label(L("react.more"), systemImage: "plus") }
                .accessibilityIdentifier("react.quick.more")
        }
        .controlGroupStyle(.palette)
    }
}

/// Selector completo: cuadrícula de emojis comunes y un campo que acepta cualquier emoji del teclado del sistema.
struct EmojiPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    var actions: Bool
    var onPick: (String) -> Void
    @State private var typed = ""
    @State private var invalid = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        TextField(L("react.typeOne"), text: $typed)
                            .font(.title2)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
                            .onSubmit(submitTyped)
                            .onChange(of: typed) { _, v in
                                // Un emoji del teclado basta: se elige al instante.
                                if let e = Reactions.normalize(v) { pick(e) } else { invalid = !v.trimmingCharacters(in: .whitespaces).isEmpty && v.count > 1 }
                            }
                            .accessibilityIdentifier("react.picker.field")
                    }
                    if invalid { Text(L("react.invalid")).font(.footnote).foregroundStyle(.red) }
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 8), spacing: 6) {
                        ForEach(Reactions.common, id: \.self) { e in
                            Button { pick(e) } label: {
                                ZStack(alignment: .bottom) {
                                    Text(e).font(.system(size: 30)).frame(maxWidth: .infinity, minHeight: 44)
                                    if actions && (e == Reactions.look || e == Reactions.done) {
                                        Circle().fill(Theme.orange).frame(width: 5, height: 5).accessibilityHidden(true)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(actions && e == Reactions.look ? L("react.lookHint") : actions && e == Reactions.done ? L("react.doneHint") : e)
                        }
                    }
                    if actions {
                        Text("\(L("react.lookHint")) · \(L("react.doneHint"))").font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(16)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle(L("react.picker"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("common.close")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func submitTyped() {
        if let e = Reactions.normalize(typed) { pick(e) } else { invalid = true }
    }

    private func pick(_ e: String) {
        onPick(e)
        dismiss()
    }
}

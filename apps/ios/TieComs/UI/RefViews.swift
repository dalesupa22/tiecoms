import SwiftUI

/// Sugerencias al escribir «#» (tanda 1.7 §1): conversaciones que puedo ver (grupos, chats y directos).
struct RefPicker: View {
    let d: BootstrapDTO
    let query: String
    var onPick: (ConversationDTO) -> Void
    var body: some View {
        let list = RefText.candidates(d, query: query)
        if !list.isEmpty {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(list) { c in
                        Button { onPick(c) } label: {
                            HStack(spacing: 10) {
                                ConvIcon(d: d, c: c, size: 28)
                                Text("#" + Naming.title(d, c)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textPrimary).lineLimit(1)
                                Spacer()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("ref.pick.\(c.id)")
                    }
                }
            }
            .frame(maxHeight: 200)
            .background(Theme.surface)
            .overlay(alignment: .top) { Rectangle().fill(Theme.textSecondary.opacity(0.15)).frame(height: 0.5) }
            .accessibilityIdentifier("ref.picker")
        }
    }
}

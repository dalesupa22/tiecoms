import SwiftUI
import UIKit

/// Estilos de texto con menciones (UIKit): cada mención con el color de SU persona; los enlaces http con el acento.
enum RichText {
    static func baseFont() -> UIFont { UIFont.preferredFont(forTextStyle: .body) }
    static func boldFont() -> UIFont {
        let d = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body).withSymbolicTraits(.traitBold) ?? UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)
        return UIFont(descriptor: d, size: 0)
    }

    static func mentionColor(_ m: Mention, mine: Bool) -> UIColor {
        if mine { return .white }
        return UIColor(m.isAll ? Theme.accentText : PersonColor.text(m.userId))
    }

    /// Texto de la burbuja: http subrayado con el color de enlace; menciones en negrita y color de su persona (link tiecoms-mention://).
    static func bubble(_ text: String, mentions: [Mention], mine: Bool, linkify: Bool) -> NSAttributedString {
        let out = NSMutableAttributedString(string: text, attributes: [.font: baseFont(), .foregroundColor: mine ? UIColor.white : UIColor(Theme.textPrimary)])
        if linkify {
            for (r, url) in Linkify.links(in: text) {
                let nr = NSRange(r, in: text)
                out.addAttributes([.link: url, .foregroundColor: mine ? UIColor.white : UIColor(Theme.accentText), .underlineStyle: NSUnderlineStyle.single.rawValue], range: nr)
            }
        }
        for m in MentionText.valid(mentions, in: text) {
            let nr = NSRange(location: m.start, length: m.length)
            out.addAttributes([.font: boldFont(), .foregroundColor: mentionColor(m, mine: mine)], range: nr)
            out.removeAttribute(.underlineStyle, range: nr)
            if !m.isAll, let u = URL(string: "tiecoms-mention://\(m.userId)") { out.addAttribute(.link, value: u, range: nr) } else { out.removeAttribute(.link, range: nr) }
        }
        return out
    }

    /// Compositor: tokens resaltados con el color de la persona y un fondo suave.
    static func applyComposerStyle(_ storage: NSTextStorage, mentions: [Mention]) {
        let full = NSRange(location: 0, length: storage.length)
        storage.beginEditing()
        storage.setAttributes([.font: baseFont(), .foregroundColor: UIColor(Theme.textPrimary)], range: full)
        for m in MentionText.valid(mentions, in: storage.string) {
            let c = mentionColor(m, mine: false)
            storage.addAttributes([.font: boldFont(), .foregroundColor: c, .backgroundColor: c.withAlphaComponent(0.13)], range: NSRange(location: m.start, length: m.length))
        }
        storage.endEditing()
    }
}

/// Texto de burbuja con menciones (UITextView de solo lectura): cada mención con su color y tocable.
struct RichMessageText: UIViewRepresentable {
    let text: String
    let mentions: [Mention]
    let mine: Bool
    let linkify: Bool
    var onMention: (String) -> Void
    @Environment(\.openURL) private var openURL

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false
        v.isSelectable = true
        v.isScrollEnabled = false
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.linkTextAttributes = [:]   // los colores van por tramo
        v.adjustsFontForContentSizeCategory = true
        v.delegate = context.coordinator
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        context.coordinator.parent = self
        v.attributedText = RichText.bubble(text, mentions: mentions, mine: mine, linkify: linkify)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxW = proposal.width ?? 280
        // Ancho real del texto (como Text): la burbuja se ciñe a él.
        let rect = uiView.attributedText.boundingRect(with: CGSize(width: maxW, height: .greatestFiniteMagnitude),
                                                      options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let w = min(maxW, ceil(rect.width) + 1)
        let h = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
        return CGSize(width: w, height: ceil(h))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: RichMessageText
        init(_ p: RichMessageText) { parent = p }
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [parent] _ in
                if url.scheme == "tiecoms-mention", let id = url.host { parent.onMention(id) } else { parent.openURL(url) }
            }
        }
        // Sin menú de edición/selección larga: el menú del mensaje lo da la burbuja.
        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? { nil }
    }
}

/// Compositor con UITextView: tokens de mención resaltados, cursor real (el buscador se abre con @ en cualquier posición),
/// un retroceso borra el token entero, altura automática hasta 5 líneas, placeholder, dictado, pegado y Dynamic Type.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var mentions: [Mention]
    /// Cursor (UTF-16).
    @Binding var cursor: Int
    @Binding var focused: Bool
    var placeholder: String
    var accessibilityLabel: String
    var onChange: (String) -> Void = { _ in }
    static let maxLines: CGFloat = 5

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.font = RichText.baseFont()
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        v.isScrollEnabled = false
        v.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        v.textContainer.lineFragmentPadding = 4
        v.allowsEditingTextAttributes = false   // pegar = texto plano
        v.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
        v.delegate = context.coordinator
        v.accessibilityIdentifier = "composer.field"
        v.accessibilityLabel = accessibilityLabel
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.setContentHuggingPriority(.defaultHigh, for: .vertical)
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if v.text != text {
            c.applying = true
            v.text = text
            RichText.applyComposerStyle(v.textStorage, mentions: mentions)
            let end = min(cursor, (text as NSString).length)
            v.selectedRange = NSRange(location: end, length: 0)
            c.applying = false
        } else if c.styledMentions != mentions, v.markedTextRange == nil {
            let sel = v.selectedRange
            RichText.applyComposerStyle(v.textStorage, mentions: mentions)
            v.selectedRange = sel
        }
        c.styledMentions = mentions
        v.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
        v.accessibilityValue = text.isEmpty ? placeholder : nil
        if focused && !v.isFirstResponder { DispatchQueue.main.async { v.becomeFirstResponder() } }
        if !focused && v.isFirstResponder { DispatchQueue.main.async { v.resignFirstResponder() } }
        let lineH = (v.font ?? RichText.baseFont()).lineHeight
        let maxH = lineH * Self.maxLines + v.textContainerInset.top + v.textContainerInset.bottom
        let wantsScroll = v.contentSize.height > maxH + 1
        if v.isScrollEnabled != wantsScroll { v.isScrollEnabled = wantsScroll }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let w = proposal.width ?? 240
        let lineH = (uiView.font ?? RichText.baseFont()).lineHeight
        let maxH = lineH * Self.maxLines + uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let fit = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
        return CGSize(width: w, height: min(maxH, max(lineH + uiView.textContainerInset.top + uiView.textContainerInset.bottom, ceil(fit))))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        var applying = false
        var styledMentions: [Mention] = []
        init(_ p: ComposerTextView) { parent = p }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText t: String) -> Bool {
            // Retroceso (o borrar una selección) sobre un token: se borra el token entero.
            guard t.isEmpty, textView.markedTextRange == nil, let full = MentionText.expandDeletion(range, mentions: parent.mentions), full != range else { return true }
            let old = textView.text ?? ""
            let new = (old as NSString).replacingCharacters(in: full, with: "")
            let r = MentionText.reconcile(old: old, new: new, mentions: parent.mentions)
            applying = true
            textView.text = r.text
            RichText.applyComposerStyle(textView.textStorage, mentions: r.mentions)
            textView.selectedRange = NSRange(location: full.location, length: 0)
            applying = false
            publish(textView, text: r.text, mentions: r.mentions)
            return false
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !applying else { return }
            let new = textView.text ?? ""
            // Dictado / teclados con texto marcado: se espera a que termine para ajustar menciones y estilos.
            if textView.markedTextRange != nil { publish(textView, text: new, mentions: parent.mentions); return }
            let r = MentionText.reconcile(old: parent.text, new: new, mentions: parent.mentions)
            if r.text != new {
                let sel = textView.selectedRange
                applying = true
                textView.text = r.text
                textView.selectedRange = NSRange(location: min(sel.location, (r.text as NSString).length), length: 0)
                applying = false
            }
            let sel = textView.selectedRange
            RichText.applyComposerStyle(textView.textStorage, mentions: r.mentions)
            textView.selectedRange = sel
            publish(textView, text: r.text, mentions: r.mentions)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying else { return }
            let loc = textView.selectedRange.location
            if parent.cursor != loc { DispatchQueue.main.async { self.parent.cursor = loc } }
        }

        func textViewDidBeginEditing(_ textView: UITextView) { if !parent.focused { DispatchQueue.main.async { self.parent.focused = true } } }
        func textViewDidEndEditing(_ textView: UITextView) { if parent.focused { DispatchQueue.main.async { self.parent.focused = false } } }

        private func publish(_ textView: UITextView, text: String, mentions: [Mention]) {
            styledMentions = mentions
            textView.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
            parent.mentions = mentions
            parent.cursor = textView.selectedRange.location
            parent.text = text
            parent.onChange(text)
            textView.invalidateIntrinsicContentSize()
        }
    }
}

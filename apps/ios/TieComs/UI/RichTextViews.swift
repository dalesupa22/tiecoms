import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Estilos de texto con menciones (UIKit): cada mención con el color de SU persona; los enlaces http con el acento.
enum RichText {
    static func baseFont() -> UIFont { UIFont.preferredFont(forTextStyle: .body) }
    static func boldFont() -> UIFont {
        let d = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body).withSymbolicTraits(.traitBold) ?? UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)
        return UIFont(descriptor: d, size: 0)
    }

    static func mentionColor(_ m: Mention, mine: Bool) -> UIColor {
        if mine { return .white }
        if m.isRef { return UIColor(Theme.accentText) }
        return UIColor(m.isAll ? Theme.accentText : PersonColor.text(m.userId))
    }

    /// Texto de la burbuja: http subrayado con el color de enlace; menciones en negrita y color de su persona (link chaggu-mention://).
    static func bubble(_ raw: String, mentions: [Mention], mine: Bool, linkify: Bool, highlight: String? = nil) -> NSAttributedString {
        // Viñetas «- » → «• » (misma longitud: las menciones no se corren).
        let text = MessageFormat.bullets(raw)
        let literals = MessageFormat.literalRanges(text)
        let out = NSMutableAttributedString(string: text, attributes: [.font: baseFont(), .foregroundColor: mine ? UIColor.white : UIColor(Theme.textPrimary)])
        if linkify {
            for (r, url) in Linkify.links(in: text) {
                let nr = NSRange(r, in: text)
                guard !literals.contains(where: { NSIntersectionRange($0, nr).length > 0 }) else { continue }
                out.addAttributes([.link: url, .foregroundColor: mine ? UIColor.white : UIColor(Theme.accentText), .underlineStyle: NSUnderlineStyle.single.rawValue], range: nr)
            }
        }
        for m in MentionText.valid(mentions, in: text) {
            let nr = NSRange(location: m.start, length: m.length)
            guard !literals.contains(where: { NSIntersectionRange($0, nr).length > 0 }) else { continue }
            out.addAttributes([.font: boldFont(), .foregroundColor: mentionColor(m, mine: mine)], range: nr)
            out.removeAttribute(.underlineStyle, range: nr)
            if let conv = m.refConversationId {
                // #grupo: pastilla del acento que abre el chat (o avisa «No tienes acceso»).
                out.addAttribute(.backgroundColor, value: mine ? UIColor.white.withAlphaComponent(0.22) : UIColor(Theme.accentText).withAlphaComponent(0.12), range: nr)
                if let u = URL(string: "chaggu-ref://\(conv)") { out.addAttribute(.link, value: u, range: nr) }
                continue
            }
            if !m.isAll, let u = URL(string: "chaggu-mention://\(m.userId)") { out.addAttribute(.link, value: u, range: nr) } else { out.removeAttribute(.link, range: nr) }
        }
        // @gg multicolor (web 63e6b0f): la mención a gg o «@gg» escrito a mano.
        GGMention.apply(to: out, text: text, mentions: mentions, mine: mine, font: boldFont())
        for r in literals where NSMaxRange(r) <= out.length {
            out.removeAttribute(.link, range: r); out.removeAttribute(.underlineStyle, range: r)
            out.addAttributes([.font: codeFont(), .foregroundColor: mine ? UIColor.white : UIColor(Theme.textPrimary)], range: r)
        }
        // Formato (*negrilla*, _cursiva_, ~tachado~, `código`) solo en el texto suelto, como la web.
        let spans = formatSpans(text, mentions: mentions)
        for sp in spans where NSMaxRange(sp.range) <= out.length { applyFormat(sp, to: out, mine: mine) }
        // Búsqueda en el chat (tanda 1.7 §6): lo que coincide, resaltado (sin mayúsculas ni tildes).
        if let highlight, highlight.count >= 2 {
            for r in ChatSearch.ranges(of: highlight, in: text) {
                out.addAttribute(.backgroundColor, value: UIColor.systemYellow.withAlphaComponent(mine ? 0.55 : 0.45), range: r)
                if !mine { out.addAttribute(.foregroundColor, value: UIColor.label, range: r) }
            }
        }
        // Las marcas se ocultan al final: los atributos de arriba usan las posiciones del texto original.
        for o in MessageFormat.hiddenOffsets(spans).reversed() where o < out.length {
            out.deleteCharacters(in: NSRange(location: o, length: 1))
        }
        return out
    }

    /// Lo que no lleva formato: menciones, #grupos, @gg y enlaces (en la web van en tramos aparte).
    static func formatSpans(_ text: String, mentions: [Mention]) -> [MessageFormat.Span] {
        guard MessageFormat.mightHaveFormat(text) else { return [] }
        var blocked = MentionText.valid(mentions, in: text).map { NSRange(location: $0.start, length: $0.length) }
        blocked += GGMention.ranges(in: text, mentions: mentions)
        let literal = MessageFormat.literalRanges(text)
        blocked = blocked.filter { r in !literal.contains { NSIntersectionRange($0, r).length > 0 } }
        blocked += Linkify.links(in: text).map { NSRange($0.range, in: text) }.filter { r in !literal.contains { NSIntersectionRange($0, r).length > 0 } }
        return MessageFormat.spans(in: text, excluding: blocked)
    }

    /// Rangos del texto original (p. ej. el brillo de @gg) en el texto ya sin marcas.
    static func displayRanges(_ ranges: [NSRange], text: String, mentions: [Mention]) -> [NSRange] {
        let hidden = MessageFormat.hiddenOffsets(formatSpans(MessageFormat.bullets(text), mentions: mentions))
        guard !hidden.isEmpty else { return ranges }
        return ranges.map { MessageFormat.map($0, hidden: hidden) }
    }

    static func italicFont() -> UIFont {
        let d = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)
        return UIFont(descriptor: d.withSymbolicTraits(.traitItalic) ?? d, size: 0)
    }

    static func codeFont() -> UIFont {
        UIFont.monospacedSystemFont(ofSize: baseFont().pointSize * 0.92, weight: .regular)
    }

    private static func applyFormat(_ sp: MessageFormat.Span, to out: NSMutableAttributedString, mine: Bool) {
        let r = sp.inner
        switch sp.kind {
        case .bold: out.addAttribute(.font, value: boldFont(), range: r)
        case .italic: out.addAttribute(.font, value: italicFont(), range: r)
        case .strike: out.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: r)
        case .code:
            // Monoespaciado con fondo suave (en la burbuja propia, blanco translúcido).
            out.addAttributes([.font: codeFont(),
                               .backgroundColor: mine ? UIColor.white.withAlphaComponent(0.22) : UIColor(Theme.textPrimary).withAlphaComponent(0.08)], range: r)
        }
    }

    /// Clave de la caché de burbujas (1.7.1): mismo texto, menciones, lado, enlaces, resaltado y tamaño de letra.
    struct Key: Hashable {
        var text: String
        var mentions: [Mention]
        var mine: Bool
        var linkify: Bool
        var highlight: String?
        /// Dynamic Type: la fuente va dentro del texto con atributos, así que cambia la clave.
        var sizeCategory: String = ""
    }

    private final class KeyBox: NSObject {
        let key: Key
        init(_ k: Key) { key = k }
        override var hash: Int { key.hashValue }
        override func isEqual(_ object: Any?) -> Bool { (object as? KeyBox)?.key == key }
    }

    private static let bubbleCache: NSCache<KeyBox, NSAttributedString> = {
        let c = NSCache<KeyBox, NSAttributedString>()
        c.countLimit = 600
        return c
    }()

    /// Igual que `bubble(...)`, pero reutiliza el resultado: al volver a pintar una fila (scroll, teclado, llegada de
    /// otro mensaje) no se recorren de nuevo enlaces, menciones ni resaltados. Los colores son dinámicos (claro/oscuro).
    static func cachedBubble(_ key: Key) -> NSAttributedString {
        let box = KeyBox(key)
        if let hit = bubbleCache.object(forKey: box) { RichTextStats.hits += 1; return hit }
        RichTextStats.misses += 1
        let v = bubble(key.text, mentions: key.mentions, mine: key.mine, linkify: key.linkify, highlight: key.highlight)
        bubbleCache.setObject(v, forKey: box, cost: key.text.utf16.count)
        return v
    }

    /// Preview uses raw UTF-16 offsets: markers stay editable, with the same styles as sent text.
    static func applyComposerStyle(_ storage: NSTextStorage, mentions: [Mention]) {
        let full = NSRange(location: 0, length: storage.length)
        storage.beginEditing()
        storage.setAttributes([.font: baseFont(), .foregroundColor: UIColor(Theme.textPrimary)], range: full)
        for m in MentionText.valid(mentions, in: storage.string) {
            let c = mentionColor(m, mine: false)
            storage.addAttributes([.font: boldFont(), .foregroundColor: c, .backgroundColor: c.withAlphaComponent(0.13)], range: NSRange(location: m.start, length: m.length))
        }
        // @gg mientras se escribe: fondo tenue del degradado.
        GGMention.applyComposer(storage, mentions: mentions, font: boldFont())
        for span in formatSpans(storage.string, mentions: mentions) {
            applyFormat(span, to: storage, mine: false)
            for location in [span.range.location, NSMaxRange(span.range) - span.markerWidth] {
                storage.addAttribute(.foregroundColor, value: UIColor.secondaryLabel,
                                     range: NSRange(location: location, length: span.markerWidth))
            }
        }
        for block in CodeMessages.blocks(storage.string) {
            storage.addAttributes([.font: codeFont(), .foregroundColor: UIColor(Theme.textPrimary),
                                   .backgroundColor: UIColor(Theme.textPrimary).withAlphaComponent(0.08)], range: block.range)
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
    var highlight: String? = nil
    /// 0 = sin tope (mensaje muy largo plegado: 30).
    var maxLines = 0
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
        let key = RichText.Key(text: text, mentions: mentions, mine: mine, linkify: linkify, highlight: highlight,
                              sizeCategory: v.traitCollection.preferredContentSizeCategory.rawValue)
        if context.coordinator.key != key {
            context.coordinator.key = key
            v.attributedText = RichText.cachedBubble(key)
            context.coordinator.ggRanges = RichText.displayRanges(GGMention.ranges(in: text, mentions: mentions).filter { r in !MessageFormat.literalRanges(text).contains { NSIntersectionRange($0, r).length > 0 } }, text: text, mentions: mentions)
        }
        // Brillo de @gg: después de maquetar (las posiciones dependen del ancho).
        let gg = context.coordinator.ggRanges
        DispatchQueue.main.async { GGShimmer.update(v, ranges: gg) }
        if v.textContainer.maximumNumberOfLines != maxLines {
            v.textContainer.maximumNumberOfLines = maxLines
            v.textContainer.lineBreakMode = maxLines > 0 ? .byTruncatingTail : .byWordWrapping
            v.invalidateIntrinsicContentSize()
        }
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
        var key: RichText.Key?
        var ggRanges: [NSRange] = []
        init(_ p: RichMessageText) { parent = p }
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [parent] _ in
                if url.scheme == "chaggu-mention", let id = url.host { parent.onMention(id) } else { parent.openURL(url) }
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
    /// Pegar imágenes (menú Pegar o ⌘V, 1.7.1): se adjuntan como si se eligieran de Fotos. nil = solo texto.
    var onPasteAttachments: (([LocalAttachment]) -> Void)? = nil
    var formatting: ComposerFormattingController? = nil
    static let maxLines: CGFloat = 5

    func makeUIView(context: Context) -> UITextView {
        let v = PastingTextView()
        v.formatting = formatting
        formatting?.editor = v
        v.onPasteAttachments = onPasteAttachments
        v.canApplyFormat = { [weak coord = context.coordinator, weak v] command in
            guard let coord, let v, v.markedTextRange == nil else { return false }
            return MessageFormat.compose(v.text ?? "", selection: v.selectedRange, command: command, mentions: coord.parent.mentions) != nil
        }
        v.onWrap = { [weak coord = context.coordinator, weak v] mark in
            guard let coord, let v else { return }
            coord.wrap(v, mark: mark)
        }
        v.font = RichText.baseFont()
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        // Keep UIKit's scrolling layout active even before overflow. With scrolling disabled,
        // contentSize can equal the capped bounds, so it cannot be used to enable scrolling later.
        v.isScrollEnabled = true
        v.alwaysBounceVertical = false
        v.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        v.textContainer.lineFragmentPadding = 4
        v.allowsEditingTextAttributes = false   // pegar = texto plano
        // Sin predicción en línea (iOS 17+): en el iPhone la muestra como texto marcado, y al reemplazar el texto
        // desde fuera (elegir una mención) el teclado seguía con rangos del texto anterior.
        v.inlinePredictionType = .no
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
        (v as? PastingTextView)?.onPasteAttachments = onPasteAttachments
        if v.text != text {
            c.applying = true
            // Texto que llega de fuera (elegir una mención, enviar, editar): primero se cierra el texto marcado
            // (predicción, dictado) para que el teclado no siga con rangos del texto anterior.
            if v.markedTextRange != nil { v.unmarkText() }
            v.text = text
            RichText.applyComposerStyle(v.textStorage, mentions: mentions)
            let end = min(cursor, (text as NSString).length)
            v.selectedRange = NSRange(location: end, length: 0)
            c.applying = false
            (v as? PastingTextView)?.revealSelectionAfterLayout()
        } else if c.styledMentions != mentions, v.markedTextRange == nil {
            let sel = v.selectedRange
            RichText.applyComposerStyle(v.textStorage, mentions: mentions)
            v.selectedRange = sel
        }
        c.styledMentions = mentions
        v.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
        v.accessibilityValue = text.isEmpty ? placeholder : nil
        (v as? PastingTextView)?.refreshFormatCommands()
        // Solo en el CAMBIO de `focused` (flanco): si el teclado se cerró por fuera (deslizar la lista, tocar fuera)
        // `focused` sigue en true un instante hasta que llega textViewDidEndEditing; reenfocar por nivel volvía a
        // abrir el teclado y no había forma de cerrarlo.
        if focused != c.lastFocused {
            c.lastFocused = focused
            if focused && !v.isFirstResponder { DispatchQueue.main.async { [weak v, weak c] in guard let v, let c, !c.tornDown, c.parent.focused, v.window != nil else { return }; v.becomeFirstResponder() } }
            if !focused && v.isFirstResponder { DispatchQueue.main.async { v.resignFirstResponder() } }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let w = proposal.width ?? 240
        let lineH = RichText.baseFont().lineHeight
        let maxH = lineH * Self.maxLines + uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let minH = lineH + uiView.textContainerInset.top + uiView.textContainerInset.bottom
        // Large accessibility text or a landscape keyboard may leave less than five lines.
        let available = min(maxH, max(minH, proposal.height ?? maxH))
        let fit = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude)).height
        return CGSize(width: w, height: min(available, max(minH, ceil(fit))))
    }

    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        coordinator.tornDown = true; coordinator.lastFocused = false
        view.resignFirstResponder(); view.delegate = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var tornDown = false
        var parent: ComposerTextView
        var applying = false
        var styledMentions: [Mention] = []
        var lastSelection = NSRange(location: 0, length: 0)
        /// Último valor de `focused` aplicado al UITextView (para reaccionar solo a cambios).
        var lastFocused = false
        init(_ p: ComposerTextView) { parent = p }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText t: String) -> Bool {
            // Retroceso (o borrar una selección) sobre un token: se borra el token entero.
            let old = textView.text ?? ""
            let length = (old as NSString).length
            guard t.isEmpty, textView.markedTextRange == nil,
                  let full = MentionText.expandDeletion(range, mentions: MentionText.clamped(parent.mentions, length: length), length: length),
                  full != range, full.location + full.length <= length else { return true }
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
            // Dictado / teclados con texto marcado: el texto no se toca hasta que termine, pero las menciones se corren
            // (si no, quedan desfasadas y un retroceso posterior usaría rangos fuera del texto).
            if textView.markedTextRange != nil {
                publish(textView, text: new, mentions: MentionText.shift(old: parent.text, new: new, mentions: parent.mentions))
                return
            }
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
            if lastSelection != textView.selectedRange {
                lastSelection = textView.selectedRange
                (textView as? PastingTextView)?.revealSelectionAfterLayout()
            }
            (textView as? PastingTextView)?.refreshFormatCommands()
            let loc = textView.selectedRange.location
            if parent.cursor != loc { DispatchQueue.main.async { self.parent.cursor = loc } }
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let editor = textView as? PastingTextView else { return nil }
            let actions = ComposerFormattingController.items.map { item in
                UIAction(title: L(item.label), image: UIImage(systemName: item.symbol),
                         attributes: editor.canFormat(item.command) ? [] : .disabled) { [weak editor] _ in editor?.applyFormat(item.command) }
            }
            let format = UIMenu(title: L("composer.format"), image: UIImage(systemName: "textformat"), identifier: .format, children: actions)
            var replaced = false
            func replacingFormat(_ element: UIMenuElement) -> UIMenuElement {
                guard let menu = element as? UIMenu else { return element }
                let hasBold = menu.children.contains { ($0 as? UICommand)?.action == #selector(UIResponderStandardEditActions.toggleBoldface(_:)) }
                if menu.identifier == .format || menu.identifier == .textStyle || hasBold {
                    replaced = true
                    return format
                }
                return menu.replacingChildren(menu.children.map(replacingFormat))
            }
            let existing = suggestedActions.map(replacingFormat)
            return UIMenu(children: existing + (replaced ? [] : [format]))
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            lastFocused = true
            if !parent.focused { DispatchQueue.main.async { self.parent.focused = true } }
        }
        func textViewDidEndEditing(_ textView: UITextView) {
            lastFocused = false
            if parent.focused { DispatchQueue.main.async { self.parent.focused = false } }
        }

        /// ⌘B / ⌘I / ⌘⇧X (o Formato en el menú): envuelve la selección en *, _ o ~ sin partir menciones.
        func wrap(_ textView: UITextView, mark: String) {
            guard textView.markedTextRange == nil,
                  let r = MessageFormat.compose(textView.text ?? "", selection: textView.selectedRange, command: mark, mentions: parent.mentions) else { return }
            applying = true
            // UITextInput replacement keeps UIKit's editing/undo transaction, unlike assigning .text.
            if let range = textView.textRange(from: textView.beginningOfDocument, to: textView.endOfDocument) {
                textView.replace(range, withText: r.text)
            }
            RichText.applyComposerStyle(textView.textStorage, mentions: r.mentions)
            textView.selectedRange = r.selection
            applying = false
            publish(textView, text: r.text, mentions: r.mentions)
        }

        private func publish(_ textView: UITextView, text: String, mentions: [Mention]) {
            styledMentions = mentions
            lastSelection = textView.selectedRange
            (textView as? PastingTextView)?.revealSelectionAfterLayout()
            textView.typingAttributes = [.font: RichText.baseFont(), .foregroundColor: UIColor(Theme.textPrimary)]
            parent.mentions = mentions
            parent.cursor = textView.selectedRange.location
            parent.text = text
            parent.onChange(text)
            (textView as? PastingTextView)?.refreshFormatCommands()
            textView.invalidateIntrinsicContentSize()
        }
    }
}

@MainActor
final class ComposerFormattingController: ObservableObject {
    struct Item {
        let command: String
        let label: String
        let symbol: String
    }
    static let items = [Item(command: "**", label: "composer.bold", symbol: "bold"),
                        Item(command: "_", label: "composer.italic", symbol: "italic"),
                        Item(command: "~", label: "composer.strike", symbol: "strikethrough"),
                        Item(command: "bullets", label: "format.bullets", symbol: "list.bullet"),
                        Item(command: "numbered", label: "format.numbered", symbol: "list.number"),
                        Item(command: "`", label: "format.inlineCode", symbol: "chevron.left.forwardslash.chevron.right"),
                        Item(command: "block", label: "format.code", symbol: "curlybraces.square")]
    weak var editor: PastingTextView?
    @Published private(set) var available: Set<String> = []
    func update(_ commands: Set<String>) {
        guard commands != available else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.available = Set(Self.items.map(\.command).filter { self.editor?.canFormat($0) == true })
        }
    }
    func apply(_ command: String) {
        guard let editor else { return }
        editor.becomeFirstResponder()
        editor.applyFormat(command)
    }
}

struct ComposerFormatMenu: View {
    @ObservedObject var controller: ComposerFormattingController
    var body: some View {
        Menu {
            ForEach(ComposerFormattingController.items, id: \.command) { item in
                Button { controller.apply(item.command) } label: { Label(L(item.label), systemImage: item.symbol) }
                    .disabled(!controller.available.contains(item.command))
                    .accessibilityIdentifier("composer.format." + item.command)
            }
        } label: { Label(L("composer.format"), systemImage: "textformat") }
        .accessibilityIdentifier("composer.plus.format")
    }
}

/// UITextView del compositor que también pega imágenes del portapapeles (capturas, fotos copiadas desde Fotos o Safari):
/// «Pegar» aparece en el menú aunque no haya texto y ⌘V con teclado pasa por aquí. Si además hay texto (no solo un enlace
/// de la imagen), el texto también se pega.
final class PastingTextView: UITextView {
    var onPasteAttachments: (([LocalAttachment]) -> Void)?
    /// Formato con teclado o con Formato ▸ Negrita / Cursiva del menú: envuelve la selección en la marca («*», «_», «~»).
    var onWrap: ((String) -> Void)?
    var canApplyFormat: ((String) -> Bool)?

    weak var formatting: ComposerFormattingController?
    func refreshFormatCommands() {
        let commands = Set(ComposerFormattingController.items.map(\.command).filter(canFormat))
        formatting?.update(commands)
    }

    func canFormat(_ command: String) -> Bool {
        canWrap && (canApplyFormat?(command) ?? true)
    }
    func applyFormat(_ command: String) { if canFormat(command) { onWrap?(command) } }
    /// Portapapeles a usar (las pruebas pasan uno propio).
    var pasteboard: UIPasteboard = .general

    private var revealGeneration = 0
    private var previousSize = CGSize.zero

    func revealSelectionAfterLayout() {
        revealGeneration += 1
        let generation = revealGeneration
        setNeedsLayout()
        DispatchQueue.main.async { [weak self] in
            guard let self, self.revealGeneration == generation, self.isFirstResponder,
                  !self.isDragging, !self.isDecelerating else { return }
            self.layoutIfNeeded()
            // A large paste may still have estimated TextKit 2 fragments outside the viewport.
            if let layout = self.textLayoutManager, let document = layout.textContentManager?.documentRange {
                layout.ensureLayout(for: document)
            }
            self.scrollRangeToVisible(self.selectedRange)
            guard let selection = self.selectedTextRange else { return }
            let caret = self.caretRect(for: selection.end)
            guard caret.height > 0 else { return }
            self.scrollRectToVisible(caret.insetBy(dx: 0, dy: -self.textContainerInset.bottom), animated: false)
        }
    }

    override func layoutSubviews() {
        let resized = previousSize != bounds.size
        previousSize = bounds.size
        super.layoutSubviews()
        // Scrolling changes bounds.origin, not size. A manual pan must not schedule a caret jump.
        if resized { revealSelectionAfterLayout() }
    }

    private var canWrap: Bool { onWrap != nil && markedTextRange == nil }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteAttachments != nil, PasteImages.hasImages(pasteboard) { return true }
        if action == #selector(toggleBoldface(_:)) { return canFormat("**") }
        if action == #selector(toggleItalics(_:)) { return canFormat("_") }
        if action == #selector(strikeSelection(_:)) { return canFormat("~") }
        if action == #selector(toggleUnderline(_:)) { return false }
        return super.canPerformAction(action, withSender: sender)
    }

    // El texto es plano (allowsEditingTextAttributes = false): ⌘B / ⌘I ponen las marcas de la web.
    override func toggleBoldface(_ sender: Any?) { applyFormat("**") }
    override func toggleItalics(_ sender: Any?) { applyFormat("_") }
    @objc func bulletSelection(_ sender: Any?) { applyFormat("bullets") }
    @objc func numberSelection(_ sender: Any?) { applyFormat("numbered") }
    @objc func codeSelection(_ sender: Any?) { applyFormat("`") }
    @objc func blockSelection(_ sender: Any?) { applyFormat("block") }
    @objc func strikeSelection(_ sender: Any?) { applyFormat("~") }

    override var keyCommands: [UIKeyCommand]? {
        let strike = UIKeyCommand(input: "x", modifierFlags: [.command, .shift], action: #selector(strikeSelection(_:)))
        strike.discoverabilityTitle = L("composer.strike")
        return (super.keyCommands ?? []) + [strike]
    }

    override func paste(_ sender: Any?) {
        guard let cb = onPasteAttachments, PasteImages.hasImages(pasteboard) else { super.paste(sender); return }
        let raw = PasteImages.raw(pasteboard)
        if PasteImages.hasPlainText(pasteboard) { super.paste(sender) }
        // Decodificar y reducir una foto de 12 MP toma ~100 ms: fuera del hilo principal.
        Task.detached(priority: .userInitiated) {
            let list = PasteImages.prepare(raw)
            await MainActor.run { if !list.isEmpty { cb(list) } }
        }
    }
}

/// Imágenes del portapapeles → adjuntos listos (mismas reglas que al elegir de Fotos: ImagePrep).
enum PasteImages {
    enum Raw: @unchecked Sendable { case data(Data, UTType), image(UIImage) }

    static func hasImages(_ pb: UIPasteboard) -> Bool { pb.hasImages || pb.contains(pasteboardTypes: [UTType.image.identifier]) }

    /// Texto que vale la pena pegar además de la imagen (no el enlace de la imagen que agrega Safari).
    static func hasPlainText(_ pb: UIPasteboard) -> Bool {
        guard pb.hasStrings, let s = pb.string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return false }
        if let u = URL(string: s), u.scheme?.hasPrefix("http") == true, !s.contains(" ") { return false }
        return true
    }

    /// Lee cada elemento del portapapeles en el hilo principal (UIPasteboard no es seguro fuera de él).
    static func raw(_ pb: UIPasteboard) -> [Raw] {
        var out: [Raw] = []
        let preferred: [UTType] = [.png, .jpeg, .heic, .heif, .gif, .webP, .tiff, .image]
        // Los bytes tal cual (`data(forPasteboardType:inItemSet:)`): `items` convierte PNG/GIF en UIImage y se perdía el
        // formato (un GIF animado quedaba como JPEG fijo).
        for i in 0..<pb.numberOfItems {
            let set = IndexSet(integer: i)
            let keys = pb.types(forItemSet: set)?.first ?? []
            var found: Raw?
            for t in preferred {
                guard let key = keys.first(where: { UTType($0)?.conforms(to: t) == true }) else { continue }
                if let d = pb.data(forPasteboardType: key, inItemSet: set)?.first, !d.isEmpty { found = .data(d, UTType(key) ?? t) }
                else if let img = pb.value(forPasteboardType: key) as? UIImage { found = .image(img) }
                if found != nil { break }
            }
            if let found { out.append(found) }
        }
        if out.isEmpty, let imgs = pb.images { out = imgs.map { .image($0) } }
        return Array(out.prefix(AttachmentRules.maxPerMessage))
    }

    static func prepare(_ raw: [Raw]) -> [LocalAttachment] {
        raw.enumerated().compactMap { i, r in
            switch r {
            case .data(let d, let t):
                let ext = t.preferredFilenameExtension ?? "png"
                return ImagePrep.prepare(d, name: "pegada-\(i + 1).\(ext)", contentType: t.preferredMIMEType ?? "image/png")
            case .image(let img):
                return ImagePrep.jpeg(img).map { LocalAttachment(name: "pegada-\(i + 1).jpg", contentType: "image/jpeg", data: $0) }
            }
        }
    }
}

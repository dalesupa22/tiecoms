import SwiftUI
import UIKit
import XCTest
@testable import TieComs

/// El compositor con texto marcado (predicción en línea del iPhone, dictado, teclados asiáticos) cuando la app
/// reemplaza el texto desde fuera, p. ej. al elegir una mención.
@MainActor
final class ComposerMarkedTextTests: XCTestCase {
    func testReplacingTextWhileMarkedDoesNotCrash() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 300))
        let v = UITextView(frame: window.bounds)
        window.addSubview(v)
        window.makeKeyAndVisible()
        v.becomeFirstResponder()
        v.text = "hola @"
        v.selectedRange = NSRange(location: 6, length: 0)
        v.setMarkedText("br", selectedRange: NSRange(location: 2, length: 0))
        XCTAssertNotNil(v.markedTextRange)
        // Como ComposerTextView.updateUIView: primero se cierra el texto marcado y luego se pone el texto nuevo.
        if v.markedTextRange != nil { v.unmarkText() }
        v.text = "@"
        RichText.applyComposerStyle(v.textStorage, mentions: [Mention(userId: "bob", start: 0, length: 12)])
        v.selectedRange = NSRange(location: min(20, (v.text as NSString).length), length: 0)
        XCTAssertNil(v.markedTextRange)
        XCTAssertEqual(v.text, "@")
        v.resignFirstResponder()
    }
}


@MainActor
private final class ComposerProbe: ObservableObject {
    @Published var text = ""
    @Published var mentions: [Mention] = []
    @Published var cursor = 0
    @Published var focused = false
}

private struct ComposerProbeView: View {
    @ObservedObject var model: ComposerProbe
    var body: some View {
        VStack {
            Color.clear
            HStack(alignment: .bottom) {
                Text("+").frame(width: 34)
                ComposerTextView(text: $model.text, mentions: $model.mentions, cursor: $model.cursor, focused: $model.focused, placeholder: "QA", accessibilityLabel: "QA")
                Text("↑").frame(width: 40)
            }.padding(12)
        }
    }
}

extension ComposerMarkedTextTests {
    private func settle(_ window: UIWindow) async throws {
        try await Task.sleep(nanoseconds: 350_000_000)
        window.layoutIfNeeded()
    }
    private func composer(in view: UIView) -> PastingTextView? {
        if let editor = view as? PastingTextView { return editor }
        return view.subviews.compactMap { composer(in: $0) }.first
    }
    func testLongDraftKeepsCaretVisibleAndCanScrollItsFullText() async throws {
        let model = ComposerProbe()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: ComposerProbeView(model: model))
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await settle(window)
        let editor = try XCTUnwrap(composer(in: host.view))
        model.focused = true
        try await settle(window)
        XCTAssertTrue(editor.becomeFirstResponder())
        try await settle(window)
        for line in 1...100 {
            editor.insertText("Línea \(line) 👋\n")
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try await settle(window)
        let original = (1...100).map { "Línea \($0) 👋\n" }.joined()
        XCTAssertEqual(model.text, original)
        XCTAssertEqual(editor.text, original)
        let caret = editor.caretRect(for: try XCTUnwrap(editor.selectedTextRange).end)
        print("COMPOSER_PROBE responder=\(editor.isFirstResponder) key=\(window.isKeyWindow) text=\(editor.text.utf16.count) frame=\(editor.frame) bounds=\(editor.bounds) content=\(editor.contentSize) scroll=\(editor.isScrollEnabled) offset=\(editor.contentOffset) caret=\(caret)")
        XCTAssertTrue(editor.isScrollEnabled, "long drafts must allow scrolling")
        XCTAssertGreaterThan(editor.contentSize.height, editor.bounds.height)
        XCTAssertGreaterThan(editor.contentOffset.y, 0, "typing the end must reveal the caret")
        XCTAssertLessThanOrEqual(caret.maxY, editor.bounds.maxY - editor.adjustedContentInset.bottom + 2)
        editor.setContentOffset(.zero, animated: false)
        try await settle(window)
        XCTAssertEqual(editor.contentOffset.y, 0, accuracy: 1, "manual scroll must stay at start")
        XCTAssertEqual(editor.text, original)
        editor.resignFirstResponder()
    }
    func testComposerPreviewUsesRealBoldAndCodeFontsWithoutChangingRawText() {
        let raw = "**Negrita** y `let x = 1`"
        let storage = NSTextStorage(string: raw)
        RichText.applyComposerStyle(storage, mentions: [])
        XCTAssertEqual(storage.string, raw)
        let bold = storage.attribute(.font, at: 2, effectiveRange: nil) as? UIFont
        let code = storage.attribute(.font, at: (raw as NSString).range(of: "let").location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(bold?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        XCTAssertTrue(code?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true)
    }
}

extension ComposerMarkedTextTests {
    private func hosted(_ model: ComposerProbe) async throws -> (UIWindow, PastingTextView) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: ComposerProbeView(model: model))
        window.rootViewController = host; window.makeKeyAndVisible()
        try await settle(window)
        let editor = try XCTUnwrap(composer(in: host.view))
        model.focused = true
        try await settle(window)
        XCTAssertTrue(editor.becomeFirstResponder())
        try await settle(window)
        return (window, editor)
    }
    private func assertCaretVisible(_ editor: UITextView, file: StaticString = #filePath, line: UInt = #line) throws {
        let caret = editor.caretRect(for: try XCTUnwrap(editor.selectedTextRange).end)
        XCTAssertGreaterThan(caret.height, 5, file: file, line: line)
        XCTAssertGreaterThanOrEqual(caret.minY, editor.bounds.minY - 2, file: file, line: line)
        XCTAssertLessThanOrEqual(caret.maxY, editor.bounds.maxY + 2, file: file, line: line)
    }
    func testPasteEditStartMiddleEndResizeAndDraftRoundTrip() async throws {
        let model = ComposerProbe()
        let (window, editor) = try await hosted(model)
        defer { editor.resignFirstResponder(); window.isHidden = true }
        let original = (1...100).map { "Línea \($0): 👩🏽‍💻 texto largo" }.joined(separator: "\n")
        editor.insertText(original) // Bulk input; native clipboard is covered by the UI fixture.
        try await settle(window)
        XCTAssertEqual(model.text, original)
        try assertCaretVisible(editor)
        var expected = original
        for (needle, addition) in [("Línea 1:", "INICIO "), ("Línea 50:", "MEDIO "), ("Línea 100:", "FINAL ")] {
            editor.setContentOffset(.zero, animated: false)
            let location = (expected as NSString).range(of: needle).location
            editor.selectedRange = NSRange(location: location, length: 0)
            editor.insertText(addition)
            expected = (expected as NSString).replacingCharacters(in: NSRange(location: location, length: 0), with: addition)
            try await settle(window)
            XCTAssertEqual(model.text, expected)
            try assertCaretVisible(editor)
        }
        window.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
        try await settle(window)
        XCTAssertEqual(model.text, expected)
        try assertCaretVisible(editor)
        editor.setContentOffset(.zero, animated: false)
        try await settle(window)
        XCTAssertEqual(editor.contentOffset.y, 0, accuracy: 1)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try DraftStorage.save(ComposerDraft(text: model.text, mentions: [], files: [], gifs: [], voice: nil), to: url)
        XCTAssertEqual(DraftStorage.load(url)?.text, expected)
        for count in [7999, 8000, 8001] {
            model.text = String(repeating: "a", count: count); model.cursor = count
            try await settle(window)
            XCTAssertEqual(editor.text.utf16.count, count, "editing never truncates at send limit")
            XCTAssertEqual(model.text, editor.text)
        }
    }
    func testToolbarAtCaretSelectedTextUndoAndMarkedText() async throws {
        let model = ComposerProbe()
        let (window, editor) = try await hosted(model)
        defer { editor.resignFirstResponder(); window.isHidden = true }
        XCTAssertNil(editor.inputAccessoryView, "format controls must not occupy permanent keyboard height")
        editor.toggleBoldface(nil)
        XCTAssertEqual(model.text, "****")
        XCTAssertEqual(editor.selectedRange, NSRange(location: 2, length: 0))
        editor.insertText("Negrita")
        try await settle(window)
        XCTAssertEqual(model.text, "**Negrita**")
        XCTAssertEqual(RichText.bubble(model.text, mentions: [], mine: false, linkify: false).string, "Negrita")
        editor.selectedRange = NSRange(location: 2, length: 7)
        editor.toggleBoldface(nil)
        try await settle(window)
        XCTAssertEqual(model.text, "Negrita")
        editor.undoManager?.undo()
        try await settle(window)
        XCTAssertEqual(model.text, "**Negrita**", "format operation must undo without losing prior text")
        editor.undoManager?.redo()
        try await settle(window)
        XCTAssertEqual(model.text, "Negrita")
        editor.selectedRange = NSRange(location: 0, length: 7)
        editor.codeSelection(nil)
        try await settle(window)
        XCTAssertEqual(model.text, "`Negrita`")
        let rendered = RichText.bubble(model.text, mentions: [], mine: false, linkify: false)
        XCTAssertEqual(rendered.string, "Negrita")
        XCTAssertTrue((rendered.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true)
        editor.selectedRange = NSRange(location: editor.text.utf16.count, length: 0)
        editor.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0))
        let markedRaw = editor.text
        XCTAssertNotNil(editor.markedTextRange)
        editor.toggleBoldface(nil)
        try await settle(window)
        XCTAssertNotNil(editor.markedTextRange)
        XCTAssertEqual(editor.text, markedRaw, "formatting must not rewrite an IME composition")
        editor.unmarkText()
    }
    func testFormattingMultilineEmojiMentionAndMidlineBlock() throws {
        let text = "👩🏽‍💻 hola\nsegunda\n@Ana"
        let mention = Mention(userId: "ana", start: (text as NSString).range(of: "@Ana").location, length: 4)
        let range = NSRange(location: 0, length: (text as NSString).range(of: "\n@Ana").location)
        let formatted = try XCTUnwrap(MessageFormat.compose(text, selection: range, command: "**", mentions: [mention]))
        XCTAssertEqual(formatted.text, "**👩🏽‍💻 hola**\n**segunda**\n@Ana")
        XCTAssertEqual((formatted.text as NSString).substring(with: NSRange(location: formatted.mentions[0].start, length: 4)), "@Ana")
        XCTAssertEqual(RichText.bubble(formatted.text, mentions: formatted.mentions, mine: false, linkify: false).string, text)
        XCTAssertNil(MessageFormat.compose(text, selection: NSRange(location: mention.start + 1, length: 0), command: "**", mentions: [mention]))
        let block = try XCTUnwrap(MessageFormat.compose("antes hola después", selection: NSRange(location: 6, length: 4), command: "block", mentions: []))
        XCTAssertEqual(CodeMessages.blocks(block.text).count, 1)
        XCTAssertEqual(CodeMessages.blocks(block.text).first?.code, "hola\n")
        let code = try XCTUnwrap(MessageFormat.compose("uno\ndos", selection: NSRange(location: 0, length: 7), command: "`", mentions: []))
        XCTAssertEqual(CodeMessages.blocks(code.text).count, 1)
        let legacy = try XCTUnwrap(MessageFormat.compose("*hola*", selection: NSRange(location: 1, length: 4), command: "**", mentions: []))
        XCTAssertEqual(legacy.text, "hola")
    }
}

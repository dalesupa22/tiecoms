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

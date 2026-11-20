import SwiftUI
import XCTest
@testable import Dray

final class HighlightTests: XCTestCase {
    func testFenceCarriesItsLanguage() {
        guard case .code(let code, let lang) = markdownBlocks("```swift title\nlet a = 1\n```").first else {
            return XCTFail("no code block")
        }
        XCTAssertEqual(code, "let a = 1")
        XCTAssertEqual(lang, "swift")
    }

    func testLanguageFromPath() {
        XCTAssertEqual(highlightLanguage("src/app.tsx"), "tsx")
        XCTAssertEqual(highlightLanguage("Makefile"), "makefile")
        XCTAssertEqual(highlightLanguage(".gitignore"), ".gitignore")
    }

    /// One line per source line, a comment spanning two keeping its colour on both,
    /// and nothing for a grammar the bundle lacks.
    func testColoursLinesAcrossASpan() async throws {
        let code = "/* one\n   two */\nconst a = \"x\" < 1 && b"
        let read = await Highlighter.shared.lines(code, lang: "ts")
        let lines = try XCTUnwrap(read)
        XCTAssertEqual(lines.map { String($0.characters) }, code.components(separatedBy: "\n"))
        let comment = Color(hex: 0x737373)
        XCTAssertEqual(lines[0].runs.first?.foregroundColor, comment)
        XCTAssertEqual(lines[1].runs.first?.foregroundColor, comment)
        XCTAssertTrue(lines[2].runs.contains { $0.foregroundColor == Color(hex: 0xFF678D) }, "const is a keyword")
        let nothing = await Highlighter.shared.lines(code, lang: "brainfreeze")
        XCTAssertNil(nothing)
    }

    /// An untagged block is coloured only on a confident guess: JSON by parsing, never prose.
    func testGuessesOnlyWhenSure() async throws {
        let json = await Highlighter.shared.lines("{\n  \"id\": 1\n}", lang: nil)
        XCTAssertEqual(try XCTUnwrap(json)[1].runs.first { $0.foregroundColor != nil }?.foregroundColor, Color(hex: 0xFF855E))
        let prose = await Highlighter.shared.lines("Some plain words in a block", lang: nil)
        XCTAssertNil(prose)
    }
}

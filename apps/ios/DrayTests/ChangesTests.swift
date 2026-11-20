import XCTest
@testable import Dray

final class ChangesTests: XCTestCase {
    func testUnifiedDiffFoldsUnchangedLines() {
        let old = (1...20).map { "l\($0)" }.joined(separator: "\n") + "\n"
        let new = old.replacingOccurrences(of: "l10\n", with: "ten\n") + "l21\n"
        let rows = unifiedDiff(old: old, new: new, context: 2)
        XCTAssertEqual(rows.first, .gap(7))
        XCTAssertTrue(rows.contains(.line(sign: "-", number: 10, text: "l10")))
        XCTAssertTrue(rows.contains(.line(sign: "+", number: 10, text: "ten")))
        XCTAssertEqual(rows.last, .line(sign: "+", number: 21, text: "l21"))
        XCTAssertEqual(unifiedDiff(old: nil, new: "a\nb"), [.line(sign: "+", number: 1, text: "a"), .line(sign: "+", number: 2, text: "b"), .noNewline])
        XCTAssertEqual(unifiedDiff(old: "same", new: "same"), [])
    }

    /// Adding or dropping the final newline is a change, said the way git says it.
    func testFinalNewlineIsAChange() {
        XCTAssertEqual(unifiedDiff(old: "a\nb\n", new: "a\nb"), [
            .line(sign: " ", number: 1, text: "a"), .line(sign: "-", number: 2, text: "b"),
            .line(sign: "+", number: 2, text: "b"), .noNewline,
        ])
        XCTAssertEqual(unifiedDiff(old: "a\nb", new: "a\nb\n"), [
            .line(sign: " ", number: 1, text: "a"), .line(sign: "-", number: 2, text: "b"), .noNewline,
            .line(sign: "+", number: 2, text: "b"),
        ])
        XCTAssertEqual(unifiedDiff(old: "a", new: "a"), [])
    }

    /// Windows line endings split per line and keep their CR, so CRLF to LF is a change too.
    func testCRLFSplitsPerLine() {
        let old = "a\r\nb\r\nc\r\n"
        XCTAssertEqual(unifiedDiff(old: old, new: "a\r\nB\r\nc\r\n"), [
            .line(sign: " ", number: 1, text: "a\r"), .line(sign: "-", number: 2, text: "b\r"),
            .line(sign: "+", number: 2, text: "B\r"), .line(sign: " ", number: 3, text: "c\r"),
        ])
        XCTAssertEqual(unifiedDiff(old: old, new: "a\r\nb\r\nc"), [
            .line(sign: " ", number: 1, text: "a\r"), .line(sign: " ", number: 2, text: "b\r"),
            .line(sign: "-", number: 3, text: "c\r"), .line(sign: "+", number: 3, text: "c"), .noNewline,
        ])
        XCTAssertEqual(unifiedDiff(old: old, new: "a\nb\r\nc\r\n").filter { if case .line(let s, _, _) = $0 { s != " " } else { false } }, [
            .line(sign: "-", number: 1, text: "a\r"), .line(sign: "+", number: 1, text: "a"),
        ])
    }

    /// The desktop's picks for the same paths, each an asset the catalog holds.
    func testFileIconsMatchTheDesktop() {
        let cases = [("src/main.ts", false, "fi-typescript"), ("package.json", false, "fi-nodejs"),
                     ("README.md", false, "fi-readme"), ("a/b.swift", false, "fi-swift"), ("x.unknownext", false, "fi-file"),
                     ("apps/src", true, "fi-folder-src"), ("Dray", true, "fi-folder")]
        for (path, folder, want) in cases {
            XCTAssertEqual(FileIcons.name(path, folder: folder), want, path)
            XCTAssertNotNil(UIImage(named: want), want)
        }
    }
}

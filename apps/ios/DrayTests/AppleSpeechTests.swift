import XCTest
@testable import Dray

/// Apple's on-device model reads a real recording, on an iOS 26 phone. The
/// fixture was made on the Mac, where `say -o` writes a file and plays nothing:
///   say -o speech.wav --data-format=LEI16@16000 "Add a dark mode toggle to the settings page"
@MainActor
final class AppleSpeechTests: XCTestCase {
    func testReadsSpeech() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("the simulator's analyzer offers no audio format")
        #else
        guard #available(iOS 26, *) else { throw XCTSkip("needs iOS 26") }
        let wav = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "speech", withExtension: "wav"))
        await AppleSpeech.shared.refresh()
        try XCTSkipIf(!AppleSpeech.shared.usable, "no Apple model for this device or language")
        guard case .text(let words) = try await AppleSpeech.shared.transcribe(wav) else {
            return XCTFail("no words read")
        }
        XCTAssertTrue(words.localizedCaseInsensitiveContains("dark mode"), words)
        XCTAssertEqual(AppleSpeech.shared.status, .ready)
        #endif
    }
}

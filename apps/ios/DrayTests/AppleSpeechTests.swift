import XCTest
@testable import Dray

/// Apple's on-device model reads a real recording, on an iOS 26 phone: the
/// simulator's analyzer offers no audio format, so it fails there. Make the WAV
/// on the Mac, where `say -o` writes the file and plays nothing:
///   say -o /tmp/speech.wav --data-format=LEI16@16000 "Add a dark mode toggle to the settings page"
///   TEST_RUNNER_DRAY_WAV=/tmp/speech.wav xcodebuild test -only-testing:DrayTests/AppleSpeechTests
@MainActor
final class AppleSpeechTests: XCTestCase {
    func testReadsSpeech() async throws {
        guard let path = ProcessInfo.processInfo.environment["DRAY_WAV"] else { throw XCTSkip("set TEST_RUNNER_DRAY_WAV") }
        guard #available(iOS 26, *) else { throw XCTSkip("needs iOS 26") }
        await AppleSpeech.shared.refresh()
        try XCTSkipIf(!AppleSpeech.shared.usable, "no Apple model for this device or language")
        guard case .text(let words) = try await AppleSpeech.shared.transcribe(URL(filePath: path)) else {
            return XCTFail("no words read")
        }
        XCTAssertTrue(words.localizedCaseInsensitiveContains("dark mode"), words)
        XCTAssertEqual(AppleSpeech.shared.status, .ready)
    }
}

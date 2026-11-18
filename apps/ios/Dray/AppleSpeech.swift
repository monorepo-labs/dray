import AVFoundation
import Speech
import UIKit

/// Apple's on-device speech models (`SpeechAnalyzer`, iOS 26 and up): the
/// recording is read on the phone, so dictation works where no server can
/// transcribe. A model is a system asset, downloaded once per language.
@MainActor @Observable
final class AppleSpeech {
    static let shared = AppleSpeech()
    /// Settings' pick for this engine, stored where a server's id would be.
    static let pick = "apple"

    enum Status: Equatable {
        case needsNewerOS, checking, unsupported, needsDownload, downloading(Double), ready
    }
    private(set) var status: Status

    init() {
        if #available(iOS 26, *) { status = .checking } else { status = .needsNewerOS }
    }

    /// Can take a recording: a model not yet down comes down on first use. Checking counts,
    /// or every launch would flash the docks to keyboard mode before the answer lands.
    var usable: Bool { status != .needsNewerOS && status != .unsupported }

    /// "iPhone" or "iPad", for "on this iPhone".
    static var device: String { UIDevice.current.model }

    func refresh() async {
        guard #available(iOS 26, *) else { return }
        if case .downloading = status { return }
        guard let module = await Self.module() else { status = .unsupported; return }
        status = switch await AssetInventory.status(forModules: [module]) {
        case .installed: .ready
        case .downloading: .downloading(0)
        case .supported: .needsDownload
        default: .unsupported
        }
    }

    /// Fetches the model ahead of the first dictation: Settings' pick, or a recording starting.
    func download() {
        guard #available(iOS 26, *), status == .needsDownload else { return }
        Task {
            guard let module = await Self.module() else { return }
            try? await install(module)
        }
    }

    /// Reads a recording on the phone, downloading the model first where it is missing.
    /// Asks no speech recognition permission: that is `SFSpeechRecognizer`'s, whose prompt
    /// tells the reader their speech goes to Apple, and this model reads it here.
    func transcribe(_ wav: URL) async throws -> TranscribeOutcome {
        guard #available(iOS 26, *) else { throw DrayError("Needs iOS 26 and above") }
        guard let module = await Self.module() else {
            throw DrayError("Apple's speech model doesn't support \(Locale.current.localizedString(forIdentifier: Locale.current.identifier) ?? "this language") yet")
        }
        try await install(module)
        // The analyzer takes its own format, never the file's: read the WAV, convert, feed one buffer.
        let file = try AVAudioFile(forReading: wav)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module], considering: file.processingFormat),
              let read = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
        else { throw DrayError("Couldn't read the recording") }
        try file.read(into: read)
        let buffer = try Self.convert(read, to: format)
        // Collected before the analyzer starts, or results it finishes early go unread.
        let words = Self.words(module)
        let analyzer = SpeechAnalyzer(modules: [module])
        let (input, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
        feed.yield(AnalyzerInput(buffer: buffer))
        feed.finish()
        do {
            _ = try await analyzer.analyzeSequence(input)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            words.cancel()
            throw error
        }
        let text = try await words.value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? .empty : .text(text)
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        if buffer.format == format { return buffer }
        let frames = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024
        guard let converter = AVAudioConverter(from: buffer.format, to: format),
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
        else { throw DrayError("Couldn't read the recording") }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .endOfStream
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if let error { throw error }
        return out
    }

    /// The newer model where the phone runs it; otherwise the one behind the
    /// keyboard's own dictation, which runs on more phones and the simulator.
    @available(iOS 26, *)
    private static func module() async -> (any SpeechModule)? {
        if SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .current) {
            return SpeechTranscriber(locale: locale, preset: .transcription)
        }
        guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: .current) else { return nil }
        return DictationTranscriber(locale: locale, preset: .longDictation)
    }

    @available(iOS 26, *)
    private static func words(_ module: any SpeechModule) -> Task<String, Error> {
        func collect<S: AsyncSequence>(_ results: S, _ text: @escaping (S.Element) -> AttributedString) -> Task<String, Error> {
            Task { try await results.reduce(into: "") { $0 += String(text($1).characters) } }
        }
        if let m = module as? SpeechTranscriber { return collect(m.results) { $0.text } }
        return collect((module as! DictationTranscriber).results) { $0.text }
    }

    @available(iOS 26, *)
    private func install(_ module: any SpeechModule) async throws {
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) else {
            status = .ready
            return
        }
        status = .downloading(0)
        let progress = request.progress
        let watch = Task {
            while !Task.isCancelled {
                status = .downloading(progress.fractionCompleted)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { watch.cancel() }
        do {
            try await request.downloadAndInstall()
            status = .ready
        } catch {
            status = .needsDownload
            throw error
        }
    }
}

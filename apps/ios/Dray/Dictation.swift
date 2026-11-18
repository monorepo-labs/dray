import AVFoundation
import SwiftUI
import UIKit

/// `transcription.rs`'s `TranscribeOutcome`. An unknown kind reads as a failure naming it.
enum TranscribeOutcome: Decodable {
    case text(String)
    case needsModel
    case noAudio
    case empty
    case failed(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        switch try c.decode(String.self, forKey: "kind") {
        case "text": self = .text(try c.decode(String.self, forKey: "value"))
        case "needsModel": self = .needsModel
        case "noAudio": self = .noAudio
        case "empty": self = .empty
        case "failed":
            let v = try c.nestedContainer(keyedBy: Key.self, forKey: "value")
            self = .failed(try v.decode(String.self, forKey: "message"))
        case let kind: self = .failed("The server answered \(kind)")
        }
    }
}

/// What turns the phone's voice into words: Apple's model on the phone, or a server's.
enum DictationEngine: Equatable {
    case apple
    case server(UUID)
}

extension Store {
    func canDictate(_ server: UUID) -> Bool {
        serverState[server] == .connected && connection(server)?.dictation == true
    }

    func canDictate(_ engine: DictationEngine) -> Bool {
        switch engine {
        case .apple: AppleSpeech.shared.usable
        case .server(let id): canDictate(id)
        }
    }

    /// Nothing can transcribe, so the docks trade the orb for a text field. Read off each
    /// server's last welcome, kept across a drop, so a blip never swaps the dock mid-reply;
    /// one not yet reached counts as able.
    var typesOnly: Bool {
        !AppleSpeech.shared.usable && !live.contains { connection($0.id)?.welcome.map { $0.dictation == true } ?? true }
    }

    /// Settings' pick while it can; otherwise the first server that can, then
    /// Apple's model on the phone. Words come back to the phone, so any
    /// session's draft can take them.
    func dictationEngine(_ pick: String) -> DictationEngine? {
        if pick == AppleSpeech.pick, AppleSpeech.shared.usable { return .apple }
        if let id = UUID(uuidString: pick), canDictate(id) { return .server(id) }
        if let id = servers.first(where: { canDictate($0.id) })?.id { return .server(id) }
        return AppleSpeech.shared.usable ? .apple : nil
    }

    func name(of engine: DictationEngine) -> String {
        switch engine {
        case .apple: AppleSpeech.device
        case .server(let id): name(of: id)
        }
    }

    /// Uploads a recording and has the server's model read it. A long
    /// dictation, on a model loading cold, can outlast the usual minute.
    func transcribe(_ server: UUID, wav: URL) async throws -> TranscribeOutcome {
        guard let c = connection(server) else { throw DrayError("Not connected") }
        let path = try await c.upload(wav, name: "dictation.wav")
        return try await call(server, "transcribe_upload", ["path": .string(path)], timeout: .seconds(300))
    }

    /// `appendToDraft`'s join: a space unless the draft is empty or already ends in one.
    func appendToDraft(_ key: SessionKey, _ text: String) {
        let draft = drafts[key] ?? ""
        drafts[key] = draft.isEmpty || draft.last!.isWhitespace ? draft + text : draft + " " + text
    }
}

/// Every dictation, per draft, outliving the composer that started it: a
/// recording sent on leaving a session answers into a view that is gone, and
/// its words, its sentence or its kept file must still be there on the way back.
@MainActor @Observable
final class Dictations {
    static let shared = Dictations()
    private(set) var phase: [SessionKey: Dictation] = [:]
    private(set) var since: [SessionKey: Date] = [:]
    var notes: [SessionKey: String] = [:]
    /// A recording the server never answered for, kept for Retry: the only copy of the speech.
    private(set) var kept: [SessionKey: URL] = [:]
    /// What reads each draft's recording, taken at the press.
    @ObservationIgnored private var engines: [SessionKey: DictationEngine] = [:]
    @ObservationIgnored private var recorders: [SessionKey: AVAudioRecorder] = [:]
    /// The transcription each draft is waiting on. Cancel clears it, so an
    /// answer landing after that is dropped rather than written in.
    @ObservationIgnored private var pending: [SessionKey: UUID] = [:]
    /// Times the app has left the screen. A send that saw this move was cut off
    /// by leaving, though the socket's error may only land once it is back.
    @ObservationIgnored private var leaves = 0

    init() {
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.leaves += 1 }
        }
    }

    func state(_ draft: SessionKey) -> Dictation { phase[draft] ?? .idle }

    /// Settings, Dictation's "Start and stop sounds": the system's own record tones.
    static let soundsKey = "dictation.sounds"
    /// A server's id, or `AppleSpeech.pick`. Named for when servers were the only engine.
    static let serverKey = "dictation.server"
    private static var sounds: Bool { UserDefaults.standard.object(forKey: soundsKey) as? Bool ?? true }

    /// The microphone's loudest sample since last asked, linear, as the orb reads it.
    func level(_ draft: SessionKey) -> Float {
        guard let r = recorders[draft] else { return 0 }
        r.updateMeters()
        return pow(10, r.peakPower(forChannel: 0) / 20)
    }

    func start(_ store: Store, engine: DictationEngine, draft: SessionKey) async {
        guard state(draft) == .idle, kept[draft] == nil else { return }
        phase[draft] = .starting
        notes[draft] = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            phase[draft] = nil
            notes[draft] = "Dray can't use the microphone. Allow it in Settings, under Privacy, Microphone."
            return
        }
        // Apple's model comes down while the reader talks, rather than after.
        if engine == .apple { AppleSpeech.shared.download() }
        // Cancelled while the prompt was up: no microphone nothing can stop.
        guard phase[draft] == .starting else { return }
        // Before the record category, which mutes output.
        if Self.sounds { AudioServicesPlaySystemSound(1113) }
        do {
            try AVAudioSession.sharedInstance().setCategory(.record)
            try AVAudioSession.sharedInstance().setActive(true)
            // What the server's models read and `recordings::read` accepts.
            let r = try AVAudioRecorder(
                url: FileManager.default.temporaryDirectory.appending(path: "dictation-\(UUID()).wav"),
                settings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: 16000,
                    AVNumberOfChannelsKey: 1,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false,
                ])
            r.isMeteringEnabled = true
            guard r.record() else { throw DrayError("The microphone would not start") }
            recorders[draft] = r
            engines[draft] = engine
            since[draft] = Date()
            phase[draft] = .recording
            Haptic.firm()
        } catch {
            release()
            phase[draft] = nil
            notes[draft] = error.localizedDescription
        }
    }

    /// Ends the recording and sends it. The draft is captured here, so words
    /// land in the draft they were spoken into even if the reader has moved on.
    func stop(_ store: Store, draft: SessionKey) async {
        guard let r = recorders.removeValue(forKey: draft), let engine = engines[draft] else { return }
        r.stop()
        release()
        if Self.sounds { AudioServicesPlaySystemSound(1114) }
        since[draft] = nil
        Haptic.tap()
        await send(store, engine, draft, r.url)
    }

    /// Two controls, as on the desktop: Cancel throws the words away, Stop keeps them.
    func cancel(_ draft: SessionKey) {
        if let r = recorders.removeValue(forKey: draft) {
            r.stop()
            r.deleteRecording()
            release()
        }
        since[draft] = nil
        // A read in flight owns the note (Apple's download line); its own clear skips a cancelled run.
        if pending.removeValue(forKey: draft) != nil { notes[draft] = nil }
        phase[draft] = nil
    }

    func retry(_ store: Store, draft: SessionKey) async {
        guard let url = kept.removeValue(forKey: draft), let engine = engines[draft] else { return }
        notes[draft] = nil
        await send(store, engine, draft, url)
    }

    /// Closing the note without retrying is the reader letting the recording go.
    func dismiss(_ draft: SessionKey) {
        notes[draft] = nil
        if let url = kept.removeValue(forKey: draft) { try? FileManager.default.removeItem(at: url) }
    }

    /// The file goes once the engine has answered, whatever it said; a send
    /// that never reached it keeps the file for Retry. Leaving the app keeps
    /// it running for the system's grace; a send cut off by suspension goes
    /// again once the app is back, since the server dropped the reply with the socket.
    private func send(_ store: Store, _ engine: DictationEngine, _ draft: SessionKey, _ url: URL) async {
        let run = UUID()
        pending[draft] = run
        phase[draft] = .transcribing
        let left = leaves
        var grace = UIBackgroundTaskIdentifier.invalid
        grace = UIApplication.shared.beginBackgroundTask(withName: "Dictation") {
            UIApplication.shared.endBackgroundTask(grace)
            grace = .invalid
        }
        defer {
            if grace != .invalid { UIApplication.shared.endBackgroundTask(grace) }
            if pending[draft] == run {
                pending[draft] = nil
                phase[draft] = nil
            }
        }
        do {
            let outcome: TranscribeOutcome
            switch engine {
            case .server(let server): outcome = try await store.transcribe(server, wav: url)
            case .apple:
                if AppleSpeech.shared.status != .ready { notes[draft] = "Downloading Apple's speech model. This happens once." }
                defer { if pending[draft] == run { notes[draft] = nil } }
                outcome = try await AppleSpeech.shared.transcribe(url)
            }
            try? FileManager.default.removeItem(at: url)
            guard pending[draft] == run else { return }
            switch outcome {
            case .text(let words):
                store.appendToDraft(draft, words)
                Haptic.success()
            case .needsModel: notes[draft] = "\(store.name(of: engine)) has no transcription model. Download one in Dray's settings, under Transcription."
            case .noAudio: notes[draft] = "No sound reached the microphone."
            case .empty: notes[draft] = "No words heard."
            case .failed(let message): notes[draft] = sentence(message)
            }
        } catch {
            guard pending[draft] == run else {
                try? FileManager.default.removeItem(at: url)
                return
            }
            if leaves != left {
                // Polled: a suspended app spends nothing on it.
                while UIApplication.shared.applicationState != .active { try? await Task.sleep(for: .seconds(1)) }
                for _ in 0..<40 where !store.canDictate(engine) { try? await Task.sleep(for: .milliseconds(500)) }
                guard pending[draft] == run else {
                    try? FileManager.default.removeItem(at: url)
                    return
                }
                if store.canDictate(engine) { return await send(store, engine, draft, url) }
            }
            kept[draft] = url
            notes[draft] = "Couldn't transcribe: \(error.localizedDescription)"
        }
    }

    private func release() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

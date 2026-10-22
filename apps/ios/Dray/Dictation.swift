import AVFoundation
import SwiftUI

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

extension Connection {
    /// `POST /upload`, the server's own route for a file from another machine.
    /// Answers the path it landed at, on the server's disk.
    func upload(_ file: URL, name: String) async throws -> String {
        guard var parts = socketURL(url).flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }) else {
            throw DrayError("Not an address: \(url)")
        }
        parts.scheme = parts.scheme == "wss" ? "https" : "http"
        parts.path = "/upload"
        parts.queryItems = [URLQueryItem(name: "name", value: name)]
        var request = URLRequest(url: parts.url!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw DrayError("The upload was refused (\((response as? HTTPURLResponse)?.statusCode ?? 0))")
        }
        return String(decoding: data, as: UTF8.self)
    }
}

extension Store {
    func canDictate(_ server: UUID) -> Bool {
        serverState[server] == .connected && connection(server)?.dictation == true
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
    /// The server each draft's recording goes to, taken at the press.
    @ObservationIgnored private var servers: [SessionKey: UUID] = [:]
    @ObservationIgnored private var recorders: [SessionKey: AVAudioRecorder] = [:]

    func state(_ draft: SessionKey) -> Dictation { phase[draft] ?? .idle }

    /// The microphone's loudest sample since last asked, linear, as the orb reads it.
    func level(_ draft: SessionKey) -> Float {
        guard let r = recorders[draft] else { return 0 }
        r.updateMeters()
        return pow(10, r.peakPower(forChannel: 0) / 20)
    }

    func start(_ store: Store, server: UUID, draft: SessionKey) async {
        guard state(draft) == .idle, kept[draft] == nil else { return }
        phase[draft] = .starting
        notes[draft] = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            phase[draft] = nil
            notes[draft] = "Dray can't use the microphone. Allow it in Settings, under Privacy, Microphone."
            return
        }
        // Cancelled while the prompt was up: no microphone nothing can stop.
        guard phase[draft] == .starting else { return }
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
            servers[draft] = server
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
        guard let r = recorders.removeValue(forKey: draft), let server = servers[draft] else { return }
        r.stop()
        release()
        since[draft] = nil
        Haptic.tap()
        await send(store, server, draft, r.url)
    }

    /// Two controls, as on the desktop: Cancel throws the words away, Stop keeps them.
    func cancel(_ draft: SessionKey) {
        if let r = recorders.removeValue(forKey: draft) {
            r.stop()
            r.deleteRecording()
            release()
        }
        since[draft] = nil
        phase[draft] = nil
    }

    func retry(_ store: Store, draft: SessionKey) async {
        guard let url = kept.removeValue(forKey: draft), let server = servers[draft] else { return }
        notes[draft] = nil
        await send(store, server, draft, url)
    }

    /// Closing the note without retrying is the reader letting the recording go.
    func dismiss(_ draft: SessionKey) {
        notes[draft] = nil
        if let url = kept.removeValue(forKey: draft) { try? FileManager.default.removeItem(at: url) }
    }

    /// The file goes once the server has answered, whatever it said; a send
    /// that never reached it keeps the file for Retry.
    private func send(_ store: Store, _ server: UUID, _ draft: SessionKey, _ url: URL) async {
        phase[draft] = .transcribing
        defer { phase[draft] = nil }
        do {
            let outcome = try await store.transcribe(server, wav: url)
            try? FileManager.default.removeItem(at: url)
            switch outcome {
            case .text(let words):
                store.appendToDraft(draft, words)
                Haptic.success()
            case .needsModel: notes[draft] = "\(store.name(of: server)) has no transcription model. Download one in Dray's settings, under Transcription."
            case .noAudio: notes[draft] = "No sound reached the microphone."
            case .empty: notes[draft] = "No words heard."
            case .failed(let message): notes[draft] = sentence(message)
            }
        } catch {
            kept[draft] = url
            notes[draft] = "Couldn't transcribe: \(error.localizedDescription)"
        }
    }

    private func release() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// The mic, where the server can transcribe. Pressing it opens the voice orb in
/// its place; nothing else of dictation draws until then.
struct DictateButton: View {
    @Environment(Store.self) private var store
    let server: UUID
    let draft: SessionKey

    var body: some View {
        // A kept recording is retried or let go first, or a new one would bury its Retry.
        if store.canDictate(server) && Dictations.shared.state(draft) == .idle && Dictations.shared.kept[draft] == nil {
            Button {
                Task { await Dictations.shared.start(store, server: server, draft: draft) }
            } label: {
                Image(systemName: "mic")
            }
            .buttonStyle(IconButtonStyle())
            .accessibilityLabel("Dictate")
            // The keyboard's own mic is also "Dictate".
            .accessibilityIdentifier("dictate")
        }
    }
}

/// A dictation under way: the voice orb hearing the reader, how long it has
/// run, and the two ways out. Transcribing keeps the orb, curled and turning.
struct DictationBar: View {
    @Environment(Store.self) private var store
    let draft: SessionKey
    private let shared = Dictations.shared

    var body: some View {
        let state = shared.state(draft)
        HStack(spacing: Theme.Space.s) {
            // Polled at the island's ~20fps; the orb eases between readings itself.
            TimelineView(.animation(minimumInterval: 1 / 20, paused: state != .recording)) { _ in
                VoiceOrb(size: 36, level: state == .recording ? shared.level(draft) : 0, state: state)
            }
            .frame(width: 36, height: 36)
            .accessibilityHidden(true)
            if state == .transcribing {
                Text("Transcribing…").font(Theme.Font.callout).foregroundStyle(Theme.secondary).shimmer()
            } else {
                RecordingTimer(since: shared.since[draft])
            }
            Spacer(minLength: 0)
            if state != .transcribing {
                Button { shared.cancel(draft) } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle())
                    .accessibilityLabel("Cancel dictation")
                Button { Task { await shared.stop(store, draft: draft) } } label: { Image(systemName: "checkmark") }
                    .buttonStyle(IconButtonStyle(filled: true))
                    .disabled(state != .recording)
                    .accessibilityLabel("Stop dictation")
            }
        }
        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .trailing)))
    }
}

/// What a dictation said instead of words, inside the composer, with Retry
/// where the recording was kept.
struct DictationNote: View {
    @Environment(Store.self) private var store
    let draft: SessionKey

    var body: some View {
        if let note = Dictations.shared.notes[draft] {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Image(systemName: "waveform").foregroundStyle(Theme.tertiary)
                Text(note).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if Dictations.shared.kept[draft] != nil {
                    Button("Retry") { Task { await Dictations.shared.retry(store, draft: draft) } }
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.text)
                }
                Button { Dictations.shared.dismiss(draft) } label: { Image(systemName: "xmark") }
                    .foregroundStyle(Theme.tertiary)
                    .accessibilityLabel("Dismiss")
            }
            .font(Theme.Font.meta)
            .buttonStyle(.borderless)
        }
    }
}

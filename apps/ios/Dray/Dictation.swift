import AVFoundation
import SwiftUI

/// The server's first frame, for the one field the phone reads off it.
struct Welcome: Decodable {
    let dictation: Bool?
}

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

/// Records on the phone, transcribes on the server, appends to the draft.
/// The mic is drawn only where the server says it can transcribe; a recording
/// or answer already under way stays on screen through a dropped socket, or
/// the words spoken so far would go with it.
struct DictateButton: View {
    @Environment(Store.self) private var store
    let key: SessionKey
    @State private var recorder: AVAudioRecorder?
    @State private var transcribing = false
    @State private var note: String?
    /// A recording the server never answered for, kept for Retry: the only copy of the speech.
    @State private var kept: URL?
    /// False once the controls are gone, so a start still waiting on the
    /// permission prompt does not open a microphone nothing can stop.
    @State private var shown = false

    var body: some View {
        let can = store.canDictate(key.server)
        if can || recorder != nil || transcribing || note != nil {
            HStack(spacing: 8) {
                if transcribing {
                    Orb().frame(width: 30, height: 30)
                } else if recorder != nil {
                    // Two controls, as on the desktop: they mean opposite things about the words.
                    Button(action: cancel) {
                        Image(systemName: "xmark.circle.fill").font(.title)
                    }
                    .tint(.secondary)
                    .accessibilityLabel("Cancel dictation")
                    Button { Task { await stop() } } label: {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .tint(.red)
                    .accessibilityLabel("Stop dictation")
                } else if can {
                    Button { Task { await start() } } label: {
                        Image(systemName: "mic.circle.fill").font(.title)
                    }
                    .accessibilityLabel("Dictate")
                }
            }
            .popover(isPresented: Binding(get: { note != nil }, set: { if !$0 { dismissNote() } })) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(note ?? "").font(.callout)
                    if let url = kept {
                        Button("Retry") {
                            // Taken first, so the dismissal below discards nothing.
                            kept = nil
                            note = nil
                            Task { await send(url) }
                        }
                    }
                }
                .padding()
                .presentationCompactAdaptation(.popover)
            }
            .onAppear { shown = true }
            // Leaving the session mid-recording sends what was said, which
            // lands in the draft it was spoken into, the desktop's rule.
            .onDisappear {
                shown = false
                if recorder != nil { Task { await stop() } }
            }
        }
    }

    private func start() async {
        guard await AVAudioApplication.requestRecordPermission() else {
            note = "Dray can't use the microphone. Allow it in Settings, under Privacy, Microphone."
            return
        }
        guard shown else { return }
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
            guard r.record() else { throw DrayError("The microphone would not start") }
            recorder = r
        } catch {
            release()
            note = error.localizedDescription
        }
    }

    private func stop() async {
        guard let r = recorder else { return }
        r.stop()
        recorder = nil
        release()
        await send(r.url)
    }

    /// The key is captured here, so words land in the draft they were spoken
    /// into even if the reader has moved on by the time the model answers.
    /// The file goes once the server has answered, whatever it said; a send
    /// that never reached it keeps the file for Retry.
    private func send(_ url: URL) async {
        transcribing = true
        defer { transcribing = false }
        do {
            let outcome = try await store.transcribe(key.server, wav: url)
            try? FileManager.default.removeItem(at: url)
            switch outcome {
            case .text(let words): store.appendToDraft(key, words)
            case .needsModel: note = "\(store.name(of: key.server)) has no transcription model. Download one in Dray's Settings, under Transcription."
            case .noAudio: note = "No sound reached the microphone."
            case .empty: note = "No words heard."
            case .failed(let message): note = message
            }
        } catch {
            kept = url
            note = error.localizedDescription
        }
    }

    /// Closing the popover without retrying is the reader letting the recording go.
    private func dismissNote() {
        note = nil
        if let url = kept { try? FileManager.default.removeItem(at: url) }
        kept = nil
    }

    private func cancel() {
        guard let r = recorder else { return }
        r.stop()
        r.deleteRecording()
        recorder = nil
        release()
    }

    private func release() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

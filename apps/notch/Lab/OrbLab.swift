import AVFoundation
import SwiftUI

/// The real panel's, in Composer.swift; the lab builds without the composer.
enum Dictation { case idle, starting, recording, transcribing }

/// Every candidate dictation orb side by side, live at the panel's two sizes
/// (#568). A demo, kept: open it again when the orb is next in question.
@main
struct OrbLabApp: App {
    @State private var model = LabModel()

    init() {
        if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), i + 1 < CommandLine.arguments.count {
            let only = CommandLine.arguments[(i + 2)...].compactMap(OrbStyle.init(rawValue:))
            let ok = Snapshot.write(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]), only: only.isEmpty ? OrbStyle.allCases : only)
            exit(ok ? 0 : 1)
        }
    }

    var body: some Scene {
        // One window, so closing it quits the lab and the microphone with it.
        Window("Orb Lab", id: "lab") {
            LabView(model: model)
                .preferredColorScheme(.dark)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1320, height: 880)
    }
}

enum LevelSource: String, CaseIterable { case speech = "Fake speech", slider = "Slider", mic = "Microphone" }

/// The panel's inputs, faked: a state and a level polled at the panel's ~20fps.
@MainActor @Observable
final class LabModel {
    var state = Dictation.recording
    var source = LevelSource.speech {
        didSet { source == .mic ? mic.start() : mic.stop() }
    }
    /// 0…1 as the orbs see it; the panel's raw level is a quarter of that.
    var slider = 0.5
    private(set) var level: Float = 0
    var palette: OrbPalette? = OrbPalette.all[0]
    var selected = OrbStyle.clearPrism
    var micError: String? { mic.error }

    private let mic = Mic()
    private var speech = FakeSpeech()

    init() {
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
    }

    private func poll() {
        switch source {
        case .speech: level = speech.next()
        case .slider: level = Float(slider) / 4
        case .mic: level = mic.take()
        }
    }
}

/// Syllables in phrases with pauses between: bursts at ~5Hz, uneven loudness,
/// at the panel's raw scale (speech peaks around 0.05–0.25).
struct FakeSpeech {
    private var talking = true
    private var left = 2.0
    private var syllable = 0.0
    private var loud = 0.8
    private var rate = 5.0

    mutating func next() -> Float {
        let dt = 0.05
        left -= dt
        if left <= 0 {
            talking.toggle()
            left = talking ? .random(in: 1.2...4) : .random(in: 0.25...1.2)
        }
        guard talking else { return .random(in: 0...0.004) }
        syllable += dt * rate
        if syllable >= 1 {
            syllable -= 1
            loud = .random(in: 0.35...1)
            rate = .random(in: 3.5...6.5)
        }
        let env = pow(sin(.pi * syllable), 0.6) * loud
        return Float(env * 0.24 * .random(in: 0.8...1.15))
    }
}

/// The loudest sample since last asked, the way `transcription_level` answers.
final class Mic: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var peak: Float = 0
    private(set) var error: String?
    private var running = false

    func start() {
        guard !running else { return }
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buf, _ in
            guard let self, let ch = buf.floatChannelData else { return }
            var m: Float = 0
            for i in 0..<Int(buf.frameLength) { m = max(m, abs(ch[0][i])) }
            self.lock.withLock { self.peak = max(self.peak, m) }
        }
        do {
            try engine.start()
            running = true
            error = nil
        } catch {
            input.removeTap(onBus: 0)
            self.error = "Microphone: \(error.localizedDescription)"
        }
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
    }

    func take() -> Float { lock.withLock { defer { peak = 0 }; return peak } }
}

struct LabView: View {
    @Bindable var model: LabModel

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                Controls(model: model)
                Divider()
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: model.palette == nil ? 470 : 230), spacing: 12)], spacing: 12) {
                        ForEach(OrbStyle.allCases) { style in
                            Card(style: style, model: model)
                        }
                    }
                    .padding(16)
                }
            }
            Divider()
            Detail(model: model).frame(width: 340)
        }
        .background(Color(white: 0.11))
    }
}

private struct Controls: View {
    @Bindable var model: LabModel

    var body: some View {
        // Two rows, so the controls fit beside the detail pane at the narrowest window.
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 16) {
                Picker("State", selection: $model.state) {
                    Text("Idle").tag(Dictation.idle)
                    Text("Starting").tag(Dictation.starting)
                    Text("Recording").tag(Dictation.recording)
                    Text("Transcribing").tag(Dictation.transcribing)
                }
                .pickerStyle(.segmented)
                .frame(width: 320)
                Spacer()
                Picker("Palette", selection: $model.palette) {
                    Text("All").tag(OrbPalette?.none)
                    ForEach(OrbPalette.all) { Text($0.name).tag(OrbPalette?.some($0)) }
                }
                .frame(width: 170)
            }
            HStack(spacing: 16) {
                Picker("Level", selection: $model.source) {
                    ForEach(LevelSource.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .frame(width: 200)
                if model.source == .slider {
                    Slider(value: $model.slider, in: 0...1).frame(width: 140)
                }
                Meter(level: model.level)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottomLeading) {
            if let e = model.micError {
                Text(e).font(.caption).foregroundStyle(.red).padding(.leading, 16).padding(.bottom, 2)
            }
        }
    }
}

private struct Meter: View {
    let level: Float
    var body: some View {
        Capsule().fill(.white.opacity(0.1))
            .overlay(alignment: .leading) {
                Capsule().fill(.white.opacity(0.7)).frame(width: 80 * CGFloat(min(1, level * 4)))
            }
            .frame(width: 80, height: 5)
            .animation(.linear(duration: 0.05), value: level)
    }
}

/// One candidate: at 48pt and 24pt on the panel's black, per palette.
private struct Card: View {
    let style: OrbStyle
    @Bindable var model: LabModel

    var body: some View {
        let on = model.selected == style
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 18) {
                ForEach(model.palette.map { [$0] } ?? OrbPalette.all) { p in
                    VStack(spacing: 8) {
                        LabOrb(style: style, size: 48, level: model.level, state: model.state, palette: p)
                        LabOrb(style: style, size: 24, level: model.level, state: model.state, palette: p)
                        if model.palette == nil {
                            Text(p.name).font(.system(size: 9)).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(.black, in: RoundedRectangle(cornerRadius: 10))
            Text(style.name).font(.system(size: 13, weight: .semibold))
            Text(style.note).font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .background(Color(white: on ? 0.2 : 0.15), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(on ? 0.35 : 0), lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { model.selected = style }
    }
}

/// The picked candidate up close, in a mock of the panel, and across palettes.
private struct Detail: View {
    @Bindable var model: LabModel

    var body: some View {
        let style = model.selected
        let palette = model.palette ?? OrbPalette.all[0]
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(style.name).font(.title2.weight(.semibold))
                Text(style.note).font(.callout).foregroundStyle(.secondary)
                Text(style.cost).font(.caption).foregroundStyle(.tertiary)
                LabOrb(style: style, size: 160, level: model.level, state: model.state, palette: palette)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                    .background(.black, in: RoundedRectangle(cornerRadius: 14))
                Text("In the panel").font(.headline)
                Text("The compact layout, at rest and while dictating.")
                    .font(.caption).foregroundStyle(.secondary)
                PanelMock(style: style, level: model.level, state: model.state, palette: palette)
                    .frame(maxWidth: .infinity)
                Text("Palettes").font(.headline)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 12) {
                    ForEach(OrbPalette.all) { p in
                        VStack(spacing: 6) {
                            LabOrb(style: style, size: 48, level: model.level, state: model.state, palette: p)
                            Text(p.name).font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(.black, in: RoundedRectangle(cornerRadius: 10))
                        .onTapGesture { model.palette = p }
                    }
                }
            }
            .padding(16)
        }
    }
}

/// The notch panel's compact layout, which stays compact while dictating:
/// the orb beside the input, the input saying what the microphone is doing.
private struct PanelMock: View {
    let style: OrbStyle
    let level: Float
    let state: Dictation
    let palette: OrbPalette

    var body: some View {
        HStack(spacing: 10) {
            LabOrb(style: style, size: 24, level: level, state: state, palette: palette)
            Text(hint).font(.system(size: 13)).foregroundStyle(.tertiary)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: hint)
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(width: 300, height: 44)
        .background(.black, in: UnevenRoundedRectangle(bottomLeadingRadius: 20, bottomTrailingRadius: 20))
    }

    private var hint: String {
        switch state {
        case .idle: "Reply to Dray…"
        case .starting, .recording: "Listening…"
        case .transcribing: "Transcribing…"
        }
    }
}

/// `--snapshot <dir> [style…]`: every candidate, or those named, at fixed moments, written as PNGs, so
/// the shaders can be checked without a screen.
@MainActor
enum Snapshot {
    /// False, having said why on stderr, where any sheet could not be written.
    static func write(to dir: URL, only styles: [OrbStyle]) -> Bool {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("\(dir.path): \(error.localizedDescription)\n".utf8))
            return false
        }
        var ok = true
        // Name, state, voice, and how far into transcribing: "turning" is a transition caught halfway.
        let moments: [(String, Dictation, Double, Double)] = [
            ("idle", .idle, 0, 0), ("soft", .recording, 0.3, 0), ("loud", .recording, 1, 0),
            ("turning", .transcribing, 0, 0.5), ("work", .transcribing, 0, 1),
        ]
        for p in OrbPalette.all {
            let sheet = VStack(alignment: .leading, spacing: 6) {
                ForEach(styles) { style in
                    HStack(spacing: 10) {
                        Text(style.name).font(.system(size: 11)).foregroundStyle(.white).frame(width: 90, alignment: .leading)
                        ForEach(moments, id: \.0) { m in
                            let f = OrbFrame(size: 96, t: 12.3, spin: 1.2 * m.3, curl: m.3, level: m.2, energy: m.2 * 0.7,
                                             rec: m.1 == .recording ? 1 : 0, work: m.3)
                            style.draw(f, palette: p)
                            style.draw(OrbFrame(size: 24, t: f.t, spin: f.spin, curl: f.curl, level: f.level, energy: f.energy,
                                                rec: f.rec, work: f.work), palette: p)
                        }
                    }
                }
            }
            .padding(12)
            .background(.black)
            let r = ImageRenderer(content: sheet)
            r.scale = 2
            let file = dir.appendingPathComponent("\(p.name).png")
            do {
                guard let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
                try png.write(to: file)
            } catch {
                FileHandle.standardError.write(Data("\(file.path): \(error.localizedDescription)\n".utf8))
                ok = false
            }
        }
        return ok
    }
}

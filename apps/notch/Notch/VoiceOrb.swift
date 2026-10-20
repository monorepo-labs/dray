import SwiftUI

/// Siri's orb, roughly: four coloured blobs drifting inside a circle, blurred
/// into one another. Slow at rest, quicker and swelling with the voice while
/// recording, breathing while the model works.
struct VoiceOrb: View {
    let size: CGFloat
    let level: Float
    let state: Dictation

    private static let colors: [Color] = [
        Color(red: 1.0, green: 0.32, blue: 0.62),
        Color(red: 0.56, green: 0.32, blue: 1.0),
        Color(red: 0.18, green: 0.52, blue: 1.0),
        Color(red: 0.2, green: 0.9, blue: 0.86),
    ]

    var body: some View {
        // ponytail: redraws at 30fps whenever it is on screen; pause at rest if it ever shows up in Activity Monitor.
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
            let speed = state == .recording ? 1.8 : state == .transcribing ? 1.1 : 0.45
            let t = context.date.timeIntervalSinceReferenceDate * speed
            let swell = state == .recording ? CGFloat(min(level * 4, 1)) * 0.22 : 0
            let breath = state == .transcribing ? CGFloat(sin(t * 3)) * 0.05 : 0
            ZStack {
                Circle().fill(Color(white: 0.08))
                ForEach(0..<4, id: \.self) { i in
                    let phase = Double(i) * .pi / 2
                    Circle()
                        .fill(Self.colors[i])
                        .frame(width: size * 0.7, height: size * 0.7)
                        .offset(x: cos(t + phase) * size * 0.2, y: sin(t * 1.3 + phase) * size * 0.2)
                        .blur(radius: size * 0.14)
                }
                // A highlight up and to the left, so it reads as a sphere rather than a disc.
                Circle().fill(RadialGradient(colors: [.white.opacity(0.35), .clear], center: .init(x: 0.35, y: 0.3), startRadius: 0, endRadius: size * 0.5))
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .opacity(state == .idle ? 0.85 : 1)
            .scaleEffect(1 + swell + breath)
            .animation(.easeOut(duration: 0.1), value: level)
        }
        .frame(width: size, height: size)
    }
}

/// How long the microphone has been open, mm:ss. Holds its space while the
/// microphone is shut, so starting a recording moves nothing.
struct RecordingTimer: View {
    let since: Date?

    var body: some View {
        TimelineView(.periodic(from: since ?? .now, by: 1)) { context in
            let s = since.map { max(0, Int(context.date.timeIntervalSince($0))) } ?? 0
            Text(String(format: "%d:%02d", s / 60, s % 60))
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(.secondary)
                .opacity(since == nil ? 0 : 1)
        }
    }
}

import SwiftUI

/// The dictation orb: clear dark glass with sunlight caught inside it, split
/// into a rainbow band with a white filament through it (#568). A wave flows
/// along the band, swelling with the voice; transcribing curls the band into
/// an arc that orbits the rim, and stopping brings the arc home before it
/// uncurls, so no change of state ever jumps.
struct VoiceOrb: View {
    let size: CGFloat
    let level: Float
    let state: Dictation

    var body: some View {
        OrbDriver(size: size, level: level, state: state) { PrismOrb(frame: $0) }
    }
}

/// The `prism` shader in VoiceOrb.metal, in any four colours. What ships is
/// clear glass split into the true rainbow; the Orb Lab draws the rest.
struct PrismOrb: View {
    let frame: OrbFrame
    var colors: [Color] = Self.rainbow
    var frosted = false
    /// The real rainbow, rather than `colors` in order.
    var spectral = true

    /// What the shader takes where `spectral` leaves it a palette to read.
    static let rainbow = [Color(red: 1, green: 0.45, blue: 0.25), Color(red: 1, green: 0.85, blue: 0.3),
                          Color(red: 0.3, green: 0.85, blue: 1), Color(red: 0.55, green: 0.4, blue: 1)]

    var body: some View {
        let extras: [Shader.Argument] = [.float(frosted ? 1 : 0), .float(spectral ? 1 : 0),
                                         .float(Float(frame.spin)), .float(Float(frame.curl))]
        Rectangle()
            .colorEffect(Shader(function: ShaderLibrary.default.prism,
                                arguments: frame.args + colors.map { .color($0) } + extras))
            .frame(width: frame.size, height: frame.size)
    }
}

/// One frame of an orb, every input already eased, so whatever draws it holds
/// no state of its own.
struct OrbFrame {
    var size: CGFloat
    /// Runs faster while recording or working, and a little with sustained speech.
    var t: Double
    /// The transcribing orbit's angle, radians; zero at rest.
    var spin: Double
    /// 0…1 into orbiting: rises with transcribing, falls once the orbit is home.
    var curl: Double
    /// The voice, 0…1, eased over ~0.15s.
    var level: Double
    /// The voice eased over ~1s: how much has been said lately.
    var energy: Double
    /// 0…1 into recording, counted from the press.
    var rec: Double
    /// 0…1 into transcribing.
    var work: Double

    /// The inputs every orb shader takes after SwiftUI's own, in `ORB_ARGS` order, palette aside.
    var args: [Shader.Argument] {
        [.float2(size, size), .float(t), .float(level), .float(energy), .float(rec), .float(work)]
    }
}

/// Turns the panel's raw inputs into eased frames, a display frame at a time.
/// The level arrives as a peak polled at ~20fps, so it is eased twice: fast
/// for what the voice is doing now, slow for how much it has been saying.
struct OrbDriver<Content: View>: View {
    let size: CGFloat
    let level: Float
    let state: Dictation
    @ViewBuilder let draw: (OrbFrame) -> Content

    var body: some View {
        let voice = state == .recording ? min(1, Double(level) * 4) : 0
        // Lively from the press, not from the microphone opening a moment later.
        let rec = [.starting, .recording].contains(state) ? 1.0 : 0
        let work = state == .transcribing ? 1.0 : 0
        Smooth(value: voice, animation: .spring(duration: 0.15)) { level in
            Smooth(value: voice, animation: .spring(duration: 1)) { energy in
                Smooth(value: rec, animation: .easeInOut(duration: 0.45)) { rec in
                    Smooth(value: work, animation: .easeInOut(duration: 0.45)) { work in
                        // ponytail: 30fps at rest, 60 while dictating; pause at rest if it ever shows up in Activity Monitor.
                        TimelineView(.animation(minimumInterval: state == .idle ? 1 / 30 : 1 / 60)) { context in
                            let clock = OrbClock.advance(
                                to: context.date.timeIntervalSinceReferenceDate,
                                rate: 0.35 + 0.8 * rec + 0.6 * work + 0.3 * energy,
                                working: state == .transcribing)
                            draw(OrbFrame(size: size, t: clock.t, spin: clock.spin, curl: clock.curl,
                                          level: level, energy: energy, rec: rec, work: work))
                        }
                    }
                }
            }
        }
        .frame(width: size, height: size)
    }
}

/// A phase that runs at a variable rate, so speeding up never jumps. One for
/// the process: every orb on screen hears the same voice, and the panel swaps
/// between two orb views on a layout change, which must not restart it.
@MainActor
enum OrbClock {
    private static var phase = 0.0
    private static var spin = 0.0
    private static var curl = 0.0
    private static var last: Double?

    /// The phase, the transcribing orbit's angle, and how far into orbiting
    /// the orb is, 0…1. The orbit starts from rest and speeds up as it curls
    /// in. Once transcribing ends it finishes its lap, easing to a stop where
    /// it began, and only then uncurls, so nothing riding it snaps back or
    /// turns after it has let go.
    static func advance(to now: Double, rate: Double, working: Bool) -> (t: Double, spin: Double, curl: Double) {
        if let last, now > last {
            let dt = min(now - last, 0.1)
            phase += dt * rate
            let winding = !working && spin > 0
            curl += ((working || winding ? 1 : 0) - curl) * (1 - exp(-dt / 0.15))
            if working {
                spin += dt * 2.6 * curl
            } else if winding {
                let home = (spin / (2 * .pi)).rounded(.up) * 2 * .pi
                spin += dt * min(2.6, max(0.4, 3 * (home - spin)))
                if spin >= home - 0.002 { spin = 0 }
            }
        }
        if now > last ?? 0 { last = now }
        // ponytail: wraps hourly, one visible jump; phase in Double and pass time as a fract-ed pair if anyone sees it.
        return (phase.truncatingRemainder(dividingBy: 3600), spin.truncatingRemainder(dividingBy: 2 * .pi), curl)
    }
}

/// Eases its value with whatever animation is in the transaction.
private struct Eased<Content: View>: View, Animatable {
    var value: Double
    let content: (Double) -> Content
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View { content(value) }
}

private struct Smooth<Content: View>: View {
    let value: Double
    let animation: Animation
    @ViewBuilder let content: (Double) -> Content
    var body: some View { Eased(value: value, content: content).animation(animation, value: value) }
}

/// How long the microphone has been open, mm:ss. Dim at 0:00 while it is
/// still opening, so the pill is whole from the press.
struct RecordingTimer: View {
    let since: Date?

    var body: some View {
        TimelineView(.periodic(from: since ?? .now, by: 1)) { context in
            let s = since.map { max(0, Int(context.date.timeIntervalSince($0))) } ?? 0
            Text(String(format: "%d:%02d", s / 60, s % 60))
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(.secondary)
                .opacity(since == nil ? 0.4 : 1)
        }
    }
}

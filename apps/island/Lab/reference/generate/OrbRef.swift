// Renders reference frames and videos of the shipped island voice orb
// (PrismOrb from apps/island/Island/VoiceOrb.swift) with no app, server or mic.
// Usage: OrbRef.app/Contents/MacOS/OrbRef <out-dir> <speech-audio>
import AVFoundation
import AppKit
import SwiftUI

/// One render target: the orb's size in points and the pixel scale.
struct Variant { let name: String; let points: CGFloat; let scale: CGFloat }

let variants = [
    Variant(name: "24pt@1x", points: 24, scale: 1),
    Variant(name: "24pt@2x", points: 24, scale: 2),
    Variant(name: "96pt@2x-detail", points: 96, scale: 2),
]

@MainActor
func png(_ frame: OrbFrame, _ v: Variant) -> Data {
    var f = frame
    f.size = v.points
    let view = PrismOrb(frame: f).frame(width: v.points, height: v.points).background(.black)
    let r = ImageRenderer(content: view)
    r.scale = v.scale
    let rep = NSBitmapImageRep(cgImage: r.cgImage!)
    return rep.representation(using: .png, properties: [:])!
}

/// SwiftUI's `.spring(duration:)`: critically damped, response `d`, velocity kept on retarget.
struct Spring {
    let d: Double
    var x = 0.0, v = 0.0
    mutating func step(to target: Double, dt: Double) {
        let w = 2 * Double.pi / d
        let n = 20
        for _ in 0..<n {
            let h = dt / Double(n)
            let a = -w * w * (x - target) - 2 * w * v
            v += a * h
            x += v * h
        }
    }
}

/// SwiftUI's `.easeInOut(duration:)`, cubic Bézier (0.42, 0, 0.58, 1), restarted from where it is on a new target.
struct Ease {
    let d: Double
    var from = 0.0, to = 0.0, start = -1e9, x = 0.0
    mutating func step(to target: Double, now: Double) -> Double {
        if target != to { from = x; to = target; start = now }
        let p = min(1, max(0, (now - start) / d))
        x = from + (to - from) * Ease.curve(p)
        return x
    }
    static func curve(_ p: Double) -> Double {
        // Solve the Bézier's x(s) = p for s, then return y(s).
        func bx(_ s: Double) -> Double { 3 * (1 - s) * (1 - s) * s * 0.42 + 3 * (1 - s) * s * s * 0.58 + s * s * s }
        func by(_ s: Double) -> Double { 3 * (1 - s) * s * s + s * s * s }
        var lo = 0.0, hi = 1.0
        for _ in 0..<40 { let m = (lo + hi) / 2; if bx(m) < p { lo = m } else { hi = m } }
        return by((lo + hi) / 2)
    }
}

/// Peak of each 50ms window, the way the island polls `transcription_level`.
func peaks(_ url: URL, gain: Float) -> [Float] {
    let file = try! AVAudioFile(forReading: url)
    let fmt = AVAudioFormat(standardFormatWithSampleRate: file.processingFormat.sampleRate, channels: 1)!
    let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
    try! file.read(into: buf)
    _ = fmt
    let ch = buf.floatChannelData![0]
    let win = Int(file.processingFormat.sampleRate * 0.05)
    var out: [Float] = []
    var i = 0
    while i < Int(buf.frameLength) {
        var m: Float = 0
        for j in i..<min(i + win, Int(buf.frameLength)) { m = max(m, abs(ch[j])) }
        out.append(m * gain)
        i += win
    }
    return out
}

@main
struct OrbRef {
    @MainActor static func main() {
        let out = URL(fileURLWithPath: CommandLine.arguments[1])
        let fm = FileManager.default
        try! fm.createDirectory(at: out, withIntermediateDirectories: true)

        // Stills: steady state, every input settled. Raw peak → loudness() → level = energy.
        let t0 = 12.3
        let stills: [(String, Dictation, Float)] = [
            ("rest", .idle, 0), ("quiet", .recording, 0.01), ("medium", .recording, 0.04), ("loud", .recording, 0.2),
        ]
        var stillRows = ["name,state,raw_peak,dbfs,level,energy,rec,work,t,spin,curl"]
        for (name, state, peak) in stills {
            let level = state == .recording ? loudness(peak) : 0
            let rec = state == .recording ? 1.0 : 0
            let f = OrbFrame(size: 24, t: t0, spin: 0, curl: 0, level: level, energy: level, rec: rec, work: 0)
            for v in variants {
                let dir = out.appendingPathComponent("stills/\(v.name)")
                try! fm.createDirectory(at: dir, withIntermediateDirectories: true)
                try! png(f, v).write(to: dir.appendingPathComponent("\(name).png"))
            }
            let db = peak > 0 ? String(format: "%.1f", 20 * log10(Double(peak))) : "-inf"
            stillRows.append("\(name),\(state),\(peak),\(db),\(String(format: "%.4f", level)),\(String(format: "%.4f", level)),\(rec),0,\(t0),0,0")
        }
        try! stillRows.joined(separator: "\n").appending("\n").write(to: out.appendingPathComponent("stills/uniforms.csv"), atomically: true, encoding: .utf8)

        // Video: rest, press, real speech, stop, transcribing, back home.
        let raw = peaks(URL(fileURLWithPath: CommandLine.arguments[2]), gain: Float(CommandLine.arguments[3])!)
        let fps = 60.0
        let press = 0.5, speechStart = 0.7
        let speechEnd = speechStart + Double(raw.count) * 0.05
        let stop = speechEnd + 0.3, done = stop + 1.2, end = done + 2.5
        var lvl = Spring(d: 0.15), eng = Spring(d: 1)
        var recE = Ease(d: 0.45), workE = Ease(d: 0.45)
        var rows = ["frame,time,state,raw_peak,level,energy,rec,work,t,spin,curl"]
        let frames = Int(end * fps)
        for v in variants {
            try! fm.createDirectory(at: out.appendingPathComponent("video/frames-\(v.name)"), withIntermediateDirectories: true)
        }
        for i in 0...frames {
            let now = Double(i) / fps
            let state: Dictation = now < press ? .idle : now < stop ? .recording : now < done ? .transcribing : .idle
            // The level is polled at 20fps, so it holds between polls.
            let poll = Int(((now - speechStart) / 0.05).rounded(.down))
            let peak: Float = (state == .recording && poll >= 0 && poll < raw.count) ? raw[poll] : 0
            let voice = state == .recording ? loudness(peak) : 0
            if i > 0 {
                lvl.step(to: voice, dt: 1 / fps)
                eng.step(to: voice, dt: 1 / fps)
            }
            let rec = recE.step(to: [.starting, .recording].contains(state) ? 1 : 0, now: now)
            let work = workE.step(to: state == .transcribing ? 1 : 0, now: now)
            let clock = OrbClock.advance(to: 1000 + now, rate: 0.35 + 0.8 * rec + 0.6 * work + 0.3 * eng.x,
                                         working: state == .transcribing)
            let f = OrbFrame(size: 24, t: clock.t, spin: clock.spin, curl: clock.curl,
                             level: lvl.x, energy: eng.x, rec: rec, work: work)
            for v in variants {
                let file = out.appendingPathComponent(String(format: "video/frames-\(v.name)/%04d.png", i))
                try! png(f, v).write(to: file)
            }
            rows.append(String(format: "%d,%.4f,%@,%.4f,%.5f,%.5f,%.5f,%.5f,%.5f,%.5f,%.5f", i, now, "\(state)", peak,
                               lvl.x, eng.x, rec, work, clock.t, clock.spin, clock.curl))
        }
        try! rows.joined(separator: "\n").appending("\n").write(to: out.appendingPathComponent("video/uniforms.csv"), atomically: true, encoding: .utf8)
        print("frames \(frames + 1), speech \(raw.count) polls, peak max \(raw.max() ?? 0)")
    }
}

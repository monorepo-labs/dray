import SwiftUI

/// Four colours an orb is painted from, read as a loop.
struct OrbPalette: Identifiable, Hashable {
    let name: String
    let colors: [Color]
    /// The light split as a prism splits it; shaders that can paint the true
    /// rainbow do, the rest take `colors`.
    var spectral = false
    var id: String { name }

    private static func rgb(_ r: Double, _ g: Double, _ b: Double) -> Color { Color(red: r, green: g, blue: b) }

    static let all = [
        OrbPalette(name: "Rainbow", colors: PrismOrb.rainbow, spectral: true),
        OrbPalette(name: "Siri", colors: [rgb(1, 0.32, 0.62), rgb(0.56, 0.32, 1), rgb(0.18, 0.52, 1), rgb(0.2, 0.9, 0.86)]),
        OrbPalette(name: "Dray", colors: [rgb(0.95, 0.78, 0.3), rgb(1, 0.55, 0.15), rgb(1, 0.93, 0.7), rgb(0.95, 0.38, 0.2)]),
        OrbPalette(name: "Mono", colors: [rgb(1, 1, 1), rgb(0.55, 0.55, 0.58), rgb(0.85, 0.85, 0.88), rgb(0.32, 0.32, 0.35)]),
        OrbPalette(name: "Aurora", colors: [rgb(0.2, 0.95, 0.55), rgb(0.1, 0.75, 0.8), rgb(0.15, 0.35, 0.95), rgb(0.55, 0.3, 0.95)]),
        OrbPalette(name: "Ember", colors: [rgb(1, 0.22, 0.25), rgb(1, 0.52, 0.1), rgb(0.9, 0.15, 0.6), rgb(1, 0.8, 0.3)]),
        OrbPalette(name: "Ice", colors: [rgb(0.9, 0.97, 1), rgb(0.4, 0.85, 1), rgb(0.2, 0.45, 1), rgb(0.7, 0.7, 1)]),
    ]
}

/// A candidate driven exactly as the panel drives its orb, in a palette.
struct LabOrb: View {
    let style: OrbStyle
    let size: CGFloat
    let level: Float
    let state: Dictation
    let palette: OrbPalette

    var body: some View {
        OrbDriver(size: size, level: level, state: state) { style.draw($0, palette: palette) }
    }
}

enum OrbStyle: String, CaseIterable, Identifiable {
    case clearPrism, lightPrism, prism, glass, nebula

    var id: String { rawValue }

    var name: String {
        switch self {
        case .clearPrism: "Prism, clear (ships)"
        case .lightPrism: "Prism, light frost"
        case .prism: "Prism, frosted"
        case .glass: "Iridescent glass"
        case .nebula: "Nebula"
        }
    }

    /// How it hears the voice, and what it is made of.
    var note: String {
        switch self {
        case .clearPrism: "Caught light in clear dark glass; a wave flows through it, swelling with the voice, and curls into an orbiting arc while transcribing."
        case .lightPrism: "The same light in dark glass with a light frost."
        case .prism: "The same light in frosted glass."
        case .glass: "Thin-film bubble churning inside; the voice stirs it, ripples it and lifts a glow. The highlight circles with a trail while transcribing."
        case .nebula: "Warped noise; the voice churns it and lights the core."
        }
    }

    /// The honest frame cost, for a panel that is always on.
    var cost: String {
        switch self {
        case .nebula: "One colorEffect pass, 12 noise lookups a pixel; under 10k pixels at 48pt @2x, negligible."
        case .glass: "One colorEffect pass, a few noise lookups and nine highlights a pixel; negligible."
        case .prism, .lightPrism, .clearPrism: "One colorEffect pass, a handful of noise lookups a pixel; negligible."
        }
    }

    @MainActor @ViewBuilder
    func draw(_ f: OrbFrame, palette: OrbPalette) -> some View {
        switch self {
        case .clearPrism: PrismOrb(frame: f, colors: palette.colors, spectral: palette.spectral)
        case .lightPrism: PrismOrb(frame: f, colors: palette.colors, frost: 0.3, spectral: palette.spectral)
        case .prism: PrismOrb(frame: f, colors: palette.colors, frost: 1, spectral: palette.spectral)
        case .glass: shader(ShaderLibrary.default.glass, f, palette, extras: [palette.spectral ? 1 : 0, Float(f.spin)])
        case .nebula: shader(ShaderLibrary.default.nebula, f, palette)
        }
    }

    private func shader(_ fn: ShaderFunction, _ f: OrbFrame, _ palette: OrbPalette, extras: [Float] = []) -> some View {
        Rectangle()
            .colorEffect(Shader(function: fn, arguments: f.args + palette.colors.map { .color($0) } + extras.map { .float($0) }))
            .frame(width: f.size, height: f.size)
    }
}

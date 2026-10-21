// Shared by every orb shader: the shipped one in VoiceOrb.metal and the Orb
// Lab's candidates, which include this by path.
#pragma once
#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// Every orb shader takes the same inputs after SwiftUI's own: the view's size,
// a phase `t` that already runs faster while recording or working (so nothing
// here multiplies `t` by an animated value, which would sweep wildly while
// that value eases), the voice `level` (fast) and `energy` (slow), how far
// into recording (`rec`) and transcribing (`work`) the orb is, 0…1, and a
// four-colour palette.
#define ORB_ARGS float2 size, float t, float level, float energy, float rec, float work, \
    half4 h0, half4 h1, half4 h2, half4 h3
#define ORB_SETUP \
    float2 uv = (pos - size * 0.5) / (size.x * 0.5); \
    float r = length(uv); \
    float aa = 2.0 / size.x; \
    float3 c0 = float3(h0.rgb), c1 = float3(h1.rgb), c2 = float3(h2.rgb), c3 = float3(h3.rgb);
#define RAMP(x) ramp((x), c0, c1, c2, c3)
#define DISC(edge) (1.0 - smoothstep((edge) - aa, (edge), r))

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

static float noise(float2 p) {
    float2 i = floor(p), f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + float2(1, 0)), u.x),
               mix(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), u.x), u.y);
}

static float fbm(float2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v / 0.9375;
}

static float2 rot(float2 p, float a) {
    float c = cos(a), s = sin(a);
    return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}

/// The palette as a loop, so any phase maps to a colour and nothing seams.
static float3 ramp(float x, float3 c0, float3 c1, float3 c2, float3 c3) {
    float s = fract(x) * 4.0;
    float f = smoothstep(0.0, 1.0, fract(s));
    if (s < 1.0) return mix(c0, c1, f);
    if (s < 2.0) return mix(c1, c2, f);
    if (s < 3.0) return mix(c2, c3, f);
    return mix(c3, c0, f);
}

static float bump(float x, float c, float w) { float d = (x - c) / w; return saturate(1.0 - d * d); }

/// Light split by a prism, red at 0 to violet at 1.
static float3 spectral(float x) {
    float3 c = float3(bump(x, 0.15, 0.32) + 0.35 * bump(x, 0.95, 0.12), bump(x, 0.42, 0.22), bump(x, 0.78, 0.25));
    return c * 0.85 + 0.12;
}

/// A full turn of the colour wheel, red through yellow, cyan, blue and back.
static float3 hue(float x) {
    return saturate(abs(fract(x + float3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0);
}

static half4 premul(float3 col, float a) {
    return half4(half3(saturate(col) * a), half(a));
}

/// Shading a unit sphere lit from the upper left; `n` is its normal.
static float spec(float3 n, float3 l, float power) {
    return pow(saturate(dot(reflect(-normalize(l), n), float3(0, 0, 1))), power);
}

/// Across a split beam, 0 at the top to 1 at the bottom: the rainbow, or the
/// palette in order.
static float3 band(float x, float prismatic, float3 c0, float3 c1, float3 c2, float3 c3) {
    return mix(ramp(x * 0.75, c0, c1, c2, c3) * 0.9 + 0.08, spectral(x), prismatic);
}

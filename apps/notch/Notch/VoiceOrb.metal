#include "VoiceOrb.h"

// A ball of frosted glass with sunlight caught inside it: a dispersed band of
// light, a warm glow over it and a bright white filament through it. The
// voice swells the band's travelling wave and pours more light through.
// Transcribing curls the whole band, glow and filament with it, into an arc
// at the rim that orbits: the band is drawn in coordinates bent round a
// circle whose curvature rises with `curl`, so the line becomes the arc
// rather than fading into it. `spin` is the orbit's angle; OrbClock brings it
// home before `curl` falls, so the band never turns once straight. `milk` 1 is frosted
// glass, 0 clear dark glass; `prismatic` 1 splits the light into the rainbow,
// 0 into the palette.
[[ stitchable ]] half4 prism(float2 pos, half4 color, ORB_ARGS, float milk, float prismatic, float spin, float curl) {
    ORB_SETUP
    float R = 0.95;
    float mask = 1.0 - smoothstep(R - aa * 2.0, R, r);
    if (mask <= 0.0) return half4(0);
    float2 dir = r > 1e-4 ? uv / r : float2(1, 0);

    float3 body = float3(mix(0.03, 0.3 - 0.06 * uv.y, milk)) * (1.0 + 0.2 * rec);
    float rim = smoothstep(0.7, R, r);
    body += rim * (0.06 + 0.2 * milk) * (0.5 + saturate(dot(dir, normalize(float2(0.6, 0.7)))));
    body += band(saturate((r - 0.8) / 0.14), prismatic, c0, c1, c2, c3) * rim * saturate(-dir.x * 1.2) * 0.45;

    // The band's own coordinates: `x` along it, `d` across it, below positive.
    float bend = smoothstep(0.0, 1.0, curl);
    float ring = 0.78;
    float2 p = rot(uv, -spin);
    float mid = mix(0.06, ring, bend);
    float x = p.x, d = p.y - mid;
    if (bend > 1e-3) {
        float rho = ring / bend;
        float2 v = p - float2(0.0, mid - rho);
        x = rho * atan2(v.x, v.y);
        d = length(v) - rho;
    }
    // Travelling waves at a steady speed; the voice only swells them, through the slow `energy`.
    float wave = ((0.06 + 0.1 * energy + 0.03 * level) * sin(x * 2.4 - t * 2.1)
               + (0.015 + 0.05 * energy) * sin(x * 4.1 - t * 3.0 + 1.0)) * (1.0 - 0.75 * bend);
    d -= wave;
    float width = (0.17 + 0.05 * energy + 0.02 * level) * (1.0 - 0.35 * bend);
    float s = d / width;
    float along = exp(-pow((x + 0.08) / (0.42 + 0.12 * energy), 2.0));
    float shimmer = 0.8 + 0.4 * noise(float2(x * 4.0 + t * 0.6, t * 0.3));
    // Curled, it reads as a comet: brightest at the leading end, the -x one.
    float comet = mix(1.0, 0.35 + 1.1 * smoothstep(0.7, -0.5, x), bend);
    float power = (0.6 + 0.25 * rec + 0.4 * energy + 0.25 * level + 0.3 * bend) * shimmer * comet;

    float3 light = band(saturate(0.45 + s * 0.42), prismatic, c0, c1, c2, c3) * exp(-s * s * 1.3) * along * 1.3;
    float2 warm = float2(x + 0.06, d + 0.15);
    light += mix(mix(c0, c1, 0.5) * 0.55, float3(1.0, 0.7, 0.3), prismatic) * exp(-dot(warm, warm) / 0.08) * (1.0 - 0.8 * bend);
    float fw = max(0.022, aa * 0.9);
    float fy = d - 0.05 - 0.04 * sin(x * 3.2 + 0.8 - t * 2.1) * (1.0 - 0.75 * bend);
    float reach = smoothstep(-0.6, -0.25, x) * smoothstep(0.75, 0.35, x);
    light += float3(1.0, 0.98, 0.95) * exp(-fy * fy / (fw * fw)) * reach * 1.4;
    light += mix(c3, float3(0.35, 0.4, 1.0), prismatic) * exp(-pow((d - 0.2) / 0.12, 2.0)) * along * 0.35;

    return premul(body + light * power * mix(1.0, 0.85, milk), mask);
}

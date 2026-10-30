#include "VoiceOrb.h"

// The prism orb's light, unchanged, in a ball of glass: above the band it is
// the prism's solid dark glass, and below it a lens over the screen behind,
// after Siri's: the middle passes nearly straight through, upright and a
// touch larger, and past ~60% of the radius the screen turns over and swells,
// meeting the upright part in a blur, as a water drop does. Each channel bends a little
// differently, splitting the colours toward the edge, and a Fresnel
// reflection brightens the rim. `back` is the screen behind, `span` orb
// widths across and centred on the orb; `has` 0 means none was captured, and
// the body is the prism's dark glass throughout.
[[ stitchable ]] half4 lens(float2 pos, half4 color, ORB_ARGS, float spin, float curl,
                            texture2d<half> back, float has, float span) {
    ORB_SETUP
    float R = 0.95;
    float mask = 1.0 - smoothstep(R - aa * 2.0, R, r);
    if (mask <= 0.0) return half4(0);
    float2 dir = r > 1e-4 ? uv / r : float2(1, 0);

    // The glass: a dome over the disc, `z` its height.
    float2 sp = uv / R;
    float z = sqrt(saturate(1.0 - dot(sp, sp)));
    constexpr sampler sm(coord::normalized, address::clamp_to_edge, filter::linear);
    // How far the screen is scaled at each radius: 0.92 in the middle, through
    // zero at ~0.6 of the radius, turned over to -1.1 at the rim. Eased rather
    // than a real dome's slope, which runs away at the rim and crushed lines
    // of text into a pixel or two there.
    float turn = smoothstep(0.3, 0.92, saturate(r / R));
    float3 scale = mix(0.92, -1.1, turn) * (1.0 + float3(-0.03, 0.0, 0.03) * turn);
    float3 seen = float3(back.sample(sm, 0.5 + uv * scale.r / (2.0 * span)).r,
                         back.sample(sm, 0.5 + uv * scale.g / (2.0 * span)).g,
                         back.sample(sm, 0.5 + uv * scale.b / (2.0 * span)).b);
    float fresnel = 0.04 + 0.96 * pow(1.0 - z, 5.0);

    // From here on, the prism, at its shipped settings: clear glass, the true
    // rainbow, and the size past where its small-orb lift applies.
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
    float wave = ((0.06 + 0.1 * energy + 0.03 * level) * sin(x * 2.4 - t * 2.1)
               + (0.015 + 0.05 * energy) * sin(x * 4.1 - t * 3.0 + 1.0)) * (1.0 - 0.75 * bend);
    d -= wave;

    // Solid dark glass above the band, the lens below it, so the line between
    // waves with the voice; curled, the arc's inside is solid and its rim the lens.
    // Smoked glass: darkest just under the band and toward the rim, so on a
    // white screen the lens still reads as grey glass rather than a hole.
    float shade = mix(0.42, 0.78, smoothstep(0.0, 0.75, d)) * (1.0 - 0.3 * smoothstep(0.55, 0.9, r / R));
    float3 glass = mix(seen * shade, float3(0.92, 0.95, 1.0), fresnel * 0.4);
    float lens = has * smoothstep(-0.02, 0.06, d);
    float3 body = mix(float3(0.03), glass, lens) * (1.0 + 0.2 * rec);
    float rim = smoothstep(0.7, R, r);
    body += rim * 0.06 * (0.5 + saturate(dot(dir, normalize(float2(0.6, 0.7)))));
    body += band(saturate((r - 0.8) / 0.14), 1.0, c0, c1, c2, c3) * rim * saturate(-dir.x * 1.2) * 0.45;
    float width = (0.17 + 0.05 * energy + 0.02 * level) * (1.0 - 0.35 * bend);
    float s = d / width;
    float along = exp(-pow((x + 0.08) / (0.42 + 0.12 * energy), 2.0));
    float shimmer = 0.8 + 0.4 * noise(float2(x * 4.0 + t * 0.6, t * 0.3));
    float comet = mix(1.0, 0.35 + 1.1 * smoothstep(0.7, -0.5, x), bend);
    float power = (0.6 + 0.25 * rec + 0.4 * energy + 0.25 * level + 0.3 * bend) * shimmer * comet;

    float3 hues = band(saturate(0.45 + s * 0.42), 1.0, c0, c1, c2, c3);
    float3 light = hues * exp(-s * s * 1.3) * along * 1.3;
    float2 warm = float2(x + 0.06, d + 0.15);
    light += float3(1.0, 0.7, 0.3) * exp(-dot(warm, warm) / 0.08) * (1.0 - 0.8 * bend);
    float fw = max(0.022, aa * 0.9);
    float fy = d - 0.05 - 0.04 * sin(x * 3.2 + 0.8 - t * 2.1) * (1.0 - 0.75 * bend);
    float reach = smoothstep(-0.6, -0.25, x) * smoothstep(0.75, 0.35, x);
    light += float3(1.0, 0.98, 0.95) * exp(-fy * fy / (fw * fw)) * reach * 1.4;
    light += float3(0.35, 0.4, 1.0) * exp(-pow((d - 0.2) / 0.12, 2.0)) * along * 0.35;

    return premul(body + light * power, mask);
}

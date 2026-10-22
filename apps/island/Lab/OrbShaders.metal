#include "../Island/VoiceOrb.h"

// The Orb Lab's other candidates, kept for a library of orbs later (#568).

// Domain-warped noise poured through the palette. The voice deepens the warp
// and lights the middle, so speech reads as the cloud churning from inside.
[[ stitchable ]] half4 nebula(float2 pos, half4 color, ORB_ARGS) {
    ORB_SETUP
    float mask = DISC(0.97);
    if (mask <= 0.0) return half4(0);
    float2 p = rot(uv, work * 1.6 * (1.0 - r) + t * 0.08) * 1.1;
    float2 w = float2(fbm(p + float2(0.0, t * 0.22)), fbm(p + float2(5.2, 1.3) - t * 0.18));
    float n = fbm(p + (0.9 + 2.6 * level) * w);
    float3 col = RAMP(n * 1.3 + w.x * 0.5 + t * 0.03);
    float core = exp(-r * r * (3.0 - 1.6 * level));
    col *= (0.45 + 0.2 * rec + 0.15 * energy + 0.7 * level * core) * (0.55 + n);
    col += RAMP(n + 0.5) * smoothstep(0.55, 0.97, r) * (0.3 + 0.35 * rec);
    col += pow(saturate(1.0 - length(uv - float2(-0.38, -0.42)) * 1.9), 3.0) * 0.5;
    return premul(col, mask);
}

// A bubble of iridescent glass. The film shifts with the angle of the
// surface and churns inside, harder with the voice; speech also sends ripples
// out from the middle and lifts a warm glow drifting inside. While the model
// works the highlight circles round on `spin`, trailing light. `prismatic` 1 paints the film in the
// rainbow instead of the palette.
[[ stitchable ]] half4 glass(float2 pos, half4 color, ORB_ARGS, float prismatic, float spin) {
    ORB_SETUP
    float R = 0.95;
    float mask = DISC(R);
    if (mask <= 0.0) return half4(0);
    float2 q = uv / R;
    float rq = length(q);
    float rip = sin(rq * 15.0 - t * 5.0) * (0.6 * energy + 0.4 * level) * 0.25 * (1.0 - rq)
              + (noise(q * 2.2 + t * 0.3) - 0.5) * (0.18 + 0.2 * energy);
    float2 qn = q + (rq > 1e-3 ? q / rq : float2(0)) * rip * 0.3;
    float z = sqrt(saturate(1.0 - dot(qn, qn)));
    float3 n = normalize(float3(qn, z));
    float fres = pow(1.0 - n.z, 1.5);
    // Two layers drifting against each other, the second warping the first.
    float2 warp = float2(noise(q * 2.0 - t * 0.4), noise(q * 2.0 + 5.0 + t * 0.3)) - 0.5;
    float churn = noise(q * 1.6 + float2(t * 0.35, -t * 0.25) + warp * (0.8 + 1.6 * energy + 0.6 * level));
    float phase = fres * 1.2 + churn * 0.9 + n.x * 0.3 + t * 0.03;
    float3 rainbow = mix(hue(phase * 0.6), float3(1.0), 0.2);
    float3 film = mix(RAMP(phase), rainbow, prismatic);
    float2 glowC = float2(0.18 * sin(t * 0.7), 0.42 + 0.12 * cos(t * 0.9));
    float glowAt = exp(-dot(q - glowC, q - glowC) * (2.8 - 1.0 * energy));
    float3 col = mix(RAMP(0.6 + t * 0.02), float3(0.7, 0.5, 0.25), prismatic) * glowAt * (0.15 + 0.45 * energy + 0.3 * level);
    col += film * (mix(0.16, 0.08, prismatic) * (1.0 + energy) + fres) * (0.8 + 0.45 * rec + 0.3 * energy + 0.3 * level);
    // The highlight orbits from where it rests, on `spin`, and leaves a fading trail.
    float home = atan2(-0.55, -0.45), reachOut = mix(0.71, 0.6, work);
    col += spec(n, float3(float2(cos(home + spin), sin(home + spin)) * reachOut, 0.8), 70.0) * 1.1;
    for (int k = 1; k <= 8; k++) {
        float ak = home + spin - float(k) * 0.13;
        col += spec(n, float3(float2(cos(ak), sin(ak)) * reachOut, 0.8), 45.0) * work * 0.7 * pow(0.72, float(k));
    }
    col += spec(n, float3(0.6, 0.7, 0.5), 12.0) * 0.12;
    return premul(col, mask);
}

# Voice orb reference frames

The Mac island's voice orb, `PrismOrb` in `Island/VoiceOrb.swift` drawn by
`prism` in `Island/VoiceOrb.metal`, rendered from the shipped sources for the
Linux port to match. Taken at `8dbf0891`.

The island draws this orb at one size: **24pt**, as the mic button in the
composer row (`MicButton(size: 24)` in `IslandView.swift`), on the card's black.
The 80pt orb floating over the screen is `LensOrb`, a different shader, and is
not here.

## How they were made

`generate/OrbRef.swift` compiles against the shipped `VoiceOrb.swift` and draws
`PrismOrb(frame:)` through SwiftUI's `ImageRenderer` on black, at scale 1 and 2.
Nothing is copied from the shader: `VoiceOrb.metal` is built into the bundle's
default library unchanged. No app, server or microphone ran.

The shader is drawn differently below ~40pt, so the **24pt frames are the
reference**. The 96pt@2x set only makes the detail readable; it is not what the
island shows.

## Stills

`stills/<size>/{rest,quiet,medium,loud}.png`; every input is in `stills/uniforms.csv`.

| name   | state     | raw peak | dBFS  | level = energy | rec |
|--------|-----------|----------|-------|----------------|-----|
| rest   | idle      | 0        | —     | 0              | 0   |
| quiet  | recording | 0.01     | −40   | 0.3125         | 1   |
| medium | recording | 0.04     | −28   | 0.6888         | 1   |
| loud   | recording | 0.20     | −14   | 1.0            | 1   |

The level is the steady state, every input settled: `level = energy =
loudness(peak)`, where `loudness` maps a peak to `(dB + 50) / 32`, clamped 0…1.
`t = 12.3`, `work = spin = curl = 0`. Rest is the mic button with no dictation.

## Video

`video/speech-<size>.mp4` (H.264, for watching) and
`video/speech-<size>-lossless.mkv` (FFV1, exact pixels, for diffing) at 60fps,
12.45s:

| time         | state        |
|--------------|--------------|
| 0–0.5s       | idle (rest)  |
| 0.5s         | press: recording |
| 0.7–8.45s    | speech       |
| 8.75s        | stop: transcribing |
| 9.95s        | idle, the orbit winding home and uncurling |

The speech is `say` reading a two-sentence prompt, scaled by 0.3 so its peaks
(max 0.237) sit in a laptop mic's range, and polled as the island polls it: the
peak of each 50ms window, held between polls. Every frame's inputs, including
the raw peak, are in `video/uniforms.csv`.

How each input moves is as `OrbDriver` does it:

- `level` and `energy` are springs of `.spring(duration:)` 0.15s and 1s
  (critically damped, response = duration).
- `rec` and `work` are `.easeInOut(duration: 0.45)`.
- `t`, `spin` and `curl` come from the island's own `OrbClock.advance`.

The springs and the ease are written out in the generator rather than run by
SwiftUI's animation system, so they match it closely but not to the bit.
`OrbClock` is the shipped code.

## Regenerating

```sh
SRC=apps/island/Island
xcrun metal -c $SRC/VoiceOrb.metal -I $SRC -o /tmp/VoiceOrb.air
mkdir -p OrbRef.app/Contents/{MacOS,Resources}
xcrun metallib /tmp/VoiceOrb.air -o OrbRef.app/Contents/Resources/default.metallib
xcrun swiftc -O -parse-as-library -target arm64-apple-macos15 \
  apps/island/Lab/reference/generate/OrbRef.swift $SRC/VoiceOrb.swift -o OrbRef.app/Contents/MacOS/OrbRef
# plus an Info.plist naming CFBundleExecutable OrbRef, so the default library is found
say -o speech.aiff "Make the sidebar remember which project I picked last, and open that one when Dray starts. Then run the tests and tell me what changed."
OrbRef.app/Contents/MacOS/OrbRef out speech.aiff 0.3
```

It writes the stills, one PNG per video frame per size, and both CSVs; the
videos are those frames through ffmpeg (`-c:v libx264 -crf 10 -pix_fmt yuv420p`,
and `-c:v ffv1 -pix_fmt bgr0`).

# The orb beside the Mac's

Each image is the Mac's render on top and the Linux port's below, at rest,
quiet, medium and loud, at the exact inputs in the Mac's
`apps/island/Lab/reference/stills/uniforms.csv` (branch `orb-reference`).
`stills-24pt.png` is the 24pt@2x set scaled 4x; `stills-96pt.png` the 96pt@2x
detail set.

Measured against those references (ImageMagick `compare`, Q16):

| set           | PSNR       | mean abs error  |
|---------------|------------|-----------------|
| 24pt@1x       | 68.5–69.4 dB | ≤ 2.4 / 65535 |
| 24pt@2x       | 69.0–71.8 dB | ≤ 2.1 / 65535 |
| 96pt@2x       | 71.1–72.2 dB | ≤ 1.3 / 65535 |
| speech video, 748 frames at 24pt@2x | mean 70.1 dB, worst 67.1 dB | |

To redo it: `dray-island --orb-csv <uniforms.csv> <size> <scale> <dir>`
renders every row, and `src/fixtures/orb-uniforms.csv` drives the motion test.

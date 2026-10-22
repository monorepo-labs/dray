# Charts

Shareable benchmark charts, one HTML page each, drawn at 1000×562 (16:9) and
exported at 2x. Start a new one by copying the page closest to it.

- `dictation-speed.html` — one before/after pair.
- `dictation-lengths.html` — before/after per row, one shared scale.

The look: black, grid hairlines with hollow squares at the corners, Geist at
regular weight for titles and numbers, Paper Mono for labels and the footer.
Before is 70% white, after is the cyan-to-blue gradient. Bars share one scale
— a chart that rescales per row hides the very difference it exists to show.

To export, serve this folder and screenshot the page at 2x:

```sh
python3 -m http.server 8799 --directory charts
dray browser open http://127.0.0.1:8799/dictation-lengths.html
dray browser set viewport 2000 1124
dray browser zoom 200
dray browser screenshot
```

Fonts are under the SIL Open Font License; each one's notice is beside it in
`fonts/`.

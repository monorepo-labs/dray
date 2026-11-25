import type { CSSProperties } from "react";

// The field starts here, just above the window, so nothing sits behind the
// headline in either scheme.
const TOP = 360;

// How far the field runs past each side of the drawn 1440, for wide screens.
const SIDE = 1200;

/// Integer hash of a tile, so the sides come out the same on server and client.
function hash(x: number, y: number, salt: number) {
  let n = Math.imul(x * 73856093 ^ y * 19349663 ^ salt * 83492791, 2654435761);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

/// The drawn 1440 field, one path per colour band from the top edge down:
/// [path, dark colour, light colour].
const FIELD = [
  ["M0 0h60v60h-60zM120 0h60v60h-60zM180 0h60v60h-60zM240 0h60v120h-60zM300 0h60v60h-60zM360 0h60v180h-60zM420 60h60v180h-60zM480 60h60v120h-60zM480 240h60v60h-60zM540 120h60v180h-60zM600 0h60v60h-60zM600 180h60v120h-60zM660 120h60v240h-60zM720 120h60v180h-60zM720 420h60v60h-60zM780 300h60v60h-60zM780 480h60v60h-60zM840 300h60v120h-60zM840 480h60v60h-60zM900 300h60v180h-60zM960 420h60v180h-60zM1020 360h60v120h-60zM1020 540h60v60h-60zM1080 360h60v300h-60zM1140 360h60v300h-60zM1200 480h60v60h-60zM1200 660h60v60h-60zM1260 600h60v120h-60zM1320 540h60v120h-60zM1320 720h60v60h-60zM1380 480h60v120h-60zM1380 720h60v60h-60zM1380 840h60v60h-60z", "#0C0C9E", "#E6E7FF"],
  ["M0 60h60v120h-60zM60 0h60v180h-60zM120 60h60v180h-60zM180 60h60v120h-60zM180 240h60v60h-60zM240 120h60v240h-60zM300 60h60v360h-60zM360 180h60v180h-60zM360 360h60v60h-60zM420 240h60v60h-60zM420 360h60v120h-60zM480 180h60v60h-60zM480 300h60v120h-60zM540 300h60v120h-60zM540 480h60v60h-60zM600 300h60v180h-60zM660 360h60v60h-60zM660 480h60v120h-60zM720 300h60v120h-60zM720 480h60v60h-60zM780 360h60v120h-60zM840 420h60v60h-60zM840 600h60v60h-60zM900 480h60v120h-60zM960 600h60v180h-60zM1020 480h60v60h-60zM1020 600h60v180h-60zM1080 660h60v120h-60zM1140 660h60v240h-60zM1200 600h60v60h-60zM1200 720h60v120h-60zM1260 720h60v180h-60zM1320 780h60v120h-60zM1380 780h60v60h-60z", "#1612F8", "#C3C5FF"],
  ["M0 180h60v180h-60zM60 180h60v180h-60zM60 420h60v60h-60zM120 240h60v180h-60zM180 180h60v60h-60zM180 300h60v120h-60zM240 360h60v60h-60zM240 480h60v120h-60zM300 420h60v120h-60zM360 420h60v180h-60zM420 300h60v60h-60zM420 540h60v60h-60zM480 420h60v180h-60zM540 420h60v60h-60zM540 540h60v120h-60zM600 480h60v300h-60zM660 420h60v60h-60zM660 600h60v120h-60zM660 780h60v60h-60zM720 540h60v120h-60zM720 720h60v180h-60zM780 540h60v360h-60zM840 540h60v60h-60zM840 660h60v120h-60zM840 840h60v60h-60zM900 600h60v180h-60zM960 780h60v120h-60zM1020 780h60v120h-60zM1080 780h60v120h-60zM1200 840h60v60h-60z", "#1612F8", "#8F93FF"],
  ["M0 360h60v180h-60zM60 360h60v60h-60zM60 540h60v60h-60zM120 420h60v180h-60zM180 420h60v180h-60zM240 420h60v60h-60zM240 600h60v60h-60zM300 540h60v120h-60zM300 720h60v60h-60zM360 600h60v180h-60zM420 480h60v60h-60zM420 600h60v240h-60zM480 600h60v60h-60zM480 720h60v120h-60zM540 660h60v240h-60zM600 780h60v120h-60zM660 720h60v60h-60zM720 660h60v60h-60zM840 780h60v60h-60zM900 780h60v120h-60z", "#1612F8", "#4A46FF"],
  ["M0 540h60v360h-60zM60 480h60v60h-60zM60 600h60v300h-60zM120 600h60v300h-60zM180 600h60v300h-60zM240 660h60v240h-60zM300 660h60v60h-60zM300 780h60v120h-60zM360 780h60v120h-60zM420 840h60v60h-60zM480 660h60v60h-60zM480 840h60v60h-60zM660 840h60v60h-60z", "#0C0C9E", "#1612F8"],
] as const;

/// Tiles for the sides past 1440, one path per colour. They carry on the two
/// diagonals the drawn field follows, the band's top edge (y ≈ x/2 − 210) and
/// the dark lower left (y ≈ 540 + 0.45x), ragged by the hash.
const SIDES = (() => {
  const out = { edge: "", low: "", blue: "", lit: "" };
  for (const from of [-SIDE, 1440]) {
    for (let x = from; x < from + SIDE; x += 60) {
      for (let y = 0; y < 900; y += 60) {
        const below = y + 30 - ((x + 30) / 2 - 210) + (hash(x, y, 1) - 0.5) * 160;
        if (below < 0) continue;
        const kind =
          below < 70
            ? "edge"
            : y + 30 - (540 + 0.45 * (x + 30)) + (hash(x, y, 2) - 0.5) * 160 > 0
              ? "low"
              : hash(x, y, 3) < 0.04
                ? "lit"
                : "blue";
        out[kind] += `M${x} ${y}h60v60h-60z`;
      }
    }
  }
  return out;
})();

/// [path, dark colour, light colour] for the sides. Light pales the band's
/// top edge and keeps the lower left deep, as the drawn field does.
const SIDE_TILES = [
  [SIDES.edge, "#0C0C9E", "#E6E7FF"],
  [SIDES.low, "#0C0C9E", "#1612F8"],
  [SIDES.blue, "#1612F8", "#C3C5FF"],
  [SIDES.lit, "#2D29FF", "#8F93FF"],
] as const;

/// The network's lit tiles: [path, dark colour, light colour].
const NODES = [
  ["M180 780h60v60h-60z", "#0C0C9E", "#8F93FF"],
  ["M0 240h60v60h-60zM120 540h60v60h-60zM60 720h60v60h-60z", "#1612F8", "#C3C5FF"],
  ["M0 480h60v60h-60zM180 660h60v60h-60zM0 840h60v60h-60z", "#4A46FF", "#E6E7FF"],
  ["M0 600h60v60h-60zM120 840h60v60h-60z", "#7F8CFF", "#FFFFFF"],
] as const;

/// Hands a path its two colours; the class picks one per scheme.
const tone = (dark: string, light: string) => ({ "--d": dark, "--l": light }) as CSSProperties;
const TONE = "fill-(--d) light:fill-(--l)";

/// The 1440×900 pixel field, centred so its tiles line up with the 960 column
/// at any width; a narrower screen crops it and a wider one gets its sides.
/// Deep blues on black; in light the same tiles take pale blues on white.
/// `top` moves the whole field down for a hero taller above its window.
export function HeroBackdrop({ id = "hero", top = "top-0" }: { id?: string; top?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute ${top} left-1/2 h-[900px] w-[1440px] -translate-x-1/2`}>
      <svg
        viewBox={`${-SIDE} 0 ${1440 + 2 * SIDE} 900`}
        width={1440 + 2 * SIDE}
        height="900"
        className="absolute top-0"
        style={{ left: -SIDE }}
      >
        <defs>
          <pattern id={`${id}-stripes`} width="6" height="900" patternUnits="userSpaceOnUse">
            <rect width="2" height="900" fill="#0000001F" />
          </pattern>
          <pattern id={`${id}-stripes-light`} width="6" height="900" patternUnits="userSpaceOnUse">
            <rect width="2" height="900" fill="#FFFFFF" />
          </pattern>
          <clipPath id={`${id}-below`}>
            <rect x={-SIDE} y={TOP} width={1440 + 2 * SIDE} height={900 - TOP} />
          </clipPath>
          {/* Stripes only where there are tiles: on the light page's white
              they would draw bars over nothing. */}
          <mask id={`${id}-tiles-mask`} style={{ maskType: "alpha" }}>
            <use href={`#${id}-tiles`} />
          </mask>
        </defs>
        <g clipPath={`url(#${id}-below)`}>
          <g id={`${id}-tiles`}>
            <g shapeRendering="crispEdges">
              {[...SIDE_TILES, ...FIELD].map(([d, dark, light]) => (
                <path key={d} d={d} className={TONE} style={tone(dark, light)} />
              ))}
            </g>
            <g className="opacity-50 light:opacity-90">
              <path
                d="M30 270L30 510M30 510L30 630M30 510L150 570M150 570L30 630M210 690L210 810M210 690L150 570M90 750L30 630M90 750L210 690M210 810L150 870M30 870L150 870M30 870L90 750M330 930L210 810M330 930L150 870"
                fill="none"
                className="stroke-[#4A46FFCC] light:stroke-[#FFFFFFCC]"
              />
              <g shapeRendering="crispEdges">
                {NODES.map(([d, dark, light]) => (
                  <path key={d} d={d} className={TONE} style={tone(dark, light)} />
                ))}
              </g>
            </g>
          </g>
          <rect
            x={-SIDE}
            width={1440 + 2 * SIDE}
            height="900"
            fill={`url(#${id}-stripes)`}
            mask={`url(#${id}-tiles-mask)`}
            className="light:hidden"
          />
          <rect
            x={-SIDE}
            width={1440 + 2 * SIDE}
            height="900"
            fill={`url(#${id}-stripes-light)`}
            mask={`url(#${id}-tiles-mask)`}
            className="hidden light:block"
          />
        </g>
      </svg>
    </div>
  );
}

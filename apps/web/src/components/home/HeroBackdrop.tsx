import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { FxGlyph } from "@/components/FxGlyph";
import { GrokGlyph } from "@/components/GrokGlyph";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import { PiGlyph } from "@/components/PiGlyph";

/// The 1440×900 pixel field, centred so its tiles line up with the 960 column
/// at any width; a narrower screen just crops it. The agent marks sit inside
/// the same box so they stay on their tiles.
export function HeroBackdrop({ id = "hero" }: { id?: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute top-0 left-1/2 h-[900px] w-[1440px] -translate-x-1/2">
      <svg viewBox="0 0 1440 900" width="1440" height="900" className="absolute inset-0">
        <defs>
          <pattern id={`${id}-stripes`} width="6" height="900" patternUnits="userSpaceOnUse">
            <rect width="2" height="900" fill="#0000001F" />
          </pattern>
        </defs>
        <g shapeRendering="crispEdges">
          <path d="M0 0h60v60h-60zM120 0h60v60h-60zM180 0h60v60h-60zM240 0h60v120h-60zM300 0h60v60h-60zM360 0h60v180h-60zM420 60h60v180h-60zM480 60h60v120h-60zM480 240h60v60h-60zM540 120h60v180h-60zM600 0h60v60h-60zM600 180h60v120h-60zM660 120h60v240h-60zM720 120h60v180h-60zM720 420h60v60h-60zM780 300h60v60h-60zM780 480h60v60h-60zM840 300h60v120h-60zM840 480h60v60h-60zM900 300h60v180h-60zM960 420h60v180h-60zM1020 360h60v120h-60zM1020 540h60v60h-60zM1080 360h60v300h-60zM1140 360h60v300h-60zM1200 480h60v60h-60zM1200 660h60v60h-60zM1260 600h60v120h-60zM1320 540h60v120h-60zM1320 720h60v60h-60zM1380 480h60v120h-60zM1380 720h60v60h-60zM1380 840h60v60h-60z" fill="#0C0C9E" />
          <path d="M0 60h60v120h-60zM60 0h60v180h-60zM120 60h60v180h-60zM180 60h60v120h-60zM180 240h60v60h-60zM240 120h60v240h-60zM300 60h60v360h-60zM360 180h60v60h-60zM360 360h60v60h-60zM420 240h60v60h-60zM420 360h60v120h-60zM480 180h60v60h-60zM480 300h60v120h-60zM540 300h60v120h-60zM540 480h60v60h-60zM600 300h60v180h-60zM660 360h60v60h-60zM660 480h60v120h-60zM720 300h60v120h-60zM720 480h60v60h-60zM780 360h60v120h-60zM840 420h60v60h-60zM840 600h60v60h-60zM900 480h60v120h-60zM960 600h60v180h-60zM1020 480h60v60h-60zM1020 600h60v180h-60zM1080 660h60v120h-60zM1140 660h60v240h-60zM1200 600h60v60h-60zM1200 720h60v120h-60zM1260 720h60v180h-60zM1320 780h60v120h-60zM1380 780h60v60h-60z" fill="#1612F8" />
          <path d="M0 180h60v180h-60zM60 180h60v180h-60zM60 420h60v60h-60zM120 240h60v180h-60zM180 180h60v60h-60zM180 300h60v120h-60zM240 360h60v60h-60zM240 480h60v120h-60zM300 420h60v120h-60zM360 240h60v120h-60zM360 420h60v180h-60zM420 300h60v60h-60zM420 540h60v60h-60zM480 420h60v180h-60zM540 420h60v60h-60zM540 540h60v120h-60zM600 480h60v300h-60zM660 420h60v60h-60zM660 600h60v120h-60zM660 780h60v60h-60zM720 540h60v120h-60zM720 720h60v180h-60zM780 540h60v360h-60zM840 540h60v60h-60zM840 660h60v120h-60zM840 840h60v60h-60zM900 600h60v180h-60zM960 780h60v120h-60zM1020 780h60v120h-60zM1080 780h60v120h-60zM1200 840h60v60h-60z" fill="#1612F8" />
          <path d="M0 360h60v180h-60zM60 360h60v60h-60zM60 540h60v60h-60zM120 420h60v180h-60zM180 420h60v180h-60zM240 420h60v60h-60zM240 600h60v60h-60zM300 540h60v120h-60zM300 720h60v60h-60zM360 600h60v180h-60zM420 480h60v60h-60zM420 600h60v240h-60zM480 600h60v60h-60zM480 720h60v120h-60zM540 660h60v240h-60zM600 780h60v120h-60zM660 720h60v60h-60zM720 660h60v60h-60zM840 780h60v60h-60zM900 780h60v120h-60z" fill="#1612F8" />
          <path d="M0 540h60v360h-60zM60 480h60v60h-60zM60 600h60v300h-60zM120 600h60v300h-60zM180 600h60v300h-60zM240 660h60v240h-60zM300 660h60v60h-60zM300 780h60v120h-60zM360 780h60v120h-60zM420 840h60v60h-60zM480 660h60v60h-60zM480 840h60v60h-60zM660 840h60v60h-60z" fill="#0C0C9E" />
        </g>
        <g opacity="0.5">
          <path d="M30 270L30 510M30 510L30 630M30 510L150 570M150 570L30 630M210 690L210 810M210 690L150 570M90 750L30 630M90 750L210 690M210 810L150 870M30 870L150 870M30 870L90 750M330 930L210 810M330 930L150 870" fill="none" stroke="#4A46FFCC" />
          <g shapeRendering="crispEdges">
            <path d="M180 780h60v60h-60z" fill="#0C0C9E" />
            <path d="M0 240h60v60h-60zM120 540h60v60h-60zM60 720h60v60h-60z" fill="#1612F8" />
            <path d="M0 480h60v60h-60zM180 660h60v60h-60zM0 840h60v60h-60z" fill="#4A46FF" />
            <path d="M0 600h60v60h-60zM120 840h60v60h-60z" fill="#7F8CFF" />
          </g>
        </g>
        <path
          shapeRendering="crispEdges"
          d="M60 180h60v60h-60zM180 180h60v60h-60zM120 360h60v60h-60zM180 360h60v60h-60zM60 420h60v60h-60z"
          fill="#2D29FF"
        />
        <rect width="1440" height="900" fill={`url(#${id}-stripes)`} />
      </svg>

      <OpenAIGlyph className="absolute top-[196px] left-[76px] size-7 text-white opacity-80" />
      <ClaudeGlyph className="absolute top-[196px] left-[196px] size-7" />
      <FxGlyph className="absolute top-[376px] left-[137px] size-7 text-white opacity-80" />
      <GrokGlyph className="absolute top-[376px] left-[197px] size-7 text-white opacity-80" />
      <PiGlyph className="absolute top-[436px] left-[76px] size-7 text-white opacity-95" />
    </div>
  );
}

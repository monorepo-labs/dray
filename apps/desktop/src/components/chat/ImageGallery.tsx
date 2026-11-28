import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import ImageLightbox, { type LightboxImage } from "@/components/chat/ImageLightbox";

/// How big a picture in a message's text is drawn. Capped on both axes and
/// cropped on neither, so a phone screenshot lands narrow and a desktop one
/// wide and short; the whole picture is one click away. 288px rather than 320
/// because four phone screenshots then fit one row of a bot's bubble.
export const GALLERY_IMAGE_CLASS =
  "block max-h-72 max-w-[min(100%,36rem)] rounded-lg border border-border object-contain";

type Slot = {
  index: number;
  report: (index: number, item: LightboxImage | null) => void;
  open: (index: number) => void;
};

const SlotContext = createContext<Slot | null>(null);

/// Puts this picture in the gallery around it, under its resolved `src`, and
/// answers how to open it there: `null` outside a gallery, where the picture
/// draws its own way.
///
/// Reported rather than read off the children, because a local file only knows
/// its `src` once it has loaded or fallen back to `read_file`'s data URL.
export function useGallerySlot(item: LightboxImage | null): (() => void) | null {
  const slot = useContext(SlotContext);
  const report = slot?.report;
  const index = slot?.index ?? 0;
  const src = item?.src;
  const name = item?.name ?? "image";
  useEffect(() => {
    if (!report) return;
    report(index, src ? { src, name } : null);
    return () => report(index, null);
  }, [report, index, src, name]);
  return useMemo(() => (slot ? () => slot.open(slot.index) : null), [slot]);
}

/// A run of pictures from a message's markdown, side by side and wrapping,
/// opening one viewer that steps through them all.
///
/// Stacked, four phone screenshots are four screens of scroll; in a row they
/// read as the set they usually are.
export default function ImageGallery({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<(LightboxImage | null)[]>([]);
  const [openAt, setOpenAt] = useState<number | null>(null);

  const report = useCallback((index: number, item: LightboxImage | null) => {
    setItems((prev) => {
      const cur = prev[index] ?? null;
      if (cur?.src === item?.src && cur?.name === item?.name) return prev;
      const next = prev.slice();
      next[index] = item;
      return next;
    });
  }, []);

  const pictures = Children.toArray(children).filter(isValidElement);
  const slots = useMemo(
    () => pictures.map((_, index) => ({ index, report, open: setOpenAt })),
    [pictures.length, report],
  );

  // The viewer holds only what loaded, so its index is a position in that list
  // and not the picture's place in the row.
  const viewable = items.flatMap((item, at) => (item ? [{ item, at }] : []));
  const shown = openAt === null ? -1 : viewable.findIndex((v) => v.at === openAt);

  return (
    <div className="my-3 flex max-w-full flex-wrap items-start gap-1.5">
      {pictures.map((picture, i) => (
        <SlotContext.Provider key={i} value={slots[i]}>
          {picture}
        </SlotContext.Provider>
      ))}
      <ImageLightbox
        images={viewable.map((v) => v.item)}
        index={shown === -1 ? null : shown}
        onIndex={(n) => setOpenAt(viewable[n]?.at ?? null)}
        onClose={() => setOpenAt(null)}
      />
    </div>
  );
}

/// One picture in a gallery row, opening the row's viewer on click.
export function GalleryPicture({
  src,
  alt = "",
  onOpen,
  onError,
}: {
  src: string;
  alt?: string;
  onOpen: () => void;
  onError?: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="min-w-0 max-w-full cursor-zoom-in">
      {/* Lazy, or every screenshot in a long chat decodes on mount at full size. */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={onError}
        className={`${GALLERY_IMAGE_CLASS} transition-opacity hover:opacity-90`}
      />
    </button>
  );
}

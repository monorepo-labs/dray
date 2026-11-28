import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";

import ImageLightbox, { type LightboxImage } from "@/components/chat/ImageLightbox";

/// How big a picture in a message's text is drawn. Capped on both axes and
/// cropped on neither, so a phone screenshot lands narrow and a desktop one
/// wide and short; the whole picture is one click away. 288px rather than 320
/// because four phone screenshots then fit one row of a bot's bubble.
export const GALLERY_IMAGE_CLASS =
  "block max-h-72 max-w-[min(100%,36rem)] rounded-lg border border-border object-contain";

type Entry = { el: { current: HTMLElement | null }; item: LightboxImage };

type Media = {
  register: (id: string, entry: Entry | null) => void;
  open: (id: string, focusTo: HTMLElement | null) => void;
  count: () => number;
};

const MediaContext = createContext<Media | null>(null);
const RowContext = createContext(false);

/// What a picture or recording inside a `MessageMedia` gets back: where it sits
/// in the message, and how to open the message's viewer on it.
export type MessageMediaSlot = {
  /// On the element drawn in the message. Its place in the page is the item's
  /// place in the viewer.
  ref: RefCallback<HTMLElement>;
  /// `focusTo` is where focus lands once the viewer closes.
  open: (focusTo: HTMLElement | null) => void;
  /// How many items the message holds right now.
  count: () => number;
};

/// Puts this item in the viewer of the message around it, under its resolved
/// `src`; `null` outside one, where the item opens its own way.
///
/// Reported rather than read off the markdown, because a local file only knows
/// its `src` once it has loaded or fallen back to `read_file`'s data URL.
export function useMessageMedia(item: LightboxImage | null): MessageMediaSlot | null {
  const media = useContext(MediaContext);
  const id = useId();
  const el = useRef<HTMLElement | null>(null);
  const register = media?.register;
  const src = item?.src;
  const name = item?.name ?? "image";
  const video = item?.video ?? false;
  useEffect(() => {
    if (!register) return;
    register(id, src ? { el, item: { src, name, video } } : null);
    return () => register(id, null);
  }, [register, id, src, name, video]);
  const ref = useCallback((node: HTMLElement | null) => {
    el.current = node;
  }, []);
  return useMemo(
    () => (media ? { ref, open: (focusTo) => media.open(id, focusTo), count: media.count } : null),
    [media, ref, id],
  );
}

/// True inside a row of pictures, where an item draws as a gallery tile.
export function useInImageRow(): boolean {
  return useContext(RowContext);
}

/// One agent message's pictures and recordings, opening one viewer that steps
/// through them all.
///
/// The message, not the row: an agent puts a screenshot under each paragraph
/// that describes it, and a viewer holding only the one clicked is a close and
/// reopen per picture. Ordered by where each sits in the page, since items
/// register as they load and a file read through `read_file` lands late.
export function MessageMedia({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  // The list is a snapshot taken on open and kept through the close, so the
  // fade-out draws the picture it was showing.
  const [view, setView] = useState<{ items: LightboxImage[]; index: number | null }>({
    items: [],
    index: null,
  });
  const focusTo = useRef<HTMLElement | null>(null);

  const media = useMemo<Media>(() => {
    const placed = () =>
      [...entries.current.entries()]
        .filter(([, entry]) => entry.el.current?.isConnected)
        .sort(([, a], [, b]) =>
          a.el.current!.compareDocumentPosition(b.el.current!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
    return {
      register: (id, entry) => {
        if (entry) entries.current.set(id, entry);
        else entries.current.delete(id);
      },
      open: (id, to) => {
        const list = placed();
        const index = list.findIndex(([key]) => key === id);
        if (index === -1) return;
        focusTo.current = to;
        setView({ items: list.map(([, entry]) => entry.item), index });
      },
      count: () => placed().length,
    };
  }, []);

  return (
    <MediaContext.Provider value={media}>
      {children}
      {/* The viewer's own player must not join the message it is showing. */}
      <MediaContext.Provider value={null}>
        <ImageLightbox
          images={view.items}
          index={view.index}
          onIndex={(index) => setView((v) => ({ ...v, index }))}
          onClose={() => setView((v) => ({ ...v, index: null }))}
          // WebKit never focuses a clicked button, so Radix's own return lands
          // on the body and the next Tab starts from the top of the window.
          onCloseAutoFocus={(e) => {
            const to = focusTo.current;
            if (!to?.isConnected) return;
            e.preventDefault();
            to.focus({ preventScroll: true });
          }}
        />
      </MediaContext.Provider>
    </MediaContext.Provider>
  );
}

/// A run of pictures from a message's markdown, side by side and wrapping.
///
/// Stacked, four phone screenshots are four screens of scroll; in a row they
/// read as the set they usually are.
export default function ImageGallery({ children }: { children: ReactNode }) {
  return (
    <div className="my-3 flex max-w-full flex-wrap items-start gap-1.5">
      <RowContext.Provider value>{children}</RowContext.Provider>
    </div>
  );
}

/// One picture in a gallery row, opening the message's viewer on click.
export function GalleryPicture({
  src,
  alt = "",
  slot,
  onError,
}: {
  src: string;
  alt?: string;
  slot: MessageMediaSlot;
  onError?: () => void;
}) {
  return (
    <button
      ref={slot.ref}
      type="button"
      onClick={(e) => slot.open(e.currentTarget)}
      className="min-w-0 max-w-full cursor-zoom-in"
    >
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

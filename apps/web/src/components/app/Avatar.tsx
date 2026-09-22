import { Blobatar } from "@blobatar/react";
import { idle } from "blobatar/expression";

/// A session's own face, seeded from a string so the same session always draws
/// the same avatar. 20px, the crew header's own slot.
///
/// `idle` and `animate="hover"` are the app's resting pair. The app never
/// imports `blobatar/motion.css` outside its demo page, so the poses sit still
/// there too — which is what this needs anyway.
///
/// `animate` is what makes this inline SVG rather than an `<img>`: content
/// inside an `<img>` is an isolated document, so host CSS cannot reach the
/// shapes. No hooks and no browser API, so it stays a server component.
export default function Avatar({
  name,
  className = "size-5 shrink-0",
}: {
  /// Any string — a session id, a title. The same string is the same face.
  name: string;
  className?: string;
}) {
  return (
    <Blobatar name={name} aria-hidden expression={idle} animate="hover" className={className} />
  );
}

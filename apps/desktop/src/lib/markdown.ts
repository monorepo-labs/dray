/// Whether this path is one the Docs panel can render.
///
/// `.mdx` is deliberately out. It is JSX inside markdown, and Streamdown has no
/// idea what a component is — a `<Callout>` would be drawn as prose or dropped
/// by the sanitizer, so the panel would show a confidently wrong version of the
/// file. It goes to the external editor with everything else.
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.endsWith(".md") || name.endsWith(".markdown");
}

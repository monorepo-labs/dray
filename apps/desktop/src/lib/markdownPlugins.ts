import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

// `rehype-harden` drops the href of any link it cannot resolve, which is right,
// and then writes " [blocked]" into the prose beside it, which is not: two
// ordinary shapes hit it. Greptile's severity badges are `<a href="#">` around
// an image — harden's hash-only branch compares `new URL("#", base).hash`
// against `"#"` and that is `""`, so a bare fragment falls through to a parse
// that throws — and a bare relative path in agent output (`src/foo.tsx`) starts
// with none of `/`, `./`, `../`, so it is never parsed either. `text-only`
// keeps the link's own content and adds nothing; real http(s) links are
// untouched, and losing the href is the safe direction.
//
// Harden's own function comes back out of Streamdown's default list rather than
// from a direct dependency, which is what pins it to whatever version
// Streamdown itself runs. Passing `rehypePlugins` replaces that list whole, so
// raw and sanitize have to be named here too.
const [hardenPlugin, hardenDefaults] = defaultRehypePlugins.harden as [
  unknown,
  Record<string, unknown>,
];

/// Streamdown's own rehype pipeline, with harden told to block a link by
/// unwrapping it rather than by annotating the text around it.
export const REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [hardenPlugin, { ...hardenDefaults, linkBlockPolicy: "text-only", imageBlockPolicy: "text-only" }],
] as StreamdownProps["rehypePlugins"];

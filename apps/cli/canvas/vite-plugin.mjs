// Dray canvas: dev-only Vite plugin. Written into a project by `dray canvas setup`.
//
// Three things, all on the dev server alone (`apply: "serve"`), so a build is untouched:
// 1. Stamps every host JSX element with `data-dray-src="file:line:col"`, by
//    wrapping React's dev JSX runtime — the compiler already hands it the source.
// 2. Serves `/__dray/frame?c=<file>&e=<export>&p=<json props>`, one component
//    rendered alone with the project's own global CSS, for a component frame.
// 3. Injects a small inspector into every page, which answers the Dray canvas
//    around it over postMessage: hover and pick outlines, computed styles, source.

import fs from "node:fs";
import path from "node:path";

const RUNTIME = "\0dray-jsx-dev-runtime";
const FRAME = "\0dray-frame";
const INSPECT = "\0dray-inspect";
const STYLE_GUESSES = ["src/index.css", "src/globals.css", "src/styles.css", "src/app/globals.css", "src/App.css"];

/**
 * @param {{ styles?: string[] }} [options] Global stylesheets a component frame
 *   loads, relative to the project root. Default: the first of the usual names.
 */
export default function drayCanvas(options = {}) {
  let root = process.cwd();
  let styles = [];

  return {
    name: "dray-canvas",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      styles = options.styles ?? STYLE_GUESSES.filter((f) => fs.existsSync(path.join(root, f))).slice(0, 1);
    },
    resolveId(id, importer) {
      if (id === "react/jsx-dev-runtime" && importer !== RUNTIME && !importer?.includes("node_modules")) return RUNTIME;
      if (id === "/__dray/frame.js") return FRAME;
      if (id === "/__dray/inspect.js") return INSPECT;
      return null;
    },
    load(id) {
      if (id === RUNTIME) return runtimeModule(root);
      if (id === FRAME) return frameModule(styles);
      if (id === INSPECT) return INSPECT_SOURCE;
      return null;
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: "/__dray/inspect.js" }, injectTo: "head" }];
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__dray/frame") || req.url.startsWith("/__dray/frame.js")) return next();
        try {
          const html = await server.transformIndexHtml(req.url, FRAME_HTML, req.originalUrl);
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

function runtimeModule(root) {
  return `
import { jsxDEV as base, Fragment } from "react/jsx-dev-runtime";
const ROOT = ${JSON.stringify(root.replace(/\\/g, "/") + "/")};
export { Fragment };
export function jsxDEV(type, props, key, isStatic, source, self) {
  if (typeof type === "string" && source && source.fileName && props && !("data-dray-src" in props)) {
    const file = source.fileName.replace(/\\\\/g, "/");
    const rel = file.startsWith(ROOT) ? file.slice(ROOT.length) : file;
    props = { ...props, "data-dray-src": rel + ":" + source.lineNumber + ":" + source.columnNumber };
  }
  return base(type, props, key, isStatic, source, self);
}
`;
}

function frameModule(styles) {
  return `
${styles.map((s) => `import ${JSON.stringify("/" + s.replace(/^\/+/, ""))};`).join("\n")}
import { createElement, Component } from "react";
import { createRoot } from "react-dom/client";

const q = new URLSearchParams(location.search);
const file = q.get("c");
const name = q.get("e") || "default";
let props = {};
try { props = JSON.parse(q.get("p") || "{}"); } catch {}

class Catch extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return createElement("pre", { style: { color: "#b91c1c", font: "12px ui-monospace, monospace", whiteSpace: "pre-wrap", margin: 0 } }, String(this.state.error?.stack || this.state.error));
    return this.props.children;
  }
}

const root = createRoot(document.getElementById("dray-frame"));
function fail(text) {
  root.render(createElement("pre", { style: { color: "#b91c1c", font: "12px ui-monospace, monospace", whiteSpace: "pre-wrap", margin: 0 } }, text));
}
if (!file) fail("No component given: /__dray/frame?c=src/Card.tsx&e=Card");
else {
  import(/* @vite-ignore */ "/" + file.replace(/^\\/+/, "")).then(
    (mod) => {
      const C = mod[name];
      if (!C) return fail(file + " has no export " + name + ". Exports: " + Object.keys(mod).join(", "));
      root.render(createElement(Catch, null, createElement(C, props)));
    },
    (e) => fail(String(e?.stack || e)),
  );
}
`;
}

const FRAME_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dray frame</title>
    <style>
      html, body { margin: 0; min-height: 0; }
      body { padding: 32px; display: flex; justify-content: center; align-items: flex-start; }
    </style>
  </head>
  <body>
    <div id="dray-frame"></div>
    <script type="module" src="/__dray/frame.js"></script>
  </body>
</html>
`;

// The inspector, as one module string so the plugin stays one file. Inert
// outside an iframe: only the canvas around a frame talks to it.
const INSPECT_SOURCE = String.raw`
if (window.parent !== window && !window.__drayInspect) {
  window.__drayInspect = true;
  const post = (msg) => window.parent.postMessage({ dray: true, ...msg }, "*");
  let frameId = null;
  let selected = null;
  let hovered = null;

  const box = (colour, fill) => {
    const el = document.createElement("div");
    el.setAttribute("data-dray-overlay", "");
    el.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;border:1.5px solid " + colour + ";background:" + fill + ";";
    return el;
  };
  const hoverBox = box("#0d99ff", "rgba(13,153,255,0.06)");
  const pickBox = box("#0d99ff", "transparent");
  pickBox.style.borderWidth = "2px";
  const tag = document.createElement("div");
  tag.setAttribute("data-dray-overlay", "");
  tag.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;display:none;background:#0d99ff;color:#fff;font:600 11px/16px system-ui,sans-serif;padding:0 5px;border-radius:3px;white-space:nowrap;";
  const mount = () => document.body && document.body.append(hoverBox, pickBox, tag);
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);

  const place = (el, target) => {
    if (!target || !target.isConnected) { el.style.display = "none"; return null; }
    const r = target.getBoundingClientRect();
    el.style.display = "block";
    el.style.left = r.left + "px"; el.style.top = r.top + "px";
    el.style.width = r.width + "px"; el.style.height = r.height + "px";
    return r;
  };
  const tick = () => {
    place(hoverBox, hovered && hovered !== selected ? hovered : null);
    const r = place(pickBox, selected);
    if (r) {
      tag.style.display = "block";
      tag.textContent = Math.round(r.width) + " × " + Math.round(r.height);
      tag.style.left = r.left + "px";
      tag.style.top = Math.max(0, r.top - 18) + "px";
    } else tag.style.display = "none";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && !el.hasAttribute("data-dray-overlay") ? el : null;
  };

  // Component names from the React fiber on the node, innermost last.
  const components = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? el[key] : null;
    const names = [];
    while (fiber && names.length < 6) {
      const t = fiber.type;
      if (typeof t === "function" || (t && typeof t === "object")) {
        const n = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
        if (n && !/^(Catch|StrictMode|Suspense)$/.test(n) && names[0] !== n) names.unshift(n);
      }
      fiber = fiber.return;
    }
    return names;
  };

  const describe = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const src = el.closest("[data-dray-src]");
    const four = (p) => [cs[p + "Top"], cs[p + "Right"], cs[p + "Bottom"], cs[p + "Left"]];
    const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: typeof el.className === "string" ? el.className : el.getAttribute("class") || "",
      text,
      source: src ? src.getAttribute("data-dray-src") : null,
      sourceIsOwn: src === el,
      components: components(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top + scrollY), width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 },
      styles: {
        display: cs.display,
        flexDirection: cs.display.includes("flex") ? cs.flexDirection : null,
        gap: cs.display.includes("flex") || cs.display.includes("grid") ? cs.gap : null,
        padding: four("padding"),
        margin: four("margin"),
        borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
        borderStyle: cs.borderTopStyle,
        borderColor: cs.borderTopColor,
        borderRadius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
        color: cs.color,
        background: cs.backgroundColor,
        opacity: cs.opacity,
        boxShadow: cs.boxShadow,
      },
    };
  };

  // The content's own size, never the viewport's: the document is at least as
  // tall as the iframe, so measuring it could only ever grow a frame.
  const measure = () => {
    const body = document.body;
    if (!body) return;
    const frame = document.getElementById("dray-frame");
    const pad = (el, side) => parseFloat(getComputedStyle(el)["padding" + side]) || 0;
    let height, width = null;
    if (frame) {
      const r = frame.getBoundingClientRect();
      height = r.bottom + scrollY + pad(body, "Bottom");
      width = frame.scrollWidth + pad(body, "Left") + pad(body, "Right");
    } else {
      let bottom = 0;
      for (const child of body.children) {
        if (child.hasAttribute("data-dray-overlay") || child.tagName === "SCRIPT") continue;
        bottom = Math.max(bottom, child.getBoundingClientRect().bottom + scrollY);
      }
      height = bottom + parseFloat(getComputedStyle(body).marginBottom || "0");
    }
    post({ type: "size", frame: frameId, height: Math.ceil(height), width: width && Math.ceil(width), title: document.title });
  };
  let measureQueued = false;
  const queueMeasure = () => {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => { measureQueued = false; measure(); });
  };
  const sizes = new ResizeObserver(queueMeasure);
  sizes.observe(document.documentElement);
  const watchBody = () => document.body && sizes.observe(document.body);
  if (document.body) watchBody(); else addEventListener("DOMContentLoaded", watchBody);
  addEventListener("load", queueMeasure);

  // A re-render after an edit can replace the picked node; find it again by
  // its source stamp and its place among nodes carrying the same one.
  let pickedSrc = null;
  let pickedIndex = 0;
  const refind = () => {
    if (!selected || selected.isConnected || !pickedSrc) return;
    const all = document.querySelectorAll('[data-dray-src="' + CSS.escape(pickedSrc) + '"]');
    selected = all[pickedIndex] || all[0] || null;
    if (selected) post({ type: "picked", frame: frameId, element: describe(selected), refreshed: true });
  };
  // The outlines move every frame; only the page's own changes count.
  const own = (r) => !(r.target.nodeType === 1 && r.target.hasAttribute("data-dray-overlay"));
  new MutationObserver((records) => {
    if (!records.some(own)) return;
    refind();
    queueMeasure();
    if (selected?.isConnected) postSoon();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
  let soon = null;
  const postSoon = () => {
    clearTimeout(soon);
    soon = setTimeout(() => selected?.isConnected && post({ type: "picked", frame: frameId, element: describe(selected), refreshed: true }), 150);
  };

  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.dray !== true || e.source !== window.parent) return;
    if (m.type === "hello") { frameId = m.frame; measure(); post({ type: "ready", frame: frameId }); }
    else if (m.type === "hover") hovered = at(m.x, m.y);
    else if (m.type === "leave") hovered = null;
    else if (m.type === "clear") { selected = null; pickedSrc = null; }
    else if (m.type === "pick") {
      const el = at(m.x, m.y);
      selected = el;
      if (!el) return post({ type: "picked", frame: frameId, element: null });
      pickedSrc = el.getAttribute("data-dray-src");
      pickedIndex = pickedSrc ? [...document.querySelectorAll('[data-dray-src="' + CSS.escape(pickedSrc) + '"]')].indexOf(el) : 0;
      post({ type: "picked", frame: frameId, element: describe(el), add: !!m.add });
    }
  });
  post({ type: "ready", frame: null });
}
`;

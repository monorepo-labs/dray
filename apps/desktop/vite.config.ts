import { cpSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Set by `scripts/tauri.mjs`, which is the only place that can know the port
// before either server starts. Absent under a bare `pnpm dev`.
const devPort = Number(process.env.DRAY_DEV_PORT) || 1420;

const url = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/// Stages the Material file icons into `public/` so `/file-icons/<name>.svg`
/// resolves the same way in dev and in a bundle.
///
/// They are ~900 separate SVGs referenced by name at runtime, not imported, so
/// no bundler can see them — copying is the only way they reach the output.
/// `public/file-icons` is generated and gitignored.
///
/// Runs at config load rather than in `buildStart`, and that placement is the
/// point: a dev server started before the directory existed serves 404s for
/// every icon until it is restarted, which reads as "the icons are broken"
/// rather than "the server is stale". Doing it here means merely loading the
/// config is enough. The count check keeps a repeat start near-free.
function fileIcons(): Plugin {
  const from = url("./node_modules/vscode-material-icons/generated/icons");
  const to = url("./public/file-icons");

  const stage = () => {
    try {
      if (readdirSync(to).length === readdirSync(from).length) return;
    } catch {
      // No staged directory yet, which is the case the copy exists for.
    }
    cpSync(from, to, { recursive: true });
  };

  stage();
  return { name: "dray-file-icons", buildStart: stage };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), fileIcons()],

  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  // The diff-highlighting worker has a conditional `import("shiki/wasm")` on a
  // path this app never takes (it uses the JS regex engine). The default iife
  // worker build can't code-split, so it would inline that ~600KB chunk into
  // the worker; `es` keeps it a separate file that is never fetched.
  worker: { format: "es" as const },

  test: {
    // `.claude/worktrees` holds live agent worktrees — full checkouts of this
    // repo. Their test files resolve `@` against *this* tree's src, so a stale
    // copy fails against code it was never written for.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri and vite have to agree on one port, so `scripts/tauri.mjs` picks a
  //    free one and hands it to both — this side through the env, tauri's own
  //    through `build.devUrl`. `strictPort` stays: the port is already known to
  //    be free, and letting Vite move off it would leave Tauri loading a URL
  //    nothing is serving. 1420 is only the fallback for `pnpm dev` on its own.
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          // Alongside the server's own, so a second dev build's HMR socket
          // doesn't land on the first one's page.
          port: devPort + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

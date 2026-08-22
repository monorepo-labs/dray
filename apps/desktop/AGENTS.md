# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React 19 and TypeScript frontend. Keep reusable UI in `src/components/`, shared types in `src/types/`, styles near their owning components, and static imports in `src/assets/`. Files copied unchanged at build time belong in `public/`.

`src-tauri/` is the Rust/Tauri 2 backend. Tauri commands and app setup live in `src-tauri/src/lib.rs`; session and CLI-process management live in `session.rs` and `claude_code.rs`. Claude stream-event parsing is isolated in `claude_code/parser.rs`, with captured `.jsonl` fixtures beside it. Native icons and capabilities stay under `src-tauri/icons/` and `src-tauri/capabilities/`.

## Build, Test, and Development Commands

Use `pnpm`; Tauri's configuration calls it directly.

- `pnpm install --frozen-lockfile` installs the locked frontend dependencies.
- `pnpm tauri dev` runs the complete desktop app and Vite frontend.
- `pnpm dev` runs only Vite on port 1420; Tauri `invoke` calls require the desktop shell.
- `pnpm build` type-checks TypeScript and builds the frontend.
- `pnpm tauri build` creates native release bundles.
- `cd src-tauri && cargo check` performs a fast Rust compile check.
- `cd src-tauri && cargo test` runs the Rust parser tests.

## Coding Style & Naming Conventions

TypeScript is strict. Use two-space indentation, double quotes, semicolons, `PascalCase` for React components and exported types, and `camelCase` for functions and local values. Keep component filenames in `PascalCase.tsx`. Rust follows `rustfmt`: use four-space indentation, `snake_case` for functions/modules, and `PascalCase` for types and enum variants. Run `cargo fmt --check` before submitting Rust changes.

Preserve the Tauri boundary: frontend invocation keys are camelCase (for example, `sessionId`), while Rust command parameters remain snake_case. Model unstable CLI payloads with `serde_json::Value` and mark optional wire fields with `#[serde(default)]`.

## Testing Guidelines

Tests currently live in `parser.rs` under `#[cfg(test)]` and use real JSONL fixtures. Name tests descriptively, such as `parses_complex_fixture`. Add or update fixture assertions whenever parser variants change. Run `cargo test`; no coverage threshold is configured. Also run `pnpm build` to catch strict TypeScript errors.

## Commit & Pull Request Guidelines

Recent history uses short, sentence-case summaries such as `Wire Claude Code sessions to a chat UI with live event streaming.` Keep each commit focused and describe the user-visible intent.

Pull requests should include a concise summary, verification commands, and linked issues when applicable. Add screenshots or a short recording for UI changes. Call out fixture/schema changes and any required local CLI setup.

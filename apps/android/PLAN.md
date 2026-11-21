# Dray for Android

A native Kotlin + Jetpack Compose client of `dray-serve`, ported from the iOS
app's first App Store version (0.1.0, `apps/ios` before its 0.2.0 additions).
It runs no core and no agent: every session lives on a server, and the phone
reads and drives it over the same WebSocket the desktop and iOS use
([SERVE-PLAN.md](../desktop/SERVE-PLAN.md)). #1379.

## What this foundation does

- **Pairing**: a `dray://connect?url=…&token=…&name=…` link (the pairing QR,
  which the system camera opens too) fills Add server but never adds unasked;
  the in-app scanner reads the same QR (CameraX + ML Kit); or paste the
  address and token, where a whole connect line fills both. Tokens are sealed
  with an Android Keystore key, never stored plain.
- **Every saved server at once, one merged list**: the desktop sidebar's
  stage runs, a child hanging off its parent on an elbow, PR marks from
  `pr_marks`, a project strip, the settled view, a waiting card under its
  row, and each server's trouble as a card with Retry or Fix. Shared machines
  (`share_machines`) join as servers of their own. The list draws from the
  last read's cache before any socket is up.
- **Transcript**, live: finished turns fold to prompt, summary and answer;
  runs of one tool group; a running turn keeps its newest five rows; `lite`
  reads with a call's body read whole on demand (`get_session_calls`);
  pictures inline and full screen (pager, pinch, double-tap, drag down);
  browser recordings play in place (Media3, token in `/file`'s query).
- **Reply dock**: a message field (text first, as Android chat is, with the
  system's dictation on the mic), the session's model and effort under it
  opening **This task** (model, effort, fast mode, stance, each locked mid-turn
  per `Picks.lockedMidTurn`), and Stop while a turn runs.
- **Permission and question cards**, answered in place, in the transcript and
  under the row in the list.
- **Servers** in Settings: state, on/off, Fix, remove, add.

Left for the tasks building on this: New task (Run with), bots and bot chat,
Changes, the rest of Settings, push (FCM), the PR sheet, the runs sheet
behind "N background tasks running", Share in the image viewer.

## Layout

```
app/src/main/java/com/yogesh/dray/
  wire/    JSON helpers and the wire types (Wire.swift)
  net/     Connection: one OkHttp WebSocket per server, reconnecting (Connection.swift)
  model/   pure logic: buildTurns, stageRuns, tool labels, markdown blocks, Picks
  store/   Store (Store.swift) and the Keystore-sealed tokens
  ui/      Compose screens; Theme.kt holds every colour, size and font
```

**Port by file, keep the names.** Each Kotlin file says which Swift file it
restates; a rule changed in one belongs in the other, and in the desktop file
both restate (`tools.ts`, `permission.ts`, `liveControls.ts`, `model.ts`).

**Every colour, size, radius and font is in [Theme.kt](app/src/main/java/com/yogesh/dray/ui/Theme.kt)**:
the iOS app's dark tokens, dark only, yellow for *needs you* alone. Roboto
stands in for SF Pro; Material is used where Android readers expect it
(back arrow, bottom sheet, pull to refresh, switches).

## Build and test

JDK 17 and the Android SDK (`compileSdk 35`). From `apps/android`:

```bash
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # the pure logic: turns, runs, markdown, labels
./gradlew installDebug         # onto a running emulator or phone
```

`pnpm test:affected` does not reach this app (no `Cargo.toml` or
`package.json`); run the unit tests above.

**Against a real server on this box**: start a `dray-serve` on its own home
and port, `adb reverse tcp:<port> tcp:<port>`, then open the pairing link:

```bash
DRAY_HOME=~/.dray-android-test dray-serve --port 7419 &
adb reverse tcp:7419 tcp:7419
adb shell am start -a android.intent.action.VIEW \
  -d "'dray://connect?url=ws://127.0.0.1:7419&token=<serve-token>&name=Test'"
```

A `dray` command meant for that server needs `DRAY_HOME` set and
`DRAY_ENDPOINT` unset, or it lands on the box's own server.

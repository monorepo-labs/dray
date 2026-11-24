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
- **A machine the phone also pairs directly shows once** (#1404, Store.swift's
  rule with the iOS review applied). Every welcome carries `identity`, a hash
  of the server's token a relay passes through; a shared machine's is learnt
  on its first connect and kept (`copyIds`), so later launches hold the copy
  back before it ever connects. It is held back only while the direct one is
  on and not failing: refused, or down past `LOST_AFTER_MS`, brings the copy
  back and hides the direct one's stale rows instead (`covered`). Removing a
  server lets back only copies held for it. A dropped copy never unregisters
  push — the server keeps one tag per handle, so its twin re-registers — and
  an alert tagged with either id opens through `shownAs`.
- **Transcript**, live: finished turns fold to prompt, summary and answer;
  runs of one tool group; a running turn keeps its newest five rows; `lite`
  reads with a call's body read whole on demand (`get_session_calls`);
  pictures inline and full screen (pager, pinch, double-tap, drag down);
  browser recordings play in place (Media3, token in `/file`'s query).
- **Reply dock**: a message field (text first, as Android chat is, with
  Dray's own dictation on the mic), the session's model and effort under it
  opening **This task** (model, effort, fast mode, stance, each locked mid-turn
  per `Picks.lockedMidTurn`), and Stop while a turn runs.
- **Permission and question cards**, answered in place, in the transcript and
  under the row in the list.
- **Servers** in Settings: state, on/off, Fix, remove, add.
- **Open bot at launch** in Settings (#1517), Off unless a bot is picked: the
  app opens on that bot's chat at launch (the first bot where the picked one
  is gone), over the list so back lands there. Read off the cached list, the
  chat is the launch's first frame; only a launch with no cache waits for the
  server. An alert, a link or any move off the list first spends it. Nothing
  else opens a bot unasked (`OpenIntoBot`).

- **Dictation** (`voice/`, Dictation.swift): per draft, outliving the screen
  that started it. Two engines: Android's `SpeechRecognizer` on the phone
  (on-device where it has one, AppleSpeech.swift's place), listening live and
  restarting across pauses; or a server's model, a 16 kHz WAV through `/upload`
  and `transcribe_upload`, kept for Retry where the server never answered.
  Settings → Dictation picks one. **The voice orb** is VoiceOrb.metal's `prism`
  as AGSL (Android 13+), the same math on the CPU below that, eased and clocked
  as OrbDriver/OrbClock do. The list's foot is VoiceDock (orb, then Cancel and
  Done, then the words and Start task); its picks and start are a stand-in
  until New task lands (`NewTaskDock`). Debug builds carry `OrbDemoActivity`.
- **Push** (`push/`, Push.swift on FCM): the FCM token is sealed by the relay
  (`/api/push/register` with `platform: "android"`) into a handle each server
  gets with `push_register`, exactly as iOS hands its APNs handle over; the
  server needs no change. Alerts are FCM data messages drawn by the app: a
  channel per kind, Allow and Deny, a question's options (three at most, or
  none and the tap opens the app) and Reply, answered on the store's socket or
  one of its own, with no app coming forward. A tap opens the chat (`open`
  where a bot's task alerts). Settings → Notifications holds the switches.

- **Pull requests and Issues pages** (Pulls.swift, PullDetail.swift,
  Issues.swift): beside Settings on the list. Each draws its last read at
  once, from `page-pulls.json` and `page-issues.json` in the cache dir on a
  fresh launch, and reads behind it (`store/Pulls.kt`, `store/Issues.kt`).
  The PR list's search box narrows by title, number, author or branch on the
  phone; the issues one asks the tracker. A PR's page reads it through
  `prs_for_branch` and its description, labels and reviewers through
  `pr_detail` (#1511), and reuses the PR sheet's readiness, checks and
  comments. Starting a task from a PR (iOS's start box) is not ported yet.

Left for the tasks building on this: New task (Run with), bots and bot chat,
Changes, the rest of Settings, the PR sheet, the runs sheet behind "N
background tasks running", Share in the image viewer.

## Push setup

**Push is off until the Firebase project's files are in.** Without
`app/google-services.json` the app builds, `FirebaseApp` never starts, and
Settings → Notifications says push isn't set up. To light it up:

1. The Firebase project is `dray-hq`, its Android app `com.dray.app` (the
   Play Store id; the Kotlin namespace stays `com.yogesh.dray`). The
   google-services plugin fails the build when the file names no client for
   that id, so a file downloaded for an older id must be replaced.
   Its `google-services.json` goes at `apps/android/app/google-services.json`
   and is **kept out of git** (gitignored). Download it from the Firebase
   console (Project settings → Your apps). A release build gets it the same
   way: by hand today, and from a CI secret written to that path before
   `assembleRelease` once an Android release workflow exists.
2. The project's service account key is `FCM_SERVICE_ACCOUNT` on the site
   (Vercel production), base64 of the key file. FCM's HTTP v1 API; the
   legacy "server key" is retired and not used.
3. `PUSH_HANDLE_SECRET` is the one iOS already uses.

**FCM on a sandbox emulator**: Play services' FCM socket sits idle up to two
minutes between heartbeats, and a boat sandbox's network drops it well before,
so a message sent then is lost. Measured, a message sent onto a fresh
connection lands in milliseconds; a test run there restarts Play services
every few seconds (`am force-stop com.google.android.gms`) to keep it fresh.
A phone on a real network needs none of this.

**Testing without FCM**: a debug build takes `--es pushRelay <url>` (seal at a
local relay) and `--es pushPayload '<data JSON>'` (an FCM message's `data`,
drawn in 3s as `PushService` would). Run the site with `FCM_ORIGIN` pointing
at a stand-in and `token_uri` in the key file at one too, and every message the
relay sends lands there to replay into the app.

## Layout

```
app/src/main/java/com/yogesh/dray/
  wire/    JSON helpers and the wire types (Wire.swift)
  net/     Connection: one OkHttp WebSocket per server, reconnecting (Connection.swift)
  push/    FCM token, the relay's handle, alerts and their buttons (Push.swift)
  voice/   dictation: the phone's recognizer, a server's model (Dictation.swift)
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

**The orbs are the [Thinking Orbs](https://github.com/yogesharc/thinking-orbs)
library**, its Compose port from JitPack, pinned to a tag in
`app/build.gradle.kts` as iOS pins the Swift package. `Orb.kt` only maps an
`OrbKind` to its state and variant. Change the drawing there, not here.

**The launcher icon is the iOS icon's layout as vectors**: `res/drawable/ic_launcher_*`
hold the mark, tile and themed (monochrome) layer. The splash is the mark
alone, white and 40dp wide (`splash_mark.xml`), with no tile. A vector draws no blur, so the mark's shadow and the legacy
`ic_launcher.png`s are rendered by `scripts/launcher_icon.sh`; rerun it after
moving the mark.

## Build and test

JDK 17 and the Android SDK (platform `android-37.2`, which AndroidX needs to compile against; the app targets 36, what Play requires). AGP 9 compiles Kotlin itself, so there is no `kotlin-android` plugin: the compose plugin's version in `build.gradle.kts` is the Kotlin in use. From `apps/android`:

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

#!/usr/bin/env python3
"""Size and speed benchmarks for `dray` and `dray-serve` (#1130).

    bench.py run <label> [build flags] [--reuse-build] [--only GROUPS]
    bench.py build <label> [build flags]
    bench.py compare <before> <after>

Results land in ~/dray-bench-results/<label>.json, binaries and logs beside it
in ~/dray-bench-results/<label>/. Outside every worktree on purpose: a later
stage in another worktree reads the same baseline. See README.md.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Another source tree to build, e.g. a `git archive` of a release tag.
REPO = Path(os.environ.get("DRAY_BENCH_REPO", HERE.parent.parent.parent)).resolve()
RESULTS = Path(os.environ.get("DRAY_BENCH_RESULTS", Path.home() / "dray-bench-results"))
CLI_DIR = REPO / "apps" / "cli"
SERVE_DIR = REPO / "apps" / "desktop" / "src-tauri"
FIXTURE = SERVE_DIR / "src" / "harness" / "claude_code" / "fixtures" / "complex.jsonl"
FIXTURE_SID = "80be0109-91a4-4fb3-a8e9-56731df1ad0e"

# The project every bench session points at: this repo cloned at a fixed
# commit, so the file index and the turn-end snapshot read the same tree
# before and after whatever lands on top of it.
PROJECT_COMMIT = "cab4014d"
# Bumped whenever the populated home's recipe changes, so an old one on disk
# is rebuilt rather than compared against.
DATASET_VERSION = 1
SESSIONS = 500
LONG_LOGS_MB = (40, 10, 10)
REPLAY_COPIES = 20

RUNS = 20
WARMUP = 3
# For working on the harness itself: few runs, no quiet-machine gate. Numbers
# taken this way are not results.
QUICK = os.environ.get("DRAY_BENCH_QUICK") == "1"
# Extra environment for every bench server, from `run --server-env`: an
# allocator preloaded, a glibc tunable. Recorded in the result.
SERVER_ENV = {}
if QUICK:
    RUNS, WARMUP = 3, 1
GROUPS = ("size", "cli", "startup", "memory", "hot")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def sh(*cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, check=True, **kw).stdout


def host_triple():
    return re.search(r"^host: (\S+)", sh("rustc", "-vV"), re.M).group(1)


def cli_version():
    return re.search(r'^version = "(.*)"', (CLI_DIR / "Cargo.toml").read_text(), re.M).group(1)


# ── statistics ───────────────────────────────────────────────────────────────


def summary(samples, unit="ms"):
    s = sorted(samples)
    p95 = s[min(len(s) - 1, max(0, round(0.95 * len(s)) - 1))]
    return {"unit": unit, "median": round(statistics.median(s), 3), "min": round(s[0], 3),
            "p95": round(p95, 3), "n": len(s)}


def value(v, unit):
    return {"unit": unit, "value": v}


# ── quiet machine ────────────────────────────────────────────────────────────


def busy_builders():
    out = subprocess.run(["ps", "-eo", "comm="], capture_output=True, text=True).stdout.split()
    return sorted({c for c in out if c in ("cargo", "rustc", "cc1", "cc1plus", "ld", "rust-lld", "lld")})


def wait_quiet(what, max_wait=1800):
    """Blocks until no compiler runs and the 1-minute load is low, or exits.

    A timed group run beside a build measures the build, so refusing beats a
    number nobody can trust. The limit is 35% of the cores.
    """
    if QUICK:
        return os.getloadavg()[0]
    limit = float(os.environ.get("DRAY_BENCH_LOAD_LIMIT", max(1.0, (os.cpu_count() or 1) * 0.35)))
    deadline = time.time() + max_wait
    while True:
        builders = busy_builders()
        load = os.getloadavg()[0]
        if not builders and load <= limit:
            return round(load, 2)
        if time.time() > deadline:
            sys.exit(f"bench: machine not quiet before {what} (builders={builders}, load={load:.2f} > {limit:.2f})")
        log(f"  waiting for a quiet machine before {what}: builders={builders} load={load:.2f}")
        time.sleep(15)


# ── build ────────────────────────────────────────────────────────────────────


def parse_env(pairs):
    env = {}
    for p in pairs or []:
        k, eq, v = p.partition("=")
        if not k or not eq:
            sys.exit(f"bench: env wants KEY=VALUE, got {p!r}")
        env[k] = v
    return env


def timed_build(cmd, cwd, env, logfile):
    shown = {k: v for k, v in env.items() if k.startswith(("CARGO", "DRAY_CLI", "RUST"))}
    t0 = time.monotonic()
    with open(logfile, "w") as f:
        f.write(f"$ {' '.join(cmd)}\n# cwd {cwd}\n# env {json.dumps(shown)}\n")
        f.flush()
        r = subprocess.run(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        sys.exit(f"bench: build failed, see {logfile}")
    return round(time.monotonic() - t0, 1)


def build(label, args):
    """Builds both binaries as release-cli.yml does, clean, for the host target.

    A private target and build dir per label, so the shared `build-dir` in
    ~/dray/.cargo/config.toml can never hand over a cached artifact and the
    build time is a clean one.
    """
    out = RESULTS / label
    out.mkdir(parents=True, exist_ok=True)
    target = host_triple()
    work = Path(args.build_dir) if args.build_dir else out / "target"
    common = parse_env(args.env)
    info = {"target": target, "env": common, "serve_env": parse_env(args.serve_env),
            "cli_env": parse_env(args.cli_env), "jobs_note": "cargo jobs as configured (sandbox: jobs = 2)"}

    def env_for(extra, tdir):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("CARGO_PROFILE_") and k not in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS")}
        env.update(common)
        env.update(extra)
        env["CARGO_TARGET_DIR"] = str(tdir)
        env["CARGO_BUILD_BUILD_DIR"] = str(tdir / "build")
        return env

    if args.cli_bin:
        shutil.copy2(args.cli_bin, out / "dray")
        info["dray_from"] = str(Path(args.cli_bin).resolve())
    else:
        tdir = work / "cli"
        shutil.rmtree(tdir, ignore_errors=True)
        wait_quiet("building dray")
        log("building dray (release, clean)…")
        info["dray_build_s"] = timed_build(["cargo", "build", "--release", "--target", target], CLI_DIR,
                                           env_for(info["cli_env"], tdir), out / "build-dray.log")
        shutil.copy2(tdir / target / "release" / "dray", out / "dray")
        log(f"  dray built in {info['dray_build_s']}s")

    if args.serve_bin:
        shutil.copy2(args.serve_bin, out / "dray-serve.unstripped")
        info["dray_serve_from"] = str(Path(args.serve_bin).resolve())
    else:
        tdir = work / "serve"
        shutil.rmtree(tdir, ignore_errors=True)
        env = env_for(info["serve_env"], tdir)
        env["DRAY_CLI_VERSION"] = cli_version()
        wait_quiet("building dray-serve")
        log("building dray-serve (release, clean)…")
        info["dray_serve_build_s"] = timed_build(
            ["cargo", "build", "--release", "--no-default-features", "--features", "serve",
             "--bin", "dray-serve", "--target", target], SERVE_DIR, env, out / "build-dray-serve.log")
        shutil.copy2(tdir / target / "release" / "dray-serve", out / "dray-serve.unstripped")
        log(f"  dray-serve built in {info['dray_serve_build_s']}s")

    # release-cli.yml strips dray-serve after the build and tars both.
    shutil.copy2(out / "dray-serve.unstripped", out / "dray-serve")
    subprocess.run(["strip", str(out / "dray-serve")], check=True)
    subprocess.run(["tar", "-czf", str(out / f"dray-{target}.tar.gz"), "-C", str(out), "dray", "dray-serve"], check=True)
    info["source"] = str(REPO)
    try:
        info["commit"] = sh("git", "-C", str(REPO), "rev-parse", "HEAD").strip()
        info["dirty"] = bool(sh("git", "-C", str(REPO), "status", "--porcelain", "--", "apps", "crates",
                                 ":!apps/cli/bench").strip())
    except subprocess.CalledProcessError:
        info["commit"] = None  # not a checkout, e.g. a `git archive` of a tag
    (out / "build.json").write_text(json.dumps(info, indent=2))
    if not args.keep_build:
        shutil.rmtree(work, ignore_errors=True)
    return info


# ── sizes ────────────────────────────────────────────────────────────────────


def sections(binary):
    """Allocated ELF sections by name and size."""
    out = {}
    for line in sh("readelf", "-SW", str(binary)).splitlines():
        m = re.match(r"\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+[0-9a-f]+\s+[0-9a-f]+\s+([0-9a-f]+)", line)
        if m and int(m.group(2), 16):
            out[m.group(1)] = int(m.group(2), 16)
    return out


def measure_sizes(out, target):
    m = {}
    for name in ("dray", "dray-serve", "dray-serve.unstripped"):
        m[f"size.{name}"] = value((out / name).stat().st_size, "bytes")
    m["size.archive"] = value((out / f"dray-{target}.tar.gz").stat().st_size, "bytes")
    for name in ("dray", "dray-serve"):
        for sec, size in sections(out / name).items():
            m[f"size.{name}.section{sec}"] = value(size, "bytes")
    return m


# ── the sandbox every server runs in ─────────────────────────────────────────


class Bench:
    """One run's scratch: a fake `claude`, a project clone, scrubbed env.

    Every server gets a DRAY_HOME under here and an environment holding
    nothing of the caller's, so DRAY_ENDPOINT, BOAT_ID and HOME can never point
    it at the real server's home. The whole measure step already runs in a
    network namespace with only loopback up (see `run`).
    """

    def __init__(self, out):
        self.out = out
        self.root = Path(tempfile.mkdtemp(prefix="dray-bench-"))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        shutil.copy2(HERE / "fake_claude.sh", self.bin / "claude")
        (self.bin / "claude").chmod(0o755)
        self.home = self.root / "home"
        self.home.mkdir()
        self.project = self.root / "project"
        subprocess.run(["git", "clone", "-q", "--shared", "--no-checkout", str(REPO), str(self.project)], check=True)
        subprocess.run(["git", "-C", str(self.project), "-c", "advice.detachedHead=false", "checkout", "-q",
                        PROJECT_COMMIT], check=True)
        self.servers = []

    def env(self, dray_home, **extra):
        env = {
            "PATH": f"{self.bin}:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.home),
            "SHELL": "/bin/sh",
            "LANG": "C.UTF-8",
            "DRAY_HOME": str(dray_home),
            "DRAY_NO_ANALYTICS": "1",
            "DRAY_BENCH_DIR": str(self.root),
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        env.update(extra)
        env.update(SERVER_ENV)
        return env

    def replay(self, sid, text, gated=False):
        """What the fake `claude` prints for `sid`, carrying `sid` as the real CLI would.

        `gated` holds the replay until `release(sid)`, for a new session's send.
        """
        (self.root / f"replay-{sid}.jsonl").write_text(text.replace(FIXTURE_SID, sid))
        if gated:
            os.mkfifo(self.root / f"gate-{sid}")

    def release(self, sid, limit=30):
        gate = self.root / f"gate-{sid}"
        deadline = time.time() + limit
        while True:
            try:
                fd = os.open(gate, os.O_WRONLY | os.O_NONBLOCK)
            except OSError:  # ENXIO: the fake has not opened its end yet
                if time.time() > deadline:
                    raise RuntimeError(f"the fake claude for {sid} never reached its gate")
                time.sleep(0.0002)
                continue
            os.write(fd, b"\n")
            os.close(fd)
            return

    def close(self):
        for s in self.servers:
            s.kill()
        shutil.rmtree(self.root, ignore_errors=True)


class Server:
    def __init__(self, bench, binary, dray_home, label):
        self.home = Path(dray_home)
        self.home.mkdir(parents=True, exist_ok=True)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.errlog = open(bench.out / f"server-{label}.log", "a")
        self.t0 = time.perf_counter()
        self.proc = subprocess.Popen([str(binary), "--port", str(self.port)], env=bench.env(self.home),
                                     stdin=subprocess.DEVNULL, stdout=self.errlog, stderr=self.errlog,
                                     start_new_session=True, cwd=str(bench.root))
        bench.servers.append(self)
        self.accepting_ms = None
        self.ready_ms = self._wait_ready()

    def _wait_ready(self, limit=60):
        """Spawn to a hello answered: polls connect at 0.2ms, then handshakes.

        Both ends are kept: the port accepting, and the welcome and
        `live_state` frames read back, which is what a client waits for.
        """
        deadline = time.perf_counter() + limit
        while time.perf_counter() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"dray-serve exited {self.proc.returncode}, see {self.errlog.name}")
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            except OSError:
                time.sleep(0.0002)
                continue
            self.accepting_ms = (time.perf_counter() - self.t0) * 1000
            ws = WS(s, self.token())
            ms = (time.perf_counter() - self.t0) * 1000
            ws.close()
            return ms
        raise RuntimeError("dray-serve never became ready")

    def token(self):
        for _ in range(5000):
            try:
                t = (self.home / "serve-token").read_text().strip()
                if t:
                    return t
            except FileNotFoundError:
                pass
            time.sleep(0.001)
        raise RuntimeError("no serve-token")

    def connect(self):
        return WS(socket.create_connection(("127.0.0.1", self.port)), self.token())

    def proc_stat(self):
        """RSS/PSS from smaps_rollup, peak and threads from status, CPU ticks."""
        pid = self.proc.pid
        r = {}
        for line in open(f"/proc/{pid}/smaps_rollup"):
            k, _, rest = line.partition(":")
            if k in ("Rss", "Pss", "Pss_Anon", "Pss_File", "Private_Dirty", "Anonymous"):
                r[k] = int(rest.split()[0])
        for line in open(f"/proc/{pid}/status"):
            k, _, rest = line.partition(":")
            if k in ("VmHWM", "VmRSS", "Threads"):
                r[k] = int(rest.split()[0])
        return r

    def cpu_ms(self):
        fields = open(f"/proc/{self.proc.pid}/stat").read().rsplit(")", 1)[1].split()
        return (int(fields[11]) + int(fields[12])) * 1000 / os.sysconf("SC_CLK_TCK")

    def kill(self):
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait()
        self.errlog.close()


class WS:
    """The serve wire: a WebSocket of JSON text frames, client side, stdlib only.

    Times are taken to the last byte of a reply, before Python parses it, so
    client-side JSON cost stays out of the numbers.
    """

    def __init__(self, sock, token):
        self.s = sock
        self.s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.s.settimeout(120)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.buf = bytearray()
        while b"\r\n\r\n" not in self.buf:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("closed during handshake")
            self.buf += chunk
        head, _, rest = bytes(self.buf).partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace"))
        self.buf = bytearray(rest)
        self.next_id = 0
        # Events that landed while the last call waited for its reply. Replies
        # and events share one socket in no promised order, and the fake agent
        # answers in microseconds, so a resumed turn can close before
        # `send_msg` answers. `wait_for` looks here first, or it waits for an
        # event already gone by: the likeliest cause of the rare resume that
        # never finished (stages 2 and 3, about 1 in 1,000 resumes).
        self.early = []
        self.send(json.dumps({"v": 1, "token": token}))
        welcome = json.loads(self.recv())
        if "err" in welcome:
            raise ConnectionError(welcome["err"])
        self.recv()  # live_state

    def _read(self, n):
        while len(self.buf) < n:
            want = max(n - len(self.buf), 1 << 20)
            chunk = self.s.recv(want)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        data = bytes(self.buf[:n])
        del self.buf[:n]
        return data

    def send(self, text, opcode=1):
        data = text.encode() if isinstance(text, str) else text
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        key = int.from_bytes((mask * (n // 4 + 1))[:n], "big")
        masked = (int.from_bytes(data, "big") ^ key).to_bytes(n, "big") if n else b""
        self.s.sendall(head + mask + masked)

    def recv(self):
        """One whole message's bytes, answering pings on the way."""
        parts = []
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            op = b0 & 0x0F
            if op == 9:
                self.send(payload, opcode=10)
                continue
            if op == 8:
                raise ConnectionError("server closed the socket")
            if op == 10:
                continue
            parts.append(payload)
            if b0 & 0x80:
                return b"".join(parts)

    def call_raw(self, cmd, args=None):
        """Sends one command; answers (ms to the reply's last byte, raw reply)."""
        self.next_id += 1
        frame = json.dumps({"id": self.next_id, "cmd": cmd, "args": args or {}})
        self.early = []
        t0 = time.perf_counter()
        self.send(frame)
        while True:
            msg = self.recv()
            if not msg.startswith(b'{"event"'):
                return (time.perf_counter() - t0) * 1000, msg
            self.early.append(msg)

    def call(self, cmd, args=None):
        ms, raw = self.call_raw(cmd, args)
        reply = json.loads(raw)
        if "err" in reply:
            raise RuntimeError(f"{cmd}: {reply['err']}")
        return ms, reply.get("ok")

    def wait_for(self, needle, limit=300):
        """Reads events, those that came ahead of the last reply first, until one holding every byte string in `needle`."""
        early, self.early = self.early, []
        for i, msg in enumerate(early):
            if all(n in msg for n in needle):
                log(f"  {needle[0].decode()} reached the client before the reply to the call that caused it")
                return i + 1
        deadline = time.time() + limit
        seen = []
        try:
            while time.time() < deadline:
                msg = self.recv()
                seen.append(msg)
                if all(n in msg for n in needle):
                    return len(early) + len(seen)
        except TimeoutError:
            pass
        last = [m[:160].decode(errors="replace") for m in (early + seen)[-5:]]
        raise TimeoutError(f"no event with {needle} in {limit}s or a quiet socket; "
                           f"{len(early)} events before the reply, {len(seen)} after; last: {last}")

    def close(self):
        try:
            self.send(b"\x03\xe8", opcode=8)
            self.s.close()
        except OSError:
            pass


# ── the populated home ───────────────────────────────────────────────────────


def replay_text(copies):
    """`copies` of complex.jsonl as one turn: every `result` but the last dropped."""
    lines = [l for l in FIXTURE.read_text().splitlines() if l.strip()]
    body = [l for l in lines if json.loads(l).get("type") != "result"]
    results = [l for l in lines if json.loads(l).get("type") == "result"]
    return "\n".join(body * copies + results[-1:]) + "\n"


def result_only():
    """The fixture's closing `result` alone: the smallest turn there is."""
    lines = [l for l in FIXTURE.read_text().splitlines() if l.strip()]
    return [l for l in lines if json.loads(l).get("type") == "result"][-1] + "\n"


def send_args(session_id, project, new, model="sonnet"):
    return {"sessionId": session_id, "prompt": "Bench turn.", "attachmentPaths": [], "harness": "claude_code",
            "model": model, "effort": None, "permissionMode": "auto", "fast": False, "cwd": str(project),
            "branch": None, "useWorktree": False, "worktreeName": None, "baseRef": None, "isNewSession": new}


def dataset(bench, serve_bin):
    """The populated home, built once per machine and reused by every label.

    Seeded by one replayed turn through the server under test, then tiled:
    SESSIONS small sessions in the index and LONG_LOGS_MB long logs. Paths to
    the project are stored as a placeholder and filled in per run. Reused so
    before and after read byte-identical data.
    """
    root = RESULTS / "data"
    meta = root / "dataset.json"
    if meta.exists() and json.loads(meta.read_text()).get("version") == DATASET_VERSION:
        return json.loads(meta.read_text())
    log("building the populated home (once per machine)…")
    shutil.rmtree(root, ignore_errors=True)
    home = bench.root / "seed-home"
    srv = Server(bench, serve_bin, home, "seed")
    ws = srv.connect()
    ws.call("add_project", {"path": str(bench.project)})
    sid = str(uuid.uuid4())
    bench.replay(sid, replay_text(1), gated=True)
    ws.call("send_msg", send_args(sid, bench.project, True))
    bench.release(sid)
    ws.wait_for([b'"turn_completed"', sid.encode()])
    time.sleep(0.5)
    ws.close()
    srv.kill()

    project = str(bench.project)
    seed_log = (home / "sessions" / f"{sid}.jsonl").read_text().replace(project, "@@PROJECT@@")
    index = json.loads((home / "sessions" / "index.json").read_text().replace(project, "@@PROJECT@@"))
    items = index if isinstance(index, list) else index["sessions"]
    seed_item = next(i for i in items if (i.get("id") or i.get("sessionId")) == sid)
    id_key = "id" if "id" in seed_item else "sessionId"
    seed_lines = seed_log.splitlines()
    seq = re.compile(r'"seq":(\d+)')

    (root / "sessions").mkdir(parents=True)
    out_items = []
    base = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)

    def item(n, new_id):
        it = json.loads(json.dumps(seed_item).replace(sid, new_id))
        it["title"] = f"Bench session {n}"
        for k in ("created", "modified"):
            if k in it:
                it[k] = (base + datetime.timedelta(minutes=n)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        if "status" in it:
            it["status"] = "idle"
        return it

    def write_log(new_id, megabytes):
        path = root / "sessions" / f"{new_id}.jsonl"
        with open(path, "w") as f:
            if not megabytes:
                f.write(seed_log.replace(sid, new_id))
                return
            offset, written = 0, 0
            top = max(int(m.group(1)) for l in seed_lines for m in [seq.search(l)] if m) + 1
            while written < megabytes << 20:
                chunk = "\n".join(seq.sub(lambda m: f'"seq":{int(m.group(1)) + offset}', l, count=1)
                                  for l in seed_lines).replace(sid, new_id) + "\n"
                f.write(chunk)
                written += len(chunk)
                offset += top

    rng = uuid.UUID(int=0x0D7A7BE7C40000000000000000000000)
    long_ids = []
    for n in range(SESSIONS):
        new_id = str(uuid.UUID(int=rng.int + n))
        mb = LONG_LOGS_MB[n] if n < len(LONG_LOGS_MB) else 0
        write_log(new_id, mb)
        if mb:
            long_ids.append(new_id)
        out_items.append(item(n, new_id))
    (root / "sessions" / "index.json").write_text(json.dumps(out_items if isinstance(index, list) else
                                                             {**index, "sessions": out_items}))
    for name in ("projects.json",):
        if (home / name).exists():
            (root / name).write_text((home / name).read_text().replace(project, "@@PROJECT@@"))
    digest = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            digest.update(p.name.encode())
            digest.update(p.read_bytes())
    info = {"version": DATASET_VERSION, "sessions": SESSIONS, "long_ids": long_ids,
            "long_mb": list(LONG_LOGS_MB), "small_id": str(uuid.UUID(int=rng.int + SESSIONS - 1)),
            "sha256": digest.hexdigest(), "seed_lines": len(seed_lines), "made_by": str(serve_bin),
            "bytes": sum(p.stat().st_size for p in root.rglob("*") if p.is_file())}
    meta.write_text(json.dumps(info, indent=2))
    return info


def populate(bench, dest):
    """Copies the dataset into `dest`, the project placeholder filled in."""
    src = RESULTS / "data"
    project = str(bench.project).encode()
    for p in src.rglob("*"):
        if p.is_dir() or p.name == "dataset.json":
            continue
        target = dest / p.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(p.read_bytes().replace(b"@@PROJECT@@", project))
    os.chmod(dest, 0o700)


# ── measurements ─────────────────────────────────────────────────────────────


def spawn_wall(argv, env, cwd=None):
    """Wall ms of one child run to exit."""
    devnull = os.open(os.devnull, os.O_RDWR)
    io = [(os.POSIX_SPAWN_DUP2, devnull, fd) for fd in (0, 1, 2)]
    here = os.getcwd()
    os.chdir(cwd or here)
    try:
        t0 = time.perf_counter()
        pid = os.posix_spawn(argv[0], argv, env, file_actions=io)
        _, status = os.waitpid(pid, 0)
        ms = (time.perf_counter() - t0) * 1000
    finally:
        os.chdir(here)
        os.close(devnull)
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError(f"{argv} exited {os.waitstatus_to_exitcode(status)}")
    return ms


def peak_rss(argv, env, cwd=None):
    """Max RSS in KiB, through GNU time.

    Not wait4 here: a child's ru_maxrss starts at its parent's high-water mark
    (exec records the old mm's), so a Python parent reads as 60+ MiB. time
    forks from its own small process, so the floor is ~2 MiB.
    """
    with tempfile.NamedTemporaryFile("r") as f:
        subprocess.run(["/usr/bin/time", "-f", "%M", "-o", f.name, *argv], env=env, cwd=cwd,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return int(f.read().split()[-1])


def timed_spawns(name, argv, env, cwd=None, runs=30):
    for _ in range(WARMUP):
        spawn_wall(argv, env, cwd)
    wall = [spawn_wall(argv, env, cwd) for _ in range(runs)]
    rss = [peak_rss(argv, env, cwd) for _ in range(5)]
    return {f"{name}_ms": summary(wall), f"{name}_maxrss": summary(rss, "KiB")}


def timed_calls(ws, name, cmd, args, runs=RUNS, warmup=WARMUP, srv=None):
    for _ in range(warmup):
        ws.call(cmd, args)
    samples, size = [], 0
    cpu0 = srv.cpu_ms() if srv else None
    for _ in range(runs):
        ms, raw = ws.call_raw(cmd, args)
        if raw.startswith(b'{"err"'):
            raise RuntimeError(f"{cmd}: {raw[:300]!r}")
        samples.append(ms)
        size = len(raw)
    m = {f"{name}_ms": summary(samples), f"{name}_reply": value(size, "bytes")}
    if srv:
        m[f"{name}_server_cpu"] = value(round((srv.cpu_ms() - cpu0) / runs, 3), "ms/op")
    return m


def mem(prefix, st):
    return {f"{prefix}_rss": value(st["Rss"], "KiB"), f"{prefix}_pss": value(st["Pss"], "KiB"),
            f"{prefix}_pss_anon": value(st["Pss_Anon"], "KiB"), f"{prefix}_pss_file": value(st["Pss_File"], "KiB"),
            f"{prefix}_hwm": value(st["VmHWM"], "KiB"), f"{prefix}_threads": value(st["Threads"], "count")}


def measure_cli(bench, out, serve_bin, info):
    m = {}
    dray = str(out / "dray")
    wait_quiet("dray startup")
    env = bench.env(bench.root / "cli-home")
    m.update(timed_spawns("cli.version", [dray, "--version"], env))
    m.update(timed_spawns("cli.help", [dray, "--help"], env))
    home = bench.root / "cli-server"
    populate(bench, home)
    srv = Server(bench, serve_bin, home, "cli")
    time.sleep(2)
    env = bench.env(home, DRAY_ENDPOINT=str(home / "dray.sock"))
    wait_quiet("dray session ls")
    m.update(timed_spawns("cli.session_ls", [dray, "session", "ls"], env, cwd=str(bench.project)))
    m.update(timed_spawns("cli.session_ls_all_json", [dray, "session", "ls", "--all", "--json"], env,
                          cwd=str(bench.project)))
    srv.kill()
    return m


def measure_startup(bench, out, serve_bin, info):
    m = {}
    serve = str(out / "dray-serve")
    wait_quiet("dray-serve --version")
    m.update(timed_spawns("serve.version", [serve, "--version"], bench.env(bench.root / "v-home")))

    wait_quiet("startup, empty home")
    samples, accepting = [], []
    for i in range(WARMUP + RUNS):
        srv = Server(bench, serve_bin, bench.root / f"empty-{i}", "startup-empty")
        srv.kill()
        if i >= WARMUP:
            samples.append(srv.ready_ms)
            accepting.append(srv.accepting_ms)
    m["serve.accepting_empty_ms"] = summary(accepting)
    m["serve.ready_empty_ms"] = summary(samples)

    home = bench.root / "populated-startup"
    populate(bench, home)
    wait_quiet("startup, populated home")
    samples, accepting = [], []
    for i in range(WARMUP + RUNS):
        srv = Server(bench, serve_bin, home, "startup-populated")
        srv.kill()
        if i >= WARMUP:
            samples.append(srv.ready_ms)
            accepting.append(srv.accepting_ms)
    m["serve.accepting_populated_ms"] = summary(accepting)
    m["serve.ready_populated_ms"] = summary(samples)
    return m


SETTLE = 5.0


def measure_memory(bench, out, serve_bin, info):
    m = {}
    for kind in ("empty", "populated"):
        stats = []
        for i in range(3):
            home = bench.root / f"mem-{kind}-{i}"
            if kind == "populated":
                populate(bench, home)
            srv = Server(bench, serve_bin, home, f"memory-{kind}")
            time.sleep(SETTLE)
            stats.append(srv.proc_stat())
            srv.kill()
        mid = sorted(stats, key=lambda s: s["Pss"])[1]
        m.update(mem(f"serve.idle_{kind}", mid))
    return m


def measure_hot(bench, out, serve_bin, info):
    m = {}
    home = bench.root / "hot"
    populate(bench, home)
    srv = Server(bench, serve_bin, home, "hot")
    time.sleep(SETTLE)
    ws = srv.connect()
    long_id = info["long_ids"][0]
    small_id = info["small_id"]

    wait_quiet("wire round trip")
    m.update(timed_calls(ws, "hot.wire_roundtrip", "live_state", {}, runs=200, warmup=20, srv=srv))

    wait_quiet("list sessions")
    m.update(timed_calls(ws, "hot.list_sessions", "list_session_index_items", {"archived": False}, srv=srv))

    wait_quiet("transcript tail")
    m.update(timed_calls(ws, "hot.transcript_tail", "get_session_by_id", {"sessionId": long_id, "turns": 8}, srv=srv))

    wait_quiet("transcript full read")
    m.update(timed_calls(ws, "hot.transcript_full", "get_session_by_id", {"sessionId": long_id, "turns": None},
                         srv=srv))

    # The whole long log paged back the way the app scrolls up: tail, then
    # 16-turn pages. Only the requests are timed; parsing `olderBefore` out of
    # each reply happens between them.
    wait_quiet("transcript paging")
    totals, pages = [], 0
    for i in range(WARMUP + RUNS):
        ms, snap = ws.call("get_session_by_id", {"sessionId": long_id, "turns": 8})
        before, total, pages = snap.get("olderBefore"), ms, 1
        while before:
            ms, page = ws.call("get_session_page", {"sessionId": long_id, "before": before, "turns": 16})
            total += ms
            pages += 1
            before = page.get("olderBefore")
        if i >= WARMUP:
            totals.append(total)
    m["hot.transcript_page_all_ms"] = summary(totals)
    m["hot.transcript_page_all_pages"] = value(pages, "count")

    # A file index from cold, on a path the server has never indexed, then
    # searches against a warm one.
    wait_quiet("file index")
    cold = []
    for i in range(10 + 1):
        link = bench.root / f"proj-link-{i}"
        link.symlink_to(bench.project)
        ms1, _ = ws.call("warm_file_index", {"cwd": str(link)})
        ms2, found = ws.call("search_files", {"cwd": str(link), "query": "session", "limit": 50})
        if not found:
            raise RuntimeError("file search found nothing")
        if i:
            cold.append(ms1 + ms2)
    m["hot.file_index_cold_ms"] = summary(cold)
    warm = []
    for q in ("session", "srv", "mapper.rs", "ts"):
        for i in range(WARMUP + RUNS):
            ms, _ = ws.call("search_files", {"cwd": str(bench.project), "query": q, "limit": 50})
            if i >= WARMUP:
                warm.append(ms)
    m["hot.file_search_ms"] = summary(warm)

    # A turn of REPLAY_COPIES × complex.jsonl through the real read loop:
    # parse, map, ingest, append, broadcast, and the turn's two snapshots.
    # Timed from the send to `turn_completed`; the replay starts once the
    # send has answered (see fake_claude.sh).
    wait_quiet("replayed turn")
    text = replay_text(REPLAY_COPIES)
    lines = text.count("\n")
    samples, cpu = [], []
    for i in range(WARMUP + RUNS):
        sid = str(uuid.uuid4())
        bench.replay(sid, text, gated=True)
        c0 = srv.cpu_ms()
        t0 = time.perf_counter()
        send_ms, _ = ws.call("send_msg", send_args(sid, bench.project, True))
        bench.release(sid)
        ws.wait_for([b'"turn_completed"', sid.encode()])
        ms = (time.perf_counter() - t0) * 1000
        time.sleep(0.3)
        if i == 0:
            # The server's first send probes every agent CLI's path; once.
            m["hot.first_send_ms"] = value(round(send_ms, 1), "ms")
        if i >= WARMUP:
            samples.append(ms)
            cpu.append(srv.cpu_ms() - c0)
    m["hot.replay_turn_ms"] = summary(samples)
    m["hot.replay_turn_lines"] = value(lines, "count")
    m["hot.replay_turn_lines_per_s"] = value(round(lines / (statistics.median(samples) / 1000)), "lines/s")
    m["hot.replay_turn_server_cpu"] = value(round(statistics.median(cpu), 1), "ms/op")

    # Resume: the child is gone, so a send respawns it with --resume, which
    # reads the whole log for its highest seq first. Long against small
    # isolates that read.
    for name, sid in (("hot.resume_long", long_id), ("hot.resume_small", small_id)):
        bench.replay(sid, result_only())
        wait_quiet(name)
        samples = []
        for i in range(WARMUP + RUNS):
            t0 = time.perf_counter()
            ws.call("send_msg", send_args(sid, bench.project, False))
            ws.wait_for([b'"turn_completed"', sid.encode()])
            ms = (time.perf_counter() - t0) * 1000
            time.sleep(0.3)
            if i >= WARMUP:
                samples.append(ms)
        m[f"{name}_ms"] = summary(samples)

    time.sleep(SETTLE)
    m.update(mem("serve.after_load", srv.proc_stat()))
    ws.close()
    srv.kill()
    return m


def machine():
    cpu = next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), "?")
    mem_kb = next(int(l.split()[1]) for l in open("/proc/meminfo") if l.startswith("MemTotal"))
    return {"cpu": cpu, "cores": os.cpu_count(), "kernel": platform.release(), "mem_gib": round(mem_kb / 2**20, 1),
            "rustc": sh("rustc", "-V").strip(), "python": platform.python_version()}


def measure(label, only):
    """The timed part. Runs inside the network namespace `run` makes."""
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    out = RESULTS / label
    info = json.loads((out / "build.json").read_text())
    serve_bin = out / "dray-serve"
    result = {"label": label, "created": datetime.datetime.now().isoformat(timespec="seconds"),
              "machine": machine(), "build": info, "settings": {"runs": RUNS, "warmup": WARMUP,
                                                               "replay_copies": REPLAY_COPIES,
                                                               "project_commit": PROJECT_COMMIT,
                                                               "server_env": SERVER_ENV}, "metrics": {}}
    m = result["metrics"]
    for k in ("dray_build_s", "dray_serve_build_s"):
        if k in info:
            m[f"build.{k.removesuffix('_s')}"] = value(info[k], "s")
    if "size" in only:
        m.update(measure_sizes(out, info["target"]))
    bench = Bench(out)
    try:
        data = dataset(bench, serve_bin)
        result["dataset"] = data
        for group, fn in (("cli", measure_cli), ("startup", measure_startup), ("memory", measure_memory),
                          ("hot", measure_hot)):
            if group in only:
                log(f"measuring {group}…")
                m.update(fn(bench, out, serve_bin, data))
    finally:
        bench.close()
    result["load_after"] = os.getloadavg()[0]
    path = RESULTS / f"{label}.json"
    if path.exists() and set(only) != set(GROUPS):
        old = json.loads(path.read_text())
        old["metrics"].update(m)
        old.update({k: v for k, v in result.items() if k != "metrics"})
        result = old
    path.write_text(json.dumps(result, indent=2))
    log(f"wrote {path}")


# ── compare ──────────────────────────────────────────────────────────────────

HIGHER_IS_BETTER = {"lines/s"}


def fmt(v, unit):
    if v is None:
        return "–"
    if unit == "bytes":
        return f"{v / 2**20:.2f} MiB" if v >= 2**20 else f"{v / 1024:.1f} KiB" if v >= 1024 else f"{v} B"
    if unit == "KiB":
        return f"{v / 1024:.1f} MiB" if v >= 10240 else f"{v:.0f} KiB"
    if unit in ("ms", "ms/op"):
        return f"{v:.3g} ms" if v < 10 else f"{v:.0f} ms"
    if unit == "s":
        return f"{v:.0f} s"
    return f"{v:,}" if isinstance(v, int) else f"{v:g}"


def scalar(metric):
    if metric is None:
        return None
    return metric.get("median", metric.get("value"))


def compare(before, after, all_sections=False):
    """Either side may name several labels, comma-separated: runs of the same
    binaries measured at different times. A side's value is then the median of
    each label's own median, and the spread shows how far its runs disagreed."""
    sides = [[json.loads((RESULTS / f"{l}.json").read_text()) for l in side.split(",") if l]
             for side in (before, after)]
    names = []
    for side in sides:
        for r in side:
            names += [k for k in r["metrics"] if k not in names]

    def side_value(side, name):
        vals = [v for v in (scalar(r["metrics"].get(name)) for r in side) if v is not None]
        if not vals:
            return None, []
        return statistics.median(vals), vals

    many = any(len(side) > 1 for side in sides)
    for title, side in (("before", sides[0]), ("after", sides[1])):
        print(f"{title}: {', '.join(r['label'] for r in side)}  ")
    print()
    heads = [f"before (n={len(sides[0])})", f"after (n={len(sides[1])})", "change %"]
    if many:
        heads += ["before range", "after range"]
    print("| metric | " + " | ".join(heads) + " |")
    print("|---|" + "---:|" * len(heads))
    for name in names:
        unit = next(r["metrics"][name]["unit"] for side in sides for r in side if name in r["metrics"])
        (va, la), (vb, lb) = side_value(sides[0], name), side_value(sides[1], name)
        if ".section" in name and not all_sections:
            if max(va or 0, vb or 0) < 64 * 1024:
                continue
        timed = any(r["metrics"][name].get("median") is not None for side in sides for r in side
                    if name in r["metrics"])
        label = name + (" (median)" if timed else "")
        change = "–"
        if va and vb is not None:
            pct = (vb - va) / va * 100
            change = f"{pct:+.1f}%"
            if unit in HIGHER_IS_BETTER:
                change += " ↑"
        row = [fmt(va, unit), fmt(vb, unit), change]
        if many:
            row += [f"{fmt(min(l), unit)} – {fmt(max(l), unit)}" if len(l) > 1 else "–" for l in (la, lb)]
        print(f"| {label} | " + " | ".join(row) + " |")


# ── bloat ────────────────────────────────────────────────────────────────────

# C code linked in, which carries no `::` path to read a crate from.
C_PREFIXES = (("git_", "libgit2 (C)"), ("mdb_", "lmdb (C)"), ("ring_core_", "ring (C/asm)"),
              ("deflate", "zlib (C)"), ("inflate", "zlib (C)"), ("crc32", "zlib (C)"), ("adler32", "zlib (C)"),
              ("zcalloc", "zlib (C)"), ("_tr_", "zlib (C)"), ("xdl_", "libgit2 (C)"), ("http_parser", "libgit2 (C)"),
              ("blake3_", "blake3 (C/asm)"), ("p256_", "ring (C/asm)"), ("x25519_", "ring (C/asm)"))


def crate_of(name):
    """The crate a demangled symbol belongs to, cargo-bloat's way.

    `<A as B>::f` counts for A's crate, `drop_in_place<T>` and other std
    wrappers for T's where T is named, so a type's glue lands on its owner.
    """
    if "::" not in name:
        for prefix, crate in C_PREFIXES:
            if name.startswith(prefix):
                return crate
        return "[C / other]"
    s = name
    for wrapper in ("core::ptr::drop_in_place<", "core::ptr::drop_in_place::<", "core::ptr::drop_glue::<"):
        if s.startswith(wrapper):
            s = s[len(wrapper):]
    s = s.lstrip("<&*([ ").removeprefix("mut ").removeprefix("dyn ").removeprefix("const ")
    m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)::", s)
    if not m:
        return "[other]"
    crate = m.group(1)
    return {"alloc": "std", "core": "std", "std": "std"}.get(crate, crate)


def bloat(label, binary, top):
    path = RESULTS / label / binary
    if not path.exists():
        sys.exit(f"bench: no {path}")
    out = sh("nm", "-S", "--size-sort", "-C", "--defined-only", str(path))
    if not out.strip():
        sys.exit(f"bench: {path} has no symbols; point at an unstripped build")
    by_crate, by_kind, fns = {}, {"code": 0, "rodata": 0, "data": 0}, []
    for line in out.splitlines():
        parts = line.split(" ", 3)
        if len(parts) < 4:
            continue
        size, kind, name = int(parts[1], 16), parts[2].lower(), parts[3]
        k = "code" if kind in "tw" else "rodata" if kind == "r" else "data" if kind in "dbv" else None
        if not k:
            continue
        by_kind[k] += size
        crate = crate_of(name)
        c = by_crate.setdefault(crate, {"code": 0, "rodata": 0, "data": 0})
        c[k] += size
        if k == "code":
            fns.append((size, name, crate))
    text = sections(path).get(".text", 0)
    ranked = sorted(by_crate.items(), key=lambda kv: -kv[1]["code"])
    print(f"{binary} ({label}): .text {text / 2**20:.2f} MiB, symbols attribute "
          f"{by_kind['code'] / 2**20:.2f} MiB code, {by_kind['rodata'] / 2**20:.2f} MiB named rodata\n")
    print("| crate | code | % of .text | named rodata |")
    print("|---|---:|---:|---:|")
    for crate, c in ranked[:top]:
        print(f"| {crate} | {c['code'] / 1024:.0f} KiB | {c['code'] / text * 100:.1f}% | {c['rodata'] / 1024:.0f} KiB |")
    print("\n| function | size | crate |")
    print("|---|---:|---|")
    for size, name, crate in sorted(fns, reverse=True)[:top]:
        short = name if len(name) < 110 else name[:107] + "…"
        print(f"| `{short.replace('|', '¦')}` | {size / 1024:.1f} KiB | {crate} |")
    (RESULTS / label / f"bloat-{binary}.json").write_text(json.dumps(
        {"text": text, "by_kind": by_kind, "by_crate": dict(ranked),
         "top_functions": [{"size": s, "name": n, "crate": c} for s, n, c in sorted(fns, reverse=True)[:200]]},
        indent=1))


# ── entry ────────────────────────────────────────────────────────────────────


def build_flags(p):
    p.add_argument("--env", action="append", help="KEY=VALUE for both builds (repeatable)")
    p.add_argument("--serve-env", action="append", help="KEY=VALUE for the dray-serve build only")
    p.add_argument("--cli-env", action="append", help="KEY=VALUE for the dray build only")
    p.add_argument("--serve-bin", help="skip building dray-serve; measure this binary (stripped here)")
    p.add_argument("--cli-bin", help="skip building dray; measure this binary")
    p.add_argument("--build-dir", help="cargo target dir (default <results>/<label>/target, removed after)")
    p.add_argument("--keep-build", action="store_true", help="keep the cargo target dir")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build both binaries into <results>/<label>/")
    b.add_argument("label")
    build_flags(b)
    r = sub.add_parser("run", help="build, then measure; writes <results>/<label>.json")
    r.add_argument("label")
    build_flags(r)
    r.add_argument("--reuse-build", action="store_true", help="measure what `build <label>` already made")
    r.add_argument("--only", default=",".join(GROUPS), help=f"comma list of {','.join(GROUPS)}")
    r.add_argument("--server-env", dest="server_env_run", action="append",
                   help="KEY=VALUE for every bench server at run time, e.g. LD_PRELOAD=… (repeatable)")
    c = sub.add_parser("compare", help="markdown table of two labels, or two comma-separated sets of runs")
    c.add_argument("before", help="label, or labels a,b,c whose medians are combined")
    c.add_argument("after", help="label, or labels a,b,c whose medians are combined")
    c.add_argument("--all-sections", action="store_true", help="list ELF sections under 64 KiB too")
    bl = sub.add_parser("bloat", help="size by crate and biggest functions, from an unstripped binary")
    bl.add_argument("label")
    bl.add_argument("--bin", default="dray-serve.unstripped", help="file under <results>/<label>/")
    bl.add_argument("--top", type=int, default=30)
    m = sub.add_parser("_measure")
    m.add_argument("label")
    m.add_argument("--only", required=True)
    m.add_argument("--server-env", default="{}")
    args = ap.parse_args()

    if args.cmd == "build":
        print(json.dumps(build(args.label, args), indent=2))
    elif args.cmd == "run":
        if not args.reuse_build:
            build(args.label, args)
        elif not (RESULTS / args.label / "build.json").exists():
            sys.exit(f"bench: nothing built for {args.label}; drop --reuse-build")
        only = [g for g in args.only.split(",") if g]
        bad = set(only) - set(GROUPS)
        if bad:
            sys.exit(f"bench: unknown group {bad}")
        # Loopback only: whatever the server reaches for at start (a relay,
        # analytics, a sandbox heartbeat) fails at once, the same every run.
        os.execvp("unshare", ["unshare", "-rn", sys.executable, str(Path(__file__).resolve()), "_measure",
                              args.label, "--only", ",".join(only),
                              "--server-env", json.dumps(parse_env(args.server_env_run))])
    elif args.cmd == "_measure":
        SERVER_ENV.update(json.loads(args.server_env))
        measure(args.label, args.only.split(","))
    elif args.cmd == "compare":
        compare(args.before, args.after, args.all_sections)
    elif args.cmd == "bloat":
        bloat(args.label, args.bin, args.top)


if __name__ == "__main__":
    main()

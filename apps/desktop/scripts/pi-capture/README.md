# pi capture harness

Everything needed to re-capture `apps/desktop/src-tauri/src/harness/pi/fixtures/`.

| file | what it is |
|---|---|
| `drive.mjs` | Spawns `pi --mode rpc`, tees both pipes into one wrapped JSONL file, plays a scenario. Reads records on `\n` only — deliberately not `readline`, which pi's own docs warn also splits on `U+2028`/`U+2029`, both legal inside a JSON string. |
| `stub-server.mjs` | A scripted OpenAI-completions provider on `127.0.0.1:8787`. Real SSE, canned tokens. Resets its script whenever a fresh conversation starts, so one server serves every scenario. |
| `stub-models.json` | The `models.json` that points pi at it. Three providers, one of them deliberately keyless — that one is what proves `get_available_models` lists only what has auth. |
| `probe-approvals.ts` | A five-line pi extension that turns every `tool_call` into `ctx.ui.confirm`. This is the shape Dray would ship; see PI-PLAN.md §6. |
| `sanitize.py` | Rewrites machine paths on the way into the fixtures tree. |
| `scenarios/*.json` | One per fixture. Paths are written as `${PI_BIN}`, `${PROBE}` and `${NODE_BIN}`, expanded from the environment. |

## Running it

pi 0.84.4 needs **Node 24 or newer**. On Node 22, npm resolves the
`legacy-node20` dist-tag and installs 0.74.2, which has no `agent_settled`.

```bash
export PROBE=/tmp/pi-probe
export NODE_BIN=$HOME/.nvm/versions/node/v24.11.1/bin
export PATH="$NODE_BIN:$PATH"

mkdir -p "$PROBE/work" "$PROBE/raw" "$PROBE/agentdir"
npm --prefix "$PROBE" install @earendil-works/pi-coding-agent@0.84.4
export PI_BIN="$PROBE/node_modules/.bin/pi"

cp stub-models.json "$PROBE/agentdir/models.json"
cp probe-approvals.ts "$PROBE/agentdir/dray-approvals.ts"
( cd "$PROBE/work" && git init -q && printf 'hello\nworld\n' > notes.txt \
  && printf 'export const a = 1;\nexport const b = 2;\n' > src.ts )

node stub-server.mjs &
node drive.mjs "$PROBE/raw/tools.jsonl" scenarios/tools.json \
  && ./sanitize.py "$PROBE/raw/tools.jsonl" \
       ../../src-tauri/src/harness/pi/fixtures/no_approvals.jsonl
```

**The `&&` is the point, not a habit.** `drive.mjs` exits non-zero when a
`waitFor` times out, when pi dies with steps left, when it cannot be spawned at
all, or when it said nothing — and every one of those produces a *plausible*
capture file. An incomplete capture sanitized into the fixtures tree reads
exactly like a good one, and the tests over it pass by describing less than
they claim to. This happened during the original capture run: a scenario timed
out waiting for `agent_settled` because the stub's script was exhausted, and
the driver reported `22 out-lines` and exited 0.

Every scenario writes to `$PROBE/raw/<name>.jsonl`; the fixtures README maps
each one to the fixture it becomes.

`scenarios/turn.json` is the odd one — it names no stub provider, so it runs
against whatever pi is really logged into. It is the only scenario that costs
anything, and the only one whose capture reached the network.

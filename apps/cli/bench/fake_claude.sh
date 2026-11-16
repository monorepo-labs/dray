#!/bin/sh
# Stands in for the `claude` CLI on a bench server's PATH, so a turn runs the
# server's real parse → map → ingest → log path with no agent and no network.
# A stream-json child reads the prompt, prints the replay the bench wrote for
# its session (the fixture with this session's id in it, as the real CLI
# echoes) and exits; the exit makes the next send a resume, which re-reads
# the log's highest seq. Anything else (the title probe) gets one line.
case " $* " in
  *" --input-format "*) ;;
  *) echo "Bench session"; exit 0 ;;
esac
sid= prev=
for arg in "$@"; do
  case $prev in --session-id | --resume) sid=$arg ;; esac
  prev=$arg
done
IFS= read -r _prompt || exit 0
# A new session's send reads its own log back before answering, and an event
# appended meanwhile can fail it as "malformed session file". The bench opens
# this gate once the send has answered.
gate="$DRAY_BENCH_DIR/gate-$sid"
if [ -p "$gate" ]; then IFS= read -r _ < "$gate"; fi
exec cat "$DRAY_BENCH_DIR/replay-$sid.jsonl"

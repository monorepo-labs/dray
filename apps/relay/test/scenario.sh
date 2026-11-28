#!/usr/bin/env bash
# One drop against the server in netns.sh's namespace, stamped into
# $EVENTS (default /tmp/rt/events.log) so probe and client logs can be lined
# up with it afterwards:
#
#   scenario.sh cut 60        link down 60s, then restored
#   scenario.sh blackhole 120 packets dropped 120s, then restored
#   scenario.sh reset         every TCP connection out of the namespace reset
#
# Then waits 45s, so recovery lands in the logs before the next one.
set -euo pipefail
here=$(dirname "$0")
events=${EVENTS:-/tmp/rt/events.log}
stamp() { echo "$(date +%H:%M:%S.%3N) $*" | tee -a "$events"; }
kind=$1
secs=${2:-0}
case "$kind" in
cut | blackhole)
  stamp "$kind start ${secs}s"
  "$here/netns.sh" "$kind"
  sleep "$secs"
  "$here/netns.sh" restore
  stamp "$kind restored"
  ;;
reset)
  stamp "reset"
  "$here/netns.sh" reset
  ;;
*)
  sed -n '2,10p' "$0"
  exit 2
  ;;
esac
sleep 45
stamp "$kind done"

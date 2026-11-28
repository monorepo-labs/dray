#!/usr/bin/env bash
# A network namespace for the server under test, so its network can be cut
# without touching the box's: `drayb` behind a veth pair, 10.200.0.2 inside
# and 10.200.0.1 on the host, NATed out so opentunnel works from it too.
#
#   netns.sh up | down
#   netns.sh cut        link down (the machine's Wi-Fi going away)
#   netns.sh blackhole  packets dropped, link up (a router or ISP gone silent)
#   netns.sh restore    both undone
#   netns.sh reset      every TCP connection out of the namespace reset
#   netns.sh run CMD…   CMD inside the namespace, as the calling user
set -euo pipefail
NS=drayb
HOST_IF=vdrayb0
NS_IF=vdrayb1

case "${1:-}" in
up)
  sudo ip netns add "$NS"
  sudo ip link add "$HOST_IF" type veth peer name "$NS_IF"
  sudo ip link set "$NS_IF" netns "$NS"
  sudo ip addr add 10.200.0.1/24 dev "$HOST_IF"
  sudo ip link set "$HOST_IF" up
  sudo ip netns exec "$NS" ip addr add 10.200.0.2/24 dev "$NS_IF"
  sudo ip netns exec "$NS" ip link set "$NS_IF" up
  sudo ip netns exec "$NS" ip link set lo up
  sudo ip netns exec "$NS" ip route add default via 10.200.0.1
  sudo sysctl -qw net.ipv4.ip_forward=1
  sudo iptables -t nat -A POSTROUTING -s 10.200.0.0/24 ! -o "$HOST_IF" -j MASQUERADE
  sudo iptables -I FORWARD -i "$HOST_IF" -j ACCEPT
  sudo iptables -I FORWARD -o "$HOST_IF" -j ACCEPT
  # A host firewall (ufw) drops input from a new interface by default.
  sudo iptables -I INPUT -i "$HOST_IF" -j ACCEPT
  sudo mkdir -p /etc/netns/"$NS"
  echo "nameserver 1.1.1.1" | sudo tee /etc/netns/"$NS"/resolv.conf >/dev/null
  ;;
down)
  sudo iptables -t nat -D POSTROUTING -s 10.200.0.0/24 ! -o "$HOST_IF" -j MASQUERADE || true
  sudo iptables -D FORWARD -i "$HOST_IF" -j ACCEPT || true
  sudo iptables -D FORWARD -o "$HOST_IF" -j ACCEPT || true
  sudo iptables -D INPUT -i "$HOST_IF" -j ACCEPT || true
  sudo ip netns del "$NS" || true
  sudo rm -rf /etc/netns/"$NS"
  ;;
cut)
  sudo ip netns exec "$NS" ip link set "$NS_IF" down
  ;;
blackhole)
  sudo ip netns exec "$NS" iptables -I OUTPUT -o "$NS_IF" -j DROP
  sudo ip netns exec "$NS" iptables -I INPUT -i "$NS_IF" -j DROP
  ;;
restore)
  sudo ip netns exec "$NS" iptables -D OUTPUT -o "$NS_IF" -j DROP 2>/dev/null || true
  sudo ip netns exec "$NS" iptables -D INPUT -i "$NS_IF" -j DROP 2>/dev/null || true
  sudo ip netns exec "$NS" ip link set "$NS_IF" up
  sudo ip netns exec "$NS" ip route replace default via 10.200.0.1
  ;;
reset)
  sudo ip netns exec "$NS" ss -K state established '( not dst 127.0.0.1 )' >/dev/null
  ;;
run)
  shift
  # HOME and PATH by hand: the nested sudo would leave root's.
  sudo ip netns exec "$NS" sudo -u "$USER" env HOME="$HOME" PATH="$PATH" "$@"
  ;;
*)
  sed -n '2,13p' "$0"
  exit 2
  ;;
esac

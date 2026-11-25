//! Says when the machine's network moved — an address or default route came
//! or went, or the machine woke — so a tunnel waiting out opentunnel's
//! backoff, up to 30s, can reconnect at once (#1558).
//!
//! Read off the kernel's own route socket (netlink on Linux, `PF_ROUTE` on
//! macOS) by one thread blocked in `read`, which costs nothing between
//! changes. Sleep is read off the clocks: the monotonic one stops while the
//! machine sleeps and the wall clock does not. Elsewhere only sleep is seen.

use std::fmt;
use std::time::{Duration, Instant, SystemTime};

use tokio::sync::{mpsc, watch};

/// A change lands as a burst — address, then routes — and a reconnect tried
/// before the default route is back fails and backs off all over again.
const SETTLE: Duration = Duration::from_secs(1);

const WAKE_TICK: Duration = Duration::from_secs(5);

/// The relay's idle timeout (opentunnel's `IDLE_TIMEOUT_MS`): a sleep past
/// it has ended the session, whatever the tunnel's status still says.
pub const LONG_SLEEP: Duration = Duration::from_millis(opentunnel::protocol::bridge::IDLE_TIMEOUT_MS);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Network,
    /// Asleep at least [`LONG_SLEEP`].
    Woke,
}

impl fmt::Display for Change {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Change::Network => "the network changed",
            Change::Woke => "woke from sleep",
        })
    }
}

/// Every change from here on, settled. Call once: each call starts a thread.
pub fn changes() -> mpsc::Receiver<Change> {
    let (bump, mut bumps) = watch::channel(0u64);
    let spawned = std::thread::Builder::new().name("netwatch".into()).spawn(move || {
        let err = listen(|| bump.send_modify(|n| *n = n.wrapping_add(1)));
        crate::tunnel::log("netwatch", &format!("not watching the network: {err}"));
    });
    if let Err(e) = spawned {
        crate::tunnel::log("netwatch", &format!("not watching the network: {e}"));
    }

    let (tx, rx) = mpsc::channel(4);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(WAKE_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut clocks = (Instant::now(), SystemTime::now());
        let mut watching = true;
        loop {
            let change = tokio::select! {
                bumped = bumps.changed(), if watching => {
                    if bumped.is_err() {
                        watching = false;
                        continue;
                    }
                    // Quiet for a whole SETTLE, so a burst is one reconnect.
                    loop {
                        tokio::time::sleep(SETTLE).await;
                        if !bumps.has_changed().unwrap_or(false) {
                            break;
                        }
                        bumps.borrow_and_update();
                    }
                    Change::Network
                }
                _ = tick.tick() => {
                    let now = (Instant::now(), SystemTime::now());
                    let asleep = slept(now.0 - clocks.0, now.1.duration_since(clocks.1).unwrap_or_default());
                    clocks = now;
                    if asleep < LONG_SLEEP {
                        continue;
                    }
                    Change::Woke
                }
            };
            if tx.send(change).await.is_err() {
                return;
            }
        }
    });
    rx
}

/// How long the machine slept between two readings: wall time the monotonic
/// clock did not see. A wall clock set back reads as none.
fn slept(monotonic: Duration, wall: Duration) -> Duration {
    wall.saturating_sub(monotonic)
}

/// Calls `changed` on every route-socket message that counts, until the
/// socket fails. A lost message (`ENOBUFS`) counts.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn listen(changed: impl Fn()) -> std::io::Error {
    use std::io::Read;
    let mut socket = match open() {
        Ok(fd) => std::fs::File::from(fd),
        Err(e) => return e,
    };
    let mut buf = vec![0u8; 16 << 10];
    loop {
        match socket.read(&mut buf) {
            Ok(0) => return std::io::ErrorKind::UnexpectedEof.into(),
            Ok(n) if counts(&buf[..n]) => changed(),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.raw_os_error() == Some(libc::ENOBUFS) => changed(),
            Err(e) => return e,
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn listen(_changed: impl Fn()) -> std::io::Error {
    std::io::ErrorKind::Unsupported.into()
}

#[cfg(target_os = "linux")]
fn open() -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // SAFETY: plain socket calls; the fd is owned from here on.
    unsafe {
        let fd = libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC, libc::NETLINK_ROUTE);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let fd = OwnedFd::from_raw_fd(fd);
        let mut addr: libc::sockaddr_nl = std::mem::zeroed();
        addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;
        addr.nl_groups =
            (libc::RTMGRP_IPV4_IFADDR | libc::RTMGRP_IPV6_IFADDR | libc::RTMGRP_IPV4_ROUTE | libc::RTMGRP_IPV6_ROUTE) as u32;
        let bound = libc::bind(
            fd.as_raw_fd(),
            (&raw const addr).cast(),
            std::mem::size_of::<libc::sockaddr_nl>() as libc::socklen_t,
        );
        if bound < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(fd)
    }
}

#[cfg(target_os = "macos")]
fn open() -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::{FromRawFd, OwnedFd};
    // SAFETY: plain socket calls; the fd is owned from here on.
    unsafe {
        let fd = libc::socket(libc::PF_ROUTE, libc::SOCK_RAW, libc::AF_UNSPEC);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let fd = OwnedFd::from_raw_fd(fd);
        // No SOCK_CLOEXEC here; without it every agent spawned would hold one.
        if libc::fcntl(std::os::fd::AsRawFd::as_raw_fd(&fd), libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(fd)
    }
}

/// Whether one read off netlink names an address, or a default route, coming
/// or going. Other routes churn with every container and VPN.
#[cfg(any(target_os = "linux", test))]
fn counts_netlink(mut buf: &[u8]) -> bool {
    const HEADER: usize = 16;
    const RTM_NEWADDR: u16 = 20;
    const RTM_DELADDR: u16 = 21;
    const RTM_NEWROUTE: u16 = 24;
    const RTM_DELROUTE: u16 = 25;
    while buf.len() >= HEADER {
        let len = u32::from_ne_bytes(buf[0..4].try_into().expect("4 bytes")) as usize;
        let kind = u16::from_ne_bytes(buf[4..6].try_into().expect("2 bytes"));
        if len < HEADER || len > buf.len() {
            return false;
        }
        match kind {
            RTM_NEWADDR | RTM_DELADDR => return true,
            // `rtmsg.rtm_dst_len`, the prefix length: 0 is a default route.
            RTM_NEWROUTE | RTM_DELROUTE if buf.get(HEADER + 1) == Some(&0) => return true,
            _ => {}
        }
        buf = &buf[((len + 3) & !3).min(buf.len())..];
    }
    false
}

/// Whether one `PF_ROUTE` message names an address coming or going, or an
/// interface going up or down. Route messages are left out: macOS clones a
/// host route for every new peer, so they arrive with every connection.
#[cfg(any(target_os = "macos", test))]
fn counts_route_socket(buf: &[u8]) -> bool {
    const RTM_NEWADDR: u8 = 0xc;
    const RTM_DELADDR: u8 = 0xd;
    const RTM_IFINFO: u8 = 0xe;
    // `rt_msghdr` and its kin open with a u16 length, a u8 version, then the u8 type.
    matches!(buf.get(3), Some(&(RTM_NEWADDR | RTM_DELADDR | RTM_IFINFO)))
}

#[cfg(target_os = "linux")]
fn counts(buf: &[u8]) -> bool {
    counts_netlink(buf)
}

#[cfg(target_os = "macos")]
fn counts(buf: &[u8]) -> bool {
    counts_route_socket(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn netlink(kind: u16, body: &[u8]) -> Vec<u8> {
        let len = 16 + body.len();
        let mut msg = Vec::new();
        msg.extend((len as u32).to_ne_bytes());
        msg.extend(kind.to_ne_bytes());
        msg.extend([0u8; 10]);
        msg.extend(body);
        msg.resize((len + 3) & !3, 0);
        msg
    }

    #[test]
    fn netlink_counts_addresses_and_default_routes_alone() {
        // rtmsg: family, dst_len, src_len, tos, table, protocol, scope, type, flags.
        let default_route = [2u8, 0, 0, 0, 254, 4, 0, 1, 0, 0, 0, 0];
        let subnet_route = [2u8, 24, 0, 0, 254, 2, 253, 1, 0, 0, 0, 0];
        assert!(counts_netlink(&netlink(20, &[0; 8])), "an address added");
        assert!(counts_netlink(&netlink(21, &[0; 8])), "an address removed");
        assert!(counts_netlink(&netlink(24, &default_route)));
        assert!(counts_netlink(&netlink(25, &default_route)));
        assert!(!counts_netlink(&netlink(24, &subnet_route)), "a container's subnet");
        assert!(!counts_netlink(&netlink(16, &[0; 16])), "a link message");

        let mut batch = netlink(24, &subnet_route);
        batch.extend(netlink(21, &[0; 5]));
        assert!(counts_netlink(&batch), "read past the first message");
        assert!(!counts_netlink(&batch[..20]), "a truncated message");
        assert!(!counts_netlink(&[]));
    }

    #[test]
    fn route_socket_counts_addresses_and_interfaces() {
        let msg = |kind: u8| [92u8, 0, 5, kind, 0, 0, 0, 0];
        assert!(counts_route_socket(&msg(0xc)));
        assert!(counts_route_socket(&msg(0xd)));
        assert!(counts_route_socket(&msg(0xe)), "an interface up or down");
        assert!(!counts_route_socket(&msg(0x1)), "a route cloned for a peer");
        assert!(!counts_route_socket(&msg(0x2)));
        assert!(!counts_route_socket(&[92, 0]));
    }

    #[test]
    fn sleep_is_wall_time_the_monotonic_clock_missed() {
        let s = Duration::from_secs;
        assert_eq!(slept(s(5), s(5)), s(0));
        assert_eq!(slept(s(5), s(305)), s(300), "slept five minutes");
        assert_eq!(slept(s(5), s(0)), s(0), "wall clock set back");
    }
}

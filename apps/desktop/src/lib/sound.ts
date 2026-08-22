// Created at module load rather than per-call, so the fetch and decode happen
// while the app is idle instead of on the first settle — otherwise that click
// pays the load latency and every one after it is instant.
const celebration = new Audio("/celebration.wav");
celebration.preload = "auto";

const notification = new Audio("/notification.wav");
notification.preload = "auto";

export function playCelebration() {
  celebration.currentTime = 0;
  void celebration.play().catch(() => {});
}

/// The in-app half of a session handing itself back to the reader.
///
/// Paired with the sidebar glow rather than replacing it: the glow is at the
/// edge of vision and easy to miss while reading something else, and the sound
/// carries with the eyes anywhere on screen. Silent when the window is in the
/// background, since the desktop notification makes its own noise there.
export function playNotification() {
  notification.currentTime = 0;
  void notification.play().catch(() => {});
}

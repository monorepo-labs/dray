//! What the island needs from Windows beyond GPUI's window: the modifier tap,
//! the screenshot key and the done pill's keys through low-level hooks; the
//! work area the panel sits inside; the foreground for a tool window Windows
//! will not activate on its own; and the screen's pixels. The X11 side is
//! `x11.rs`, with the same functions.

use crate::prefs::{self, Key};
use crate::tap::{Kind, Pen, Tap};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DwmSetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
    VK_CONTROL, VK_ESCAPE, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RETURN, VK_RMENU, VK_RSHIFT,
    VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CallNextHookEx, DispatchMessageW, GWL_EXSTYLE, GetClientRect, GetForegroundWindow, GetMessageW,
    GetSystemMetrics, GetWindowRect,
    GetWindowLongPtrW, GetWindowThreadProcessId, HC_ACTION, HWND_TOPMOST, KBDLLHOOKSTRUCT, LWA_ALPHA, MSG, SM_CXSCREEN,
    SM_CYSCREEN, SPI_GETCLIENTAREAANIMATION, SPI_GETWORKAREA, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetForegroundWindow, SetLayeredWindowAttributes,
    SetWindowLongPtrW, SetWindowPos, SetWindowsHookExW, ShowWindow, SystemParametersInfoW, TranslateMessage,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_SYSKEYDOWN, WM_XBUTTONDOWN, WM_XBUTTONUP, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};

/// A window of ours as Windows names it: its `HWND`, as the integer a raw
/// handle carries.
pub type Wid = isize;

pub fn window_id(window: &gpui::Window) -> Option<Wid> {
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Win32(h) => Some(h.hwnd.get()),
        _ => None,
    }
}

/// Makes a GPUI window the island's: no border or rounded corners from
/// Windows 11, which would frame the card's own shape, and, where it must
/// never take the keyboard, never activated by a click either.
pub fn adopt(window: Wid, takes_keys: bool) {
    let h = hwnd(window);
    unsafe {
        let square = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, (&raw const square).cast(), std::mem::size_of_val(&square) as u32);
        let none = DWMWA_COLOR_NONE;
        let _ = DwmSetWindowAttribute(h, DWMWA_BORDER_COLOR, (&raw const none).cast(), std::mem::size_of_val(&none) as u32);
        if !takes_keys {
            let style = GetWindowLongPtrW(h, GWL_EXSTYLE);
            SetWindowLongPtrW(h, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize);
        }
    }
}

fn hwnd(id: Wid) -> HWND {
    HWND(id as *mut _)
}

/// Marks the keys the island itself sends, so its own hook passes them by.
const OURS: usize = 0x4452_4159;

/// A key no keyboard has, sent between a tapped Alt or Win and its release:
/// a modifier released with another key between is no menu key, so the tap
/// neither opens Start nor wakes a window's menu bar. AutoHotkey's mask key.
const MASK: VIRTUAL_KEY = VIRTUAL_KEY(0xE8);

/// `2`, the screenshot key with Win+Shift: the Mac's ⌘⇧2, read as on Linux.
const KEY_2: u32 = 0x32;

struct Watch {
    tap: Tap,
    pen: Pen,
    /// Keys down now, so a held key's repeats are no new presses.
    down: HashSet<u32>,
    /// Presses the hook swallowed, whose releases it swallows too.
    eaten: HashSet<u32>,
    /// The reader's key, read off the prefs at each modifier press, never per key typed.
    key: Key,
    on_tap: Box<dyn Fn()>,
    on_capture: Box<dyn Fn()>,
    on_shift: Box<dyn Fn(bool)>,
}

thread_local! {
    /// The hook thread's state: Windows calls a low-level hook on the thread
    /// that set it, from inside that thread's message loop.
    static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) };
}

/// The done pill's keys, while it is up: who hears them.
static DONE: Mutex<Option<Box<dyn Fn(DoneKey) + Send>>> = Mutex::new(None);

/// Watches for the reader's modifier tapped alone and calls `on_tap` from the
/// watch's own thread. Low-level keyboard and mouse hooks, which see every
/// key and click whoever has focus; a key or a click between down and up
/// rules the tap out, as on X11.
pub fn watch_taps(on_tap: impl Fn() + Send + 'static, on_capture: impl Fn() + Send + 'static, on_shift: impl Fn(bool) + Send + 'static) {
    std::thread::Builder::new()
        .name("island-taps".into())
        .spawn(move || {
            WATCH.with(|w| {
                *w.borrow_mut() = Some(Watch {
                    tap: Tap::default(),
                    pen: Pen::default(),
                    down: HashSet::new(),
                    eaten: HashSet::new(),
                    key: prefs::read().key,
                    on_tap: Box::new(on_tap),
                    on_capture: Box::new(on_capture),
                    on_shift: Box::new(on_shift),
                })
            });
            let module = unsafe { GetModuleHandleW(None) }.ok();
            let hooks = unsafe {
                (
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module.map(Into::into), 0),
                    SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module.map(Into::into), 0),
                )
            };
            if let (Err(err), _) | (_, Err(err)) = &hooks {
                eprintln!("island: no modifier tap: {err}");
                return;
            }
            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        })
        .expect("tap thread");
}

/// Left and right of each, as the low-level hook names them. `None` asks for any of the three.
fn is_key(vk: u32, key: Option<Key>) -> bool {
    let control = [VK_LCONTROL.0, VK_RCONTROL.0, VK_CONTROL.0];
    let alt = [VK_LMENU.0, VK_RMENU.0, VK_MENU.0];
    let win = [VK_LWIN.0, VK_RWIN.0];
    let vk = vk as u16;
    match key {
        Some(Key::Control) => control.contains(&vk),
        Some(Key::Option) => alt.contains(&vk),
        Some(Key::Command) => win.contains(&vk),
        None => control.contains(&vk) || alt.contains(&vk) || win.contains(&vk),
    }
}

fn kind(vk: u32) -> Kind {
    if [VK_LSHIFT.0, VK_RSHIFT.0, VK_SHIFT.0].contains(&(vk as u16)) {
        Kind::Shift
    } else if is_key(vk, None) {
        Kind::Modifier
    } else {
        Kind::Other
    }
}

fn held(vk: VIRTUAL_KEY) -> bool {
    (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16) & 0x8000 != 0
}

/// Which modifiers are down besides the key being pressed: the hook runs
/// before Windows updates its own state for that key, never for the others.
fn mods() -> (bool, bool, bool, bool) {
    (held(VK_CONTROL), held(VK_MENU), held(VK_SHIFT), held(VK_LWIN) || held(VK_RWIN))
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        if info.dwExtraInfo != OURS && WATCH.with(|w| w.borrow_mut().as_mut().is_some_and(|w| w.key(info.vkCode, down))) {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let (button, pressed) = match wparam.0 as u32 {
            WM_LBUTTONDOWN => (1, true),
            WM_LBUTTONUP => (1, false),
            WM_RBUTTONDOWN => (2, true),
            WM_RBUTTONUP => (2, false),
            WM_MBUTTONDOWN => (3, true),
            WM_MBUTTONUP => (3, false),
            WM_XBUTTONDOWN => (4, true),
            WM_XBUTTONUP => (4, false),
            _ => (0, false),
        };
        if button != 0 {
            WATCH.with(|w| {
                if let Some(w) = w.borrow_mut().as_mut() {
                    w.tap.button(button, pressed, Instant::now());
                }
            });
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

impl Watch {
    /// One key down or up. Answers whether the hook swallows it.
    fn key(&mut self, vk: u32, down: bool) -> bool {
        let now = Instant::now();
        if down {
            let repeat = !self.down.insert(vk);
            if is_key(vk, None) && !repeat {
                self.key = prefs::read().key;
            }
            let ours = is_key(vk, Some(self.key));
            self.tap.press(vk, ours, repeat, now);
            if let Some(armed) = self.pen.press(vk, kind(vk)) {
                (self.on_shift)(armed);
            }
            if repeat {
                return self.eaten.contains(&vk);
            }
            let swallow = self.chord(vk);
            if swallow {
                self.eaten.insert(vk);
            }
            return swallow;
        }
        self.down.remove(&vk);
        let ours = is_key(vk, Some(self.key));
        let tapped = self.tap.release(vk, ours, now);
        if let Some(armed) = self.pen.release(vk) {
            (self.on_shift)(armed);
        }
        let eaten = self.eaten.remove(&vk);
        if tapped {
            (self.on_tap)();
            // Alt and Win mean something tapped alone: Start, a menu bar. The
            // release is held back and sent again behind the mask, so Windows
            // reads a chord and does nothing. Sent from here it would land
            // after this release, which Windows handles before we return.
            if self.key != Key::Control {
                send(&[(MASK, false), (MASK, true), (VIRTUAL_KEY(vk as u16), true)]);
                return true;
            }
        }
        eaten
    }

    /// The island's own chords: the screenshot key always, and Esc and
    /// Win+⏎ while the done pill is up. Answers whether to swallow the press.
    fn chord(&mut self, vk: u32) -> bool {
        let (ctrl, alt, shift, win) = mods();
        if vk == KEY_2 && win && shift && !ctrl && !alt {
            (self.on_capture)();
            send(&[(MASK, false), (MASK, true)]);
            return true;
        }
        let done = DONE.lock().unwrap_or_else(|e| e.into_inner());
        let Some(on_key) = done.as_ref() else { return false };
        if vk == VK_ESCAPE.0 as u32 && !ctrl && !alt && !shift && !win {
            on_key(DoneKey::Dismiss);
            return true;
        }
        if vk == VK_RETURN.0 as u32 && win && !ctrl && !alt && !shift {
            on_key(DoneKey::OpenInApp);
            send(&[(MASK, false), (MASK, true)]);
            return true;
        }
        false
    }
}

/// Sends keys marked as ours: `(key, up)` in order.
fn send(keys: &[(VIRTUAL_KEY, bool)]) {
    let inputs: Vec<INPUT> = keys
        .iter()
        .map(|&(vk, up)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }
                        | if [VK_RCONTROL, VK_RMENU, VK_LWIN, VK_RWIN].contains(&vk) { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: OURS,
                },
            },
        })
        .collect();
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// The primary display's work area in device pixels: the screen less the
/// taskbar, wherever it is docked.
pub fn work_area() -> Option<(i32, i32, i32, i32)> {
    let mut rect = RECT::default();
    unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut rect as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) }.ok()?;
    Some((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top))
}

/// The primary display's width in device pixels, against which GPUI's
/// logical display width gives the scale.
pub fn screen_width() -> Option<i32> {
    Some(unsafe { GetSystemMetrics(SM_CXSCREEN) }).filter(|w| *w > 0)
}

pub fn screen_size() -> Option<(u32, u32)> {
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    (w > 0 && h > 0).then_some((w as u32, h as u32))
}

/// DWM composes every window since Windows 8, so clear pixels are always clear.
pub fn compositing() -> bool {
    true
}

/// Windows' "Animation effects" switch, its Reduce Motion.
pub fn animations_off() -> bool {
    let mut on = windows::core::BOOL(1);
    let read = unsafe {
        SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, Some(&mut on as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0))
    };
    read.is_ok() && !on.as_bool()
}

/// The screen's pixels in `rect` (device pixels, primary display at the
/// origin), as RGBA. Our own windows are in it, so the island hides them first.
pub fn capture(x: i32, y: i32, width: u32, height: u32) -> Option<image::RgbaImage> {
    let (w, h) = (width as i32, height as i32);
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).is_ok();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // Negative: rows top-down, as an image's are.
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        SelectObject(memory, old);
        let lines = if copied {
            GetDIBits(memory, bitmap, 0, height, Some(bgra.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS)
        } else {
            0
        };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        if lines != h {
            return None;
        }
        for p in bgra.chunks_exact_mut(4) {
            p.swap(0, 2);
            p[3] = 255;
        }
        image::RgbaImage::from_raw(width, height, bgra)
    }
}

/// Lets the mouse through `window`, or stops letting it through: a layered,
/// transparent window passes every click to whatever is beneath, so the page
/// under the ink still scrolls and clicks until the pen is armed.
pub fn pass_mouse(window: Wid, through: bool) {
    let h = hwnd(window);
    unsafe {
        let style = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let flags = (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) as isize;
        let next = if through { style | flags } else { style & !flags };
        if next != style {
            SetWindowLongPtrW(h, GWL_EXSTYLE, next);
            // A layered window draws nothing until told its opacity.
            if through {
                let _ = SetLayeredWindowAttributes(h, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA);
            }
        }
    }
}

/// Takes a window of ours off the screen for a moment, as a read of the
/// screen must not see it, or puts it back.
pub fn unmap(window: Wid) {
    unsafe {
        let _ = ShowWindow(hwnd(window), SW_HIDE);
    }
}

pub fn map(window: Wid) {
    unsafe {
        let _ = ShowWindow(hwnd(window), SW_SHOWNOACTIVATE);
    }
}

/// Hands the keyboard back to `window`, whoever holds it now.
pub fn refocus(window: Wid) {
    if window != 0 {
        foreground(hwnd(window));
    }
}

/// Whether Shift alone is down right now: the pen may be armed before the
/// microphone opened.
pub fn shift_alone() -> bool {
    let (ctrl, alt, shift, win) = mods();
    shift && !ctrl && !alt && !win
}

/// Puts `window` over every other window of ours: the panel over a capture's
/// overlay, so dictation stays in sight and in reach.
pub fn raise(window: Wid) {
    unsafe {
        let _ = SetWindowPos(hwnd(window), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Moves and sizes a window of ours in device pixels. GPUI reads the
/// `WM_MOVE` and `WM_SIZE` this causes as its new bounds.
///
/// The rect is the client's, as GPUI's bounds are: a window with no title
/// bar keeps Windows' frame on its other three sides, so the window itself
/// is that much larger, or each fit would shrink it by the frame.
pub fn configure(window: Wid, x: i32, y: i32, width: i32, height: i32) {
    let h = hwnd(window);
    let (left, top, right, bottom) = frame(h);
    unsafe {
        let _ = SetWindowPos(
            h,
            None,
            x - left,
            y - top,
            width.max(1) + left + right,
            height.max(1) + top + bottom,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// The frame around the client, per side, in device pixels.
fn frame(h: HWND) -> (i32, i32, i32, i32) {
    let (mut outer, mut client) = (RECT::default(), RECT::default());
    let mut origin = POINT::default();
    unsafe {
        if GetWindowRect(h, &mut outer).is_err() || GetClientRect(h, &mut client).is_err() || !ClientToScreen(h, &mut origin).as_bool() {
            return (0, 0, 0, 0);
        }
    }
    (
        origin.x - outer.left,
        origin.y - outer.top,
        outer.right - (origin.x + client.right),
        outer.bottom - (origin.y + client.bottom),
    )
}

/// Whether Dray's own window is the one in front, which sounds its own
/// notice, so the island's chime would double it: read off the foreground
/// window's process.
pub fn dray_in_front() -> bool {
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return false;
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return false };
    let mut name = [0u16; 1024];
    let mut len = name.len() as u32;
    let read = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(name.as_mut_ptr()), &mut len) };
    let _ = unsafe { windows::Win32::Foundation::CloseHandle(process) };
    read.is_ok() && is_dray_exe(&String::from_utf16_lossy(&name[..len as usize]))
}

/// The app's binary: `Dray.exe` installed, `dray.exe` in a dev build. The
/// server is the same binary but owns no window, so it is never in front.
fn is_dray_exe(path: &str) -> bool {
    let stem = std::path::Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase();
    matches!(stem.as_str(), "dray" | "dray-dev" | "dray-app")
}

/// The window holding the keyboard.
pub fn focus() -> Option<Wid> {
    let window = unsafe { GetForegroundWindow() };
    (!window.is_invalid()).then_some(window.0 as Wid)
}

/// Gives `window` the keyboard and answers whoever had it. Windows lets only
/// the foreground app hand the foreground on, so the island borrows its
/// input queue for the moment it takes it.
pub fn take_focus(window: Wid) -> Option<Wid> {
    let before = focus().unwrap_or(0);
    foreground(hwnd(window));
    Some(before)
}

fn foreground(window: HWND) {
    unsafe {
        let front = GetForegroundWindow();
        let theirs = if front.is_invalid() { 0 } else { GetWindowThreadProcessId(front, None) };
        let ours = GetCurrentThreadId();
        let attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
        let _ = BringWindowToTop(window);
        let _ = SetForegroundWindow(window);
        if attached {
            let _ = AttachThreadInput(ours, theirs, false);
        }
    }
}

/// Hands the keyboard back to the window that had it before the panel took
/// it — only while the panel still holds it: a reader who clicked into another
/// app meanwhile keeps that app.
pub fn give_back(ours: Wid, window: Wid) {
    if window == 0 || focus() != Some(ours) {
        return;
    }
    foreground(hwnd(window));
}

/// A key the done pill answers while it is up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoneKey {
    /// Esc: the pill put away.
    Dismiss,
    /// Win+⏎, the Mac's ⌘⏎: the newest opened in Dray.
    OpenInApp,
}

/// Esc and Win+⏎ taken from every app while the done pill is up, as the
/// Mac's are: the pill never takes the keyboard, so nothing else would hear
/// them. Dropped, the keys go back.
pub struct DoneKeys(());

impl Drop for DoneKeys {
    fn drop(&mut self) {
        *DONE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// The tap watch's hook hears them, so this only says who answers.
pub fn grab_done_keys(on_key: impl Fn(DoneKey) + Send + 'static) -> Option<DoneKeys> {
    *DONE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(on_key));
    Some(DoneKeys(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_dray_by_its_binary() {
        assert!(is_dray_exe(r"C:\Program Files\Dray\Dray.exe"));
        assert!(is_dray_exe(r"C:\dray\apps\desktop\src-tauri\target\debug\dray.exe"));
        assert!(!is_dray_exe(r"C:\Windows\explorer.exe"));
        assert!(!is_dray_exe(r"C:\x\dray-island.exe"));
    }

    #[test]
    fn each_pick_names_its_own_keys() {
        assert!(is_key(VK_LCONTROL.0 as u32, Some(Key::Control)));
        assert!(!is_key(VK_LCONTROL.0 as u32, Some(Key::Option)));
        assert!(is_key(VK_RMENU.0 as u32, Some(Key::Option)));
        assert!(is_key(VK_LWIN.0 as u32, Some(Key::Command)));
        assert_eq!(kind(VK_RSHIFT.0 as u32), Kind::Shift);
        assert_eq!(kind(0x41), Kind::Other);
    }
}

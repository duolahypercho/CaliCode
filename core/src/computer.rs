//! Attach scoping: which processes computer use is allowed to drive.
//!
//! This is the policy half of computer use, and deliberately the half that
//! exists first. The driver half is a third-party dependency sitting behind an
//! install and two macOS TCC grants (`docs/plans/computer-use.md` §1, §4.1),
//! neither of which core can arrange for itself. The rule about what the agent
//! is allowed to touch needs none of that, is testable today, and is the thing
//! that makes an unattended `/loop` defensible at all — so the driver arrives
//! into a boundary that already exists rather than the other way round.
//!
//! The rule is one sentence: **the agent may drive a window only when core
//! spawned the process that owns it.** [`crate::spawn_ledger`] answers that,
//! and answers it in a way that survives pid reuse. Everything here is the
//! surface over that answer.
//!
//! Two things about the shape are load-bearing:
//!
//! 1. **A refusal names the alternatives.** A model told only "no" guesses
//!    again, and guessing at pids is precisely the behaviour scoping exists to
//!    stop. Told what it *may* drive, it stops guessing.
//! 2. **An empty ledger refuses everything**, and that is the correct way to
//!    be incomplete. A spawn site that forgets to register costs a refused
//!    attach; the opposite failure would cost the invariant.

use crate::spawn_ledger::{Entry, SpawnLedger};
use anyhow::{bail, Result};
use serde_json::{json, Value};
// Only the withheld click path and the delivery diagnostics need these; the
// shipped surface (capture, enumeration, keyboard, doctor) is stateless.
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

/// A process computer use may drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub pid: u32,
    pub kind: &'static str,
    pub label: String,
}

impl From<Entry> for Target {
    fn from(entry: Entry) -> Self {
        Target {
            pid: entry.pid,
            kind: entry.kind.as_str(),
            label: entry.label,
        }
    }
}

/// An on-screen window belonging to some process.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub id: u32,
    pub pid: u32,
    pub title: String,
    /// Global screen rect in points, top-left origin: (x, y, width, height).
    pub bounds: (f64, f64, f64, f64),
}

impl Window {
    fn to_json(&self) -> Value {
        json!({ "windowId": self.id, "title": self.title })
    }
}

/// Every on-screen window, with the pid that owns it.
///
/// `CGWindowListCopyWindowInfo` is pure C and synchronous, which is why it is
/// here rather than ScreenCaptureKit: the wrapper crates for SCK build and link
/// Swift, and one enumeration call is not worth a third toolchain.
///
/// Window *titles* need the Screen Recording grant; the list itself does not.
/// So an unpermitted core still sees that windows exist and how many, which is
/// exactly the signal `computer_doctor` needs to tell the user what is missing.
#[cfg(target_os = "macos")]
fn on_screen_windows() -> Vec<Window> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::geometry::CGRect;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListOptionOnScreenOnly,
    };

    let Some(infos) = copy_window_info(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) else {
        return Vec::new();
    };
    // SAFETY: `copy_window_info` returns a CFArray of CFDictionary per the
    // CoreGraphics contract; the wrap is a retain of that same array.
    let array: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_get_rule(infos.as_concrete_TypeRef() as _) };

    let number = |dict: &CFDictionary<CFString, CFType>, key: &str| {
        dict.find(CFString::new(key))
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i64())
    };
    let text = |dict: &CFDictionary<CFString, CFType>, key: &str| {
        dict.find(CFString::new(key))
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
    };

    array
        .iter()
        .filter_map(|dict| {
            // CoreGraphics hands the rect back as a dictionary; its own
            // converter is the only thing that knows the key names for sure.
            let bounds = dict
                .find(CFString::new("kCGWindowBounds"))
                .and_then(|value| value.downcast::<CFDictionary>())
                .and_then(|rect| CGRect::from_dict_representation(&rect))
                .map(|rect| {
                    (
                        rect.origin.x,
                        rect.origin.y,
                        rect.size.width,
                        rect.size.height,
                    )
                })
                .unwrap_or((0.0, 0.0, 0.0, 0.0));
            Some(Window {
                id: number(&dict, "kCGWindowNumber")? as u32,
                pid: number(&dict, "kCGWindowOwnerPID")? as u32,
                title: text(&dict, "kCGWindowName").unwrap_or_default(),
                bounds,
            })
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn on_screen_windows() -> Vec<Window> {
    Vec::new()
}

/// The on-screen windows owned by `pid`.
fn windows_for(pid: u32) -> Vec<Window> {
    on_screen_windows()
        .into_iter()
        .filter(|window| window.pid == pid)
        .collect()
}

fn targets_in(ledger: &SpawnLedger) -> Vec<Target> {
    ledger.list().into_iter().map(Target::from).collect()
}

/// Resolve a pid the model asked to drive, or explain why it may not.
///
/// The error is the user-visible half of the invariant, so it says what the
/// rule is rather than only that it was broken.
fn resolve_in(ledger: &SpawnLedger, pid: u32) -> Result<Target> {
    if let Some(entry) = ledger.lookup(pid) {
        return Ok(entry.into());
    }
    let available = targets_in(ledger);
    if available.is_empty() {
        bail!(
            "pid {pid} is not attachable: computer use may only drive processes CaliCode \
             started, and it has not started any yet. Start the dev server, the agent \
             browser, or Blender first."
        );
    }
    let listed = available
        .iter()
        .map(|target| format!("{} ({}, pid {})", target.label, target.kind, target.pid))
        .collect::<Vec<_>>()
        .join(", ");
    bail!(
        "pid {pid} is not attachable: computer use may only drive processes CaliCode \
         started. Attachable right now: {listed}."
    )
}

/// Longest edge a capture is scaled to before it reaches a vision model.
///
/// A window on this hardware captures at retina scale — 3024x1776 for one
/// editor — and sending that costs tokens for detail no model uses. 1568 is
/// Anthropic's documented ceiling before an image is downscaled server-side
/// anyway, so scaling here buys the same picture for fewer bytes.
const MAX_CAPTURE_EDGE: u32 = 1568;

/// Capture one window as PNG bytes, whether or not it is frontmost.
///
/// **This uses `CGWindowListCreateImage`, which Apple deprecated in macOS 14 in
/// favour of ScreenCaptureKit.** Deliberate, and the alternatives are worse
/// today: the ScreenCaptureKit wrapper crates build and link Swift, which would
/// put a third toolchain in a Rust + TypeScript repo; `objc2-screen-capture-kit`
/// is pure Rust but only exposes the completion-handler API, so a synchronous
/// screenshot means block plumbing; and shelling out to `/usr/sbin/screencapture`
/// would need a Seatbelt carve-out (`sandbox.rs` confines spawns) for something
/// that runs in-process here for free. Verified working on macOS 26.4. The call
/// is one function, so migrating when it finally breaks is contained — that
/// containment is the reason this is an acceptable bet rather than a shortcut.
#[cfg(target_os = "macos")]
fn capture_window(window_id: u32) -> Result<Vec<u8>> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::window::{
        create_image, kCGWindowImageBoundsIgnoreFraming, kCGWindowListOptionIncludingWindow,
    };

    // A zero rect means "the window's own bounds" to CGWindowListCreateImage.
    let null_rect = CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(0.0, 0.0));
    let image = create_image(
        null_rect,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming,
    )
    .ok_or_else(|| {
        anyhow::anyhow!(
            "could not capture window {window_id}: it may have closed, or CaliCode may not \
             hold the Screen Recording permission (System Settings > Privacy & Security > \
             Screen Recording)"
        )
    })?;

    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        bail!("window {window_id} captured as an empty image");
    }
    let stride = image.bytes_per_row();
    let data = image.data();
    let bytes = data.bytes();

    // CoreGraphics hands back BGRA with rows padded out to `stride`, so the
    // channel swap and the row walk both have to happen before any encoder
    // sees it. Reading `width * 4` per row rather than `stride` is what drops
    // the padding.
    let mut rgba = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let start = row * stride;
        let line = bytes
            .get(start..start + width * 4)
            .ok_or_else(|| anyhow::anyhow!("capture buffer shorter than its stated geometry"))?;
        for pixel in line.chunks_exact(4) {
            rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }

    let buffer = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| anyhow::anyhow!("capture buffer did not match its geometry"))?;
    // Scale both axes by the *same* factor. Clamping each independently turns a
    // 1280x800 window into a 1568x1568 square, which is a lie to whatever reads
    // the picture — and the distortion is invisible in the bytes, so only an
    // assertion catches it.
    let longest = width.max(height) as u32;
    let scaled = if longest > MAX_CAPTURE_EDGE {
        let factor = MAX_CAPTURE_EDGE as f64 / longest as f64;
        image::imageops::resize(
            &buffer,
            ((width as f64 * factor).round() as u32).max(1),
            ((height as f64 * factor).round() as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        buffer
    };

    // Remembered so a later click can map the coordinates the model read off
    // this image back onto the window. Stored as the image's own size rather
    // than a scale factor: the model reasons in the pixels it was shown.
    #[cfg(test)]
    remember_capture(window_id, scaled.width(), scaled.height());

    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(scaled)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| anyhow::anyhow!("could not encode capture as png: {error}"))?;
    Ok(png.into_inner())
}

#[cfg(not(target_os = "macos"))]
fn capture_window(_window_id: u32) -> Result<Vec<u8>> {
    bail!("computer use capture is implemented for macOS only")
}

/// Image dimensions of the most recent capture per window.
///
/// A click arrives in the coordinate space of a picture the model was shown,
/// and nothing else in the system knows what that space was — the capture is
/// retina and then downscaled, so neither the window's point size nor its pixel
/// size is the answer. This is the only record of it.
#[cfg(test)]
fn capture_sizes() -> &'static Mutex<HashMap<u32, (u32, u32)>> {
    static SIZES: OnceLock<Mutex<HashMap<u32, (u32, u32)>>> = OnceLock::new();
    SIZES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn remember_capture(window_id: u32, width: u32, height: u32) {
    capture_sizes()
        .lock()
        .unwrap()
        .insert(window_id, (width, height));
}

/// Map a point in captured-image space onto the screen.
///
/// Done as a *fraction* of the window rather than a fixed offset, and against
/// the window's bounds read fresh at click time. That is what makes it survive
/// the window having been moved since the capture: the same fraction of the
/// same window is still the same control, wherever the user dragged it to.
#[cfg(test)]
fn map_to_screen(window: &Window, x: f64, y: f64) -> Result<(f64, f64)> {
    let (image_width, image_height) = capture_sizes()
        .lock()
        .unwrap()
        .get(&window.id)
        .copied()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no capture recorded for window {} — call computer_look first, because a \
                 click is expressed in the coordinates of the picture you were shown",
                window.id
            )
        })?;

    if x < 0.0 || y < 0.0 || x >= image_width as f64 || y >= image_height as f64 {
        bail!(
            "({x}, {y}) is outside the captured image, which is {image_width}x{image_height}. \
             Use coordinates read off that image."
        );
    }

    let (bx, by, bw, bh) = window.bounds;
    if bw <= 0.0 || bh <= 0.0 {
        bail!("window {} reports no size on screen", window.id);
    }
    Ok((
        bx + (x / image_width as f64) * bw,
        by + (y / image_height as f64) * bh,
    ))
}

/// Click a point in `pid`'s window, without moving the user's cursor.
///
/// **This does not currently reach a background window, and that is a limit of
/// the public API rather than of this code.** Measured against a real Chrome on
/// macOS 26.4: keyboard events posted with `CGEventPostToPid` arrive and are
/// read back over CDP; mouse events do not, with or without
/// `MOUSE_EVENT_CLICK_STATE` and with or without both
/// `MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER*` fields naming the target window.
/// A background application cannot hit-test a point it is not under, and
/// nothing public says otherwise on its behalf. This is precisely the gap the
/// private SkyLight SPI (`SLPSPostEventRecordTo`) exists to close, and it is
/// the one place "build it on public API" does not reach — see
/// `docs/plans/computer-use.md` §4.1b.
///
/// Kept, with its live test, because it is the regression test for whichever
/// fix lands. The tool reports that delivery is unconfirmed rather than
/// claiming a success it cannot observe.
#[cfg(all(target_os = "macos", test))]
fn click_at(pid: u32, window_id: u32, screen_x: f64, screen_y: f64) -> Result<()> {
    post_to_pid(pid, mouse_events(window_id, screen_x, screen_y)?)
}

#[cfg(target_os = "macos")]
#[cfg(test)]
fn mouse_events(
    window_id: u32,
    screen_x: f64,
    screen_y: f64,
) -> Result<Vec<core_graphics::event::CGEvent>> {
    use core_graphics::event::{CGEvent, CGEventType, CGMouseButton, EventField};
    use core_graphics::geometry::CGPoint;

    let point = CGPoint::new(screen_x, screen_y);
    let mut events = Vec::new();
    // A mouse-move first: some apps track enter/exit and ignore a press that
    // arrives at a location the pointer was never reported at.
    let moved = CGEvent::new_mouse_event(
        source()?,
        CGEventType::MouseMoved,
        point,
        CGMouseButton::Left,
    )
    .map_err(|_| anyhow::anyhow!("could not create a mouse event"))?;
    events.push(moved);
    for kind in [CGEventType::LeftMouseDown, CGEventType::LeftMouseUp] {
        let event = CGEvent::new_mouse_event(source()?, kind, point, CGMouseButton::Left)
            .map_err(|_| anyhow::anyhow!("could not create a mouse event"))?;
        // Without a click state an app reads this as a stray press and drops it.
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);
        // Name the window explicitly. A background app cannot hit-test the
        // point itself — it is not the one under the real pointer — so without
        // these the event arrives addressed to nothing.
        event.set_integer_value_field(
            EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER,
            window_id as i64,
        );
        event.set_integer_value_field(
            EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT,
            window_id as i64,
        );
        events.push(event);
    }
    Ok(events)
}

#[cfg(all(target_os = "macos", test))]
fn click_via(pid: u32, window_id: u32, screen_x: f64, screen_y: f64, by_psn: bool) -> Result<()> {
    let events = mouse_events(window_id, screen_x, screen_y)?;
    if by_psn {
        post_to_psn(pid, events)
    } else {
        post_to_pid(pid, events)
    }
}

#[cfg(all(not(target_os = "macos"), test))]
fn click_at(_pid: u32, _window_id: u32, _screen_x: f64, _screen_y: f64) -> Result<()> {
    bail!("computer use input is implemented for macOS only")
}

/// Pick the window a capture request means.
///
/// With an explicit `windowId` it must belong to the resolved target — a window
/// id is not a capability, and accepting one without checking would route
/// straight around attach scoping.
fn choose_window(target: &Target, requested: Option<u32>) -> Result<Window> {
    let windows = windows_for(target.pid);
    match requested {
        Some(id) => windows
            .into_iter()
            .find(|window| window.id == id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "window {id} does not belong to pid {} ({}). Call computer_targets to see \
                     which windows it owns.",
                    target.pid,
                    target.label
                )
            }),
        None => windows.into_iter().next().ok_or_else(|| {
            anyhow::anyhow!(
                "{} (pid {}) has no window on screen — it is running headless or has not \
                 opened one yet, so there is nothing to capture.",
                target.label,
                target.pid
            )
        }),
    }
}

/// A target plus the windows it actually has on screen.
///
/// The window list is the honest half. A process core spawned is *permitted*;
/// only a process with a window is *reachable*, and the two differ more often
/// than they look — headless Chrome and a dev server are both permitted and
/// both have nothing to show.
fn describe(target: &Target) -> Value {
    let windows = windows_for(target.pid);
    json!({
        "pid": target.pid,
        "kind": target.kind,
        "label": target.label,
        "windows": windows.iter().map(Window::to_json).collect::<Vec<_>>(),
    })
}

fn note(targets: usize, with_windows: usize) -> &'static str {
    match (targets, with_windows) {
        (0, _) => "CaliCode has not started any drivable process yet.",
        (_, 0) => {
            "Every process CaliCode started is running headless or windowless, so there is \
             nothing on screen to capture yet."
        }
        _ => "Computer use may drive only these; anything else is refused.",
    }
}

/// Keys worth naming, mapped to their virtual keycodes.
///
/// Deliberately small. Text goes through [`type_text`], which sets a unicode
/// string on the event and needs no keycode at all; this table exists only for
/// the keys that have no character — the ones that mean "submit", "next field",
/// "cancel".
fn keycode(name: &str) -> Option<u16> {
    Some(match name.to_ascii_lowercase().as_str() {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    })
}

/// Post a keystroke or a run of text into a process without touching the user.
///
/// `CGEventPostToPid` is the whole reason this is safe to run unattended: the
/// event goes onto the target process's own queue, so the real cursor does not
/// move, the frontmost application does not change, and the user's focus stays
/// where they left it. That property is asserted in the tests, not assumed —
/// it is the difference between a background agent and a stolen keyboard.
///
/// Known limit: this reaches apps that read events through the normal AppKit
/// path. Anything reading raw HID — notably a running game built on Unity's
/// Input System or Unreal's raw input — may never see it. Editors are fine;
/// shipped builds are the open question (`docs/plans/computer-use.md` §4.1a).
#[cfg(target_os = "macos")]
fn post_to_pid(pid: u32, events: Vec<core_graphics::event::CGEvent>) -> Result<()> {
    use foreign_types::ForeignType;

    // Not exposed by the `core-graphics` crate, so declared here. This is the
    // one call the whole design rests on; see the doc comment above.
    extern "C" {
        fn CGEventPostToPid(pid: libc::pid_t, event: core_graphics::sys::CGEventRef);
    }

    for event in events {
        // SAFETY: `event` owns a live CGEventRef for the duration of the call,
        // and CGEventPostToPid neither retains nor frees it.
        unsafe { CGEventPostToPid(pid as libc::pid_t, event.as_ptr()) };
    }
    Ok(())
}

/// Post events through SkyLight's private `SLEventPostToPid`.
///
/// **This is a private SPI and an explicit exception to how the rest of this
/// module is built.** Everything else here rides public API precisely so there
/// is nothing to maintain across macOS releases; this one call exists because
/// three public routes were measured and none delivers a mouse event to a
/// background window (§4.1b). It is resolved at runtime with `dlsym` rather
/// than linked, so a macOS that no longer exports it degrades to a clear error
/// instead of failing to launch core at all.
#[cfg(all(target_os = "macos", test))]
fn post_via_skylight(pid: u32, events: Vec<core_graphics::event::CGEvent>) -> Result<()> {
    use foreign_types::ForeignType;
    use std::ffi::CString;

    type PostFn = unsafe extern "C" fn(libc::pid_t, core_graphics::sys::CGEventRef) -> i32;

    static SYMBOL: OnceLock<Option<PostFn>> = OnceLock::new();
    let post = SYMBOL.get_or_init(|| {
        let path =
            CString::new("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight").ok()?;
        let name = CString::new("SLEventPostToPid").ok()?;
        // SAFETY: both strings are NUL-terminated and outlive the calls; a
        // missing framework or symbol comes back null and is handled.
        unsafe {
            let handle = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
            if handle.is_null() {
                return None;
            }
            let symbol = libc::dlsym(handle, name.as_ptr());
            if symbol.is_null() {
                return None;
            }
            Some(std::mem::transmute::<*mut libc::c_void, PostFn>(symbol))
        }
    });

    let Some(post) = post else {
        bail!(
            "SLEventPostToPid is unavailable on this macOS, so background mouse input cannot              be delivered"
        );
    };
    for event in events {
        // SAFETY: `event` owns a live CGEventRef for the duration of the call.
        unsafe { post(pid as libc::pid_t, event.as_ptr()) };
    }
    Ok(())
}

/// Flip a window into AppKit's "active" state without raising it.
///
/// The missing first stage. `SLEventPostToPid` alone posts mouse events that
/// never arrive, because a process that does not believe it is active will not
/// hit-test a point — the events are addressed to nothing. This tells the
/// process otherwise, using the event-record form yabai uses for the same
/// purpose (MIT, `window_manager_make_key_window`): a 0xf8-byte record with
/// `0x04 = 0xf8`, `0x3a = 0x10`, the window id at `0x3c`, `0xff` filling
/// `0x20..0x30`, and `0x08` carrying 0x01 then 0x02 for deactivate/activate.
///
/// **Everything here is undocumented and version-fragile.** The layout is
/// reverse-engineered, not specified, and Apple owes it no stability. It is
/// isolated behind a `dlsym` that degrades to a clear error, so when it breaks
/// the failure is one function rather than the feature.
#[cfg(all(target_os = "macos", test))]
fn make_key_window(pid: u32, window_id: u32) -> Result<()> {
    use std::ffi::CString;

    #[repr(C)]
    #[derive(Default)]
    struct Psn {
        high: u32,
        low: u32,
    }
    type PostRecordFn = unsafe extern "C" fn(*const Psn, *const u8) -> i32;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn GetProcessForPID(pid: libc::pid_t, psn: *mut Psn) -> i32;
    }

    static SYMBOL: OnceLock<Option<PostRecordFn>> = OnceLock::new();
    let post = SYMBOL.get_or_init(|| {
        let path =
            CString::new("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight").ok()?;
        let name = CString::new("SLPSPostEventRecordTo").ok()?;
        // SAFETY: NUL-terminated strings outlive the calls; null results are
        // handled rather than transmuted.
        unsafe {
            let handle = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
            if handle.is_null() {
                return None;
            }
            let symbol = libc::dlsym(handle, name.as_ptr());
            if symbol.is_null() {
                return None;
            }
            Some(std::mem::transmute::<*mut libc::c_void, PostRecordFn>(
                symbol,
            ))
        }
    });
    let Some(post) = post else {
        bail!("SLPSPostEventRecordTo is unavailable on this macOS");
    };

    let mut psn = Psn::default();
    // SAFETY: `psn` is a live, correctly sized out-parameter.
    if unsafe { GetProcessForPID(pid as libc::pid_t, &mut psn) } != 0 {
        bail!("no ProcessSerialNumber for pid {pid}");
    }

    let mut bytes = [0u8; 0xf8];
    bytes[0x04] = 0xf8;
    bytes[0x3a] = 0x10;
    bytes[0x3c..0x40].copy_from_slice(&window_id.to_ne_bytes());
    bytes[0x20..0x30].fill(0xff);
    for state in [0x01u8, 0x02u8] {
        bytes[0x08] = state;
        // SAFETY: `bytes` is exactly the 0xf8-byte record the SPI reads.
        unsafe { post(&psn, bytes.as_ptr()) };
    }
    Ok(())
}

/// Post events addressed by ProcessSerialNumber rather than pid.
///
/// `CGEventPostToPid` delivers keyboard fine and drops mouse events on a
/// background window (§4.1b). `CGEventPostToPSN` is the older address form and
/// is reported to route where the pid form does not — both are public, both are
/// deprecated Carbon-era surface, and the difference costs one call to try.
#[cfg(all(target_os = "macos", test))]
fn post_to_psn(pid: u32, events: Vec<core_graphics::event::CGEvent>) -> Result<()> {
    use foreign_types::ForeignType;

    #[repr(C)]
    #[derive(Default)]
    struct ProcessSerialNumber {
        high: u32,
        low: u32,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn GetProcessForPID(pid: libc::pid_t, psn: *mut ProcessSerialNumber) -> i32;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventPostToPSN(psn: *const ProcessSerialNumber, event: core_graphics::sys::CGEventRef);
    }

    let mut psn = ProcessSerialNumber::default();
    // SAFETY: `psn` is a live, correctly sized out-parameter.
    let status = unsafe { GetProcessForPID(pid as libc::pid_t, &mut psn) };
    if status != 0 {
        bail!("no ProcessSerialNumber for pid {pid} (GetProcessForPID returned {status})");
    }
    for event in events {
        // SAFETY: `event` owns a live CGEventRef for the call, which neither
        // retains nor frees it; `psn` outlives the loop.
        unsafe { CGEventPostToPSN(&psn, event.as_ptr()) };
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn post_to_pid(_pid: u32, _events: Vec<()>) -> Result<()> {
    bail!("computer use input is implemented for macOS only")
}

#[cfg(target_os = "macos")]
fn source() -> Result<core_graphics::event_source::CGEventSource> {
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("could not create a CoreGraphics event source"))
}

/// Type literal text into `pid`.
#[cfg(target_os = "macos")]
fn type_text(pid: u32, text: &str) -> Result<()> {
    use core_graphics::event::CGEvent;

    let mut events = Vec::new();
    for chunk in text.chars().collect::<Vec<_>>().chunks(16) {
        let piece: String = chunk.iter().collect();
        for down in [true, false] {
            let event = CGEvent::new_keyboard_event(source()?, 0, down)
                .map_err(|_| anyhow::anyhow!("could not create a keyboard event"))?;
            event.set_string(&piece);
            events.push(event);
        }
    }
    post_to_pid(pid, events)
}

/// Press a named key in `pid`, with optional modifiers.
#[cfg(target_os = "macos")]
fn press_key(pid: u32, key: &str, modifiers: &[String]) -> Result<()> {
    use core_graphics::event::{CGEvent, CGEventFlags};

    let code = keycode(key).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown key {key:?}; known keys are return, tab, space, delete, escape, and the \
             four arrows. For literal text use computer_type."
        )
    })?;
    let mut flags = CGEventFlags::CGEventFlagNull;
    for modifier in modifiers {
        flags |= match modifier.to_ascii_lowercase().as_str() {
            "cmd" | "command" => CGEventFlags::CGEventFlagCommand,
            "shift" => CGEventFlags::CGEventFlagShift,
            "alt" | "option" => CGEventFlags::CGEventFlagAlternate,
            "ctrl" | "control" => CGEventFlags::CGEventFlagControl,
            other => bail!("unknown modifier {other:?}; use cmd, shift, alt, or ctrl"),
        };
    }

    let mut events = Vec::new();
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source()?, code, down)
            .map_err(|_| anyhow::anyhow!("could not create a keyboard event"))?;
        if flags != CGEventFlags::CGEventFlagNull {
            event.set_flags(flags);
        }
        events.push(event);
    }
    post_to_pid(pid, events)
}

#[cfg(not(target_os = "macos"))]
fn type_text(_pid: u32, _text: &str) -> Result<()> {
    bail!("computer use input is implemented for macOS only")
}

#[cfg(not(target_os = "macos"))]
fn press_key(_pid: u32, _key: &str, _modifiers: &[String]) -> Result<()> {
    bail!("computer use input is implemented for macOS only")
}

/// Body of `computer_type`.
pub fn type_tool(args: &Value) -> Result<Value> {
    let (pid, target) = scoped_pid(args)?;
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("computer_type needs `text`"))?;
    type_text(pid, text)?;
    Ok(json!({ "typed": text.chars().count(), "into": target.label }))
}

/// Body of `computer_key`.
pub fn key_tool(args: &Value) -> Result<Value> {
    let (pid, target) = scoped_pid(args)?;
    let key = args
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("computer_key needs `key`"))?;
    let modifiers: Vec<String> = args
        .get("modifiers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    press_key(pid, key, &modifiers)?;
    Ok(json!({ "pressed": key, "into": target.label }))
}

/// Every input tool starts here: a pid is only usable once scoping says so.
fn scoped_pid(args: &Value) -> Result<(u32, Target)> {
    let pid = args
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("needs `pid`; call computer_targets first"))?
        as u32;
    let target = resolve_in(crate::spawn_ledger::global(), pid)?;
    Ok((pid, target))
}

/// Resolve, scope, capture — everything `computer_look` does before a model
/// sees anything. Returns the PNG as a data URL, and a human label for the
/// prompt so the model knows what it is looking at.
pub fn look(args: &Value) -> Result<(String, String)> {
    let pid =
        args.get("pid").and_then(Value::as_u64).ok_or_else(|| {
            anyhow::anyhow!("computer_look needs `pid`; call computer_targets first")
        })? as u32;
    let target = resolve_in(crate::spawn_ledger::global(), pid)?;
    let requested = args
        .get("windowId")
        .and_then(Value::as_u64)
        .map(|id| id as u32);
    let window = choose_window(&target, requested)?;
    let png = capture_window(window.id)?;

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    let label = if window.title.is_empty() {
        target.label.clone()
    } else {
        format!("{} — {}", target.label, window.title)
    };
    Ok((format!("data:image/png;base64,{encoded}"), label))
}

/// Whether this process may capture the screen, and whether it may synthesise
/// input — the two macOS grants computer use cannot work without.
///
/// Both are read rather than requested. Prompting from inside a tool call would
/// throw a system dialog at whoever happens to be watching, possibly nobody, in
/// the middle of an unattended run; reporting lets the model say what is
/// missing and lets the user grant it when they are actually there.
#[cfg(target_os = "macos")]
fn permissions() -> (bool, bool) {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    // SAFETY: both are argument-free predicates over process state.
    unsafe { (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted()) }
}

#[cfg(not(target_os = "macos"))]
fn permissions() -> (bool, bool) {
    (false, false)
}

/// Scroll inside `pid`'s window — **deliberately not exposed as a tool.**
///
/// Built, measured, and withheld. A scroll is a mouse event, and mouse events
/// do not reach a window the pointer is not over (§4.1b): the probe scrolled a
/// 5000px page and `window.scrollY` stayed at 0. Shipping input that silently
/// does nothing is worse than shipping none, so `computer_scroll` does not
/// exist. This stays compiled under test as the executable evidence, and as the
/// regression check for the day mouse delivery starts working.
#[cfg(all(target_os = "macos", test))]
fn scroll_by(pid: u32, window_id: u32, dx: i32, dy: i32) -> Result<()> {
    use core_graphics::event::{CGEvent, CGEventType, EventField, ScrollEventUnit};

    let event = CGEvent::new_scroll_event(source()?, ScrollEventUnit::PIXEL, 2, dy, dx, 0)
        .map_err(|_| anyhow::anyhow!("could not create a scroll event"))?;
    event.set_integer_value_field(
        EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER,
        window_id as i64,
    );
    let _ = CGEventType::ScrollWheel;
    post_to_pid(pid, vec![event])
}

/// Ask macOS for the grants, rather than only reporting they are missing.
///
/// Separated from [`permissions`] and off by default because a grant dialog is
/// modal and steals focus: raising one during an unattended `/loop` interrupts
/// whoever happens to be at the machine — possibly nobody — to answer a
/// question about work they did not start. Asked for explicitly it is the
/// fastest path there is: the Screen Recording call raises the system prompt
/// directly, and the Accessibility one raises a dialog carrying an Open System
/// Settings button.
#[cfg(target_os = "macos")]
fn request_permissions() -> (bool, bool) {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    // SAFETY: the options dictionary outlives the call, which only borrows it.
    unsafe {
        let screen = CGRequestScreenCaptureAccess();
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        let accessibility =
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const _);
        (screen, accessibility)
    }
}

#[cfg(not(target_os = "macos"))]
fn request_permissions() -> (bool, bool) {
    (false, false)
}

/// The exact Settings pane for a grant, so fixing it is a click not a hunt.
fn settings_url(pane: &str) -> String {
    format!("x-apple.systempreferences:com.apple.preference.security?Privacy_{pane}")
}

/// Body of `computer_doctor`.
///
/// Exists because the failure modes here are all silent. A missing Screen
/// Recording grant yields captures that are blank rather than refused; a
/// missing Accessibility grant yields input that posts and vanishes; and the
/// grant attaches to whichever process is *responsible* for core, which differs
/// between `dev.sh` (the terminal) and the packaged app (CaliCode itself). None
/// of that is discoverable by trying harder, so it is reported here instead.
pub fn doctor_tool(args: &Value) -> Result<Value> {
    let (mut screen_recording, mut accessibility) = permissions();
    // Only ever on request — see `request_permissions`.
    let asked = args
        .get("request")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if asked && !(screen_recording && accessibility) {
        let (screen, access) = request_permissions();
        screen_recording |= screen;
        accessibility |= access;
    }
    let targets = targets_in(crate::spawn_ledger::global());
    let described: Vec<Value> = targets.iter().map(describe).collect();
    let reachable = described
        .iter()
        .filter(|entry| !entry["windows"].as_array().is_none_or(Vec::is_empty))
        .count();

    // Proof rather than a claim: capture something and see.
    let capture_works = on_screen_windows()
        .first()
        .map(|window| capture_window(window.id).is_ok());

    let mut problems: Vec<String> = Vec::new();
    let mut fixes: Vec<Value> = Vec::new();
    if !screen_recording {
        problems
            .push("Screen Recording is not granted, so computer_look will capture nothing.".into());
        fixes.push(json!({
            "grant": "Screen Recording",
            "why": "without it captures come back blank rather than refused",
            "openSettings": settings_url("ScreenCapture"),
            "orCallThis": "computer_doctor with request=true raises the system prompt",
        }));
    }
    if !accessibility {
        problems.push(
            "Accessibility is not granted, so computer_type and computer_key will post events              that go nowhere."
                .into(),
        );
        fixes.push(json!({
            "grant": "Accessibility",
            "why": "without it input posts successfully and never arrives",
            "openSettings": settings_url("Accessibility"),
            "orCallThis": "computer_doctor with request=true raises the system prompt",
        }));
    }
    if targets.is_empty() {
        problems.push(
            "CaliCode has not started any process yet, so there is nothing computer use is permitted to drive."
                .into(),
        );
    } else if reachable == 0 {
        problems.push(
            "Everything CaliCode started is headless or windowless, so there is nothing on screen to capture."
                .into(),
        );
    }

    Ok(json!({
        "screenRecording": screen_recording,
        "accessibility": accessibility,
        "captureVerified": capture_works,
        "grantedTo": grant_holder(),
        "targets": described,
        "reachable": reachable,
        "knownLimits": [
            "Clicking posts but delivery is unconfirmed; verify with computer_look rather \
             than assuming it worked.",
            "Apps reading raw HID input — a running Unity or Unreal build — may not receive \
             synthetic input at all."
        ],
        "problems": problems,
        "fixes": fixes,
        "requested": asked,
        "ok": problems.is_empty(),
    }))
}

/// Which process the TCC grants actually attach to.
///
/// Not cosmetic: under `dev.sh` core is a child of the user's terminal and
/// inherits *its* grants, while the packaged app supplies its own. Someone
/// granting the wrong one sees no error, just a feature that does nothing.
fn grant_holder() -> String {
    match std::env::current_exe() {
        Ok(path) if path.to_string_lossy().contains(".app/Contents/") => {
            "the CaliCode app bundle".into()
        }
        Ok(_) => "whichever process started core — under dev.sh that is your terminal".into(),
        Err(_) => "unknown".into(),
    }
}

/// Body of the `computer_targets` tool.
///
/// One tool answers both questions because they are the same question: with no
/// `pid` it reports everything drivable, and with one it reports whether that
/// process is drivable and, when it is not, what is.
pub fn targets_tool(args: &Value) -> Result<Value> {
    let ledger = crate::spawn_ledger::global();
    match args.get("pid").and_then(Value::as_u64) {
        Some(pid) => {
            let target = resolve_in(ledger, pid as u32)?;
            Ok(json!({ "attachable": true, "target": describe(&target) }))
        }
        None => {
            let targets = targets_in(ledger);
            let described: Vec<Value> = targets.iter().map(describe).collect();
            let with_windows = described
                .iter()
                .filter(|entry| !entry["windows"].as_array().is_none_or(Vec::is_empty))
                .count();
            Ok(json!({
                "targets": described,
                "note": note(targets.len(), with_windows),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spawn_ledger::SpawnKind;
    use std::process::{Child, Command};

    fn sleeper() -> Child {
        Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep must be spawnable")
    }

    #[test]
    fn a_process_core_started_resolves() {
        let ledger = SpawnLedger::new();
        let mut child = sleeper();
        ledger.register(child.id(), SpawnKind::Browser, "agent browser (chrome)");

        let target = resolve_in(&ledger, child.id()).expect("a spawned process must resolve");
        assert_eq!(target.kind, "browser");
        assert_eq!(target.label, "agent browser (chrome)");

        child.kill().ok();
        child.wait().ok();
    }

    /// The invariant. Any pid core did not start is refused, and the user's own
    /// running applications are exactly the population this covers.
    #[test]
    fn a_process_core_did_not_start_is_refused() {
        let ledger = SpawnLedger::new();
        let mut theirs = sleeper();

        let error = resolve_in(&ledger, theirs.id()).expect_err("an unspawned pid must refuse");
        assert!(
            error
                .to_string()
                .contains("only drive processes CaliCode started"),
            "the refusal must state the rule, got: {error}"
        );

        theirs.kill().ok();
        theirs.wait().ok();
    }

    /// A refusal that lists nothing teaches the model to guess again.
    #[test]
    fn a_refusal_names_what_is_attachable_instead() {
        let ledger = SpawnLedger::new();
        let mut ours = sleeper();
        let mut theirs = sleeper();
        ledger.register(ours.id(), SpawnKind::DevServer, "dev server (demo)");

        let error = resolve_in(&ledger, theirs.id()).expect_err("must refuse");
        let message = error.to_string();
        assert!(
            message.contains("dev server (demo)") && message.contains(&ours.id().to_string()),
            "the refusal must name the alternative, got: {message}"
        );

        ours.kill().ok();
        ours.wait().ok();
        theirs.kill().ok();
        theirs.wait().ok();
    }

    #[test]
    fn an_empty_ledger_refuses_everything_and_says_why() {
        let ledger = SpawnLedger::new();
        let mut theirs = sleeper();

        let error = resolve_in(&ledger, theirs.id()).expect_err("must refuse");
        assert!(
            error.to_string().contains("has not started any yet"),
            "an empty ledger must explain itself, got: {error}"
        );

        theirs.kill().ok();
        theirs.wait().ok();
    }

    #[test]
    fn targets_lists_only_live_spawned_processes() {
        let ledger = SpawnLedger::new();
        let mut live = sleeper();
        let mut gone = sleeper();
        ledger.register(live.id(), SpawnKind::Blender, "blender (gui)");
        ledger.register(gone.id(), SpawnKind::Mcp, "mcp server (x)");

        gone.kill().ok();
        gone.wait().ok();

        let listed = targets_in(&ledger);
        assert_eq!(listed.len(), 1, "a dead process must not be listed");
        assert_eq!(listed[0].pid, live.id());
        assert_eq!(listed[0].kind, "blender");

        live.kill().ok();
        live.wait().ok();
    }

    /// Capture, end to end, against whatever is genuinely on this screen.
    /// Skips where there is no window system or no Screen Recording grant —
    /// but where there is, this is the real CoreGraphics path producing a real
    /// PNG, not a mock.
    #[cfg(target_os = "macos")]
    #[test]
    fn capture_produces_a_decodable_png_of_a_real_window() {
        let Some(window) = on_screen_windows().into_iter().find(|w| w.id > 0) else {
            return; // no window server
        };
        let Ok(png) = capture_window(window.id) else {
            return; // no Screen Recording grant in this context
        };

        assert_eq!(
            &png[..8],
            b"\x89PNG\r\n\x1a\n",
            "capture must be a real png, not arbitrary bytes"
        );
        let decoded = image::load_from_memory(&png).expect("capture must decode");
        assert!(
            decoded.width() > 0 && decoded.height() > 0,
            "a capture must have pixels"
        );
        assert!(
            decoded.width() <= MAX_CAPTURE_EDGE && decoded.height() <= MAX_CAPTURE_EDGE,
            "a retina capture must be scaled down, got {}x{}",
            decoded.width(),
            decoded.height()
        );
    }

    /// A window id is not a capability. Handing one in for a process the agent
    /// is not allowed to drive must fail, or scoping is decorative.
    #[test]
    fn a_window_id_from_another_process_is_refused() {
        let mut child = sleeper();
        let target = Target {
            pid: child.id(),
            kind: "dev-server",
            label: "sleep".into(),
        };
        // 1 is not a window `sleep` owns — it owns none at all.
        let error = choose_window(&target, Some(1)).expect_err("must refuse a foreign window");
        assert!(
            error.to_string().contains("does not belong to pid"),
            "got: {error}"
        );
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn a_windowless_target_says_so_rather_than_capturing_nothing() {
        let mut child = sleeper();
        let target = Target {
            pid: child.id(),
            kind: "browser",
            label: "headless chrome".into(),
        };
        let error = choose_window(&target, None).expect_err("must refuse");
        assert!(
            error.to_string().contains("no window on screen"),
            "got: {error}"
        );
        child.kill().ok();
        child.wait().ok();
    }

    /// The one test that proves input actually arrives, rather than proving we
    /// called an API. Core spawns Chrome — so it lands in the ledger by the
    /// normal path — the text goes in through `CGEventPostToPid`, and the
    /// result is read back over CDP. Two independent channels: the assertion
    /// cannot be satisfied by the code that produced it.
    ///
    /// `cargo test computer::tests::live -- --ignored --test-threads=1`
    ///
    /// Serially, always: every live test here launches Chrome against the same
    /// profile, and two at once collide on its `SingletonLock` and both fail
    /// for a reason that has nothing to do with what they measure.
    /// Set `CALI_BROWSER_HEADED=1`; a headless Chrome has no window and no key
    /// focus, which is the very thing being measured.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "needs a real headed Chrome"]
    async fn live_typing_reaches_the_agent_browser() {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let browsers = crate::browser::Browsers::new();
        let browser = browsers.ensure(bus).await.expect("chrome must start");

        // `normalize_url` refuses `data:` and `about:blank`, so the page comes
        // off a throwaway loopback server. Offline, and deterministic.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a scratch port");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            const BODY: &str =
                "<html><body><input id=t autofocus style='font-size:40px'></body></html>";
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                    BODY.len(),
                    BODY
                );
                socket.write_all(response.as_bytes()).await.ok();
                socket.flush().await.ok();
            }
        });

        browser
            .navigate(&format!("http://127.0.0.1:{port}/"))
            .await
            .expect("navigate");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        browser
            .eval("document.getElementById('t').focus();'ok'")
            .await
            .expect("focus the field");

        let entry = crate::spawn_ledger::global()
            .list()
            .into_iter()
            .find(|entry| entry.kind == SpawnKind::Browser)
            .expect("core must have registered the chrome it spawned");

        // What the user must not lose: their frontmost app.
        let frontmost_before = frontmost_app_name();

        type_text(entry.pid, "hello").expect("type must post");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let value = browser
            .eval("document.getElementById('t').value")
            .await
            .expect("read back");
        let seen = value.to_string();
        assert!(
            seen.contains("hello"),
            "typed text must arrive in the page; CDP read back {seen}"
        );
        assert_eq!(
            frontmost_app_name(),
            frontmost_before,
            "posting input must not change which application is frontmost"
        );

        drop(browser);
        browsers.shutdown().await;
    }

    /// The regression test for background clicking, which **currently fails**.
    /// Typing passes the identical shape; clicking does not arrive. Kept
    /// failing-and-ignored on purpose: it is the check that tells us the day a
    /// fix works, and deleting it would erase the only evidence of the gap.
    ///
    /// `CALI_BROWSER_HEADED=1 cargo test computer::tests::live_clicking -- --ignored`
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "known gap: background windows do not receive synthetic clicks"]
    async fn live_clicking_reaches_the_agent_browser() {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let browsers = crate::browser::Browsers::new();
        let browser = browsers.ensure(bus).await.expect("chrome must start");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a scratch port");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            const BODY: &str = "<html><body style='margin:0'>\
                <div id=s style='width:100vw;height:100vh;background:#eee'></div>\
                <script>window.__clicks=0;\
                document.getElementById('s').addEventListener('click',()=>{window.__clicks++});\
                </script></body></html>";
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                    BODY.len(),
                    BODY
                );
                socket.write_all(response.as_bytes()).await.ok();
                socket.flush().await.ok();
            }
        });

        browser
            .navigate(&format!("http://127.0.0.1:{port}/"))
            .await
            .expect("navigate");
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let entry = crate::spawn_ledger::global()
            .list()
            .into_iter()
            .find(|entry| entry.kind == SpawnKind::Browser)
            .expect("core must have registered the chrome it spawned");
        let target = Target {
            pid: entry.pid,
            kind: entry.kind.as_str(),
            label: entry.label.clone(),
        };
        let window = choose_window(&target, None).expect("chrome must have a window");

        // Capture first — that is what establishes the coordinate space, and
        // doing it in the test is the same order the model is told to use.
        let png = capture_window(window.id).expect("capture");
        let image = image::load_from_memory(&png).expect("decode");
        let frontmost_before = frontmost_app_name();

        // Two thirds down the window: past the toolbar, inside the page.
        let (sx, sy) = map_to_screen(
            &window,
            image.width() as f64 / 2.0,
            image.height() as f64 * 0.66,
        )
        .expect("map");
        click_at(entry.pid, window.id, sx, sy).expect("click must post");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        let clicks = browser.eval("window.__clicks").await.expect("read back");
        let seen = clicks.to_string();
        assert!(
            seen.contains('1') || seen.contains('2'),
            "the click must reach the page; CDP read back {seen}"
        );
        assert_eq!(
            frontmost_app_name(),
            frontmost_before,
            "clicking must not change which application is frontmost"
        );

        drop(browser);
        browsers.shutdown().await;
    }

    /// Diagnostic, not a feature test: does the click land when the window is
    /// *frontmost*? That single bit decides whether background routing is the
    /// wall (mechanism sound, needs SkyLight) or the whole approach is wrong.
    /// Restores whatever was frontmost before, so running it costs a blink.
    ///
    /// `CALI_BROWSER_HEADED=1 cargo test computer::tests::diag_click -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "diagnostic; briefly activates Chrome"]
    async fn diag_click_when_frontmost() {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let browsers = crate::browser::Browsers::new();
        let browser = browsers.ensure(bus).await.expect("chrome must start");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            const BODY: &str = "<html><body style='margin:0'>\
                <div id=s style='width:100vw;height:100vh;background:#dfd'></div>\
                <script>window.__clicks=0;document.getElementById('s')\
                .addEventListener('click',()=>{window.__clicks++});</script></body></html>";
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                    BODY.len(),
                    BODY
                );
                socket.write_all(response.as_bytes()).await.ok();
            }
        });
        browser
            .navigate(&format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let entry = crate::spawn_ledger::global()
            .list()
            .into_iter()
            .find(|e| e.kind == SpawnKind::Browser)
            .expect("ledger");
        let target = Target {
            pid: entry.pid,
            kind: entry.kind.as_str(),
            label: entry.label.clone(),
        };
        let window = choose_window(&target, None).expect("window");
        let png = capture_window(window.id).expect("capture");
        let image = image::load_from_memory(&png).unwrap();
        let (sx, sy) = map_to_screen(
            &window,
            image.width() as f64 / 2.0,
            image.height() as f64 * 0.66,
        )
        .unwrap();

        println!("window bounds = {:?}", window.bounds);
        println!("image = {}x{}", image.width(), image.height());
        println!("mapped screen point = ({sx:.1}, {sy:.1})");

        let restore = frontmost_app_name();
        std::process::Command::new("osascript")
            .args(["-e", "tell application \"Google Chrome\" to activate"])
            .output()
            .ok();
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        println!("frontmost now = {}", frontmost_app_name());

        click_at(entry.pid, window.id, sx, sy).expect("post");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let clicks = browser.eval("window.__clicks").await.unwrap();
        println!("CLICKS VIA PID = {clicks}");

        // Same event, addressed by ProcessSerialNumber instead.
        click_via(entry.pid, window.id, sx, sy, true).expect("psn post");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let by_psn = browser.eval("window.__clicks").await.unwrap();
        println!("CLICKS VIA PSN = {by_psn}");

        // And the private SkyLight channel, which is what the shipping
        // computer-use products use for exactly this.
        match post_via_skylight(entry.pid, mouse_events(window.id, sx, sy).unwrap()) {
            Ok(()) => {
                tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                let by_sl = browser.eval("window.__clicks").await.unwrap();
                println!("CLICKS VIA SKYLIGHT = {by_sl}");
            }
            Err(error) => println!("CLICKS VIA SKYLIGHT = unavailable: {error}"),
        }

        // Give the user their focus back before anything else happens.
        if !restore.is_empty() {
            std::process::Command::new("osascript")
                .args(["-e", &format!("tell application \"{restore}\" to activate")])
                .output()
                .ok();
        }
        drop(browser);
        browsers.shutdown().await;
    }

    /// Does a scroll reach a background window? Asked before `computer_scroll`
    /// is offered as a tool, because shipping input that silently does nothing
    /// is worse than not shipping it.
    ///
    /// `CALI_BROWSER_HEADED=1 cargo test computer::tests::diag_scroll -- --ignored --nocapture`
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "diagnostic; needs a real headed Chrome"]
    async fn diag_scroll_delivery() {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let browsers = crate::browser::Browsers::new();
        let browser = browsers.ensure(bus).await.expect("chrome must start");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            const BODY: &str = "<html><body style='height:5000px;margin:0'>\
                <div style='height:5000px;background:linear-gradient(#fff,#333)'></div>\
                </body></html>";
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::AsyncWriteExt;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
                    BODY.len(),
                    BODY
                );
                socket.write_all(response.as_bytes()).await.ok();
            }
        });
        browser
            .navigate(&format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let entry = crate::spawn_ledger::global()
            .list()
            .into_iter()
            .find(|e| e.kind == SpawnKind::Browser)
            .expect("ledger");
        let target = Target {
            pid: entry.pid,
            kind: entry.kind.as_str(),
            label: entry.label.clone(),
        };
        let window = choose_window(&target, None).expect("window");

        let before = browser.eval("window.scrollY").await.unwrap().to_string();
        scroll_by(entry.pid, window.id, 0, -400).expect("scroll must post");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let after = browser.eval("window.scrollY").await.unwrap().to_string();
        println!("SCROLL before={before} after={after}");

        drop(browser);
        browsers.shutdown().await;
    }

    /// Which app is frontmost, so the live test can prove we did not steal it.
    /// Is it *mouse input to a background window* that fails, or is it Chrome?
    ///
    /// Every earlier measurement used Chrome, and Chromium is documented to run
    /// a renderer-side trust filter that rejects synthetic clicks outright — so
    /// generalising from it was a mistake. This drives a plain AppKit window
    /// instead, one that never becomes key, and reads a file the app writes on
    /// `mouseDown`. The target lives at `core/tests/helpers/clicktarget.swift`:
    ///   swiftc -O core/tests/helpers/clicktarget.swift -o /tmp/clicktarget
    ///   CALI_CLICK_TARGET=/tmp/clicktarget \
    ///     cargo test computer::tests::diag_appkit -- --ignored --nocapture
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "diagnostic; needs the clicktarget helper built"]
    async fn diag_appkit_click_delivery() {
        let Ok(binary) = std::env::var("CALI_CLICK_TARGET") else {
            println!("set CALI_CLICK_TARGET to the clicktarget binary");
            return;
        };
        let log = format!("{}/clicktarget.log", std::env::temp_dir().display());
        let mut child = std::process::Command::new(&binary)
            .spawn()
            .expect("click target must start");
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

        let pid = child.id();
        let window = on_screen_windows()
            .into_iter()
            .find(|w| w.pid == pid)
            .expect("the click target must have a window");
        println!(
            "target pid={pid} window={} bounds={:?}",
            window.id, window.bounds
        );

        let (bx, by, bw, bh) = window.bounds;
        let (sx, sy) = (bx + bw / 2.0, by + bh / 2.0);

        // One at a time: an array literal would evaluate every post before the
        // loop body ran, and then the sleeps would attribute nothing.
        for name in ["PID", "PSN", "SKYLIGHT"] {
            let batch = mouse_events(window.id, sx, sy).unwrap();
            let posted = match name {
                "PID" => post_to_pid(pid, batch),
                "PSN" => post_to_psn(pid, batch),
                _ => post_via_skylight(pid, batch),
            };
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            let seen: Vec<String> = std::fs::read_to_string(&log)
                .unwrap_or_default()
                .lines()
                .filter(|line| *line != "ready")
                .map(str::to_string)
                .collect();
            println!(
                "after {name}: posted={:?} events={:?}",
                posted.is_ok(),
                seen
            );
        }

        // Keyboard through the same pid, same non-key window. If this logs and
        // the mouse posts did not, the target is alive and the gap is specific
        // to mouse — and if it also fails, then "keyboard works in the
        // background" was measured on a Chrome that happened to be key.
        type_text(pid, "k").ok();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let after_key: Vec<String> = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|line| *line != "ready")
            .map(str::to_string)
            .collect();
        println!("after KEYBOARD: events={after_key:?}");

        // The stage that was missing: make the window AppKit-active first.
        match make_key_window(pid, window.id) {
            Ok(()) => {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                // Stage 2: a decoy press at (-1,-1) that ticks the target's
                // user-activation gate so the real click reads as a trusted
                // continuation rather than a cold synthetic event.
                post_via_skylight(pid, mouse_events(window.id, -1.0, -1.0).unwrap()).ok();
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                post_via_skylight(pid, mouse_events(window.id, sx, sy).unwrap()).ok();
                tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                let after: Vec<String> = std::fs::read_to_string(&log)
                    .unwrap_or_default()
                    .lines()
                    .filter(|line| *line != "ready")
                    .map(str::to_string)
                    .collect();
                println!("after MAKE_KEY + SKYLIGHT: events={after:?}");
            }
            Err(error) => println!("after MAKE_KEY: unavailable: {error}"),
        }

        child.kill().ok();
        child.wait().ok();
    }

    /// `lsappinfo front` needs no Automation grant, unlike asking System Events.
    /// The earlier osascript version returned an empty string here, which made
    /// the assertion that used it compare "" to "" and never fail.
    #[cfg(target_os = "macos")]
    fn frontmost_app_name() -> String {
        std::process::Command::new("/usr/bin/lsappinfo")
            .arg("front")
            .output()
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default()
    }

    fn window_at(id: u32, bounds: (f64, f64, f64, f64)) -> Window {
        Window {
            id,
            pid: 1,
            title: String::new(),
            bounds,
        }
    }

    /// The transform, checked against numbers rather than vibes. Half way
    /// across a 400px-wide capture must be half way across the window, wherever
    /// that window sits on the desktop.
    #[test]
    fn image_coordinates_map_onto_the_window() {
        let window = window_at(9_001, (100.0, 200.0, 800.0, 600.0));
        remember_capture(window.id, 400, 300);

        let (x, y) = map_to_screen(&window, 200.0, 150.0).expect("centre must map");
        assert!((x - 500.0).abs() < 0.001, "x was {x}");
        assert!((y - 500.0).abs() < 0.001, "y was {y}");

        let (ox, oy) = map_to_screen(&window, 0.0, 0.0).expect("origin must map");
        assert!((ox - 100.0).abs() < 0.001 && (oy - 200.0).abs() < 0.001);
    }

    /// A window the user dragged after the screenshot must still click right —
    /// which is why the transform reads bounds fresh instead of storing them.
    #[test]
    fn a_moved_window_still_maps_to_the_same_control() {
        let before = window_at(9_002, (0.0, 0.0, 800.0, 600.0));
        remember_capture(before.id, 400, 300);
        let (x1, y1) = map_to_screen(&before, 100.0, 75.0).unwrap();

        let after = window_at(9_002, (640.0, 480.0, 800.0, 600.0));
        let (x2, y2) = map_to_screen(&after, 100.0, 75.0).unwrap();

        assert!((x2 - x1 - 640.0).abs() < 0.001, "x moved by {}", x2 - x1);
        assert!((y2 - y1 - 480.0).abs() < 0.001, "y moved by {}", y2 - y1);
    }

    /// Clicking before looking is a coordinate space that does not exist yet.
    #[test]
    fn a_click_before_any_capture_is_refused_with_the_reason() {
        let window = window_at(9_003, (0.0, 0.0, 800.0, 600.0));
        let error = map_to_screen(&window, 10.0, 10.0).expect_err("must refuse");
        assert!(
            error.to_string().contains("call computer_look first"),
            "got: {error}"
        );
    }

    #[test]
    fn a_click_outside_the_captured_image_is_refused() {
        let window = window_at(9_004, (0.0, 0.0, 800.0, 600.0));
        remember_capture(window.id, 400, 300);
        let error = map_to_screen(&window, 400.0, 10.0).expect_err("must refuse");
        assert!(error.to_string().contains("outside the captured image"));
    }

    /// The doctor must answer even when everything is wrong — it is what the
    /// model calls precisely when nothing else is working, so an error here
    /// would hide the diagnosis it exists to give.
    #[test]
    fn the_doctor_always_answers() {
        let report = doctor_tool(&json!({})).expect("doctor must never fail");
        // Visible with --nocapture: the fastest way to read real permission
        // state on a machine that is misbehaving.
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        for key in [
            "screenRecording",
            "accessibility",
            "grantedTo",
            "targets",
            "problems",
            "ok",
        ] {
            assert!(report.get(key).is_some(), "missing {key} in {report}");
        }
        // With an empty ledger it must say so rather than report health.
        assert_eq!(report["ok"], false);
        let problems = report["problems"].as_array().unwrap();
        assert!(
            problems.iter().any(|p| p
                .as_str()
                .unwrap_or_default()
                .contains("has not started any process")),
            "an empty ledger must be named as a problem, got {problems:?}"
        );
    }

    /// The doctor must never raise a permission dialog on its own. It is the
    /// tool a model reaches for when something looks broken, and that can
    /// happen in the middle of an unattended run with nobody watching — a
    /// modal grant prompt there interrupts whoever is at the machine to answer
    /// for work they did not start.
    #[test]
    fn the_doctor_does_not_prompt_unless_asked() {
        let report = doctor_tool(&json!({})).expect("doctor");
        assert_eq!(
            report["requested"], false,
            "an unasked doctor must not have prompted: {report}"
        );
        let asked = doctor_tool(&json!({ "request": false })).expect("doctor");
        assert_eq!(asked["requested"], false);
    }

    /// A fix the user has to go hunting for is not a fix. These deep-link
    /// straight to the pane that holds the toggle.
    #[test]
    fn a_missing_grant_is_answered_with_the_exact_settings_pane() {
        for (pane, expect) in [
            ("ScreenCapture", "Privacy_ScreenCapture"),
            ("Accessibility", "Privacy_Accessibility"),
        ] {
            let url = settings_url(pane);
            assert!(
                url.starts_with("x-apple.systempreferences:") && url.ends_with(expect),
                "settings link must open the right pane, got {url}"
            );
        }
    }

    /// A silent failure is the whole hazard here, so the report must not claim
    /// health it has not checked: capture is proven by capturing.
    #[test]
    fn the_doctor_verifies_capture_rather_than_assuming_it() {
        let report = doctor_tool(&json!({})).expect("doctor");
        let verified = &report["captureVerified"];
        assert!(
            verified.is_boolean() || verified.is_null(),
            "captureVerified must be a real result or explicitly unknown, got {verified}"
        );
    }

    /// The signal that keeps the tool honest. "Permitted" and "reachable" are
    /// different states, and conflating them is how a model ends up asking to
    /// capture headless Chrome and getting a confusing nothing back.
    #[test]
    fn the_note_distinguishes_permitted_from_reachable() {
        assert!(note(0, 0).contains("has not started any"));
        assert!(note(2, 0).contains("nothing on screen to capture"));
        assert!(note(2, 1).contains("may drive only these"));
    }

    /// A squashed capture is invisible in the bytes — it decodes fine, it just
    /// lies about shape. Clamping each axis independently produced exactly that:
    /// a 1280x800 window came back 1568x1568. Only an assertion catches it.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_capture_keeps_the_window_aspect_ratio() {
        let Some(window) = on_screen_windows()
            .into_iter()
            .find(|w| w.bounds.2 > 200.0 && w.bounds.3 > 200.0)
        else {
            return;
        };
        let Ok(png) = capture_window(window.id) else {
            return;
        };
        let decoded = image::load_from_memory(&png).expect("decode");
        let want = window.bounds.2 / window.bounds.3;
        let got = decoded.width() as f64 / decoded.height() as f64;
        assert!(
            (want - got).abs() < 0.02,
            "window is {:.0}x{:.0} (ratio {want:.3}) but capture is {}x{} (ratio {got:.3})",
            window.bounds.2,
            window.bounds.3,
            decoded.width(),
            decoded.height()
        );
    }

    /// Enumeration must never panic, whatever the platform or permission
    /// state — on Linux CI it is simply empty, and an unpermitted macOS still
    /// returns windows without titles.
    #[test]
    fn window_enumeration_is_total() {
        for window in on_screen_windows() {
            assert!(window.pid > 0, "a window must name a real owner");
            assert!(window.id > 0, "a window must have an id");
        }
    }

    /// The pid -> window mapping, against whatever is genuinely on this screen.
    /// Takes a real window, pretends core spawned its process, and checks the
    /// describe path surfaces it. Skips where there is no window system.
    #[test]
    fn describe_reports_the_windows_of_a_real_process() {
        let Some(sample) = on_screen_windows().into_iter().find(|w| w.pid > 0) else {
            return; // headless CI: nothing to map, and nothing to prove
        };
        let target = Target {
            pid: sample.pid,
            kind: "browser",
            label: "stand-in".into(),
        };
        let described = describe(&target);
        let windows = described["windows"].as_array().expect("windows array");
        assert!(
            !windows.is_empty(),
            "a pid taken from the window list must map back to at least one window"
        );
        assert_eq!(described["pid"], sample.pid);
    }

    /// A pid with no window is the common case, not an error: headless Chrome
    /// and the dev server both live here.
    #[test]
    fn a_windowless_process_describes_as_reachable_by_nothing() {
        let mut child = sleeper();
        let target = Target {
            pid: child.id(),
            kind: "dev-server",
            label: "sleep".into(),
        };
        let described = describe(&target);
        assert_eq!(
            described["windows"].as_array().map(Vec::len),
            Some(0),
            "sleep has no window and must not claim one"
        );
        child.kill().ok();
        child.wait().ok();
    }

    /// The tool's no-argument form must be safe to call before anything has
    /// been spawned — it is how the model discovers there is nothing to drive.
    #[test]
    fn the_tool_reports_an_empty_world_without_erroring() {
        let out = targets_tool(&json!({})).expect("listing must not error");
        assert!(out["targets"].is_array());
    }
}

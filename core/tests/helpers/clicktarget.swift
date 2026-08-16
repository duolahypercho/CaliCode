// Control target for the computer-use input diagnostics in `computer.rs`.
//
// A window that is deliberately never key, in an `.accessory` app that never
// takes focus, logging every event it receives to a file. It exists so a claim
// like "synthetic mouse input does not reach a background window" can be tested
// against something other than Chrome — Chromium runs a renderer-side trust
// filter that rejects synthetic clicks, which makes it the worst possible sole
// witness.
//
// The keyboard handler is the control-of-the-control: keyboard input is known
// to arrive, so if `keyDown` logs and `mouseDown` does not, the target is alive
// and the failure is specific to mouse.
//
//   swiftc -O core/tests/helpers/clicktarget.swift -o /tmp/clicktarget
//   CALI_CLICK_TARGET=/tmp/clicktarget \
//     cargo test computer::tests::diag_appkit -- --ignored --nocapture

import Cocoa
let log = "\(NSTemporaryDirectory())/clicktarget.log"
try? "".write(toFile: log, atomically: true, encoding: .utf8)
func note(_ s: String) {
    if let h = FileHandle(forWritingAtPath: log) {
        h.seekToEndOfFile(); h.write("\(s)\n".data(using: .utf8)!); h.closeFile()
    }
}
class V: NSView {
    // Default is false: an inactive window swallows the first click to activate
    // itself and never forwards it. That alone can look exactly like "delivery
    // failed", so the control must opt in.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { note("mouseDown") }
    override func mouseUp(with e: NSEvent) { note("mouseUp") }
    override func scrollWheel(with e: NSEvent) { note("scroll") }
    // Keyboard is the control-of-the-control: it is supposed to reach a
    // background process, so if it logs and mouseDown does not, the app and its
    // logging are alive and the failure is specific to mouse.
    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with e: NSEvent) { note("keyDown:\(e.charactersIgnoringModifiers ?? "")") }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let w = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 420, height: 320),
                 styleMask: [.titled], backing: .buffered, defer: false)
w.title = "calicode-click-target"
w.contentView = V()
w.ignoresMouseEvents = false
w.orderFrontRegardless()
w.makeFirstResponder(w.contentView)
note("ready")
app.run()

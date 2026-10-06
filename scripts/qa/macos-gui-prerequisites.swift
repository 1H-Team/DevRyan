import AppKit
import CoreGraphics

// This executable is launched only by the GitHub-hosted runner owner.
func emit(_ value: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10]))
}

let session = CGSessionCopyCurrentDictionary() as? [String: Any]
let onConsole = session?[kCGSessionOnConsoleKey as String] as? Bool == true
let loggedIn = session?[kCGSessionLoginDoneKey as String] as? Bool == true
let sameUser = (session?[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid()
let screenCapture = CGPreflightScreenCaptureAccess()
let checks: [String: Bool] = ["onConsole": onConsole, "loggedIn": loggedIn,
    "sameUser": sameUser, "screenCapture": screenCapture]
guard checks.values.allSatisfy({ $0 }) else {
    emit(["protocol": "devryan.macos-gui-prerequisites/1", "status": "unavailable", "checks": checks])
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 500, height: 160),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "DevRyan disposable runner GUI prerequisite"
window.isReleasedWhenClosed = false
let label = NSTextField(labelWithString: "DevRyan 2.0.2 — disposable GUI prerequisite")
label.frame = NSRect(x: 20, y: 55, width: 460, height: 50)
label.font = NSFont.systemFont(ofSize: 20)
window.contentView?.addSubview(label)
app.finishLaunching()
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let visible = windows.contains {
        ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid()
            && ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == window.windowNumber
    }
    emit(["protocol": "devryan.macos-gui-prerequisites/1", "status": visible && window.isVisible ? "ready" : "unavailable",
        "checks": checks, "visible": visible && window.isVisible, "windowId": window.windowNumber])
    if !visible || !window.isVisible { app.terminate(nil) }
}
DispatchQueue.global().async {
    _ = FileHandle.standardInput.readDataToEndOfFile()
    DispatchQueue.main.async { window.close(); app.terminate(nil) }
}
app.run()

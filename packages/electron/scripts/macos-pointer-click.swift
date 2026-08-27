import CoreGraphics
import Foundation
import AppKit

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

guard CommandLine.arguments.count == 4,
      let processId = Int32(CommandLine.arguments[1]),
      let x = Double(CommandLine.arguments[2]),
      let y = Double(CommandLine.arguments[3]),
      x.isFinite,
      y.isFinite else {
    fail("usage: macos-pointer-click.swift <pid> <screen-x> <screen-y>", 64)
}

if #available(macOS 10.15, *) {
    guard CGPreflightPostEventAccess() else {
        fail("CoreGraphics event posting is not authorized for this terminal", 77)
    }
}

guard let application = NSRunningApplication(processIdentifier: processId) else {
    fail("Electron process \(processId) is not running", 69)
}

guard application.activate(options: [.activateAllWindows]) else {
    fail("Could not foreground Electron process \(processId)", 69)
}

Thread.sleep(forTimeInterval: 0.35)

let original = CGEvent(source: nil)?.location
let target = CGPoint(x: x, y: y)
guard let source = CGEventSource(stateID: .combinedSessionState) else {
    fail("Could not create a CoreGraphics event source", 70)
}
source.localEventsSuppressionInterval = 0

func post(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left) {
    guard let event = CGEvent(
        mouseEventSource: source,
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else {
        fail("Could not create CoreGraphics pointer event", 70)
    }
    event.setIntegerValueField(.mouseEventClickState, value: 1)
    event.post(tap: .cghidEventTap)
}

post(.mouseMoved, at: target)
Thread.sleep(forTimeInterval: 0.08)
post(.leftMouseDown, at: target)
Thread.sleep(forTimeInterval: 0.05)
post(.leftMouseUp, at: target)
Thread.sleep(forTimeInterval: 0.25)

if let original {
    post(.mouseMoved, at: original)
}

FileHandle.standardOutput.write(Data("{\"clicked\":true,\"x\":\(x),\"y\":\(y)}\n".utf8))

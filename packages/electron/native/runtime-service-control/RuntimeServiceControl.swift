import Foundation
import ServiceManagement

struct Response: Codable {
    let ok: Bool
    let state: String
    let code: String?
}

func printResponse(_ response: Response) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"state\":\"unavailable\",\"code\":\"runtime_service_control_failed\"}")
        return
    }
    print(text)
}

guard #available(macOS 13.0, *) else {
    printResponse(Response(ok: false, state: "legacy_required", code: "smappservice_unavailable"))
    exit(2)
}

let service = SMAppService.agent(plistName: "dev.openchamber.desktop.runtime-service.plist")
let command = CommandLine.arguments.dropFirst().first ?? "status"

func stateName(_ status: SMAppService.Status) -> String {
    switch status {
    case .enabled: return "enabled"
    case .requiresApproval: return "requires_approval"
    case .notRegistered: return "not_registered"
    case .notFound: return "not_found"
    @unknown default: return "unknown"
    }
}

do {
    switch command {
    case "status":
        printResponse(Response(ok: true, state: stateName(service.status), code: nil))
    case "register":
        try service.register()
        printResponse(Response(ok: true, state: stateName(service.status), code: nil))
    case "unregister":
        try service.unregister()
        printResponse(Response(ok: true, state: stateName(service.status), code: nil))
    default:
        printResponse(Response(ok: false, state: "invalid", code: "runtime_service_control_invalid"))
        exit(2)
    }
} catch {
    let state = stateName(service.status)
    if command == "register" && (state == "enabled" || state == "requires_approval") {
        printResponse(Response(ok: true, state: state, code: nil))
        exit(0)
    }
    let code: String
    switch command {
    case "register": code = "smappservice_registration_failed"
    case "unregister": code = "smappservice_unregistration_failed"
    default: code = "runtime_service_control_failed"
    }
    printResponse(Response(ok: false, state: state, code: code))
    exit(1)
}

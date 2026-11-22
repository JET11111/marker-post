import Capacitor
import Foundation
import MarkerPostCore
import UIKit

// The bridge between the web app and the native side. JavaScript reaches it as
// Capacitor.registerPlugin('MarkerPost'); the contract is in
// docs/native-apps.md, section 1.
//
// Capacitor's tooling finds this class by searching the plugin's Swift files
// for the Objective-C name attribute on the line below. Nothing else in the
// plugin may carry a named attribute of that kind, in code or in a comment,
// or the tooling would register the wrong class.

@objc(MarkerPostPlugin)
public class MarkerPostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MarkerPostPlugin"
    public let jsName = "MarkerPost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTrackingStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishPost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        // The tracker outlives the web view (it also runs when the app is
        // started in the background), so it reports to whichever plugin
        // instance is current rather than holding on to one.
        Task { @MainActor [weak self] in
            let tracker = MarkerTracker.shared
            tracker.onTrackingChanged = { [weak self] active, reason in
                var data: [String: Any] = ["active": active]
                if let reason = reason {
                    data["reason"] = reason
                }
                self?.notifyListeners("trackingChanged", data: data)
            }
            // The tracker only calls this while the app is on screen.
            tracker.onFix = { [weak self] snapshot in
                self?.notifyListeners("trackingFix", data: MarkerPostPlugin.payload(snapshot))
            }
        }
    }

    // MARK: - Live tracking

    /// { useHeading } -> { active: true, since } or { active: false, reason }.
    /// Never rejects: a refusal by the user or the system is an answer, not an error.
    @objc func startTracking(_ call: CAPPluginCall) {
        // The app's own default for "prefer my direction of travel" is on.
        let useHeading = call.getBool("useHeading", true)
        Task { @MainActor in
            let status = await MarkerTracker.shared.start(useHeading: useHeading)
            call.resolve(MarkerPostPlugin.payload(status))
        }
    }

    /// -> { active: false }
    @objc func stopTracking(_ call: CAPPluginCall) {
        Task { @MainActor in
            MarkerTracker.shared.stop(reason: "stopped-by-user")
            call.resolve(["active": false])
        }
    }

    /// -> { active, since?, reason? }
    @objc func getTrackingStatus(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(MarkerPostPlugin.payload(MarkerTracker.shared.status()))
        }
    }

    /// { useHeading } -> {}. Tells a running session about a changed setting.
    @objc func updateTracking(_ call: CAPPluginCall) {
        let useHeading = call.getBool("useHeading")
        Task { @MainActor in
            if let useHeading = useHeading {
                MarkerTracker.shared.setUseHeading(useHeading)
            }
            call.resolve([:])
        }
    }

    // MARK: - Last known post

    /// A snapshot without stale/tracking -> {}. The post the web app is
    /// showing, for the widgets. Ignored while live tracking is running.
    @objc func publishPost(_ call: CAPPluginCall) {
        let snapshot = MarkerPostPlugin.snapshot(from: call)
        Task { @MainActor in
            if let snapshot = snapshot {
                MarkerTracker.shared.publishFromWeb(snapshot)
            }
            call.resolve([:])
        }
    }

    // MARK: - Screen

    /// { on } -> {}. Keeps the screen from dimming and locking while the app is open.
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on", true)
        Task { @MainActor in
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve([:])
        }
    }

    // MARK: - Shapes

    /// JavaScript counts time in milliseconds since 1970.
    private static func milliseconds(_ date: Date) -> Int {
        return Int((date.timeIntervalSince1970 * 1000).rounded())
    }

    private static func payload(_ status: TrackingStatus) -> [String: Any] {
        var data: [String: Any] = ["active": status.active]
        if let since = status.since {
            data["since"] = milliseconds(since)
        }
        if let reason = status.reason {
            data["reason"] = reason
        }
        return data
    }

    private static func payload(_ snapshot: PostSnapshot) -> [String: Any] {
        return [
            "road": snapshot.road,
            "roadClass": snapshot.roadClass,
            "km": snapshot.km,
            "letter": snapshot.letter,
            "ref": snapshot.ref,
            "context": snapshot.context,
            "confirmed": snapshot.confirmed,
            "fixTime": milliseconds(snapshot.fixTime),
            "stale": snapshot.stale,
            "tracking": snapshot.tracking
        ]
    }

    /// The snapshot JavaScript handed over, or nil if it cannot be trusted.
    /// A post with no reference or no fix time is dropped rather than patched
    /// up: the widgets must never show a time that was made up here.
    private static func snapshot(from call: CAPPluginCall) -> PostSnapshot? {
        guard let ref = call.getString("ref"), !ref.isEmpty,
              let fixMilliseconds = call.getDouble("fixTime"),
              fixMilliseconds.isFinite, fixMilliseconds > 0 else { return nil }
        return PostSnapshot(
            road: call.getString("road", ""),
            // "O" is the neutral badge: the class only chooses a colour.
            roadClass: call.getString("roadClass", "O"),
            km: call.getString("km", ""),
            letter: call.getString("letter", ""),
            ref: ref,
            context: call.getString("context", ""),
            // Not stated means not confirmed: by position only.
            confirmed: call.getBool("confirmed", false),
            fixTime: Date(timeIntervalSince1970: fixMilliseconds / 1000),
            stale: false,
            tracking: false)
    }
}

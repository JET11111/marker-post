import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        #if DEBUG
        TestLinks.install()
        #endif
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

#if DEBUG
/// For the simulator check on GitHub (scripts/smoke-ios.mjs). Debug builds only:
/// a release build contains none of this.
///
/// iOS asks "Open in Marker Post?" before it hands a markerpost:// link sent
/// from the command line to the app, and nothing can press that button. So a
/// debug build also takes the same links as system-wide notifications:
///
///     xcrun simctl spawn <device> notifyutil -p io.github.jet11111.markerpost.link.live-start
///
/// Each one is passed on exactly as if iOS had opened the link.
enum TestLinks {
    static let prefix = "io.github.jet11111.markerpost.link."
    static let links = ["nearest", "map", "signs", "goto", "live-start", "live-stop"]

    static func install() { _ = installed }

    // A static constant runs its closure once, however often it is asked for.
    private static let installed: Bool = {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        for link in links {
            CFNotificationCenterAddObserver(center, nil, { _, _, name, _, _ in
                guard let cfName = name?.rawValue else { return }
                let full = cfName as String
                guard full.hasPrefix(TestLinks.prefix) else { return }
                let path = String(full.dropFirst(TestLinks.prefix.count)).replacingOccurrences(of: "-", with: "/")
                guard let url = URL(string: "markerpost://\(path)") else { return }
                DispatchQueue.main.async {
                    _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
                }
            }, (prefix + link) as CFString, nil, .deliverImmediately)
        }
        return true
    }()
}
#endif

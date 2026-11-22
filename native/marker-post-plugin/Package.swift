// swift-tools-version: 5.9
import PackageDescription
import Foundation

// MarkerPostCore   pure Swift: the nearest-post lookup and the types shared
//                  with the widget extension. No UIKit, no Capacitor.
// MarkerPostNative the Capacitor plugin, background location and Live Activity.
//
// The Capacitor framework only exists for iOS, so the whole package cannot be
// built with "swift test" on a Mac. Setting MARKERPOST_CORE_ONLY=1 leaves the
// plugin target out, which lets the lookup tests run anywhere:
//
//   MARKERPOST_CORE_ONLY=1 swift test
//
// The product is named "MarkerPostNative" because the Capacitor CLI derives
// that name from the npm package name ("marker-post-native").
let coreOnly = ProcessInfo.processInfo.environment["MARKERPOST_CORE_ONLY"] == "1"

var products: [Product] = [
    .library(name: "MarkerPostNative", targets: ["MarkerPostNative"])
]
var dependencies: [Package.Dependency] = [
    .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
]
var targets: [Target] = [
    .target(
        name: "MarkerPostCore",
        path: "ios/Sources/MarkerPostCore",
        resources: [.copy("Resources/posts.tsv")]),
    .target(
        name: "MarkerPostNative",
        dependencies: [
            "MarkerPostCore",
            .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "Cordova", package: "capacitor-swift-pm")
        ],
        path: "ios/Sources/MarkerPostNative"),
    .testTarget(
        name: "MarkerPostCoreTests",
        dependencies: ["MarkerPostCore"],
        path: "ios/Tests/MarkerPostCoreTests",
        resources: [.copy("Resources/nearest-fixtures.tsv"), .copy("Resources/posts.tsv")])
]

if coreOnly {
    products = [.library(name: "MarkerPostCore", targets: ["MarkerPostCore"])]
    dependencies = []
    targets.removeAll { $0.name == "MarkerPostNative" }
}

let package = Package(
    name: "MarkerPostNative",
    // iOS 18 is written as text: the named constant only exists from package
    // format 6.0, and this package stays on 5.9 so that it is built in Swift 5 mode.
    platforms: [.iOS("18.0"), .macOS(.v13)],
    products: products,
    dependencies: dependencies,
    targets: targets
)

import SwiftUI
import WidgetKit

// The widget extension's entry point. One bundle holds both surfaces:
//   MarkerPostLiveActivity  the live post (Lock Screen, Dynamic Island, CarPlay, Apple Watch)
//   LastPostWidget          the last post the app saved (Home Screen, Lock Screen, StandBy, CarPlay)

@main
struct MarkerPostWidgetsBundle: WidgetBundle {
    var body: some Widget {
        MarkerPostLiveActivity()
        LastPostWidget()
    }
}

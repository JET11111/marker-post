# Testing on a phone and in a vehicle

The web app has been checked in a desktop browser at phone sizes, in light and dark, online and with the network cut. The Swift and Kotlin lookups are checked against the web app's answers on every build. What nobody but you can check is how it behaves on a real phone, with real GPS, in a real vehicle. This page is that list.

**Set it up before you move, and let a passenger do the pressing.** Everything here is designed to be glanced at, not operated, while driving.

When something is wrong, the most useful thing you can send is: what you expected, what happened, a screenshot, and the text from **Settings and about** (the ⓘ button) **> Copy diagnostics**. That text holds the app version, the phone type and any errors. It never includes your position.

## A. Any phone, first launch (5 minutes, parked)

1. Open the app. No white flash at night: the screen should go from the launch screen straight to the app's own background.
2. Allow location when asked ("While using", precise).
3. **Nearest** shows a road badge, a large post number, the carriageway letter in an amber block and the junction section, within a few seconds of a GPS fix.
4. Stand still. The carriageway letter may be **outlined** rather than filled: that is correct, it means your direction of travel has not confirmed which carriageway you are on.
5. Switch the phone to dark mode and back. The app follows.
6. Turn the phone on its side. The layout changes to a wide one and nothing is cut off, including beside the camera cut-out.
7. Switch on aeroplane mode, close the app completely and open it again. Nearest still works; **Map** still shows the network and (in the phone apps) the street map; **Signs** says it is showing a saved copy and when it was saved.
8. Switch aeroplane mode off.

## B. On the road (as a passenger, or in a cradle)

1. With **Prefer my direction of travel** on, the letter becomes **filled** within a few seconds of moving off, and matches the carriageway you are on.
2. The post number counts up or down every 100 metres, in step with the posts on the verge. Compare a few. If it is consistently one post behind or ahead, note your speed and tell me.
3. Pass under or over another road, and through an interchange. The readout should not jump to the other road while you are moving on the main carriageway. Slip roads and link roads show their own references where the data has them.
4. Go through a place with no signal. Nothing changes.
5. Stop on the hard shoulder or in an emergency area (when you are there anyway). The post should stay put and the letter stay filled for the same carriageway.
6. Cover the phone or go under cover until GPS is lost. Within about 15 seconds while moving, the readout **dims** and says "No GPS update for …" and "last known post". It must never keep showing an old post as if it were current.

## C. iPhone: Live Activity

1. On **Nearest** press **Start live tracking**. Lock the phone.
2. The Lock Screen shows a dark card: road badge, post number, carriageway letter, section, and "Updated" with a time.
3. On an iPhone with a Dynamic Island, unlock and go to the Home Screen: the road is on the left of the island and the post on the right. Press and hold it for the larger view.
4. Drive. The card changes when the post changes, and only then.
5. Lose GPS (as in B6). The card dims and says "No GPS since" with a time.
6. Press **Stop live tracking** in the app. The card goes after showing the last post.
7. Leave tracking on for a whole shift at least once. Around seven and a half hours in, watch what happens:
   - iOS 26 or later: nothing should change. A replacement activity takes over before the 8-hour limit.
   - iOS 18: the Lock Screen warns that the display will end at a stated time. Opening the app once renews it.
   Tell me which iOS version you have and what you saw. This is the part I could least check.

## D. iPhone: CarPlay (iOS 26 or later)

1. Start live tracking, then connect the phone to the car.
2. On the CarPlay **Dashboard** the post should appear as a small panel: road badge, post number and letter, section, time. There are no buttons on it, on purpose.
3. If it does not appear: check **Settings > Marker Post > Live Activities** is on, and note the iOS version and the car.

There is no separate CarPlay app, and nothing to set up in the car.

## E. iPhone: widgets

1. Press and hold the Home Screen, press **Edit**, **Add Widget**, find **Marker Post**.
2. Add the small one and the medium one. Each shows the last post the app recorded and "Last updated" with a time. The medium one says plainly that it is not live.
3. Add the Lock Screen one too (press and hold the Lock Screen, **Customise**).
4. Before the app has recorded any post they say "No post yet".

Widgets are refreshed by iOS when it chooses, so they can be minutes behind. That is why they show a time, and why the Live Activity exists.

## F. Android

1. On **Nearest** press **Start live tracking** and allow notifications.
2. Pull down the notification shade: there is an ongoing notification with the post as its title, the section, and "updated" with a time. It is also on the lock screen.
3. Lock the phone and drive. The notification follows the post.
4. Lose GPS (as in B6). The notification says "No GPS since" with a time, and "last known post".
5. Press **Stop** on the notification. It goes, and the button in the app is back to **Start live tracking**.
6. Add the widget (press and hold the home screen, **Widgets**, **Marker Post**). It says "Live" with a time while tracking, otherwise "Last updated".
7. Press the phone's Back button or swipe back: inside the app it closes whatever is open (a sheet, the search, the map card); on the first screen it sends the app to the background rather than closing it.
8. Leave tracking on for a few hours with the screen off. If it stops by itself, see "If tracking stops by itself" in [android-app.md](android-app.md), and tell me the phone model.

## G. Map

1. **Map** opens on the patch with the network in blue (motorways) and green (A roads) on a muted street map.
2. Press the arrow button: the map moves to you, with a blue dot and an accuracy circle.
3. Zoom in until the marker dots appear. Tap one: a card shows its reference. Tap the road beside it: the card shows what is recorded about that stretch.
4. Search for a post (`M27 13.6 A`), a junction (`M3 J14`) and a lay-by (`A31 layby`).
5. Open the layers button (top right): switch layers on and off and change the appearance. Tap the "Road data" pill (top left) for the data dates and coverage.
6. At night, in dark mode, the map should be dark too, with no bright flash when it opens or when you change tab.
7. The attribution "© OpenStreetMap · National Highways (OGL)" stays visible at the bottom.

## What I could not check, in order of risk

1. **The Swift and Kotlin code has never run on a device.** It compiles on GitHub and the lookup is tested there, but permissions, background behaviour and the notification, Live Activity and widget layouts have only been reviewed, not seen.
2. **The eight-hour Live Activity handover** (C7). It depends on iOS behaviour that cannot be simulated.
3. **CarPlay** (D). Apple's documentation says a Live Activity appears there on iOS 26; I have not seen this one do it.
4. **Battery use** over a 12-hour shift with tracking on. It uses GPS once a second, like a sat-nav. Expect to keep the phone on charge.
5. **The map on an iPhone.** It needs iOS 16.4 or later for the map engine; the app needs iOS 18 anyway. Performance on an older phone is unknown.
6. **Phones that close background apps** (F8).

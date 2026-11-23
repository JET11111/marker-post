# Testing on a phone and in a vehicle

The web app has been checked in a desktop browser at phone sizes, in light and dark, online and with the network cut. On 22 November 2026 the Swift and Kotlin lookups passed on GitHub against 2,056 positions whose answers come from the web app's own code, and both phone apps compiled there. Nothing has yet been run on a real phone. What nobody but you can check is how it behaves there, with real GPS, in a real vehicle. This page is that list.

**Set it up before you move, and let a passenger do the pressing.** Everything here is designed to be glanced at, not operated, while driving.

When something is wrong, the most useful thing you can send is: what you expected, what happened, a screenshot, and the text from **Settings and about** (the ⓘ button) **> Copy diagnostics**. That text holds the app version, the phone type and any errors. It never includes your position.

## A. Any phone, first launch (5 minutes, parked)

1. Open the app. No white flash at night: the screen should go from the launch screen straight to the app's own background.
2. Allow location when asked ("While using", precise).
3. **Nearest** shows the post's reference in very large text (for example 20/9A) with the road beneath it in amber, within a few seconds of a GPS fix. The card below gives the junction section, the distance, the nearest junction and, on smart motorways, the nearest emergency area reference. The small line under the card says "updated" with the time, and "distances are straight-line".
4. Stand still. A second small line may appear under the card: "Nearest post by position only. Check the carriageway." That is correct: it means your direction of travel has not confirmed which carriageway you are on.
5. Switch the phone to dark mode and back. The app follows.
6. Turn the phone on its side. The layout changes to a wide one and nothing is cut off, including beside the camera cut-out.
7. Switch on aeroplane mode, close the app completely and open it again. Nearest still works; **Map** still shows the network and (in the phone apps) the street map; **Signs** says it is showing a saved copy and how long ago the signs last changed.
8. Switch aeroplane mode off.

## B. On the road (as a passenger, or in a cradle)

1. With **Prefer my direction of travel** on, the line "Nearest post by position only. Check the carriageway." goes within a few seconds of moving off, and the letter matches the carriageway you are on.
2. The post number counts up or down every 100 metres, in step with the posts on the verge. Compare a few. If it is consistently one post behind or ahead, note your speed and tell me.
3. Pass under or over another road, and through an interchange. The readout should not jump to the other road while you are moving on the main carriageway. Slip roads and link roads show their own references where the data has them.
4. Go through a place with no signal. Nothing changes.
5. Stop on the hard shoulder or in an emergency area (when you are there anyway). The post should stay put, on the same carriageway, without the "Nearest post by position only" line.
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
8. With live tracking off, open the link `markerpost://live/start`. Either set up the Shortcuts automation described in [ios-testflight.md](ios-testflight.md) ("Starting it when you get in the vehicle"), or type the link into Safari's address bar. If Safari asks whether to open Marker Post, say yes. The app opens and live tracking starts. `markerpost://live/stop` stops it.

These next checks are for behaviour that changed on 23 November 2026 and has only been read in the code. Note what you see for each, even when it is what is expected.

9. Park with tracking on. After 5 minutes the card is bright, with "Updated" and about the time you stopped. After 40 minutes, note whether it is bright or says "No GPS since". Drive off: the post changes within seconds.
10. Lose GPS at speed, then stop under cover: the card dims within about 15 seconds and stays dimmed.
11. Close the app from the app switcher with the card showing, then open it again: tracking is still on and the card follows the post again.
12. The same, but swipe the card away before opening the app again: tracking is off.
13. iOS 26 or later: close the app, swipe the card away, do not open the app, and wait past 7 h 45 min from the last start or renewal. Note whether a new card appears ("Waiting for GPS…") and whether tracking is on when the app is next opened.
14. Say "Show Marker Post" to Siri with a card under 7 h 30 min old showing. Write down what Siri says and whether the card is replaced or left alone. Expected: "…has been renewed", or "…is still on. It could not be renewed." It must never say "Open Marker Post" while a card is on screen, and the card must not go.
15. The same with tracking off: "Live tracking is off. Open Marker Post to start it.", and nothing starts.
16. The same after the 7 h 30 min warning: the card is replaced and Siri says it has been renewed.
17. If Siri ever says "…could not be renewed. Open Marker Post.", open the app: the card must come back within a few seconds.
18. For each of the four sentences you get, note whether Siri spoke it, showed it, or did neither. Run the shortcut from the Shortcuts app too.
19. More than 250 m from any post (at home, say): the card shows "Nearest recorded post · … away" under the post, an outlined letter, and the distance changes about every 5 seconds as you move.
20. Parked over midnight: the time gains its date ("22 Nov, 23:40").
21. Cover the phone shortly before midnight until the card says "No GPS since", and leave it. After midnight the card must read "No GPS since 22 Nov, 23:40" (the day in front). If it still shows the bare time, tell me.
22. On a post numbered 100.0 or more (there are many on the M3 and the A303): the small Dynamic Island still shows the carriageway letter in its chip.
23. With the phone on its side, the Dynamic Island shows the post number alone, whole.
24. Set the phone to 12-hour time (**Settings > General > Date & Time**). Every time on the card, the island and the widgets is still 24-hour ("14:32"). Set it back afterwards if you prefer.

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
5. Add the round Lock Screen widget as well. Near the Chilworth links or the M27 / M275 interchange (long road names), nothing touches the edge of the circle.
6. Leave a widget untouched overnight. In the morning its time has its date in front ("22 Nov, 14:32").

Widgets are refreshed by iOS when it chooses, so they can be minutes behind. That is why they show a time, and why the Live Activity exists.

## F. Android

1. On **Nearest** press **Start live tracking** and allow notifications.
2. Pull down the notification shade: there is an ongoing notification with the post as its title and, below it, "Updated" with the time first, then the section ("Updated 14:32 · J4 – J5"). If the carriageway is not confirmed yet, "Check carriageway" comes straight after the time. It is also on the lock screen.
3. Lock the phone and drive. The notification follows the post.
4. Lose GPS (as in B6). The notification says "No GPS since" with a time, and "last known post".
5. Press **Stop** on the notification. It goes, and the button in the app is back to **Start live tracking**.
6. Add the widget (press and hold the home screen, **Widgets**, **Marker Post**). It says "Last updated" with a time, and the time moves on while tracking. It never says "Live".
7. Press the phone's Back button or swipe back: inside the app it closes whatever is open (a sheet, the search, the map card); on the first screen it sends the app to the background rather than closing it.
8. Leave tracking on for a few hours with the screen off. If it stops by itself, see "If tracking stops by itself" in [android-app.md](android-app.md), and tell me the phone model.
9. If you have an automation app that can open a link: with live tracking off, open `markerpost://live/start` from it. The app opens and live tracking starts. `markerpost://live/stop` stops it. Tell me which app you used and whether it worked.
10. More than 250 m from any post (at home, say), with tracking on: the notification reads "Updated 14:32 · Nearest recorded post · … away", its title has no carriageway letter, and on Android 16 there is no post in the status bar.
11. Make the widget smaller (press and hold it, then drag an edge). The post number stays easy to read; the line under it drops to one line, ending in "…" if it is cut. Then set the phone's text size to the largest (**Settings > Display > Font size**): the number and the time are still whole. Set it back afterwards.

## G. Map

1. **Map** opens on the patch with the network in blue (motorways) and green (A roads) on a muted street map.
2. Press the arrow button: the map moves to you, with a blue dot and an accuracy circle. A message gives the accuracy. If the phone has had no position for a while, the dot is grey and labelled "Last known" with a time.
3. Zoom in until the marker dots appear. Tap one: a card shows its reference. Tap the road beside it: the card shows what is recorded about that stretch.
4. Search for a post (`M27 13.6 A`), a junction (`M3 J14`) and a lay-by (`A31 layby`).
5. Open the layers button (top right): switch layers on and off and change the appearance. Tap the "Road data" pill (top left) for the data dates and coverage.
6. At night, in dark mode, the map should be dark too, with no bright flash when it opens or when you change tab.
7. The attribution "© OpenStreetMap · National Highways (OGL)" stays readable: at the bottom of the map, and above a card when one is open (beside it with the phone on its side). Open "Record details and dates": it moves up with the card. With the Street map layer off it reads "National Highways (OGL)" only.
8. Tap the "Road data" pill: the list includes "Street map data (OpenStreetMap)" with a date.

## What I could not check, in order of risk

1. **Whether tracking survives the app being closed with the card showing** (C11). If iOS does not report the card to the app when it starts again, tracking now ends without a word. Please try this one first.
2. **The Swift and Kotlin code has never run on a real phone.** On 22 November 2026 both apps compiled on GitHub, and the lookups passed there against 2,056 positions. But permissions, background tracking, the Live Activity, CarPlay, the widgets and the Android notification have only been reviewed, not seen on a device.
3. **The eight-hour Live Activity handover** (C7), and the follow-on card after the card was swiped away with the app closed (C13). Both depend on iOS behaviour that cannot be simulated.
4. **Whether Siri says the shortcut's sentences at all** (C14 to C18). Apple's documentation says the system might not show them when Siri runs the shortcut; the card itself is still right in every case.
5. **CarPlay** (D). Apple's documentation says a Live Activity appears there on iOS 26; I have not seen this one do it.
6. **Battery use** over a 12-hour shift with tracking on. It uses GPS once a second, like a sat-nav. Expect to keep the phone on charge.
7. **Widget and Dynamic Island layouts** (C22, C23, E5, F11). Their sizes were worked out from font measurements. The Android widget is photographed on GitHub's emulator at ordinary and large text; the iPhone ones have not been seen at all.
8. **The map on an iPhone.** It needs iOS 16.4 or later for the map engine; the app needs iOS 18 anyway. Performance on an older phone is unknown.
9. **Phones that close background apps** (F8).
10. **The `markerpost://` links from a real automation app** (C8, F9). The app handles the links, but I have not been able to open one from Shortcuts or from an Android automation app.

# The Android app

GitHub builds the Android app for you. You do not need Android Studio, Java or anything else on your computer: you download a file (an "APK") and install it on the phone.

What the Android app adds to the web app:

- **Live tracking** with the screen off, shown as an ongoing notification: the post, the time it was updated and the section, on the lock screen and at the top of the notification shade. A "Stop" button ends it.
- **A home screen widget** with the last known post and the time it was updated.
- The street map of the patch is inside the app, so the map works with no signal from the first launch.

## 1. Get the APK

**From the Actions page** (works straight away)

1. On GitHub, open the repository, then **Actions**, then **android** in the list on the left.
2. Open the newest run with a green tick that is one of your own: under its title it shows the branch `master` (or `feature/native-app` before the merge) and your name. Skip any run marked as a pull request from someone else. That app was built from their changes, which nobody has checked.
3. At the bottom, under **Artifacts**, download **marker-post-android**. It is a zip file holding two APKs:
   - `marker-post-2.0.0-buildN.apk`: the normal app. Use this one.
   - `marker-post-2.0.0-buildN-debug.apk`: the same app with developer tools switched on. Only useful when chasing a fault.
4. Unzip it and get the APK onto the phone: download it on the phone itself (you must be signed in to GitHub in the phone's browser), or copy it over with a USB cable or your usual cloud drive.

Builds are kept for 30 days. If the download says **Expired**, start a new build:

- Before the branch has been merged: [in the app's folder](../README.md#running-a-command), run `gh workflow run android.yml --ref feature/native-app`. If it answers with an error, tell me.
- After the merge: use the **Run workflow** button described next. Leave the box unticked if you do not want the public link.

**From a download link** (easier on the phone, but public)

1. **Actions**, **android**, **Run workflow**. Tick "Also attach the APK to a GitHub pre-release", choose the branch, press **Run workflow**.

   Until the branch has been merged, that button is not shown. Instead, in the app's folder, run:

   ```
   gh workflow run android.yml --ref feature/native-app -f publish=true
   ```

   If it answers with an error, use the Actions page route above.
2. When it finishes, the repository's **Releases** page has the APK as a normal download link you can open on the phone.

Anyone can download from that page. The app contains nothing secret, but it is your choice whether to publish it, which is why the box is not ticked by default.

## 2. Install it

1. Open the APK on the phone.
2. Android asks whether the app you opened it from (Chrome, Files, Drive) may install apps. Allow it. You can switch that off again afterwards.
3. If Play Protect says it does not recognise the developer, choose **Install anyway**. That message appears for every app that did not come from the Play Store.
4. Open **Marker Post**. When it asks for location, choose **While using the app** and leave **Precise** on. Without precise location the nearest post would be wrong, so with approximate location the app shows no post and says location is blocked.

## 3. Use it

- **Live tracking**: on the Nearest screen press **Start live tracking**. Android asks to allow notifications the first time: allow it, because the notification is the display. The post then stays in your notifications with the screen off. Press **Stop** on the notification, or the button in the app, to end it.
- **Widget**: press and hold an empty part of the home screen, choose **Widgets**, find **Marker Post**, and drag it into place. It shows the last post with "Last updated" and a time. It never says it is live: a widget cannot refresh every few seconds. The notification is the live display.
- **If tracking stops by itself after a while**: some phones (Samsung, Xiaomi, OnePlus and others) close apps to save battery. Open Settings, Apps, Marker Post, Battery, and choose **Unrestricted**.

## 4. Your own signing key (do this once)

Android only installs an update over an app that was signed with the same key. Until the repository has a key of its own, each build is signed with a key made for that build only, so you must uninstall the app before installing a newer one.

To fix that for good, run this once, [in the app's folder](../README.md#running-a-command) on your computer:

```
node scripts/setup-android-signing.mjs
```

It makes a key in `marker-post-keys` in your home folder (outside the repository), asks before sending anything, and then stores the key as four encrypted GitHub secrets. The next build is the first one signed with your own key, so uninstall the app one last time before installing it. After that, updates install over the top.

Afterwards, back up two things somewhere safe that is not a repository (a password manager, or a USB stick):

- the folder `marker-post-keys` in your home folder;
- the file `android/keystore.properties` in the app's folder (git ignores it).

If you ever lose them, nothing is broken: uninstall the app once, run the script again to make a new key, and carry on. If only one of the two is lost, the script stops without changing anything and tells you what to move out of the way first: it never replaces a key, or the file that holds a key's password.

To see what the script would do without doing it: `node scripts/setup-android-signing.mjs --dry-run`.

## 5. Updating

Every change pushed to GitHub that touches the app builds a new APK. Download and open the new one: with your own key it installs over the old app and keeps your settings. The build number in the file name goes up each time; the app shows its version at the bottom of Settings and about.

## Things to know

- **Location in the background.** The app never asks for "Allow all the time". Live tracking runs as a visible foreground service with its notification, which Android allows with "While using the app". When you stop tracking, location stops.
- **Backups.** The app is excluded from Android's cloud backup, because the last known post is a record of where the phone has been.
- **Starting it automatically.** The app answers the link `markerpost://live/start`, which opens it and starts live tracking (`markerpost://live/stop` stops it). An automation app that can open a link can use it when the phone connects to the vehicle's Bluetooth. I have not been able to try this on a phone, including with Samsung's Modes and Routines. If your automation app has no "open link" action, it cannot use it.
- **Pull requests from other people.** The repository is public, so anyone can propose a change and GitHub would build an APK from it. Make GitHub ask you first, every time: **Settings**, **Actions**, **General**, **Approval for running fork pull request workflows from contributors**, choose **Require approval for all external contributors**, **Save**.
- **Android Auto.** Nothing appears on the car's screen. Android does not show this kind of notification there, and an app installed by hand cannot run as a car app. The phone in a cradle is the display.
- **From 2027: developer verification.** Google has announced that apps installed by hand on certified phones will need to come from a registered developer, rolling out worldwide during 2027. A free "limited distribution" account is meant for exactly this case (a personal app on a few phones). When it reaches the UK, register the app name `io.github.jet11111.markerpost` and your signing key at <https://developer.android.com/developer-verification>. That is another reason to have your own key (section 4).
- **The Play Store** is not set up. It would need a Google Play developer account and a store listing, and is not needed for your own phones.
- **Vehicle lookup and the NTIS page** are not in the Android app. See [going-live.md](going-live.md).

## Building it yourself (optional)

Only if you want to. Install Android Studio (it brings JDK 21 and the Android SDK). Set the `JAVA_HOME` environment variable to Android Studio's `jbr` folder. Then either set `ANDROID_HOME` to the SDK folder, or open the `android` folder once in Android Studio so that it writes `android/local.properties`. Then in the app's folder:

```
npm install
npm run basemap          # once: cuts the offline street map
npm run android:debug    # the APK appears in android/app/build/outputs/apk/debug/
```

`npm run android:test` runs the lookup tests: they check that the Kotlin nearest-post lookup gives exactly the same answers as the web app for about two thousand positions.

## If something goes wrong

| What you see | What to do |
|---|---|
| "App not installed" when updating | The new build was signed with a different key. Before you have your own key (section 4), and for the first build after you set it up, this is normal: uninstall Marker Post, then install again. After that it means the file is not one of your own builds, or is older than the app on the phone: do not uninstall to get round it. Go back to section 1 and check which run you downloaded from. |
| "There was a problem parsing the package" | The download was cut short, or the zip was opened instead of the APK inside it. Download again and unzip first. |
| The map has no streets, only the road network | The street map could not be read. Settings and about, **Copy diagnostics**, and send me the text. |
| "Location blocked" at the top of the first page, with "Location is blocked. Allow location for Marker Post in Settings." under the card; or "Live tracking needs Precise Location. Turn it on for Marker Post in Settings." | Settings, Apps, Marker Post, Permissions, Location: choose **Allow only while using the app** and switch **Use precise location** on. Then go back to the app: it carries on by itself. For live tracking, press **Start live tracking** again. |
| No notification when tracking | Settings, Apps, Marker Post, Notifications: switch them on, including the **Live tracking** category. Tracking still runs without it, but there is nothing to see. |
| Anything else | Settings and about, **Copy diagnostics**. It copies the app version, phone type and any errors (never your position). |

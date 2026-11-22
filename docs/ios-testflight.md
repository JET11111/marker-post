# The iPhone app, through TestFlight

GitHub builds the iPhone app on one of its own Macs, signs it and sends it to TestFlight, Apple's app for installing test builds. You never need a Mac or Xcode. Everything on this page is done in a web browser on Windows, plus one command.

What the iPhone app adds to the web app:

- **A Live Activity**: the nearest post on the Lock Screen and in the Dynamic Island while live tracking is on, and on the CarPlay Dashboard (iOS 26 or later).
- **Home screen and Lock Screen widgets** with the last known post and the time it was updated.
- Tracking that carries on with the screen off, and the street map of the patch inside the app.

The app needs iOS 18 or later.

## What only you can do

Apple and GitHub accounts are yours, so these steps are yours. Allow about an hour in total, mostly waiting for Apple. You do them once.

| Step | Where | Time |
|---|---|---|
| 1. Join the Apple Developer Program | developer.apple.com | 10 minutes, then up to 2 days for Apple to confirm |
| 2. Accept Apple's agreements | appstoreconnect.apple.com | 2 minutes |
| 3. Register the app's three identifiers | developer.apple.com | 10 minutes |
| 4. Create the app's page | appstoreconnect.apple.com | 5 minutes |
| 5. Make an access key | appstoreconnect.apple.com | 5 minutes |
| 6. Run the setup command | this computer | 5 minutes |
| 7. Create your tester group | appstoreconnect.apple.com | 3 minutes |
| 8. Start the first build and approve it | github.com | 2 minutes, then about 30 minutes of waiting |
| 9. Install on the iPhone | the iPhone | 5 minutes |

Type the identifiers exactly as written here. They are already built into the app, and Apple will not let you change them later.

### 1. Join the Apple Developer Program

1. Go to <https://developer.apple.com/programs/enroll/> and sign in with your Apple Account. It must have two-factor authentication switched on.
2. Enrol as an **individual**. It costs US$99 a year, charged in pounds (about £79).
3. Wait for Apple's confirmation email. It is often quick but can take up to two days. Nothing else on this page works until it arrives.

### 2. Accept the agreements

1. Go to <https://appstoreconnect.apple.com> and sign in.
2. Open **Business**. If an agreement is waiting, read and accept it. You cannot create an app until this is done.

### 3. Register the three identifiers

Go to <https://developer.apple.com/account>, then **Certificates, Identifiers & Profiles**, then **Identifiers**.

**The App Group** (lets the app share the last known post with its widgets)

1. Press **+**. Choose **App Groups**, then **Continue**.
2. Description: `Marker Post`. Identifier: `group.io.github.jet11111.markerpost`
3. **Continue**, then **Register**.

**The app**

1. Press **+**. Choose **App IDs**, **Continue**, then **App**, **Continue**.
2. Description: `Marker Post`. Bundle ID: choose **Explicit** and type `io.github.jet11111.markerpost`
3. In the list of capabilities tick **App Groups**. Leave everything else as it is. (Location, widgets and Live Activities need no tick here.)
4. **Continue**, then **Register**.
5. Click the identifier you just made. Beside App Groups press **Configure** (it may say **Edit**), tick `group.io.github.jet11111.markerpost` and press **Continue**. Then press whatever confirms it. Apple's help calls it **Assign**, then **Done**. You may instead see **Save**, then **Confirm** in a warning box. Press them all until you are back on the list. Finally open the identifier again and check that App Groups is ticked and shows the group as enabled. If it does not, do this step again.

**The widgets**

Repeat "The app" with description `Marker Post Widgets` and Bundle ID `io.github.jet11111.markerpost.widgets`, including steps 3 and 5.

### 4. Create the app's page

1. Go to <https://appstoreconnect.apple.com>, **Apps**, press **+**, then **New App**.
2. Platform: **iOS**.
3. Name: this must be unique across the whole App Store, so `Marker Post` may be taken. Something like `Marker Post Hampshire` is fine. It is only the name on Apple's website: the name under the icon on your phone stays "Marker Post".
4. Primary language: **English (U.K.)**. Bundle ID: choose `io.github.jet11111.markerpost` from the list. SKU: `markerpost`. User Access: **Full Access**.
5. **Create**.

You do not need to fill in anything else on that page. It is not being submitted to the App Store.

### 5. Make an access key

This is what lets GitHub upload builds for you.

1. In App Store Connect open **Users and Access**, then the **Integrations** tab, then **App Store Connect API**.
2. The first time, press **Request Access** and accept.
3. Under **Team Keys** press **+** (Generate API Key). Name: `Marker Post builds`. Access: **App Manager**. Press **Generate**.
4. Press **Download** beside the new key. You get a file called `AuthKey_XXXXXXXXXX.p8`. **Apple lets you download it only once.** Leave it in your Downloads folder for now.
5. Note two things from the same page: the **Key ID** (10 characters, beside the key) and the **Issuer ID** (a long code above the list).
6. Now open <https://developer.apple.com/account> and scroll to **Membership details**. Note your **Team ID** (10 characters) and the name shown as the team name (for a personal membership it is your own name).

### 6. Run the setup command

On this computer, [in the app's folder](../README.md#running-a-command):

```
node scripts/setup-ios-signing.mjs
```

It asks for the four things you noted and the key file, and walks you through creating one access token on GitHub. If its token steps do not match what GitHub shows (for example there is no "1 year" choice), use the link in the token list under "Once a year" below: it fills in the name, a one-year expiry and the permission for you.

It also asks two yes/no questions:

- whether to create the private repository (it asks this only the first time): type `y` and press Enter;
- whether each upload must wait for your approval: press Enter, which means yes.

The rest of this page assumes you said yes to both.

Then it:

- creates a **private** repository, `marker-post-signing`, to hold the signing certificate in encrypted form;
- creates a `testflight` "environment" on this repository, with you as the person who must approve each upload (that is the second question);
- stores everything as encrypted secrets there.

Nothing secret is printed or written to the computer, and nothing goes into this (public) repository. At the end it shows one password: save it in your password manager as "Marker Post match password". If you ever run the command again, it keeps that password and does not show a new one.

To see what it would do without doing it: `node scripts/setup-ios-signing.mjs --dry-run`.

When it has finished, move the `.p8` file out of Downloads into your password manager or somewhere safe. You will not normally need it again.

### 7. Create your tester group

1. In App Store Connect open **Apps**, your app, then the **TestFlight** tab.
2. Beside **Internal Testing** press **+**. Group name: `Me`. Tick **Enable automatic distribution**. **Create**.
3. In the group, press **+** beside Testers and add yourself.

With automatic distribution, every build GitHub uploads reaches your phone without another click. Internal testing needs no review by Apple.

### 8. Start the first build

The first build must also create the signing certificate, so it needs the "bootstrap" switch.

On this computer, in the app's folder:

```
gh workflow run ios-testflight.yml --ref feature/native-app -f bootstrap_signing=true
```

(Once the branch has been merged, you can instead use the website: **Actions**, **ios-testflight**, **Run workflow**, tick the bootstrap box. On the website that box's label begins "Create or renew the signing certificate and profiles".)

If the command answers that it could not find the workflow, or that the workflow has no `workflow_dispatch` trigger, GitHub will not start it from a branch. Merge first ([going-live.md](going-live.md)), then use the website as above, with the bootstrap box ticked.

Then:

1. On GitHub open the repository's **Actions** page and open the new **ios-testflight** run.
2. It waits for you. Press **Review deployments**, tick **testflight**, press **Approve and deploy**.
3. It takes about 20 to 30 minutes. A green tick means the build is with Apple.

### 9. Install on the iPhone

1. Install **TestFlight** from the App Store on the iPhone.
2. Apple emails you an invitation a few minutes after the build has been processed (usually 5 to 15 minutes after the green tick). Open it on the iPhone and press **View in TestFlight**, or just open TestFlight: the app is listed.
3. Press **Install**, then open **Marker Post**.
4. When it asks for location choose **Allow While Using App**, and leave **Precise Location** on.

Then follow [testing-on-device.md](testing-on-device.md).

## After that

- **A new build**: either press **Run workflow** (bootstrap box unticked) or push a version tag:
  ```
  git tag v2.0.1
  git push origin v2.0.1
  ```
  Approve it on the Actions page as in step 8. TestFlight on the phone updates the app by itself if automatic updates are on.
- **Every month**: on the 1st, GitHub starts a build by itself and waits for your approval. TestFlight builds stop working 90 days after upload, so approving it keeps the app alive. If you do not want that month's build, open the run, press **Review deployments**, tick **testflight** and press **Reject** (or press **Cancel run**). Do not leave it waiting: a waiting run can hold the queue, so a build you start later sits as "pending" until the old one has been approved, rejected or cancelled. GitHub gives up on a waiting run by itself after 30 days. The monthly build only starts once the branch has been merged into `master`.
- **Once a year**: the signing certificate and your GitHub token expire.
  - Certificate: run the workflow once with the bootstrap box ticked.
  - Token: make a new one and hand it to GitHub, like this. Do not run the setup command again for this.
    1. Open <https://github.com/settings/personal-access-tokens/new?name=Marker+Post+signing&expires_in=365&contents=write>. The name, a one-year expiry and the Contents permission are filled in. If GitHub says the name is already in use, add the year or a number to it.
    2. Under **Repository access** choose **Only select repositories** and pick `marker-post-signing`.
    3. Check that **Permissions** shows Contents: Read and write. Leave everything else as it is.
    4. Press **Generate token** and copy it (it starts with `github_pat_`).
    5. In the app's folder run `gh secret set MATCH_GIT_TOKEN --env testflight`, paste the token and press Enter.
- **April 2027**: Apple will require apps to be built with Xcode 27. The **ios** workflow already tries a build with it on every change and shows a warning if that stops working, so there is time to react.

## Things to know

- **Location.** The app asks for "While Using" only, never "Always". Live tracking keeps running in the background because the Live Activity is visible; when you stop tracking, location stops. iOS shows its usual location indicator while it runs.
- **Eight hours.** iOS ends any Live Activity after 8 hours, and a shift is 12. On iOS 26 the app lines up a replacement shortly before the limit, so the post stays on screen. On iOS 18 it warns you on the Lock Screen about half an hour before, and opening the app once renews it. The app also adds a "Show nearest marker post" shortcut that does the same from the Shortcuts app or by asking Siri.
- **CarPlay.** With iOS 26 or later the Live Activity appears on the CarPlay Dashboard by itself. There is no separate CarPlay app, and no setting to turn on.
- **Starting it when you get in the vehicle.** The app answers the link `markerpost://live/start`, which opens it and starts live tracking. The Shortcuts app can open that link for you when CarPlay connects: Shortcuts, **Automation**, **+**, **CarPlay**, **Connects**, **Run Immediately**, then add the action **Open URLs** with `markerpost://live/start`. iOS may ask you to unlock the phone first, because only an app that is on screen is allowed to start a Live Activity. I have not been able to try this on a phone: it is step C8 in [testing-on-device.md](testing-on-device.md).
- **Public logs.** This repository is public, so the build logs are too. The workflow hides your team name and Team ID in them and keeps no build files. Do not add `--verbose` to the build command.
- **Vehicle lookup and the NTIS page** are not in the iPhone app. See [going-live.md](going-live.md).
- **The App Store** itself is a further step (screenshots, a privacy policy page, Apple's review). TestFlight is enough for your own phones. Sharing the app with colleagues is possible through TestFlight too, but that needs a short review by Apple first: say when you want it.

## If something goes wrong

Open the failed run on the Actions page and read the last lines of the **Sign, build and upload** step.

| What it says | What to do |
|---|---|
| The command in step 8 answers that it could not find the workflow, or that the workflow has no `workflow_dispatch` trigger | GitHub will not start it from a branch. Merge first ([going-live.md](going-live.md)), then use **Actions**, **ios-testflight**, **Run workflow** with the bootstrap box ticked. |
| The run is "skipped" | The setup command has not been run on this repository yet (step 6). |
| `An app with that bundle ID needs to exist` | An identifier is missing or mistyped. Check step 3: both `io.github.jet11111.markerpost` and `io.github.jet11111.markerpost.widgets`. |
| `Could not find an app on App Store Connect` | The app's page is missing, or was made with a different Bundle ID (step 4). |
| `No code signing identity found … readonly` | The certificate has not been created yet. Run again with the bootstrap box ticked. |
| A permissions or "forbidden" error while creating the certificate | The access key needs more rights. Make a second key as in step 5, with Access **Admin**. Run the setup command again (step 6) and give it the new Key ID and key file. It asks everything again, including a new GitHub token (make one with the token list under "Once a year"). It keeps the certificate password. Then run the bootstrap again (step 8). To go back to the first key afterwards, run the setup command once more with the first key before you revoke the Admin one. |
| `Couldn't decrypt the repo` or `Invalid password passed via 'MATCH_PASSWORD'` | The password on GitHub does not match the certificate. In the app's folder run `gh secret set MATCH_PASSWORD --env testflight`, paste the password you saved in your password manager as "Marker Post match password" and press Enter. Then start the build again. |
| `Could not create another Distribution certificate` | An earlier failed bootstrap left a certificate behind. At developer.apple.com, **Certificates**, revoke the Apple Distribution certificate that is not in use, then run the bootstrap again. |
| `Provisioning profile … doesn't include the com.apple.security.application-groups entitlement` | The App Group was not attached to one of the identifiers (step 3, sub-step 5). Fix it, then run with the bootstrap box ticked. |
| Authentication failed for the signing repository | The GitHub token has expired or was limited to the wrong repository. Make a new one: follow the token list under "Once a year" above. |
| The build is green but nothing arrives on the phone | Apple is still processing (give it 30 minutes), or you are not in the tester group, or automatic distribution was not ticked (step 7). |

If the message is none of these, copy the last 30 lines of that step and send them to me.

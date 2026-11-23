# Going live

All of the redesign, the new map and the phone apps are on the branch `feature/native-app`. The branch `master` is what the live web app at <https://jet11111.github.io/marker-post/> is published from, and it has not been touched. Nothing changes for anyone until you merge.

This page is the checklist for the day you do.

## Before you merge

### 1. Look at it

The branch is on GitHub (pushed on 22 November 2026). Pushing it changed nothing on the live site.

Any of these shows you the new app without affecting the live one:

- **On this computer, exactly as it will be published**: [in the app's folder](../README.md#running-a-command) run `npm run preview`, then open <http://localhost:8080>. Add `?sim=50.93795,-1.352527,110,30` to the address for a simulated position on the M27. Stop it with Ctrl+C when you have finished.
- **Side by side at several phone sizes**: run `node scripts/serve.mjs` instead and open <http://localhost:8080/docs/mobile-preview.html>.
- **On an Android phone**: the APK is built from the branch. See [android-app.md](android-app.md).
- **On the iPhone**: TestFlight builds from the branch too. See [ios-testflight.md](ios-testflight.md).
- **The design rules** (colours, type, components) are written down in [design.md](design.md).

### 2. Two decisions that are yours

**Vehicle lookup in the phone apps.** It depends on your own DVLA relay and its terms of use, so it is switched **off** in the Android and iPhone builds and **on** in the web app, exactly as today. To include it in a phone build, the build needs `MP_VEHICLE=1`; tell me and I will wire the switch into the workflows. Nothing else changes.

**The NTIS page.** It is a separate page (`ntis.html`) that the app does not link to. It stays on the website as it is, and is **not** inside the phone apps. If you would rather it left the public website too, say so.

### 3. Change one GitHub setting (important)

Today GitHub publishes the website twice: once by copying the repository as it is, and once through the "Deploy to GitHub Pages" workflow. Until now both produced the same site. After the merge they would not: the workflow publishes the properly built app, the plain copy would publish an unbuilt one with no street map and no offline list, and whichever finished last would win.

So, **before merging**:

1. On GitHub open the repository, **Settings**, **Pages**.
2. Under **Build and deployment**, change **Source** from "Deploy from a branch" to **GitHub Actions**.

That is safe to do at any time: the live site keeps being published by the workflow exactly as now.

(The same thing from this computer: `gh api -X PUT repos/JET11111/marker-post/pages -f build_type=workflow`)

### 4. Recommended: approve other people's pull requests first

The repository is public, so anyone can propose a change, and GitHub would then build an Android app from it. Make GitHub ask you before it runs anything for someone else: **Settings**, **Actions**, **General**, **Approval for running fork pull request workflows from contributors**, choose **Require approval for all external contributors**, **Save**. It changes nothing for your own builds.

## Merging

1. On GitHub open **Pull requests**. If there is not one for `feature/native-app` yet, press **New pull request**, set "compare" to `feature/native-app`, and press **Create pull request**.
2. Wait for the checks at the bottom of the page. These four must show a green tick (each may be listed twice):
   - **map-checks / check**
   - **android / build**
   - **ios / Lookup tests**
   - **ios / Build (Xcode 26)**

   Two others are early warnings. They may show a red cross without stopping you:
   - **ios / Build (Xcode 27 preview)**: it tries the build with Xcode 27, which Apple will require from April 2027.
   - **android / Run it on an emulator**: this check is new and still being proven.

   A grey "Skipped" entry is normal. If a warning one is red, tell me afterwards, but you can still merge.
3. Press **Merge pull request**.

The "Deploy to GitHub Pages" workflow then builds and publishes the site. It takes two or three minutes; the first time, about a minute longer while it cuts the street map.

## Afterwards

1. Open <https://jet11111.github.io/marker-post/> in a private window. You should see the new design.
2. On a phone that already has the web app on its home screen: open it with a signal. It fetches the new version at once. If it still looks old, close it completely and open it again. Nobody has to reinstall anything.
3. Open **Map**. It should show the street map behind the network. To keep the street map for use without signal, open the layers button and press **Save street map** (about 41 MB, once).
4. Open **Signs** and **Vehicle** and check they still work: they use your Cloudflare Workers, which have not been changed.

## If it goes wrong

The way back is to undo the merge:

1. On GitHub open the merged pull request (**Pull requests**, then **Closed**) and press **Revert**.
2. GitHub offers a new pull request that undoes the merge. Press **Create pull request**, then **Merge pull request**. The old site is back two or three minutes later, and it stays back.
3. Then tell me what was wrong.

Re-running an old "Deploy to GitHub Pages" run also brings the old site back, but only until the next sign or network update, usually within a few hours. Those updates republish whatever is on `master`. Do not rely on it.

## What does not change

- The address of the web app, and the home screen icon people already have (its picture updates when they add it again).
- The data jobs: the road network (daily) and the signs (every few minutes) carry on, and republish the site as before.
- Your Cloudflare Workers and their keys. Nothing needs deploying again.

## Worth knowing

- **The signs job runs less often than its schedule says.** It is set to every five minutes, but GitHub actually runs it every few hours. The app already tells you the true age of the sign data, and the live relay covers the gap when you are online. A Cloudflare scheduled Worker would be reliable to the minute, if you want that.

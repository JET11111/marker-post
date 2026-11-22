#!/usr/bin/env node
// Run the Android build tool from any shell, on any system:
//   node scripts/gradle.mjs assembleDebug
//
// You do not need this to get the app: the "android" workflow on GitHub builds
// the APK for you (docs/android-app.md). It is here for building on your own
// computer, which needs JDK 21 and the Android SDK installed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const android = fileURLToPath(new URL('../android', import.meta.url));
const windows = process.platform === 'win32';
const wrapper = join(android, windows ? 'gradlew.bat' : 'gradlew');

if (!existsSync(wrapper)) {
  console.error('The android/ project is missing. Run "npx cap add android" first.');
  process.exit(1);
}
const java = spawnSync(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java', ['-version'], { stdio: 'ignore' });
if (java.error || java.status !== 0) {
  console.error('Java was not found. Building Android on this computer needs JDK 21 and the Android SDK.');
  console.error('You can skip both: the "android" workflow on GitHub builds the APK. See docs/android-app.md.');
  process.exit(1);
}
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT && !existsSync(join(android, 'local.properties'))) {
  console.error('The Android SDK was not found (ANDROID_HOME is not set and android/local.properties does not exist).');
  console.error('You can skip it: the "android" workflow on GitHub builds the APK. See docs/android-app.md.');
  process.exit(1);
}

// A .bat file has to be started through the shell on Windows.
const run = spawnSync(windows ? `"${wrapper}"` : wrapper, process.argv.slice(2), { cwd: android, stdio: 'inherit', shell: windows });
process.exit(run.status ?? 1);

#!/usr/bin/env node
// Keep the Xcode project in step with the files on disk, without Xcode.
//
// Capacitor generates ios/App/App.xcodeproj with every file listed explicitly,
// and there is no Mac here to tick "target membership" boxes. This script makes
// the same entries Xcode would. It can be re-run at any time: every object it
// adds has an ID derived from its role, so running it twice changes nothing.
//
//   node scripts/ios-project.mjs           apply
//   node scripts/ios-project.mjs --check   exit 1 if applying would change anything (used by CI)
//
// What it ensures:
//   * iOS 18.0 as the deployment target in EVERY build configuration. (The
//     Capacitor CLI copies the first one it finds into CapApp-SPM/Package.swift,
//     so they must all agree.)
//   * the app target compiles App/MarkerPostIntents.swift, bundles
//     App/PrivacyInfo.xcprivacy and is signed with App/App.entitlements;
//   * a widget extension target "MarkerPostWidgets" exists, is built before and
//     embedded in the app, and compiles every Swift file in
//     ios/App/MarkerPostWidgets plus the three shared files from the plugin
//     package, with its own Info.plist, entitlements and privacy manifest;
//   * both targets carry the version from package.json;
//   * a shared scheme "App" exists, so `xcodebuild -scheme App` works on a
//     fresh checkout.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const xcode = require('xcode'); // ships with @capacitor/cli; used only to parse and write the file

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IOS_APP = join(ROOT, 'ios', 'App');
const PBXPROJ = join(IOS_APP, 'App.xcodeproj', 'project.pbxproj');
const SCHEME = join(IOS_APP, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme');
const CHECK = process.argv.includes('--check');

const DEPLOYMENT_TARGET = '18.0';
const WIDGETS = 'MarkerPostWidgets';
const EMBED_PHASE = 'Embed Foundation Extensions';
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const appId = JSON.parse(readFileSync(join(ROOT, 'capacitor.config.json'), 'utf8')).appId;
const WIDGETS_BUNDLE_ID = `${appId}.widgets`;
// Compiled into the extension as well as into the plugin package (path from ios/App).
const SHARED_DIR = '../../native/marker-post-plugin/ios/Sources/MarkerPostCore/Shared';
const SHARED = ['MarkerPostActivityAttributes.swift', 'PostSnapshot.swift', 'SharedStore.swift'];

if (!existsSync(PBXPROJ)) throw new Error('ios/App/App.xcodeproj not found. Run "npx cap add ios" first.');
const before = readFileSync(PBXPROJ, 'utf8');
const project = xcode.project(PBXPROJ);
project.parseSync();
const proj = project.hash.project;
const objects = proj.objects;
const projectId = proj.rootObject;
const pbxProject = objects.PBXProject[projectId];

// ---------------------------------------------------------------- helpers

/** A stable 24-character object ID for a named role. */
const id = (role) => createHash('sha1').update(`markerpost:${role}`).digest('hex').slice(0, 24).toUpperCase();
/** Quote a value the way Xcode does: bare only if it is letters, digits and _ $ . / */
const q = (s) => (/^[A-Za-z0-9_$./]+$/.test(String(s)) ? String(s) : `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
const unquote = (s) => String(s ?? '').replace(/^"|"$/g, '');
const isComment = (key) => key.endsWith('_comment');
const item = (value, comment) => ({ value, comment });

function put(isa, uuid, body, comment) {
  const section = (objects[isa] ??= {});
  section[uuid] = { isa, ...body };
  section[`${uuid}_comment`] = comment;
  return uuid;
}
function drop(isa, uuid) {
  const section = objects[isa];
  if (!section) return;
  delete section[uuid];
  delete section[`${uuid}_comment`];
}
/** Make sure `list` holds exactly one entry for `value`, optionally straight after another entry. */
function ensureItem(list, value, comment, afterValue) {
  const at = list.findIndex((e) => e.value === value);
  if (at >= 0) { list[at].comment = comment; return; }
  const after = afterValue ? list.findIndex((e) => e.value === afterValue) : -1;
  if (after >= 0) list.splice(after + 1, 0, item(value, comment));
  else list.push(item(value, comment));
}
function findTarget(name) {
  const section = objects.PBXNativeTarget;
  for (const key of Object.keys(section)) {
    if (!isComment(key) && unquote(section[key].name) === name) return { uuid: key, target: section[key] };
  }
  return null;
}
function configsOf(target) {
  const list = objects.XCConfigurationList[target.buildConfigurationList];
  return list.buildConfigurations.map((c) => objects.XCBuildConfiguration[c.value]);
}
function phaseOf(target, isa) {
  for (const p of target.buildPhases) {
    if (objects[isa]?.[p.value]) return objects[isa][p.value];
  }
  throw new Error(`Build phase ${isa} not found`);
}
function groupContaining(fileName) {
  const groups = objects.PBXGroup;
  for (const key of Object.keys(groups)) {
    if (!isComment(key) && (groups[key].children || []).some((c) => c.comment === fileName)) return key;
  }
  throw new Error(`Could not find the group that holds ${fileName}`);
}
const FILE_TYPES = {
  '.swift': 'sourcecode.swift',
  '.plist': 'text.plist.xml',
  '.entitlements': 'text.plist.entitlements',
  '.xcprivacy': 'text.xml',
};
const typeOf = (name) => FILE_TYPES[name.slice(name.lastIndexOf('.'))] || 'text';

/** A file reference. Keys stay in Xcode's (alphabetical) order. */
function fileRef(role, { name, path = name, sourceTree = '"<group>"' }) {
  const body = { lastKnownFileType: q(typeOf(name)) };
  if (path !== name) body.name = q(name);
  body.path = q(path);
  body.sourceTree = sourceTree;
  return put('PBXFileReference', id(`ref:${role}`), body, name);
}
/** Membership of a build phase. */
function buildFile(role, refId, name, phaseName, settings) {
  const body = { fileRef: refId, fileRef_comment: name };
  if (settings) body.settings = settings;
  return put('PBXBuildFile', id(`build:${role}`), body, `${name} in ${phaseName}`);
}

// ------------------------------------------------- 1. one deployment target

for (const key of Object.keys(objects.XCBuildConfiguration)) {
  if (isComment(key)) continue;
  const settings = objects.XCBuildConfiguration[key].buildSettings;
  if ('IPHONEOS_DEPLOYMENT_TARGET' in settings) settings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
}

// --------------------------------------------------------- 2. the app target

const app = findTarget('App');
if (!app) throw new Error('App target not found in the Xcode project');
const appGroupId = groupContaining('AppDelegate.swift');
const appGroup = objects.PBXGroup[appGroupId];
const onDisk = (...parts) => existsSync(join(IOS_APP, ...parts));

for (const config of configsOf(app.target)) {
  config.buildSettings.CODE_SIGN_ENTITLEMENTS = 'App/App.entitlements';
  config.buildSettings.MARKETING_VERSION = pkg.version;
  // Keep the settings in Xcode's order (plain character order) so a later save from Xcode moves nothing.
  config.buildSettings = Object.fromEntries(Object.keys(config.buildSettings).sort().map((k) => [k, config.buildSettings[k]]));
}

// Files the app target needs beyond Capacitor's template. Each is skipped (and
// reported) while it does not exist, so a missing file can never break the project.
const missing = [];
if (onDisk('App', 'App.entitlements')) {
  ensureItem(appGroup.children, fileRef('app:App.entitlements', { name: 'App.entitlements' }), 'App.entitlements');
} else missing.push('ios/App/App/App.entitlements');

if (onDisk('App', 'MarkerPostIntents.swift')) {
  const ref = fileRef('app:MarkerPostIntents.swift', { name: 'MarkerPostIntents.swift' });
  ensureItem(appGroup.children, ref, 'MarkerPostIntents.swift');
  ensureItem(phaseOf(app.target, 'PBXSourcesBuildPhase').files,
    buildFile('app:MarkerPostIntents.swift', ref, 'MarkerPostIntents.swift', 'Sources'), 'MarkerPostIntents.swift in Sources');
} else missing.push('ios/App/App/MarkerPostIntents.swift');

if (onDisk('App', 'PrivacyInfo.xcprivacy')) {
  const ref = fileRef('app:PrivacyInfo.xcprivacy', { name: 'PrivacyInfo.xcprivacy' });
  ensureItem(appGroup.children, ref, 'PrivacyInfo.xcprivacy');
  ensureItem(phaseOf(app.target, 'PBXResourcesBuildPhase').files,
    buildFile('app:PrivacyInfo.xcprivacy', ref, 'PrivacyInfo.xcprivacy', 'Resources'), 'PrivacyInfo.xcprivacy in Resources');
} else missing.push('ios/App/App/PrivacyInfo.xcprivacy');

// ------------------------------------------------- 3. the widget extension

const widgetDir = join(IOS_APP, WIDGETS);
const ownSwift = existsSync(widgetDir) ? readdirSync(widgetDir).filter((f) => f.endsWith('.swift')).sort() : [];
for (const f of SHARED) {
  if (!onDisk(SHARED_DIR, f)) throw new Error(`Shared Swift file missing: ${f}`);
}
const widgetsReady = ownSwift.length > 0 && onDisk(WIDGETS, 'Info.plist') && onDisk(WIDGETS, `${WIDGETS}.entitlements`);

if (!widgetsReady) {
  missing.push(`ios/App/${WIDGETS}/ (Swift files, Info.plist and ${WIDGETS}.entitlements): widget target not added`);
} else {
  const targetId = id('widgets:target');
  const groupId = id('widgets:group');
  const productId = id('widgets:product');
  const sourcesId = id('widgets:sources');
  const frameworksId = id('widgets:frameworks');
  const resourcesId = id('widgets:resources');
  const configListId = id('widgets:configs');
  const proxyId = id('widgets:proxy');
  const dependencyId = id('widgets:dependency');
  const embedId = id('widgets:embed');
  const listComment = `Build configuration list for PBXNativeTarget "${WIDGETS}"`;

  // The file list is rebuilt from disk every time, so a deleted file leaves the project too.
  for (const child of objects.PBXGroup[groupId]?.children || []) drop('PBXFileReference', child.value);
  for (const [isa, phaseId] of [['PBXSourcesBuildPhase', sourcesId], ['PBXResourcesBuildPhase', resourcesId]]) {
    for (const f of objects[isa]?.[phaseId]?.files || []) drop('PBXBuildFile', f.value);
  }

  const children = [], sources = [], resources = [];
  for (const name of ownSwift) {
    const ref = fileRef(`widgets:${name}`, { name });
    children.push(item(ref, name));
    sources.push(item(buildFile(`widgets:${name}`, ref, name, 'Sources'), `${name} in Sources`));
  }
  for (const name of SHARED) {
    const ref = fileRef(`widgets:shared:${name}`, { name, path: `${SHARED_DIR}/${name}`, sourceTree: 'SOURCE_ROOT' });
    children.push(item(ref, name));
    sources.push(item(buildFile(`widgets:shared:${name}`, ref, name, 'Sources'), `${name} in Sources`));
  }
  for (const name of ['Info.plist', `${WIDGETS}.entitlements`]) {
    children.push(item(fileRef(`widgets:${name}`, { name }), name));
  }
  if (onDisk(WIDGETS, 'PrivacyInfo.xcprivacy')) {
    const name = 'PrivacyInfo.xcprivacy';
    const ref = fileRef(`widgets:${name}`, { name });
    children.push(item(ref, name));
    resources.push(item(buildFile(`widgets:${name}`, ref, name, 'Resources'), `${name} in Resources`));
  }

  put('PBXGroup', groupId, { children, path: WIDGETS, sourceTree: '"<group>"' }, WIDGETS);
  ensureItem(objects.PBXGroup[pbxProject.mainGroup].children, groupId, WIDGETS, appGroupId);

  put('PBXFileReference', productId, {
    explicitFileType: q('wrapper.app-extension'), includeInIndex: 0, path: `${WIDGETS}.appex`, sourceTree: 'BUILT_PRODUCTS_DIR',
  }, `${WIDGETS}.appex`);
  ensureItem(objects.PBXGroup[pbxProject.productRefGroup].children, productId, `${WIDGETS}.appex`);

  const phase = (isa, phaseId, files, name) => put(isa, phaseId,
    { buildActionMask: 2147483647, files, runOnlyForDeploymentPostprocessing: 0 }, name);
  phase('PBXSourcesBuildPhase', sourcesId, sources, 'Sources');
  phase('PBXFrameworksBuildPhase', frameworksId, [], 'Frameworks');
  phase('PBXResourcesBuildPhase', resourcesId, resources, 'Resources');

  // Build settings: what Xcode's own "Widget Extension" template sets, with a
  // hand-written Info.plist. Everything else comes from the project level.
  const appSettings = configsOf(app.target)[0].buildSettings;
  const settings = () => ({
    APPLICATION_EXTENSION_API_ONLY: 'YES',
    CODE_SIGN_ENTITLEMENTS: `${WIDGETS}/${WIDGETS}.entitlements`,
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: appSettings.CURRENT_PROJECT_VERSION ?? 1,
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: `${WIDGETS}/Info.plist`,
    IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
    LD_RUNPATH_SEARCH_PATHS: ['"$(inherited)"', '"@executable_path/Frameworks"', '"@executable_path/../../Frameworks"'],
    MARKETING_VERSION: pkg.version,
    PRODUCT_BUNDLE_IDENTIFIER: WIDGETS_BUNDLE_ID,
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    SKIP_INSTALL: 'YES',
    SWIFT_EMIT_LOC_STRINGS: 'YES',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: '"1,2"',
  });
  const configs = ['Debug', 'Release'].map((name) => item(
    put('XCBuildConfiguration', id(`widgets:config:${name}`), { buildSettings: settings(), name }, name), name));
  put('XCConfigurationList', configListId, {
    buildConfigurations: configs, defaultConfigurationIsVisible: 0, defaultConfigurationName: 'Release',
  }, listComment);

  put('PBXNativeTarget', targetId, {
    buildConfigurationList: configListId,
    buildConfigurationList_comment: listComment,
    buildPhases: [item(sourcesId, 'Sources'), item(frameworksId, 'Frameworks'), item(resourcesId, 'Resources')],
    buildRules: [],
    dependencies: [],
    name: WIDGETS,
    productName: WIDGETS,
    productReference: productId,
    productReference_comment: `${WIDGETS}.appex`,
    productType: q('com.apple.product-type.app-extension'),
  }, WIDGETS);
  ensureItem(pbxProject.targets, targetId, WIDGETS);
  pbxProject.attributes.TargetAttributes[targetId] = { CreatedOnToolsVersion: '26.0', ProvisioningStyle: 'Automatic' };

  // The app is built after the extension, and carries it in its PlugIns folder.
  put('PBXContainerItemProxy', proxyId, {
    containerPortal: projectId,
    containerPortal_comment: 'Project object',
    proxyType: 1,
    remoteGlobalIDString: targetId,
    remoteInfo: WIDGETS,
  }, 'PBXContainerItemProxy');
  put('PBXTargetDependency', dependencyId, {
    target: targetId, target_comment: WIDGETS, targetProxy: proxyId, targetProxy_comment: 'PBXContainerItemProxy',
  }, 'PBXTargetDependency');
  ensureItem(app.target.dependencies, dependencyId, 'PBXTargetDependency');

  const embedded = buildFile('widgets:embed', productId, `${WIDGETS}.appex`, EMBED_PHASE, { ATTRIBUTES: ['RemoveHeadersOnCopy'] });
  put('PBXCopyFilesBuildPhase', embedId, {
    buildActionMask: 2147483647,
    dstPath: '""',
    dstSubfolderSpec: 13, // PlugIns
    files: [item(embedded, `${WIDGETS}.appex in ${EMBED_PHASE}`)],
    name: q(EMBED_PHASE),
    runOnlyForDeploymentPostprocessing: 0,
  }, EMBED_PHASE);
  ensureItem(app.target.buildPhases, embedId, EMBED_PHASE);
}

// ------------------------------------------------------------- 4. write out

// The parser reads these two as numbers and would drop their leading zero.
for (const key of ['LastSwiftUpdateCheck', 'LastUpgradeCheck']) {
  const v = pbxProject.attributes[key];
  if (typeof v === 'number') pbxProject.attributes[key] = String(v).padStart(4, '0');
}

// Sections in alphabetical order and objects in ID order, as Xcode writes them,
// so the result does not depend on the order things were added in.
proj.objects = Object.fromEntries(Object.keys(objects).sort().map((isa) => {
  const section = objects[isa];
  const sorted = {};
  for (const key of Object.keys(section).filter((k) => !isComment(k)).sort()) {
    sorted[key] = section[key];
    if (`${key}_comment` in section) sorted[`${key}_comment`] = section[`${key}_comment`];
  }
  return [isa, sorted];
}));

const after = project.writeSync();

// A shared scheme, so xcodebuild does not depend on Xcode having created one.
const buildable = `<BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${app.uuid}"
               BuildableName = "App.app"
               BlueprintName = "App"
               ReferencedContainer = "container:App.xcodeproj">
            </BuildableReference>`;
const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "2600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            ${buildable}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${buildable}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${buildable}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

const projectChanged = after !== before;
const schemeChanged = !existsSync(SCHEME) || readFileSync(SCHEME, 'utf8') !== scheme;

for (const m of missing) console.warn(`Not on disk yet: ${m}`);
if (CHECK) {
  if (projectChanged || schemeChanged || missing.length) {
    console.error('The Xcode project is out of date. Run: node scripts/ios-project.mjs');
    process.exit(1);
  }
  console.log('Xcode project is up to date.');
} else {
  if (projectChanged) writeFileSync(PBXPROJ, after);
  if (schemeChanged) { mkdirSync(dirname(SCHEME), { recursive: true }); writeFileSync(SCHEME, scheme); }
  console.log(projectChanged || schemeChanged ? 'Xcode project updated.' : 'Xcode project already up to date.');
}

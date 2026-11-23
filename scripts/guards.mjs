// Safety rules for the scripts that can delete, hand out or overwrite things:
// the build (it empties its output folder), the development server (it serves
// files from a folder) and the Android signing set-up (it writes the file that
// holds a key's password).
//
// Every rule here is a pure function. It decides from names and plain facts and
// touches nothing, so tests/build-scripts.test.mjs can try the dangerous cases
// without going near a real folder or a real key.

import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The path parts from `outer` down to `inner`: [] when they are the same place,
 * null when `inner` is not inside `outer` (above it, beside it, on another drive).
 */
export function partsBelow(outer, inner) {
  const rel = relative(resolve(outer), resolve(inner));
  if (rel === '') return [];
  if (isAbsolute(rel)) return null; // another drive or a network share
  const parts = rel.split(sep);
  return parts[0] === '..' ? null : parts;
}

// ------------------------------------------------------------------ the build

/**
 * Where each kind of build is written unless --out says otherwise. The phone
 * build has a folder of its own, and capacitor.config.json (webDir) points at
 * it, so a web build can never be what Capacitor copies into the phone apps.
 */
export const BUILD_FOLDER = { pwa: 'www', native: 'www-native' };

/** Folders that only ever hold a build, so they may be emptied even after a build that stopped part-way. */
const BUILD_ONLY = [BUILD_FOLDER.pwa, BUILD_FOLDER.native, '.build-check'];

/**
 * Names Windows keeps for its own devices: nul, con, aux, prn, COM1, lpt9. With
 * an ending too (NUL.txt), which Windows can read as the same device. Names
 * that only begin like one (null, console) are ordinary names.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Why a build must not be written to `out`, or null when it may be. The build
 * empties its output folder before it writes anything, so this is what stops a
 * mistyped --out from deleting the repository or its sources.
 *   root     the app's folder
 *   out      the folder asked for
 *   target   'pwa' or 'native'
 *   holds    what is there now: 'nothing' (missing or empty), 'build' (an
 *            earlier build by the same script) or 'other'
 *   sources  names in the app's folder that belong to the app (what the build
 *            reads from, the phone projects, the documents); never an output,
 *            even while they do not exist yet (tiles, node_modules)
 */
export function outputProblem({ root, out, target, holds, sources = [] }) {
  const parts = partsBelow(root, out);
  if (!parts) return "it is outside the app's folder";
  if (!parts.length) return "it is the app's folder itself";
  if (parts.length > 1) return "the output must be a folder directly inside the app's folder, not inside another folder";
  // A plain name only. On Windows anything else can be a second name for a
  // folder that already has one (a short name such as WWW-NA~1, a name with a
  // colon, a dot or a space at the end).
  if (!/^[A-Za-z0-9._-]*[A-Za-z0-9_-]$/.test(parts[0])) {
    return 'its name may only have letters, digits, dots, dashes and underscores, and may not end with a dot';
  }
  // Not a device name either. Node can make a folder called "nul" (what someone
  // might type to throw a build away), and then Explorer, Command Prompt and
  // git cannot open it or delete it in the usual way.
  if (WINDOWS_DEVICE.test(parts[0])) return 'that name belongs to Windows itself, so it cannot be a folder';
  // Capitals do not count on Windows ("DATA" is the data folder), so what is
  // refused goes by the name in small letters. What is let through at the end
  // goes by the name exactly as given.
  const name = parts[0].toLowerCase();
  if (sources.some((s) => s.toLowerCase() === name)) return "the app's own files live there";
  if (name === BUILD_FOLDER.native && target !== 'native') {
    return `${BUILD_FOLDER.native} is what Capacitor copies into the phone apps, so only the phone build may go there`;
  }
  if (holds === 'other' && !BUILD_ONLY.includes(parts[0])) return 'it holds files that are not a build made by this script';
  return null;
}

// ------------------------------------------------------ the development server

/** The phone projects: the signing settings (android/keystore.properties) and machine settings live in them. */
const PRIVATE_FOLDERS = ['android', 'ios'];
/** Signing material, by the same names .gitignore lists. */
const SIGNING_FILE = /^keystore\.properties$|\.(jks|keystore|p12|p8|mobileprovision)$/i;

/**
 * May the development server hand out the file at these path parts, counted
 * from the folder being served? Never: anything outside that folder (null),
 * hidden files and folders (.git, .env), the phone projects, signing files.
 */
export function mayServe(parts) {
  if (!parts) return false;
  if (PRIVATE_FOLDERS.includes(String(parts[0] ?? '').toLowerCase())) return false;
  return parts.every((p) => !p.startsWith('.') && !SIGNING_FILE.test(p));
}

/**
 * The file a request names inside the folder being served, or null when it
 * must not be served. `pathname` is the path from the address, still
 * percent-encoded. The server applies mayServe() a second time to the real
 * file on disk, because a link or a Windows short name (ANDROI~1) can make an
 * innocent-looking name lead somewhere else.
 */
export function requestedFile(root, pathname) {
  let path;
  try { path = decodeURIComponent(pathname); } catch { return null; } // not a valid address
  const parts = path.split('/').filter((p) => p && p !== '.');
  // "..", a backslash, a colon (a drive letter, or a hidden Windows file stream) and a NUL can all lead elsewhere.
  if (parts.some((p) => p === '..' || /[\\:\0]/.test(p))) return null;
  return mayServe(parts) ? resolve(root, ...parts) : null;
}

// --------------------------------------------------- the Android signing set-up

/**
 * Is this the storeFile of a key made for one build only (by --throwaway, or a
 * dry run)? Such a key sits in a temporary folder named markerpost-key-XXXXXX
 * and is worth nothing after its build. Anything else counts as a real key.
 */
export function isThrowawayKeyFile(storeFile) {
  return /(^|[\\/])markerpost-key-[A-Za-z0-9]{6}[\\/]markerpost-android\.p12$/.test(String(storeFile ?? ''));
}

/**
 * Why the Android signing set-up must stop before it makes or writes anything,
 * or null when it may go on. android/keystore.properties is the only readable
 * copy of a key's password (GitHub's copy cannot be read back), so it is never
 * replaced unless it belongs to a throwaway key, or holds the very password
 * that is about to be written again.
 *   throwaway   the script was run with --throwaway
 *   keyExists   your own key file is in its usual place
 *   saved       that file as read: { storeFile, storePassword }, or null if there is none
 * The answers:
 *   'throwaway-over-own-password'   --throwaway would replace your own key's password
 *   'password-file-missing'         a key, but nothing that holds its password
 *   'password-file-is-throwaway'    a key, but the file belongs to a throwaway key
 *   'password-missing'              a key and a file, but no password in the file
 *   'key-missing'                   a password for a key that is not there
 */
export function signingProblem({ throwaway, keyExists, saved }) {
  const ownPasswordFile = Boolean(saved) && !isThrowawayKeyFile(saved.storeFile);
  if (throwaway) return ownPasswordFile ? 'throwaway-over-own-password' : null;
  if (keyExists) {
    if (!saved) return 'password-file-missing';
    if (!ownPasswordFile) return 'password-file-is-throwaway';
    return saved.storePassword ? null : 'password-missing';
  }
  return ownPasswordFile ? 'key-missing' : null;
}

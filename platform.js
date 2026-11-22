// One place that knows whether the app is running in a browser or inside the
// native (Capacitor) shell. Everything else asks this module for a position
// watch, a haptic tap, a CORS-free request and so on, and gets the right
// implementation for where it is running.
//
// In the browser `globalThis.Capacitor` does not exist and every function
// falls back to a plain web API. In the native apps the Capacitor runtime
// (vendor/capacitor/capacitor.js, added by the native build) is loaded before
// this module, so plugins are reached with registerPlugin() and no bundler.

const cap = globalThis.Capacitor;

export const isNative = Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
/** "ios", "android" or "web". */
export const platform = isNative ? cap.getPlatform() : 'web';

if (typeof document !== 'undefined') document.documentElement.dataset.platform = platform;

const registry = new Map();
function plugin(name) {
  if (!isNative || typeof cap.registerPlugin !== 'function') return null;
  if (!registry.has(name)) registry.set(name, cap.registerPlugin(name));
  return registry.get(name);
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNegative = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Normalise a browser or plugin position into the shape the app uses.
 * `heading` here always means DIRECTION OF TRAVEL, because that is what
 * chooses the carriageway. The native plugin's own `heading` can be the
 * compass direction the phone is pointing, so on native only its `course`
 * value is trusted; when it is missing, the direction of travel is unknown.
 */
export function toFix(coords, timestamp, native = isNative) {
  let heading;
  if (native) heading = nonNegative(coords.course);
  else heading = typeof coords.heading === 'number' ? coords.heading : null; // may be NaN when stationary
  return {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: finite(coords.accuracy),
    heading,
    speed: nonNegative(coords.speed),
    timestamp: finite(timestamp) ?? Date.now(),
  };
}

// ---------------------------------------------------------------- position

/**
 * Desk testing in a browser only: ?sim=lat,lng[,heading[,speed]] feeds one
 * fixed position instead of the GPS. The fix is flagged so the screen can say
 * "Simulated position" and never be mistaken for a real one.
 */
function simulatedFix() {
  if (isNative || typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('sim');
  if (!raw) return null;
  const [lat, lng, heading, speed] = raw.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat, lng, accuracy: 5,
    heading: Number.isFinite(heading) ? heading : null,
    speed: Number.isFinite(speed) ? speed : null,
    simulated: true,
  };
}

const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };

/**
 * Start a continuous high-accuracy position watch.
 * onFix(fix) for every fix; onError({ code, message }) with code 1 when
 * permission is refused, 2 for anything else. Returns a function that stops
 * the watch.
 */
export function watchPosition(onFix, onError) {
  if (isNative) return watchNative(onFix, onError);
  const sim = simulatedFix();
  if (sim) {
    const emit = () => onFix({ ...sim, timestamp: Date.now() });
    emit();
    const timer = setInterval(emit, 1000);
    return () => clearInterval(timer);
  }
  if (!('geolocation' in navigator)) {
    onError({ code: 0, message: 'No geolocation on this device' });
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix(toFix(pos.coords, pos.timestamp, false)),
    (err) => onError({ code: err.code === 1 ? 1 : 2, message: err.message }),
    WATCH_OPTIONS,
  );
  return () => navigator.geolocation.clearWatch(id);
}

function watchNative(onFix, onError) {
  const Geo = plugin('Geolocation');
  let stopped = false, watchId = null, retry = null;
  const clear = () => {
    if (watchId != null) { Geo.clearWatch({ id: watchId }).catch(() => {}); watchId = null; }
  };
  // The plugin ends a watch when it reports certain errors (a first fix that
  // takes too long, for example starting in a garage). Start it again shortly
  // afterwards so the readout recovers by itself.
  const restartSoon = () => {
    if (stopped || retry) return;
    clear();
    retry = setTimeout(() => { retry = null; start(); }, 3000);
  };
  async function start() {
    if (stopped) return;
    try {
      // `interval` defaults to `timeout` on Android, so it must be set or
      // fixes would arrive only once a minute.
      watchId = await Geo.watchPosition(
        { ...WATCH_OPTIONS, timeout: 60000, interval: 1000, minimumUpdateInterval: 1000 },
        (pos, err) => {
          if (stopped) return;
          if (err || !pos) {
            onError({ code: 2, message: String(err?.message || err || 'No position') });
            restartSoon();
            return;
          }
          onFix(toFix(pos.coords, pos.timestamp, true));
        },
      );
      if (stopped) clear();
    } catch (e) {
      onError({ code: 2, message: String(e?.message || e) });
      restartSoon();
    }
  }
  (async () => {
    try {
      let perm = await Geo.checkPermissions();
      if (perm.location !== 'granted') perm = await Geo.requestPermissions({ permissions: ['location'] });
      if (perm.location !== 'granted') { onError({ code: 1, message: 'Location permission refused' }); return; }
    } catch (e) {
      // Thrown when location services are switched off for the whole device.
      onError({ code: 2, message: String(e?.message || e) });
      return;
    }
    start();
  })();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clear();
  };
}

/** One position, for the map's locate button. */
export async function getCurrentPosition(options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }) {
  if (isNative) {
    const Geo = plugin('Geolocation');
    const pos = await Geo.getCurrentPosition(options);
    return toFix(pos.coords, pos.timestamp, true);
  }
  if (!('geolocation' in navigator)) throw new Error('No geolocation on this device');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toFix(pos.coords, pos.timestamp, false)), reject, options);
  });
}

// ----------------------------------------------------------------- haptics

/** A short tap. kind: "light" | "selection" | "success" | "warning". Never throws. */
export function haptic(kind = 'light') {
  try {
    if (isNative) {
      const H = plugin('Haptics');
      if (kind === 'selection') { H.selectionStart(); H.selectionChanged(); H.selectionEnd(); }
      else if (kind === 'success') H.notification({ type: 'SUCCESS' });
      else if (kind === 'warning') H.notification({ type: 'WARNING' });
      else H.impact({ style: 'LIGHT' });
    }
    // The web app stays silent: vibration there is inconsistent and unrequested.
  } catch { /* haptics are decoration */ }
}

// -------------------------------------------------------- keep screen awake

let wakeLock = null;
/** Keep the screen on while the app is open. Safe to call repeatedly. */
export async function keepAwake() {
  if (isNative) {
    try { await plugin('MarkerPost').setKeepAwake({ on: true }); return; } catch { /* fall through to the web API */ }
  }
  if (!('wakeLock' in navigator)) return;
  try {
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* denied or not allowed right now; retried on the next visibility change */ }
}

// ------------------------------------------------------ app lifecycle, back

/** Call handler(isActive) when the app comes to the front or goes away. */
export function onAppState(handler) {
  if (isNative) {
    plugin('App').addListener('appStateChange', (state) => handler(Boolean(state?.isActive)));
    return;
  }
  document.addEventListener('visibilitychange', () => handler(document.visibilityState === 'visible'));
}

/**
 * Links that open the app: markerpost://map, markerpost://live/start and so on.
 * Calls handler(path) with "map", "live/start"… for each link, including the
 * one that launched the app. Native apps only; a web page has its own address.
 */
export function onAppLink(handler) {
  if (!isNative) return;
  const App = plugin('App');
  const deliver = (address) => {
    try {
      const link = new URL(address);
      if (link.protocol !== 'markerpost:') return;
      handler(`${link.host}${link.pathname}`.replace(/\/+$/, '').toLowerCase());
    } catch { /* not a link we understand */ }
  };
  try {
    App.addListener('appUrlOpen', (event) => deliver(event?.url));
    App.getLaunchUrl().then((launch) => { if (launch?.url) deliver(launch.url); }).catch(() => {});
  } catch { /* App plugin missing: links simply open the app */ }
}

/**
 * Android hardware/gesture back. handler() returns true when it handled the
 * press (closed a sheet, went back to the first tab); otherwise the app is
 * sent to the background, as a native app would be.
 */
export function onBackButton(handler) {
  if (platform !== 'android') return;
  const App = plugin('App');
  App.addListener('backButton', () => {
    let handled = false;
    try { handled = Boolean(handler()); } catch { handled = false; }
    if (!handled) App.minimizeApp().catch(() => {});
  });
}

// ------------------------------------------------------------ system chrome

/** Make status-bar and navigation-bar icons readable on the current theme. */
export function setSystemBars(isDark) {
  if (!isNative) return;
  try { plugin('SystemBars').setStyle({ style: isDark ? 'DARK' : 'LIGHT' }).catch(() => {}); } catch { /* optional */ }
}

// ------------------------------------------------------------------ network

/**
 * GET a JSON document with a timeout. In the native apps the request is made
 * by the operating system rather than the web view, so services that only
 * allow the website's origin (the sign and vehicle relays) still answer.
 * Resolves { ok, status, data }. Rejects on timeout or no connection.
 */
export async function getJson(url, { timeoutMs = 10000, cache } = {}) {
  if (isNative) {
    const Http = plugin('CapacitorHttp');
    const res = await Http.get({
      url, connectTimeout: timeoutMs, readTimeout: timeoutMs, responseType: 'json',
      headers: { Accept: 'application/json' },
    });
    let data = res.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, ...(cache ? { cache } : {}) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data, fallback: res.headers.get('X-Markerpost-Cache') === 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------- last known post

/**
 * Hand the post on screen to the native side, so the home screen widgets have
 * a "last known" value even when live tracking has never been started. The
 * native side ignores it while live tracking is running. Never throws.
 */
export function publishPost(snapshot) {
  if (!isNative) return;
  try { plugin('MarkerPost').publishPost(snapshot).catch(() => {}); } catch { /* plugin missing */ }
}

// ------------------------------------------------------------ live tracking

/**
 * Live tracking is a native-only feature: an iOS Live Activity (Lock Screen,
 * Dynamic Island, CarPlay) or an Android ongoing notification, both fed by a
 * native background location session and a native nearest-post lookup. The
 * web view only starts and stops it.
 */
export const live = {
  supported: isNative,

  /** { active, reason? } — never throws. */
  async status() {
    if (!isNative) return { active: false };
    try { return await plugin('MarkerPost').getTrackingStatus(); } catch { return { active: false }; }
  },

  /** Start. Resolves { active: true } or { active: false, reason }. */
  async start(options = {}) {
    try { return await plugin('MarkerPost').startTracking(options); }
    catch (e) { return { active: false, reason: String(e?.message || e) }; }
  },

  async stop() {
    try { return await plugin('MarkerPost').stopTracking(); }
    catch (e) { return { active: false, reason: String(e?.message || e) }; }
  },

  /** Tell a running session about a changed preference. */
  async update(options = {}) {
    if (!isNative) return;
    try { await plugin('MarkerPost').updateTracking(options); } catch { /* not running */ }
  },

  /** handler({ active, reason? }) whenever the native side starts or stops tracking. */
  onChange(handler) {
    if (!isNative) return;
    try { plugin('MarkerPost').addListener('trackingChanged', handler); } catch { /* plugin missing */ }
  },
};

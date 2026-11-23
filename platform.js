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

/**
 * Call a plugin where a failure does not matter (a tap, a listener, the
 * colour of the bars). A plugin that is missing does not throw: its call
 * returns a promise that rejects. Both kinds of failure end here, so neither
 * stops the app nor fills the problem log.
 */
function quietly(call) {
  try {
    const result = call();
    if (result && typeof result.then === 'function') result.then(null, () => {});
  } catch { /* the plugin is missing or not ready */ }
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
 * fixed position instead of the GPS. Every position made here is flagged
 * `simulated: true`, so the screen can say "Simulated position" and it is
 * never mistaken for a real one. This is the only place a made-up position
 * comes from; the phone apps have none.
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
    timestamp: Date.now(),
    simulated: true,
  };
}

const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };

/**
 * Start a continuous high-accuracy position watch.
 * onFix(fix) for every fix. onError({ code, message, reason? }): code 0 when
 * the device has no geolocation, 1 when permission is refused, 2 for anything
 * else; reason is "location-off" when location is switched off for the whole
 * phone (native apps). Returns a function that stops the watch.
 *
 * In the native apps a refusal, or location being switched off, is reported
 * once and the watch then keeps looking: it starts by itself when the user
 * has put it right, with no need to close the app. When it does, onError is
 * called once more, with code 2 and reason "looking". That one is not a
 * failure: it says the last report no longer holds and a position is being
 * looked for again, so the app can stop saying "blocked" before the first
 * fix arrives.
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

/**
 * What a failure reported by the Geolocation plugin means for the user. The
 * plugin uses the same codes on iOS and Android.
 *   "refused"  the app is not allowed to use location (denied or restricted)
 *   "off"      location is switched off for the whole phone
 *   null       anything else: a passing problem, worth trying again
 */
export function geoBlock(err) {
  const code = String(err?.code || '');
  if (code === 'OS-PLUG-GLOC-0003' || code === 'OS-PLUG-GLOC-0008') return 'refused';
  if (code === 'OS-PLUG-GLOC-0007') return 'off';
  return null;
}

/** How soon to try again after a problem. */
const RETRY_MS = 3000;

function watchNative(onFix, onError) {
  const Geo = plugin('Geolocation');
  let stopped = false;
  let serial = 0, current = 0, watchId = null; // the watch that is running or starting, if any
  let checking = false, again = null;
  // The user is asked once at most, and only while the app has never been
  // seen to hold the permission. The system's own prompt sends the app to the
  // back and brings it forward again, so asking on every return would put a
  // refused prompt straight back up. Permission that was given and then lost
  // was taken away in Settings (or, after "Allow Once" on an iPhone, is asked
  // for again by the plugin itself), so it is not asked for a second time.
  let mayAsk = true;
  // Why there is no watch: null (there is one, or one is on its way),
  // "refused", "off" (see geoBlock) or "failed" (the check itself went wrong).
  let blocked = null;

  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const clear = () => {
    current = 0;
    if (watchId != null) { const id = watchId; watchId = null; quietly(() => Geo.clearWatch({ id })); }
  };
  const lookSoon = () => {
    if (!stopped && !again) again = setTimeout(() => { again = null; look(); }, RETRY_MS);
  };

  // There can be no position until something changes on the phone. Say why,
  // once, and keep looking: the user may put it right in Settings and come
  // back, and nothing restarts the app when they do.
  const block = (why, err) => {
    clear();
    if (blocked !== why) {
      blocked = why;
      if (why === 'refused') onError({ code: 1, message: 'Location permission refused' });
      else if (why === 'off') onError({ code: 2, reason: 'location-off', message: String(err?.message || 'Location is switched off') });
      else onError({ code: 2, message: String(err?.message || err || 'Location could not be checked') });
    }
    lookSoon();
  };

  async function start() {
    const mine = ++serial;
    current = mine;
    const wanted = () => !stopped && current === mine;
    try {
      // `interval` defaults to `timeout` on Android, so it must be set or
      // fixes would arrive only once a minute.
      const id = await Geo.watchPosition(
        { ...WATCH_OPTIONS, timeout: 60000, interval: 1000, minimumUpdateInterval: 1000 },
        (pos, err) => {
          if (!wanted()) return;
          if (err || !pos) {
            const why = geoBlock(err);
            if (why) { block(why, err); return; }
            // The plugin ends a watch when it reports certain errors (a first
            // fix that takes too long, for example starting in a garage).
            // Start again shortly so the readout recovers by itself.
            onError({ code: 2, message: String(err?.message || err || 'No position') });
            clear();
            lookSoon();
            return;
          }
          onFix(toFix(pos.coords, pos.timestamp, true));
        },
      );
      if (wanted()) watchId = id;
      else quietly(() => Geo.clearWatch({ id })); // stopped or replaced while it was starting
    } catch (e) {
      if (!wanted()) return;
      onError({ code: 2, message: String(e?.message || e) });
      clear();
      lookSoon();
    }
  }

  // Make sure location may be used, then start the watch. Apart from the one
  // question (see mayAsk) this only looks.
  async function look(now = false) {
    if (stopped || checking || current) return;
    clearTimeout(again); again = null;
    // A timed look waits while the app is out of sight: nothing is asked then.
    if (!now && hidden()) { lookSoon(); return; }
    checking = true;
    let why = null, failure = null;
    try {
      // Both calls reject when location is switched off for the whole phone.
      let perm = await Geo.checkPermissions();
      if (perm.location !== 'granted' && mayAsk) {
        mayAsk = false;
        perm = await Geo.requestPermissions({ permissions: ['location'] });
      }
      if (perm.location === 'granted') mayAsk = false;
      else why = 'refused';
    } catch (e) {
      failure = e;
      why = geoBlock(e) || 'failed';
    }
    checking = false;
    if (stopped) return;
    if (why) { block(why, failure); return; }
    // It was blocked and no longer is. Say so now: the first fix can be most
    // of a minute away, and until it came the app would go on saying
    // "blocked" or "switched off", which has stopped being true.
    if (blocked) onError({ code: 2, reason: 'looking', message: 'Location is available again' });
    blocked = null;
    start();
  }

  // Coming back to the app is the moment the user may have put it right, and
  // the moment to restart a watch that failed while the app was away: look
  // at once, without waiting for the timer.
  let listening = null;
  quietly(() => (listening = plugin('App').addListener('appStateChange', (state) => {
    if (state?.isActive && !current) look(true);
  })));

  look(true);
  return () => {
    stopped = true;
    clearTimeout(again);
    clear();
    quietly(() => listening && listening.then((l) => l.remove()));
  };
}

/** One position, for the map's locate button. */
export async function getCurrentPosition(options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }) {
  if (isNative) {
    const Geo = plugin('Geolocation');
    const pos = await Geo.getCurrentPosition(options);
    return toFix(pos.coords, pos.timestamp, true);
  }
  // Desk testing: the made-up position, never the real one mixed in with it.
  const sim = simulatedFix();
  if (sim) return sim;
  if (!('geolocation' in navigator)) throw new Error('No geolocation on this device');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toFix(pos.coords, pos.timestamp, false)), reject, options);
  });
}

// ----------------------------------------------------------------- haptics

/** A short tap. kind: "light" | "selection" | "success" | "warning". Never throws. */
export function haptic(kind = 'light') {
  // The web app stays silent: vibration there is inconsistent and unrequested.
  if (!isNative) return;
  // Haptics are decoration: a failure is ignored.
  quietly(() => {
    const H = plugin('Haptics');
    if (kind === 'selection') return Promise.all([H.selectionStart(), H.selectionChanged(), H.selectionEnd()]);
    if (kind === 'success') return H.notification({ type: 'SUCCESS' });
    if (kind === 'warning') return H.notification({ type: 'WARNING' });
    return H.impact({ style: 'LIGHT' });
  });
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
    quietly(() => plugin('App').addListener('appStateChange', (state) => handler(Boolean(state?.isActive))));
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
      // Web views before Chrome 130 do not split a custom link into host and
      // path: they give an empty host and "//live/start". Trim both ends so
      // every version hands over the same "live/start".
      handler(`${link.host}${link.pathname}`.replace(/^\/+|\/+$/g, '').toLowerCase());
    } catch { /* not a link we understand */ }
  };
  // If the App plugin is missing, links simply open the app.
  quietly(() => App.addListener('appUrlOpen', (event) => deliver(event?.url)));
  quietly(() => App.getLaunchUrl().then((launch) => { if (launch?.url) deliver(launch.url); }));
}

/**
 * Android hardware/gesture back. handler() returns true when it handled the
 * press (closed a sheet, went back to the first tab); otherwise the app is
 * sent to the background, as a native app would be.
 */
export function onBackButton(handler) {
  if (platform !== 'android') return;
  const App = plugin('App');
  quietly(() => App.addListener('backButton', () => {
    let handled = false;
    try { handled = Boolean(handler()); } catch { handled = false; }
    if (!handled) quietly(() => App.minimizeApp());
  }));
}

// ------------------------------------------------------------ system chrome

/** Make status-bar and navigation-bar icons readable on the current theme. */
export function setSystemBars(isDark) {
  if (!isNative) return;
  quietly(() => plugin('SystemBars').setStyle({ style: isDark ? 'DARK' : 'LIGHT' }));
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
  quietly(() => plugin('MarkerPost').publishPost(snapshot));
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

  /**
   * Start. Resolves { active: true, since } or { active: false, reason? }.
   * A start that succeeded can still carry a reason: on Android,
   * "notifications-denied" means tracking runs but its notification cannot be
   * shown, so the post is nowhere to be seen. iOS can refuse without a reason
   * when none of the words fits (usually a passing cause).
   */
  async start(options = {}) {
    try { return await plugin('MarkerPost').startTracking(options); }
    catch (e) { return { active: false, reason: String(e?.message || e) }; }
  },

  /**
   * Stop. Resolves { active: false } once the native side has been told. If
   * the request did not get through, tracking may still be running: the
   * answer is then what the native side reports, and { active: true,
   * reason: "stop-failed" } while it is still running or cannot be asked.
   * A failure is never reported as "stopped".
   */
  async stop() {
    if (!isNative) return { active: false };
    try { return await plugin('MarkerPost').stopTracking(); } catch { /* the request did not get through */ }
    try {
      const now = await plugin('MarkerPost').getTrackingStatus();
      return now && now.active ? { ...now, reason: 'stop-failed' } : (now || { active: false });
    } catch { return { active: true, reason: 'stop-failed' }; }
  },

  /** Tell a running session about a changed preference. */
  async update(options = {}) {
    if (!isNative) return;
    try { await plugin('MarkerPost').updateTracking(options); } catch { /* not running */ }
  },

  /** handler({ active, reason? }) whenever the native side starts or stops tracking. */
  onChange(handler) {
    if (!isNative) return;
    quietly(() => plugin('MarkerPost').addListener('trackingChanged', handler));
  },
};

// Pure geodesy helpers shared by the web app, the tests and the native-data
// generator. No DOM, no Node APIs. The maths is the app's original
// implementation, unchanged: the Swift and Kotlin ports are checked against it.

export const EARTH_RADIUS_M = 6371000;

export const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Initial bearing from point 1 to point 2, in degrees, -180..180. */
export function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Smallest difference between two bearings, 0..180. */
export function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

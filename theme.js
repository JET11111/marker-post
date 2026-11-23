// Appearance: follows the system unless the user picks Light or Dark.
// The choice is applied as html[data-theme] (see styles.css) and saved so it
// is in place before the first paint on the next launch (see index.html).

const KEY = 'mp-theme';
const root = document.documentElement;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

// Browser chrome (address bar, task switcher). index.html declares one colour
// for a light system and one for a dark system. They are read once, here, so
// the two colours live in one place.
const lightMeta = document.getElementById('theme-color-light');
const darkMeta = document.getElementById('theme-color-dark');
const CHROME = { light: lightMeta?.content || '#F2F2F7', dark: darkMeta?.content || '#0A0F1A' };

/** "auto", "light" or "dark". */
export function themeChoice() {
  const t = root.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'auto';
}

/** True when the app is currently drawn dark. */
export function isDark() {
  const choice = themeChoice();
  return choice === 'auto' ? systemDark.matches : choice === 'dark';
}

/** Make the browser chrome follow the app's choice, not just the system's. */
function paintChrome() {
  const choice = themeChoice();
  if (lightMeta) lightMeta.content = choice === 'dark' ? CHROME.dark : CHROME.light;
  if (darkMeta) darkMeta.content = choice === 'light' ? CHROME.light : CHROME.dark;
}

function notify() {
  const dark = isDark();
  paintChrome();
  for (const fn of listeners) {
    try { fn(dark); } catch { /* one listener must not stop the others */ }
  }
}

export function setTheme(choice) {
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;
  try {
    if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice);
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the choice lasts for this session */ }
  notify();
}

/**
 * fn(isDark) after every setTheme(), wherever in the app it was called, and
 * when the system switches between light and dark while the choice is
 * Automatic (and straight away, with `immediate`). Returns an unsubscribe
 * function.
 */
export function onThemeChange(fn, { immediate = false } = {}) {
  listeners.add(fn);
  if (immediate) fn(isDark());
  return () => listeners.delete(fn);
}

systemDark.addEventListener('change', () => { if (themeChoice() === 'auto') notify(); });

// A saved Light or Dark is already on <html> when this runs (index.html
// applies it before the first paint): give the browser chrome the same answer
// from the start, not only after the next change.
paintChrome();

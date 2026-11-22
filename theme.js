// Appearance: follows the system unless the user picks Light or Dark.
// The choice is applied as html[data-theme] (see styles.css) and saved so it
// is in place before the first paint on the next launch (see index.html).

const KEY = 'mp-theme';
const root = document.documentElement;
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

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

function notify() {
  const dark = isDark();
  // Browser chrome (address bar, task switcher) follows the app, not just the system.
  const light = document.getElementById('theme-color-light');
  const darkMeta = document.getElementById('theme-color-dark');
  const choice = themeChoice();
  if (light) light.content = choice === 'dark' ? '#000000' : '#F2F2F7';
  if (darkMeta) darkMeta.content = choice === 'light' ? '#F2F2F7' : '#000000';
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

/** fn(isDark) now-and-whenever the drawn theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn, { immediate = false } = {}) {
  listeners.add(fn);
  if (immediate) fn(isDark());
  return () => listeners.delete(fn);
}

systemDark.addEventListener('change', () => { if (themeChoice() === 'auto') notify(); });

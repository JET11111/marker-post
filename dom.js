// Tiny DOM helpers shared by the app shell and the map.

export const el = (id) => document.getElementById(id);

/** Set text only when it changed, so a 1 Hz position stream does not churn the page. */
export const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

export const show = (node, on) => node.classList.toggle('hidden', !on);

/**
 * Build an element. Text is always set as text, never parsed as HTML, so data
 * from feeds and files cannot inject markup.
 *   h('button', { class: 'chip', type: 'button', onclick: fn }, 'Label', child)
 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** An inline icon from trusted, constant path data (24 px grid, stroked). */
export function icon(paths, { size = 22, stroke = 1.8 } = {}) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span.firstChild;
}

export const ICONS = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  locate: '<path d="M20.5 3.5 3.5 10.6l7 2.9 2.9 7 7.1-17Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12.5 9 5 9-5M3 17l9 5 9-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m12 6 2.6 6H9.4L12 6Z" fill="currentColor" stroke="none"/><path d="M9.4 12 12 18l2.6-6"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  minus: '<path d="M5 12h14"/>',
  warn: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4.5M12 17.5v.5"/>',
};

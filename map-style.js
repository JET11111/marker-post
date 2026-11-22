// Map appearance: the base-map style (light and dark) and the colours used
// for the app's own layers (network, marker posts, bays, position).
//
// The base map is drawn from OpenStreetMap vector tiles with the Protomaps
// basemap layer set, recoloured here to a calm, muted palette so the National
// Highways network and the marker posts are what stand out. Light and dark
// use identical layers; only colours differ.

import { layers as basemapLayers, namedFlavor } from './vendor/protomaps-basemaps/basemaps.js';

const ASSETS = new URL('vendor/basemaps-assets/', document.baseURI).href;

/** Colours for the app's own layers. */
export const PALETTE = {
  light: {
    land: '#F3EFE7',
    motorway: '#2F7DE1', aRoad: '#2E9E6B', slipMotorway: '#7FB0EC', slipARoad: '#86C7A8',
    networkCasing: '#FFFFFF',
    post: '#F5A800', postStroke: '#FFFFFF',
    selection: '#FFB81C', selectionRing: '#0A0A0C',
    you: '#0A6CFF', youStale: '#8A8A92', youRing: '#FFFFFF',
    eraOld: '#7F6938', era: '#C2410C', layby: '#4A4FB8', junction: '#5A5A62', badgeText: '#FFFFFF',
    shieldMotorway: '#0B62B8', shieldARoad: '#00693A', shieldARoadText: '#FFD100',
  },
  dark: {
    land: '#17191C',
    motorway: '#4F93E6', aRoad: '#4CB383', slipMotorway: '#3A70B5', slipARoad: '#378664',
    networkCasing: '#0B0D10',
    post: '#FFC23D', postStroke: '#17191C',
    selection: '#FFC23D', selectionRing: '#EBEBF0',
    you: '#0A84FF', youStale: '#8E8E96', youRing: '#FFFFFF',
    eraOld: '#7F6938', era: '#C2410C', layby: '#5B60D6', junction: '#8E8E96', badgeText: '#FFFFFF',
    shieldMotorway: '#0B62B8', shieldARoad: '#00693A', shieldARoadText: '#FFD100',
  },
};

const LIGHT = {
  ...namedFlavor('light'),
  background: '#F3EFE7', earth: '#F3EFE7',
  park_a: '#E3ECD8', park_b: '#D2E4C4', wood_a: '#DEE9D4', wood_b: '#CCDFBE', scrub_a: '#E4EBD9', scrub_b: '#D6E3C8',
  hospital: '#F1E7E5', industrial: '#EBE8E2', school: '#EFEAE0', pedestrian: '#EFECE5',
  sand: '#EFEAD9', beach: '#F1EBD5', aerodrome: '#E9E8EA', runway: '#F4F4F6', zoo: '#DFE9DD', military: '#E9E6E0',
  glacier: '#F7F7F7', pier: '#E5E1DA',
  water: '#A9D1F0',
  buildings: '#E7E2D9',
  tunnel_other_casing: '#E3DED5', tunnel_minor_casing: '#E3DED5', tunnel_link_casing: '#E3DED5', tunnel_major_casing: '#E3DED5', tunnel_highway_casing: '#E3DED5',
  tunnel_other: '#F2EFE9', tunnel_minor: '#F2EFE9', tunnel_link: '#F2EFE9', tunnel_major: '#F2EFE9', tunnel_highway: '#F6EFD9',
  minor_service_casing: '#DDD7CC', minor_casing: '#DDD7CC', link_casing: '#DDD7CC', major_casing_late: '#D6CFC2', highway_casing_late: '#E2C37C',
  major_casing_early: '#D6CFC2', highway_casing_early: '#E2C37C',
  other: '#FBFAF7', minor_service: '#FFFFFF', minor_a: '#FFFFFF', minor_b: '#FFFFFF', link: '#FFFFFF', major: '#FFFFFF', highway: '#FBE8B8',
  bridges_other_casing: '#DDD7CC', bridges_minor_casing: '#DDD7CC', bridges_link_casing: '#DDD7CC', bridges_major_casing: '#D6CFC2', bridges_highway_casing: '#E2C37C',
  bridges_other: '#FBFAF7', bridges_minor: '#FFFFFF', bridges_link: '#FFFFFF', bridges_major: '#FFFFFF', bridges_highway: '#FBE8B8',
  railway: '#C8C2B7', boundaries: '#B8B2A6',
  roads_label_minor: '#7A746A', roads_label_minor_halo: '#FFFFFF',
  roads_label_major: '#6A655C', roads_label_major_halo: '#FFFFFF',
  ocean_label: '#5B8DBE', subplace_label: '#77726A', subplace_label_halo: '#F3EFE7',
  city_label: '#3D3B38', city_label_halo: '#F3EFE7', state_label: '#A9A49B', state_label_halo: '#F3EFE7',
  country_label: '#9A958C', address_label: '#8A847A', address_label_halo: '#FFFFFF',
  landcover: {
    grassland: '#E6EDDA', barren: '#EFEADE', urban_area: '#EDE9E1', farmland: '#EFF0E0',
    glacier: '#FFFFFF', scrub: '#E4EBD9', forest: '#D8E6CB',
  },
};

const DARK = {
  ...namedFlavor('dark'),
  background: '#17191C', earth: '#17191C',
  park_a: '#1B2620', park_b: '#1E2D24', wood_a: '#1A251F', wood_b: '#1D2C23', scrub_a: '#1B2520', scrub_b: '#1E2A23',
  hospital: '#231D1E', industrial: '#1D1F22', school: '#211F1C', pedestrian: '#1D1F22',
  sand: '#22211C', beach: '#24231C', aerodrome: '#1E2024', runway: '#2A2D32', zoo: '#1C2622', military: '#1F2023',
  glacier: '#2A2D31', pier: '#24272B',
  water: '#0F2A40',
  buildings: '#22252A',
  tunnel_other_casing: '#101214', tunnel_minor_casing: '#101214', tunnel_link_casing: '#101214', tunnel_major_casing: '#101214', tunnel_highway_casing: '#101214',
  tunnel_other: '#23262A', tunnel_minor: '#23262A', tunnel_link: '#272A2F', tunnel_major: '#2B2E33', tunnel_highway: '#34322B',
  minor_service_casing: '#101214', minor_casing: '#101214', link_casing: '#101214', major_casing_late: '#101214', highway_casing_late: '#101214',
  major_casing_early: '#101214', highway_casing_early: '#101214',
  other: '#26292D', minor_service: '#2A2D32', minor_a: '#2D3035', minor_b: '#2D3035', link: '#34373D', major: '#3A3E44', highway: '#4A4638',
  bridges_other_casing: '#101214', bridges_minor_casing: '#101214', bridges_link_casing: '#101214', bridges_major_casing: '#101214', bridges_highway_casing: '#101214',
  bridges_other: '#26292D', bridges_minor: '#2D3035', bridges_link: '#34373D', bridges_major: '#3A3E44', bridges_highway: '#4A4638',
  railway: '#3A3D42', boundaries: '#4A4E55',
  roads_label_minor: '#8C9198', roads_label_minor_halo: '#17191C',
  roads_label_major: '#A3A8AF', roads_label_major_halo: '#17191C',
  ocean_label: '#5C86AE', subplace_label: '#8C9198', subplace_label_halo: '#17191C',
  city_label: '#C9CDD3', city_label_halo: '#17191C', state_label: '#6B7078', state_label_halo: '#17191C',
  country_label: '#7A7F87', address_label: '#7A7F87', address_label_halo: '#17191C',
  landcover: {
    grassland: '#1B251F', barren: '#201F1C', urban_area: '#1B1D20', farmland: '#1A211D',
    glacier: '#2A2D31', scrub: '#1B2520', forest: '#1A2620',
  },
};

// Layers the tool does not need: shop and amenity icons, house numbers.
const DROPPED = new Set(['pois', 'address_label']);
const FONT_FOLDERS = { 'Noto Sans Regular': 'NotoSans-Regular', 'Noto Sans Medium': 'NotoSans-Medium', 'Noto Sans Italic': 'NotoSans-Italic' };

function baseLayers(dark, source) {
  const flavor = dark ? DARK : LIGHT;
  const generated = basemapLayers(source, flavor, { lang: 'en' }).filter((l) => !DROPPED.has(l.id));
  // Point the style's font names at the folders shipped in vendor/basemaps-assets.
  let json = JSON.stringify(generated);
  for (const [name, folder] of Object.entries(FONT_FOLDERS)) json = json.replaceAll(`"${name}"`, `"${folder}"`);
  const layers = JSON.parse(json);
  // Road numbers. In these tiles UK roads carry a `ref` but not the
  // `shield_text` the stock style draws, so read `ref` directly. From zoom 12
  // up; below that the network's own shields (map.js) label the main roads.
  layers.push({
    id: 'roads_ref', type: 'symbol', source, 'source-layer': 'roads', minzoom: 12,
    filter: ['all',
      ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
      ['has', 'ref'], ['!', ['has', 'shield_text']],
      ['<=', ['length', ['get', 'ref']], 5]],
    layout: {
      'symbol-placement': 'line', 'symbol-spacing': 260,
      'icon-image': ['concat', 'generic_shield-', ['to-string', ['length', ['get', 'ref']]], 'char'],
      'text-field': ['get', 'ref'], 'text-font': ['NotoSans-Medium'], 'text-size': 10,
      'icon-rotation-alignment': 'viewport', 'text-rotation-alignment': 'viewport',
      'icon-pitch-alignment': 'viewport', 'text-pitch-alignment': 'viewport',
    },
    paint: { 'text-color': dark ? '#C9CDD3' : '#4A463F' },
  });
  // Restrained depth: building blocks rise slightly when zoomed right in.
  const firstLabel = layers.findIndex((l) => l.type === 'symbol');
  layers.splice(firstLabel < 0 ? layers.length : firstLabel, 0, {
    id: 'buildings_depth', type: 'fill-extrusion', source, 'source-layer': 'buildings', minzoom: 15,
    paint: {
      'fill-extrusion-color': dark ? '#2A2E34' : '#DDD7CD',
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 16.5, 6],
      'fill-extrusion-opacity': 0.7,
    },
  });
  return layers;
}

/**
 * A complete MapLibre style.
 *   dark      draw the dark palette
 *   basemap   null, or { url } — a "pmtiles://…" address for the vector tiles.
 *             Without it only a plain ground colour is drawn, and the app's
 *             own layers go on top as usual.
 *   streets   false hides the street map but keeps the ground colour
 */
export function buildStyle({ dark, basemap, streets = true }) {
  const land = PALETTE[dark ? 'dark' : 'light'].land;
  const style = {
    version: 8,
    name: dark ? 'Marker Post dark' : 'Marker Post light',
    glyphs: `${ASSETS}fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}sprites/v4/${dark ? 'dark' : 'light'}`,
    sources: {},
    layers: [{ id: 'ground', type: 'background', paint: { 'background-color': land } }],
  };
  if (basemap && streets) {
    style.sources.basemap = { type: 'vector', url: basemap.url };
    style.layers = baseLayers(dark, 'basemap');
  }
  return style;
}

/** Font folder names for the app's own text layers. */
export const FONT = { regular: ['NotoSans-Regular'], medium: ['NotoSans-Medium'] };

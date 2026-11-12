// Addresses of the outside services. tools/build.py writes the real helper address into HELPER.
// Tests point everything at the local dev server through localStorage 'zc-dev'.
const HELPER = 'https://script.google.com/macros/s/AKfycbySJuiMhGBwMUpb6dzk7g-okLy_-wfFGGUzbZm8IjIcqUHbAaJXgNIL-bs3PAb47t9Bsg/exec';

let dev = {};
try { dev = JSON.parse(localStorage.getItem('zc-dev') || '{}'); } catch (e) { dev = {}; }

export const CFG = {
  helper: dev.helper || (HELPER.startsWith('__') ? '' : HELPER),
  aiBase: dev.aiBase || undefined, // undefined = api.anthropic.com
  geminiBase: dev.geminiBase || undefined, // undefined = generativelanguage.googleapis.com
  photon: dev.photon || 'https://photon.komoot.io/api/',
  nominatim: dev.nominatim || 'https://nominatim.openstreetmap.org/search',
  reverse: dev.reverse || 'https://nominatim.openstreetmap.org/reverse',
  osrmDrive: dev.osrmDrive || 'https://router.project-osrm.org/route/v1/driving/',
  osrmFoot: dev.osrmFoot || 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
  tiles: dev.tiles || 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  tilesAttr: '© OpenStreetMap © CARTO',
  isDev: !!dev.helper,
};

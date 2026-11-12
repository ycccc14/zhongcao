// Pure logic: no DOM, no storage, so node tests can import it.

export const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = (now) => isoDate(now || new Date());
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
export const diffDays = (from, to) => Math.round((parseDate(to) - parseDate(from)) / 86400000);
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------- links ----------

export function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'，。！？、；）)】\]]+/i);
  return m ? m[0] : '';
}

export function linkKind(url) {
  const h = (String(url).match(/^https?:\/\/([^/?#:]+)/i) || [])[1] || '';
  if (/xhslink\.com$|xiaohongshu\.com$|rednote\.com$/i.test(h)) return 'xhs';
  if (/instagram\.com$/i.test(h)) return 'ins';
  if (/(^|\.)goo\.gl$|google\.[a-z.]+$|g\.co$/i.test(h)) return 'maps';
  return h ? 'web' : '';
}

export const SOURCE_LABEL = { xhs: '小红书', ins: 'Instagram', maps: 'Google Maps', web: '网页', shot: '截图', video: '视频' };

// ---------- distance & travel ----------

export function km(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function fmtKm(d) {
  if (d == null) return '';
  return d < 1 ? `${Math.round(d * 1000 / 10) * 10} m` : `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;
}

export function fmtMin(m) {
  if (m == null) return '';
  m = Math.max(1, Math.round(m));
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}

// Rough times from straight-line distance when no route is known yet (roads are ~1.3× longer).
export const walkMin = (d) => (d * 1.3 / 4.8) * 60;
export const driveMin = (d) => (d * 1.35 / (d < 5 ? 22 : d < 20 ? 32 : 55)) * 60 + 4;

// How to get there. route = {walk:{km,min}, drive:{km,min}} from a routing service when known.
export function travelAdvice(d, route) {
  if (d == null) return null;
  const walk = route && route.walk ? route.walk.min : walkMin(d);
  const drive = route && route.drive ? route.drive.min : driveMin(d);
  const roadKm = route && route.drive ? route.drive.km : d * 1.35;
  let mode;
  let say;
  if (walk <= 15) { mode = 'walk'; say = `走路就到，约 ${fmtMin(walk)}`; }
  else if (walk <= 30) { mode = 'walk'; say = `走路 ${fmtMin(walk)}，或打车 ${fmtMin(drive)}`; }
  else if (roadKm <= 25) { mode = 'car'; say = `开车/打车约 ${fmtMin(drive)}`; }
  else { mode = 'car'; say = `较远：开车约 ${fmtMin(drive)}，可以顺路时再去`; }
  const transitHint = roadKm > 3 && roadKm <= 40 ? '也可以看看公共交通' : '';
  return { mode, say, walk, drive, roadKm, transitHint, estimated: !route };
}

export function navLinks(dest, origin) {
  if (!dest || dest.lat == null) {
    const q = encodeURIComponent([dest && dest.name, dest && dest.address].filter(Boolean).join(' '));
    return { google: `https://www.google.com/maps/search/?api=1&query=${q}`, waze: `https://waze.com/ul?q=${q}`, apple: `https://maps.apple.com/?q=${q}` };
  }
  const d = `${dest.lat},${dest.lng}`;
  const o = origin && origin.lat != null ? `&origin=${origin.lat},${origin.lng}` : '';
  const name = encodeURIComponent(dest.name || '');
  return {
    google: `https://www.google.com/maps/dir/?api=1${o}&destination=${d}`,
    transit: `https://www.google.com/maps/dir/?api=1${o}&destination=${d}&travelmode=transit`,
    waze: `https://waze.com/ul?ll=${d}&navigate=yes`,
    apple: `https://maps.apple.com/?daddr=${d}${origin && origin.lat != null ? `&saddr=${origin.lat},${origin.lng}` : ''}&q=${name}`,
    grab: `grab://open?screenType=BOOKING&dropOffLatitude=${dest.lat}&dropOffLongitude=${dest.lng}&dropOffName=${name}`,
  };
}

// ---------- food ----------

export const FOOD_STATUS = { want: '想吃', been: '吃过', skip: '不去了' };

// Fixed cuisine types. The AI picks one; guessCuisine() is the fallback for manual entries and old records.
// Order matters for guessing: shop types (dessert, café) first, then a cuisine's country (韩式烤肉 = Korean),
// then cooking styles (hot pot, BBQ), then the broad ones (Western, Chinese).
export const CUISINES = [
  { key: 'dessert', label: '甜品饮品', icon: '🍰', re: /甜品|甜点|蛋糕|dessert|cake|雪花冰|刨冰|奶茶|饮品|bubble ?tea|boba|gelato|ice ?cream|冰淇淋|糖水|tea ?shop/i },
  { key: 'bakery', label: '面包烘焙', icon: '🥐', re: /面包|烘焙|bakery|bread|可颂|croissant|贝果|bagel|patisserie/i },
  { key: 'cafe', label: '咖啡早午餐', icon: '☕', re: /咖啡|cafe|café|coffee|brunch|早午餐|kopi(?!tiam)/i },
  { key: 'hk', label: '港式', icon: '🫖', re: /港式|茶餐厅|烧腊|点心|dim ?sum|cha ?chaan|香港/i },
  { key: 'taiwan', label: '台式', icon: '🧋', re: /台式|台湾|卤肉饭|盐酥鸡|taiwan/i },
  { key: 'japanese', label: '日料', icon: '🍣', re: /日料|日本|日式|寿司|拉面|居酒屋|丼|omakase|japanese|sushi|ramen|izakaya|udon|乌冬|天妇罗/i },
  { key: 'korean', label: '韩餐', icon: '🇰🇷', re: /韩餐|韩国|韩式|korean|kimchi|泡菜|部队锅|拌饭|bibimbap|tteok/i },
  { key: 'thai', label: '泰餐', icon: '🇹🇭', re: /泰餐|泰国|泰式|thai|冬阴功|tom ?yum|船面|boat noodle|mookata/i },
  { key: 'vietnamese', label: '越南菜', icon: '🇻🇳', re: /越南|vietnam|pho\b|banh ?mi/i },
  { key: 'malay', label: '南洋马来', icon: '🇲🇾', re: /马来|南洋|娘惹|nyonya|peranakan|mamak|nasi|roti ?canai|laksa|叻沙|椰浆饭|kopitiam|印尼|indonesia/i },
  { key: 'indian', label: '印度菜', icon: '🇮🇳', re: /印度|indian|biryani|naan|tandoori|banana ?leaf|masala/i },
  { key: 'italian', label: '意大利菜', icon: '🍝', re: /意大利|意式|italian|pasta|pizza|披萨|trattoria/i },
  { key: 'mexican', label: '墨西哥菜', icon: '🌮', re: /墨西哥|mexican|taco|burrito/i },
  { key: 'middleeast', label: '中东菜', icon: '🧆', re: /中东|土耳其|turkish|arab|kebab|shawarma|lebanese|阿拉伯/i },
  { key: 'hotpot', label: '火锅', icon: '🍲', re: /火锅|hot ?pot|shabu|steamboat|麻辣香锅|串串/i },
  { key: 'bbq', label: '烧烤', icon: '🍢', re: /烧烤|烤肉|烤串|bbq|barbecue|yakiniku|烧鸟|yakitori/i },
  { key: 'seafood', label: '海鲜', icon: '🦞', re: /海鲜|seafood|螃蟹|crab|lobster|生蚝|oyster/i },
  { key: 'veg', label: '素食', icon: '🥗', re: /素食|斋|vegan|vegetarian|plant.based/i },
  { key: 'western', label: '西餐', icon: '🍽️', re: /西餐|western|steak|牛排|汉堡|burger|bistro|french|法餐|法式|grill/i },
  { key: 'chinese', label: '中餐', icon: '🥢', re: /中餐|中菜|川菜|湘菜|粤菜|东北菜|江浙|本帮|小炒|煮炒|饺子|面馆|兰州|麻辣烫|chinese|酸菜鱼|烤鱼|客家|潮州/i },
  { key: 'other', label: '其他', icon: '🍴', re: /$^/ },
];
export const CUISINE_KEYS = CUISINES.map((c) => c.key);
export const cuisineInfo = (key) => CUISINES.find((c) => c.key === key) || CUISINES[CUISINES.length - 1];

export function guessCuisine(...texts) {
  const s = texts.flat().filter(Boolean).join(' ');
  if (!s.trim()) return 'other';
  const hit = CUISINES.find((c) => c.re.test(s));
  return hit ? hit.key : 'other';
}

// The cuisine type of a stored record (records saved before types existed are guessed).
export const cuisineOf = (f) => (CUISINE_KEYS.includes(f.category) ? f.category
  : guessCuisine(f.cuisine, f.tags, f.name, (f.dishes || []).map((d) => d.name)));

export function priceText(p) {
  if (!p) return '';
  const cur = p.currency || '';
  const n = (x) => (x == null || x === '' ? null : Number(x));
  const lo = n(p.min);
  const hi = n(p.max);
  const per = p.per ? ` / ${p.per}` : '';
  if (lo != null && hi != null && lo !== hi) return `${cur}${lo}–${hi}${per}`;
  if (lo != null || hi != null) return `${cur}${lo != null ? lo : hi}${per}`;
  return p.text || '';
}

// A promo: {title, detail, start, end, time}. Status relative to `on` (YYYY-MM-DD).
export function promoStatus(promo, on) {
  const s = validDate(promo.start) ? promo.start : '';
  const e = validDate(promo.end) ? promo.end : '';
  if (e && e < on) return { key: 'expired', label: '已结束' };
  if (s && s > on) return { key: 'soon', label: `${diffDays(on, s)} 天后开始` };
  if (e) {
    const left = diffDays(on, e);
    return left <= 3 ? { key: 'ending', label: left === 0 ? '今天最后一天' : `还剩 ${left} 天` } : { key: 'active', label: `到 ${e.slice(5).replace('-', '/')}` };
  }
  if (s) return { key: 'active', label: '进行中' };
  return { key: 'unknown', label: '' };
}

export const livePromos = (food, on) => (food.promos || []).filter((p) => ['active', 'ending'].includes(promoStatus(p, on).key));

// Names for matching the same restaurant across posts: lower case, no spaces/punctuation/branch in brackets.
export function normName(name) {
  return String(name || '').toLowerCase()
    .replace(/[(（【\[].*?[)）】\]]/g, '')
    .replace(/(restaurant|cafe|café|kopitiam|餐厅|餐馆|饭店|茶餐室|cafe & bar)/g, '')
    .replace(/[\s·・.,，。'’"“”!！?？&@#\-_/|:：]/g, '');
}

export function sameRestaurant(a, b) {
  const x = normName(a.name);
  const y = normName(b.name);
  if (!x || !y) return false;
  const nameHit = x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)));
  if (!nameHit) return false;
  const d = km(a, b);
  return d == null || d < 2;
}

export const findDuplicate = (list, cand) => list.find((f) => f.id !== cand.id && sameRestaurant(f, cand)) || null;

const uniqBy = (arr, key) => {
  const seen = new Set();
  return arr.filter((x) => { const k = key(x); if (!k || seen.has(k)) return false; seen.add(k); return true; });
};

// Merge `b` into `a` (a wins on conflicts, b fills the gaps; lists are joined).
export function mergeFood(a, b) {
  const out = { ...a };
  if (!CUISINE_KEYS.includes(out.category) || out.category === 'other') out.category = CUISINE_KEYS.includes(b.category) ? b.category : out.category;
  for (const k of ['branch', 'cuisine', 'area', 'address', 'city', 'hours', 'phone', 'summary']) if (!out[k] && b[k]) out[k] = b[k];
  if (out.lat == null && b.lat != null) { out.lat = b.lat; out.lng = b.lng; out.geo = b.geo; }
  const p = a.price || {};
  if (p.min == null && p.max == null && !p.text && b.price) out.price = b.price;
  out.dishes = uniqBy([...(a.dishes || []), ...(b.dishes || [])], (d) => normName(d.name));
  out.promos = uniqBy([...(a.promos || []), ...(b.promos || [])], (x) => normName(x.title) + (x.end || ''));
  out.tags = uniqBy([...(a.tags || []), ...(b.tags || [])], (t) => t);
  out.images = uniqBy([...(a.images || []), ...(b.images || [])], (i) => i);
  out.sources = uniqBy([...(a.sources || []), ...(b.sources || [])], (s) => s.url || s.at);
  out.notes = [a.notes, b.notes].filter(Boolean).join('\n');
  out.updated = Date.now();
  return out;
}

// Normalise what the AI sends back for one restaurant into a stored record shape.
export function foodFromAi(r, extra) {
  const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
  return {
    id: uid(),
    status: 'want',
    name: (r.name || '').trim() || '未命名餐厅',
    branch: r.branch || '',
    cuisine: r.cuisine || '',
    category: CUISINE_KEYS.includes(r.category) && r.category !== 'other' ? r.category : guessCuisine(r.cuisine, r.tags, r.name, (r.dishes || []).map((d) => d && d.name)),
    area: r.area || '',
    address: r.address || '',
    city: r.city || '',
    country: r.country || '',
    price: { currency: r.price && r.price.currency || '', min: num(r.price && r.price.min), max: num(r.price && r.price.max), per: r.price && r.price.per || '', text: r.price && r.price.text || '' },
    dishes: (r.dishes || []).filter((d) => d && d.name).map((d) => ({ name: d.name, price: d.price || '', note: d.note || '', star: !!d.must })),
    promos: (r.promos || []).filter((p) => p && (p.title || p.detail)).map((p) => ({ title: p.title || '', detail: p.detail || '', start: validDate(p.start) ? p.start : '', end: validDate(p.end) ? p.end : '', time: p.time || '' })),
    hours: r.hours || '',
    phone: r.phone || '',
    tags: (r.tags || []).filter(Boolean),
    summary: r.summary || '',
    lat: null, lng: null, geo: '',
    images: [], sources: [], notes: '', rating: 0,
    created: Date.now(), updated: Date.now(),
    ...(extra || {}),
  };
}

export function geoQueries(f) {
  const parts = (...xs) => xs.filter(Boolean).join(' ').trim();
  return uniqBy([
    parts(f.address),
    parts(f.name, f.branch, f.area, f.city),
    parts(f.name, f.city || f.country),
    parts(f.area, f.city),
  ], (x) => x);
}

// ---------- nails ----------

export const NAIL_COLORS = {
  nude: { label: '裸色/奶茶', hex: '#d9b8a0' }, white: { label: '白色/奶白', hex: '#f4efe9' }, pink: { label: '粉色', hex: '#f2a7b8' },
  red: { label: '红色/酒红', hex: '#b8323f' }, orange: { label: '橘/珊瑚', hex: '#f08a5d' }, yellow: { label: '黄色', hex: '#f3d36b' },
  green: { label: '绿色', hex: '#86b38a' }, blue: { label: '蓝色', hex: '#7da2d6' }, purple: { label: '紫色', hex: '#ad8fd0' },
  brown: { label: '棕/焦糖', hex: '#8a5a3c' }, black: { label: '黑色', hex: '#2b2626' }, grey: { label: '灰色', hex: '#a3a3aa' },
  silver: { label: '银/镜面', hex: '#c9ccd3' }, gold: { label: '金色', hex: '#d4af5a' }, multi: { label: '多色/撞色', hex: 'linear-gradient(135deg,#f2a7b8,#7da2d6,#f3d36b)' },
  clear: { label: '透明/裸感', hex: '#efe6e1' },
};
export const NAIL_STYLES = ['纯色', '法式', '猫眼', '渐变/晕染', '腮红', '手绘', '花朵', '亮片/闪粉', '贴钻/饰品', '镜面/极光', '大理石/石纹', '格纹/波点', '卡通/可爱', '立体/浮雕', '磨砂', '珍珠/贝壳', '线条/几何', '豹纹/动物纹', '节日'];
export const NAIL_SHAPES = ['方形', '方圆', '椭圆', '圆形', '杏仁', '尖形', '芭蕾/梯形'];
export const NAIL_LENGTHS = ['短', '中', '长'];
export const NAIL_VIBES = ['温柔', '日常通勤', '高级感', '显白', '甜美', '甜酷', '可爱', '复古', '清冷', '活泼', '仙女', '酷/个性', '婚礼/约会'];
export const SEASONS = ['春', '夏', '秋', '冬'];

export function nailFromAi(r, imageId) {
  const pick = (v, list) => (list.includes(v) ? v : '');
  return {
    id: uid(), image: imageId,
    title: r.title || '',
    color: NAIL_COLORS[r.color_family] ? r.color_family : '',
    colors: (r.colors || []).filter((c) => c && /^#[0-9a-f]{6}$/i.test(c.hex)).slice(0, 4),
    styles: (r.styles || []).filter((s) => NAIL_STYLES.includes(s)),
    shape: pick(r.shape, NAIL_SHAPES),
    length: pick(r.length, NAIL_LENGTHS),
    vibes: (r.vibes || []).filter((s) => NAIL_VIBES.includes(s)),
    seasons: (r.seasons || []).filter((s) => SEASONS.includes(s)),
    note: r.note || '', fav: false, done: false, sources: [],
    created: Date.now(), updated: Date.now(), ai: true,
  };
}

// ---------- AI edit prompts ----------

export function parseSrt(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\n+/).map((block) => {
    const lines = block.split('\n').filter(Boolean);
    const t = lines.find((l) => /-->/.test(l));
    if (!t) return null;
    const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    const sec = m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
    const words = lines.slice(lines.indexOf(t) + 1).join(' ').trim();
    return words ? { t: sec, text: words } : null;
  }).filter(Boolean);
}

export const srtPlain = (text) => parseSrt(text).map((x) => `[${Math.floor(x.t / 60)}:${pad(x.t % 60)}] ${x.text}`).join('\n');

// Times to sample from a video: n frames spread over the clip, skipping the very first/last fraction of a second.
export function frameTimes(duration, n) {
  if (!(duration > 0)) return [0];
  const count = Math.max(1, Math.min(n, Math.ceil(duration / 0.6)));
  const start = Math.min(0.15, duration / 10);
  const end = Math.max(start, duration - Math.min(0.25, duration / 10));
  if (count === 1) return [Math.min(duration / 2, end)];
  return Array.from({ length: count }, (_, i) => +(start + ((end - start) * i) / (count - 1)).toFixed(2));
}

// AI boxes are 0–1000 on each axis; turn into a fraction box, or null for "the whole picture".
export function normBox(b) {
  if (!b) return null;
  let [x0, y0, x1, y1] = [b.x0, b.y0, b.x1, b.y1].map((v) => Math.max(0, Math.min(1000, Number(v) || 0)));
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 - x0 < 40 || y1 - y0 < 40) return null;
  if (x0 <= 15 && y0 <= 15 && x1 >= 985 && y1 >= 985) return null;
  return { x: x0 / 1000, y: y0 / 1000, w: (x1 - x0) / 1000, h: (y1 - y0) / 1000 };
}

export const EDIT_TOOLS = ['ChatGPT', 'Gemini', '即梦', '豆包', '醒图', '美图秀秀', 'Midjourney', 'Lightroom', 'Photoshop', 'Meitu', 'Picsart', 'Snapseed', 'Canva', '可灵', '其他'];

export function normalizeTool(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  const hit = EDIT_TOOLS.find((x) => x.toLowerCase() === s.toLowerCase() || s.toLowerCase().includes(x.toLowerCase()));
  if (hit) return hit;
  if (/gpt|openai|4o/i.test(s)) return 'ChatGPT';
  if (/nano.?banana|gemini/i.test(s)) return 'Gemini';
  if (/dreamina|jimeng/i.test(s)) return '即梦';
  if (/doubao/i.test(s)) return '豆包';
  if (/xingtu|hypic/i.test(s)) return '醒图';
  return s.slice(0, 16);
}

// ---------- misc ----------

export function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  return n < 1e6 ? `${Math.round(n / 1e3)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

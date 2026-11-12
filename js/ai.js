// Recognition. Two providers, both called straight from the phone with the user's own key:
//   gemini (default): Google Gemini API free tier, plain REST generateContent (no SDK: less to go wrong on the phone)
//   claude (optional, paid): Anthropic API, through the official Anthropic SDK (web/vendor/anthropic.mjs, loaded when first used)
import { CFG } from './config.js';
import { today, CUISINES, NAIL_COLORS, NAIL_STYLES, NAIL_SHAPES, NAIL_LENGTHS, NAIL_VIBES, SEASONS } from './logic.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini（免费）',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza...',
    // Tiers, not fixed model names: the newest model of the tier that this key can use is looked up from Google's list.
    models: {
      flash: { label: 'Gemini Flash（最准，默认）', note: '免费；每天有次数上限，用完会自动换 Flash-Lite' },
      'flash-lite': { label: 'Gemini Flash-Lite（更快）', note: '免费；次数上限更宽松，密密麻麻的截图可能漏字' },
    },
    fallback: 'flash-lite',
  },
  claude: {
    label: 'Claude（付费，可选）',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-...',
    models: {
      'claude-opus-5-5': { label: 'Claude Opus 5.5', note: '每次识别大约 US$0.03–0.15（看图片数量）' },
      'claude-haiku-5-5': { label: 'Claude Haiku 5.5（便宜很多）', note: '每次识别大约 US$0.002–0.01' },
    },
  },
};
export const DEFAULT_PROVIDER = 'gemini';
export const defaultModel = (p) => Object.keys(PROVIDERS[p].models)[0];
export const VIDEO_INLINE_MAX = 11 * 1024 * 1024; // Gemini: the whole request must stay under 20 MB
// Settings saved by the first version named exact models.
const OLD_GEMINI = { 'gemini-3.8-flash': 'flash', 'gemini-3.5-flash-lite': 'flash-lite' };
export const modelSetting = (p, m) => (p === 'gemini' && OLD_GEMINI[m] ? OLD_GEMINI[m] : m);

// settings = {provider, keys: {gemini, claude}, models: {gemini, claude}}
let settings = { provider: DEFAULT_PROVIDER, keys: {}, models: {} };
let lastNote = '';
export function configure(s) {
  settings = { ...settings, ...s, keys: { ...settings.keys, ...(s.keys || {}) }, models: { ...settings.models, ...(s.models || {}) } };
}
export const provider = () => (PROVIDERS[settings.provider] ? settings.provider : DEFAULT_PROVIDER);
export const ready = () => !!settings.keys[provider()];
export const takeNote = () => { const n = lastNote; lastNote = ''; return n; }; // e.g. "used Flash-Lite because the free quota ran out"
const modelOf = (p) => { const m = modelSetting(p, settings.models[p]); return PROVIDERS[p].models[m] ? m : defaultModel(p); };

// ---------- Gemini (REST) ----------

const geminiBase = () => `${CFG.geminiBase || 'https://generativelanguage.googleapis.com'}/v1beta`;

class GeminiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function geminiFetch(key, path, body) {
  let res;
  try {
    res = await fetch(`${geminiBase()}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GeminiError(0, 'NETWORK', String((e && e.message) || e));
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok) {
    const er = (data && data.error) || {};
    throw new GeminiError(res.status, er.status || '', er.message || text.slice(0, 200) || `HTTP ${res.status}`);
  }
  return data || {};
}

function geminiError(err) {
  const status = (err && err.status) || 0;
  const code = (err && err.code) || '';
  const msg = String((err && err.message) || err);
  if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(msg) || status === 401) return { text: 'Gemini API key 不对，请到「设置」重新填写（要整串复制，开头是 AIza）' };
  if (/location is not supported/i.test(msg)) return { text: '你所在的地区不能用 Gemini 免费版（Google 的限制）' };
  if (status === 403 || code === 'PERMISSION_DENIED') return { text: `这个 Gemini key 没有权限：${msg.slice(0, 120)}` };
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return { text: '今天的免费次数用完了，或请求太频繁；稍等一下或明天再试', quota: true };
  if (status === 404 || code === 'NOT_FOUND') return { text: `找不到这个模型：${msg.slice(0, 120)}`, missing: true };
  if (status === 400 && /schema|response_?json|enum|anyOf/i.test(msg)) return { text: msg.slice(0, 160), schema: true };
  if (status >= 500) return { text: `Gemini 暂时出错了（${status}），稍后再试`, retry: true };
  if (code === 'NETWORK') return { text: `连不上 Gemini，请检查网络（${msg.slice(0, 60)}）` };
  return { text: `Gemini 出错了（${status || '?'}）：${msg.slice(0, 160)}` };
}

// Newest model of each tier that this key may call, from Google's own list (cached for the session).
const TIER_RE = { flash: /^gemini-(\d+(?:\.\d+)?)-flash$/, 'flash-lite': /^gemini-(\d+(?:\.\d+)?)-flash-lite$/ };
const TIER_ALIAS = { flash: 'gemini-flash-latest', 'flash-lite': 'gemini-flash-lite-latest' };
const resolved = new Map(); // key -> Promise<{flash, 'flash-lite'}>
export function pickModels(names) {
  const out = {};
  for (const [tier, re] of Object.entries(TIER_RE)) {
    const best = names.map((n) => { const m = n.match(re); return m ? { n, v: parseFloat(m[1]) } : null; }).filter(Boolean).sort((a, b) => b.v - a.v)[0];
    out[tier] = best ? best.n : names.includes(TIER_ALIAS[tier]) ? TIER_ALIAS[tier] : '';
  }
  if (!out.flash) out.flash = out['flash-lite'] || TIER_ALIAS.flash;
  if (!out['flash-lite']) out['flash-lite'] = out.flash;
  return out;
}
function geminiModels(key) {
  if (!resolved.has(key)) {
    resolved.set(key, (async () => {
      try {
        const data = await geminiFetch(key, 'models?pageSize=1000');
        const names = (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
        return pickModels(names);
      } catch (e) {
        resolved.delete(key);
        if (e.status === 400 || e.status === 401 || e.status === 403) throw e; // bad key: say so
        return { ...TIER_ALIAS };
      }
    })());
  }
  return resolved.get(key);
}

// Our content blocks (Claude's shape, plus our own {type:'video'}) -> Gemini parts.
function geminiParts(content) {
  return content.map((c) => {
    if (c.type === 'text') return { text: c.text };
    if (c.type === 'image' || c.type === 'video') return { inlineData: { mimeType: c.source.media_type, data: c.source.data } };
    return null;
  }).filter(Boolean);
}

// Gemini takes a JSON Schema subset; drop the keywords it doesn't need.
function geminiSchema(x) {
  if (Array.isArray(x)) return x.map(geminiSchema);
  if (!x || typeof x !== 'object') return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) if (k !== 'additionalProperties') out[k] = geminiSchema(v);
  return out;
}

async function geminiCall(key, model, { system, content, schema }, withSchema) {
  const generationConfig = { responseMimeType: 'application/json' };
  if (withSchema) generationConfig.responseJsonSchema = geminiSchema(schema);
  // If Google rejects the schema, describe it in words instead.
  const sys = withSchema ? system : `${system}\n\n只输出一个 JSON 对象，结构严格按照这个 JSON Schema：\n${JSON.stringify(geminiSchema(schema))}`;
  const data = await geminiFetch(key, `models/${encodeURIComponent(model)}:generateContent`, {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: geminiParts(content) }],
    generationConfig,
  });
  const cand = (data.candidates || [])[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(why ? `Gemini 拒绝识别这些图片（${why}），可以换几张试试` : 'Gemini 没有返回内容，请再试一次');
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('内容太多，识别被截断了；请少选几张图再试');
  const text = ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error(cand.finishReason && cand.finishReason !== 'STOP' ? `Gemini 没有完成识别（${cand.finishReason}），可以换几张图试试` : 'Gemini 没有返回内容，请再试一次');
  return text;
}

async function askGemini(req) {
  const key = settings.keys.gemini;
  let tier = modelOf('gemini');
  let withSchema = true;
  let triedAlias = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const model = (await geminiModels(key))[tier];
      return await geminiCall(key, model, req, withSchema);
    } catch (err) {
      if (!(err instanceof GeminiError)) throw err;
      const e = geminiError(err);
      if (e.quota && tier !== PROVIDERS.gemini.fallback) { tier = PROVIDERS.gemini.fallback; lastNote = '今天 Flash 的免费次数用完了，这次用 Flash-Lite 识别'; continue; }
      if (e.schema && withSchema) { withSchema = false; continue; }
      if (e.missing && !triedAlias) { triedAlias = true; resolved.set(key, Promise.resolve({ ...TIER_ALIAS })); continue; }
      if (e.retry && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error(e.text);
    }
  }
  throw new Error('Gemini 一直没有回应，请稍后再试');
}

// ---------- Claude ----------

async function askClaude({ system, content, schema, effort }) {
  const { default: Anthropic, AuthenticationError, PermissionDeniedError, RateLimitError, APIConnectionError, BadRequestError, APIError } = await import('../vendor/anthropic.mjs');
  const friendly = (err) => {
    if (err instanceof AuthenticationError) return 'Claude API key 不对或已失效，请到「设置」重新填写';
    if (err instanceof PermissionDeniedError) return '这个 API key 没有权限使用该模型';
    if (err instanceof RateLimitError) return '请求太频繁或额度用完了，稍后再试（也请检查 Console 余额）';
    if (err instanceof APIConnectionError) return '连不上 Claude，请检查网络';
    if (err instanceof BadRequestError) return /credit|balance/i.test(err.message) ? 'Claude 账户余额不足，请到 console.anthropic.com 充值' : `请求被拒绝：${err.message}`;
    if (err instanceof APIError) return `Claude 出错了（${err.status || ''}），稍后再试`;
    return err && err.message ? err.message : String(err);
  };
  const model = modelOf('claude');
  const params = {
    model,
    max_tokens: 16000,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort: effort || 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: content.filter((c) => c.type !== 'video') }], // Claude reads pictures, not video files
  };
  // Opus: if a safety check declines, the API re-runs the request on Anthropic's recommended fallback model.
  if (/opus|sonnet|fable/.test(model)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  let res;
  try {
    res = await new Anthropic({ apiKey: settings.keys.claude, baseURL: CFG.aiBase, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 240000 }).beta.messages.create(params);
  } catch (err) {
    throw new Error(friendly(err));
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude 拒绝识别这张图片，可以换一张试试或手动填写');
  if (res.stop_reason === 'max_tokens') throw new Error('内容太多，识别被截断了；请少选几张图再试');
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// One structured request. content = array of content blocks. Returns the parsed JSON object.
export async function ask(req) {
  const p = provider();
  if (!settings.keys[p]) throw new Error(`还没有填写 ${p === 'gemini' ? 'Gemini' : 'Claude'} API key（设置 → AI 识别）`);
  const text = p === 'gemini' ? await askGemini(req) : await askClaude(req);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('AI 返回的内容看不懂，请再试一次');
  }
}

// Checks a key with a tiny request. Returns {error: '' when it works, otherwise a message; model: the model used}.
export async function testKey(p, key, model) {
  try {
    if (p === 'gemini') {
      resolved.delete(key);
      const tier = PROVIDERS.gemini.models[modelSetting(p, model)] ? modelSetting(p, model) : defaultModel('gemini');
      const name = (await geminiModels(key))[tier];
      await geminiFetch(key, `models/${encodeURIComponent(name)}:generateContent`, { contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }] });
      return { error: '', model: name };
    }
    const { default: Anthropic } = await import('../vendor/anthropic.mjs');
    await new Anthropic({ apiKey: key, baseURL: CFG.aiBase, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 30000 })
      .messages.create({ model: model || defaultModel('claude'), max_tokens: 16, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply OK' }] });
    return { error: '', model: model || defaultModel('claude') };
  } catch (err) {
    if (p === 'gemini') return { error: err instanceof GeminiError ? geminiError(err).text : String((err && err.message) || err).slice(0, 160) };
    return { error: /401|auth/i.test(String(err && (err.status || err.message))) ? 'Claude API key 不对或已失效' : String((err && err.message) || err).slice(0, 120) };
  }
}

// Whole videos (with sound) go to Gemini when small enough; Claude only gets the frames.
export async function videoParts(blobs) {
  if (provider() !== 'gemini') return [];
  const out = [];
  let total = 0;
  for (const b of blobs || []) {
    if (total + b.size > VIDEO_INLINE_MAX) continue;
    total += b.size;
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(b);
    });
    out.push({ type: 'video', source: { type: 'base64', media_type: b.type || 'video/mp4', data } });
  }
  return out;
}

// ---------- schemas ----------

const S = (type, extra) => ({ type, ...(extra || {}) });
const str = S('string');
const strs = S('array', { items: str });
const numOrNull = { anyOf: [S('number'), S('null')] };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const box = obj({ x0: S('integer'), y0: S('integer'), x1: S('integer'), y1: S('integer') });

const FOOD_SCHEMA = obj({
  post_title: str,
  restaurants: S('array', {
    items: obj({
      name: str, branch: str, category: S('string', { enum: CUISINES.map((c) => c.key) }), cuisine: str, area: str, address: str, city: str, country: str,
      price: obj({ currency: str, min: numOrNull, max: numOrNull, per: str, text: str }),
      dishes: S('array', { items: obj({ name: str, price: str, note: str, must: S('boolean') }) }),
      promos: S('array', { items: obj({ title: str, detail: str, start: str, end: str, time: str }) }),
      hours: str, phone: str, tags: strs, summary: str,
      images: S('array', { items: S('integer') }),
    }),
  }),
});

const NAIL_SCHEMA = obj({
  items: S('array', {
    items: obj({
      index: S('integer'), is_nail: S('boolean'), title: str,
      color_family: S('string', { enum: [...Object.keys(NAIL_COLORS), ''] }),
      colors: S('array', { items: obj({ name: str, hex: str }) }),
      styles: S('array', { items: S('string', { enum: NAIL_STYLES }) }),
      shape: S('string', { enum: [...NAIL_SHAPES, ''] }),
      length: S('string', { enum: [...NAIL_LENGTHS, ''] }),
      vibes: S('array', { items: S('string', { enum: NAIL_VIBES }) }),
      seasons: S('array', { items: S('string', { enum: SEASONS }) }),
      note: str,
    }),
  }),
});

const EDIT_SCHEMA = obj({
  tool: str,
  effects: S('array', {
    items: obj({
      title: str,
      prompts: S('array', { items: obj({ label: str, text: str }) }),
      before: obj({ image: S('integer'), box }),
      after: obj({ image: S('integer'), box }),
      steps: strs, tips: str, tags: strs,
    }),
  }),
});

// ---------- tasks ----------

function sourceText(src) {
  if (!src) return '';
  const lines = [];
  if (src.title) lines.push(`标题：${src.title}`);
  if (src.author) lines.push(`作者：${src.author}`);
  if (src.time) lines.push(`发布时间：${today(new Date(src.time))}`);
  if (src.place) lines.push(`笔记定位：${src.place}`);
  if (src.tags && src.tags.length) lines.push(`话题：${src.tags.join('、')}`);
  if (src.desc) lines.push(`正文：\n${src.desc}`);
  if (src.subtitles) lines.push(`视频字幕（语音）：\n${src.subtitles}`);
  return lines.join('\n');
}

const label = (i, extra) => ({ type: 'text', text: `【图片 ${i}${extra ? ' · ' + extra : ''}】` });
const addVideos = (content, videos, note) => { for (const v of videos || []) { content.push({ type: 'text', text: note }); content.push(v); } };

// videos = whole video blocks from videoParts() (Gemini only; may be empty)
export async function readFood(images, src, videos) {
  const content = [];
  images.forEach((im, i) => { content.push(label(i)); content.push(im); });
  addVideos(content, videos, '【完整视频（有声音），图片编号仍以上面的为准】');
  content.push({ type: 'text', text: `${sourceText(src) || '（只有截图，没有正文）'}\n\n今天是 ${today()}。请整理出里面推荐的餐厅/美食店。` });
  const system = `你帮用户把小红书 / Instagram 美食笔记（截图、正文、视频字幕，有时还有完整视频）整理成“想去吃的餐厅”清单。
规则：
- 每家店一条。店名用笔记里的原文（中英文/马来文都保留，如 "Restoran Wong Kee 黄记"），分店写在 branch。笔记里没有提到的就留空字符串，不要编造。
- category：菜系大类，只能选一个代码：${CUISINES.map((c) => `${c.key}=${c.label}`).join('，')}。按这家店最主要卖的东西选（韩式炸鸡店=korean，泰式奶茶店=dessert，港式茶餐厅=hk，马来西亚 mamak/nasi lemak=malay），实在看不出就 other。cuisine 写更细的原文描述（如“韩式烤肉”“川菜”“泰式船面”）。
- address 尽量完整（门牌、路名、区、城市、邮编）；area 是商场或地区名（如 Pavilion KL、SS15）；city、country 要写（能从语言、货币、地名推断时可以推断）。
- price：currency 用笔记里的符号（RM、$、¥、S$…），min/max 是人均或单价范围的数字，per 写“人均”或“一份”等，text 放原话。没有价格就 min、max 为 null。
- dishes：推荐的菜品/饮品，price 放原文价格，note 一句话说为什么推荐，must=true 表示博主强烈推荐/必点。
- promos：优惠活动、折扣、限时套餐、开幕优惠。start/end 用 YYYY-MM-DD（笔记写“到本月底”等相对日期时，用发布时间推算；推不出就留空），time 写适用时段（如“周一至周五 3-6pm”）。
- hours：营业时间原文；tags：菜系/特色（如 火锅、咖啡、早午餐、清真、宠物友好、适合拍照）；summary：一句中文概括这家店。
- images：哪些图片编号属于这家店（菜品、门面、菜单、环境照片）。纯文字封面或与店无关的图不要放。
- 如果整篇笔记都不是关于餐厅/美食，restaurants 返回空数组。`;
  return ask({ system, content, schema: FOOD_SCHEMA, effort: 'medium' });
}

export async function readNails(images, src) {
  const content = [];
  images.forEach((im, i) => { content.push(label(i)); content.push(im); });
  content.push({ type: 'text', text: `${sourceText(src)}\n请给每张图片分类（每张图一条，index 对应图片编号）。` });
  const system = `你是美甲款式整理助手。对每张图片：
- is_nail：图里是否主要是美甲款式（手/指甲）。不是美甲（比如价目表、店面）就 false，其余字段可以留空。
- title：6-12 个字的中文款式名，像小红书标题，如“奶油白猫眼法式”“冰透粉晕染短甲”。
- color_family：整体主色归类，只能选给定的英文代码之一；colors：1-4 个主要颜色，name 中文，hex 是 #RRGGBB。
- styles：所有符合的款式类型；shape：甲型；length：长度；vibes：风格感觉（1-3 个）；seasons：适合的季节（可多选）。
- note：一句话描述细节（如“无名指加了小珍珠”），方便给美甲师看。`;
  return ask({ system, content, schema: NAIL_SCHEMA, effort: 'low' });
}

// pics = [{part, note}] where note says e.g. "视频 0:12" for frames.
export async function readEdit(pics, src, videos) {
  const content = [];
  pics.forEach((p, i) => { content.push(label(i, p.note)); content.push(p.part); });
  addVideos(content, videos, '【完整视频（有声音），before/after 的图片编号仍以上面的截帧为准】');
  content.push({ type: 'text', text: `${sourceText(src) || '（没有正文）'}\n请找出 AI 修图/生图的口令（prompt）和前后效果图。` });
  const system = `你帮用户收藏 AI 修图 / AI 生图的“口令”（prompt）。材料可能是截图、笔记正文、视频截帧（带时间）、视频字幕，有时还有完整视频（请听里面说的话，口令常常是念出来的）。
- effects：每一个独立的口令+效果一条（一篇笔记分享了 5 个口令就返回 5 条）。
- prompts：口令原文，一字不改（保留原语言、标点、换行、英文大小写和参数如 --ar 3:4）。可以从图片里的文字、正文、字幕或视频语音中找到；如果口令被分成几段（比如“第一步”“第二步”），每段一条，label 写“第一步”等，否则 label 留空。不要自己编写或润色口令。
- before / after：原图（修图前）和效果图（修图后）分别是哪张图片编号（image）。box 是该效果图在那张图片里的位置，坐标 0-1000（x0,y0 左上角，x1,y1 右下角）；整张图就是 0,0,1000,1000。前后对比拼在同一张图里时，用 box 分别框出左右/上下两半。没有原图时 before.image = -1。对视频截帧，选最清楚、没被字幕或手指挡住的那一帧。
- tool：用的 App/模型（如 ChatGPT、Gemini、即梦、豆包、醒图、美图秀秀、Midjourney），看不出就留空。
- title：6-14 个字的中文名，说清楚效果（如“老照片修复上色”“胶片感人像”）。steps：操作步骤（简短，每步一句）；tips：注意事项；tags：效果类型（如 人像、风景、证件照、胶片、动漫、换背景、修复）。
- 如果材料里没有任何口令，effects 返回空数组。`;
  return ask({ system, content, schema: EDIT_SCHEMA, effort: 'medium' });
}

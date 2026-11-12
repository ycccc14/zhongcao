// Recognition. Two providers, both called straight from the phone with the user's own key:
//   gemini (default): Google Gemini API free tier, through Google's official Gen AI SDK (web/vendor/genai.mjs)
//   claude (optional, paid): Anthropic API, through the official Anthropic SDK (web/vendor/anthropic.mjs)
// The SDKs are loaded only when first used.
import { CFG } from './config.js';
import { today, CUISINES, NAIL_COLORS, NAIL_STYLES, NAIL_SHAPES, NAIL_LENGTHS, NAIL_VIBES, SEASONS } from './logic.js';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini（免费）',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza...',
    models: {
      'gemini-3.8-flash': { label: 'Gemini 3.8 Flash（最准，默认）', note: '免费；每天有次数上限，用完会自动换 Flash-Lite' },
      'gemini-3.5-flash-lite': { label: 'Gemini 3.5 Flash-Lite（更快）', note: '免费；次数上限更宽松，密密麻麻的截图可能漏字' },
    },
    fallback: 'gemini-3.5-flash-lite',
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

// settings = {provider, keys: {gemini, claude}, models: {gemini, claude}}
let settings = { provider: DEFAULT_PROVIDER, keys: {}, models: {} };
let lastNote = '';
export function configure(s) {
  settings = { ...settings, ...s, keys: { ...settings.keys, ...(s.keys || {}) }, models: { ...settings.models, ...(s.models || {}) } };
}
export const provider = () => (PROVIDERS[settings.provider] ? settings.provider : DEFAULT_PROVIDER);
export const ready = () => !!settings.keys[provider()];
export const takeNote = () => { const n = lastNote; lastNote = ''; return n; }; // e.g. "used Flash-Lite because the free quota ran out"
const modelOf = (p) => (PROVIDERS[p].models[settings.models[p]] ? settings.models[p] : defaultModel(p));

// ---------- Gemini ----------

async function geminiClient(key) {
  const { GoogleGenAI } = await import('../vendor/genai.mjs');
  return new GoogleGenAI({ apiKey: key, httpOptions: CFG.geminiBase ? { baseUrl: CFG.geminiBase } : undefined });
}

// Gemini takes a JSON Schema subset; drop the keywords it doesn't need.
function geminiSchema(x) {
  if (Array.isArray(x)) return x.map(geminiSchema);
  if (!x || typeof x !== 'object') return x;
  const out = {};
  for (const [k, v] of Object.entries(x)) if (k !== 'additionalProperties') out[k] = geminiSchema(v);
  return out;
}

// Our content blocks (Claude's shape, plus our own {type:'video'}) -> Gemini Interactions input.
function geminiInput(content) {
  return content.map((c) => {
    if (c.type === 'text') return { type: 'text', text: c.text };
    if (c.type === 'image') return { type: 'image', data: c.source.data, mime_type: c.source.media_type };
    if (c.type === 'video') return { type: 'video', data: c.source.data, mime_type: c.source.media_type };
    return null;
  }).filter(Boolean);
}

function geminiError(err) {
  const status = err && (err.status || err.code);
  const msg = String((err && err.message) || err);
  if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(msg) || status === 401) return { text: 'Gemini API key 不对，请到「设置」重新填写' };
  if (status === 403 || /PERMISSION_DENIED/.test(msg)) return { text: '这个 Gemini key 没有权限（可能所在地区不支持，或 key 被停用）' };
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return { text: '今天的免费次数用完了，或请求太频繁；稍等一下或明天再试', quota: true };
  if (status >= 500) return { text: `Gemini 暂时出错了（${status}），稍后再试`, retry: true };
  if (!status && /fetch|network/i.test(msg)) return { text: '连不上 Gemini，请检查网络' };
  return { text: `Gemini 出错了：${msg.slice(0, 120)}` };
}

async function askGemini({ system, content, schema, effort }) {
  const ai = await geminiClient(settings.keys.gemini);
  const params = (model) => ({
    model,
    input: geminiInput(content),
    system_instruction: system,
    response_format: { type: 'text', mime_type: 'application/json', schema: geminiSchema(schema) },
    generation_config: { thinking_level: effort === 'low' ? 'low' : 'medium' },
    store: false, // don't keep the conversation on Google's side
  });
  let model = modelOf('gemini');
  let res = null;
  for (let attempt = 0; attempt < 4 && !res; attempt++) {
    try {
      res = await ai.interactions.create(params(model));
    } catch (err) {
      const e = geminiError(err);
      if (e.quota && model !== PROVIDERS.gemini.fallback) { model = PROVIDERS.gemini.fallback; lastNote = '今天 Flash 的免费次数用完了，这次用 Flash-Lite 识别'; continue; }
      if (e.retry && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error(e.text);
    }
  }
  if (res.status && res.status !== 'completed') {
    throw new Error(res.status === 'incomplete' ? '内容太多，识别被截断了；请少选几张图再试' : `识别没有完成（${res.status}），请再试一次`);
  }
  return res.output_text || '';
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

// Checks a key with a tiny request. Returns '' when it works, otherwise a message.
export async function testKey(p, key, model) {
  try {
    if (p === 'gemini') {
      const ai = await geminiClient(key);
      await ai.interactions.create({ model: model || defaultModel('gemini'), input: 'Reply OK', generation_config: { thinking_level: 'minimal' }, store: false });
    } else {
      const { default: Anthropic } = await import('../vendor/anthropic.mjs');
      await new Anthropic({ apiKey: key, baseURL: CFG.aiBase, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 30000 })
        .messages.create({ model: model || defaultModel('claude'), max_tokens: 16, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply OK' }] });
    }
    return '';
  } catch (err) {
    if (p === 'gemini') return geminiError(err).text;
    return /401|auth/i.test(String(err && (err.status || err.message))) ? 'Claude API key 不对或已失效' : String((err && err.message) || err).slice(0, 120);
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

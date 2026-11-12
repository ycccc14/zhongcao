// The "add" sheet shared by all three pages: paste a link and/or choose screenshots/videos,
// then gather everything into pictures the AI can look at and the app can save at full size.
import * as net from './net.js';
import * as img from './img.js';
import { firstUrl, linkKind, SOURCE_LABEL, srtPlain } from './logic.js';
import { el, esc, $, openSheet, toast, pickFiles } from './ui.js';

const TEXT = {
  food: { title: '添加想吃的店', files: '选截图 / 照片', accept: 'image/*,video/*', manual: '手动添加' },
  nails: { title: '添加美甲款式', files: '选照片（可多选）', accept: 'image/*', manual: '' },
  edits: { title: '添加修图口令', files: '选截图或视频', accept: 'image/*,video/*', manual: '手动添加' },
};
const FRAMES = { food: 10, nails: 8, edits: 20 };
const MAX_LINK_IMAGES = 18;
const MAX_VIDEO = 80 * 1024 * 1024;

// Opens the sheet. onGo({text, files}) runs when the user taps start; onManual() for manual entry.
export function openImport(kind, onGo, onManual, preset) {
  const t = TEXT[kind];
  let files = [];
  openSheet(t.title, (box, sheet) => {
    box.innerHTML = `<div class="paste"><textarea rows="3" placeholder="粘贴小红书 / Instagram 的分享链接或整段分享文字">${esc(preset || '')}</textarea>
        <button class="btn small ghost" data-a="paste">粘贴</button></div>
      <div class="or">或者 / 同时</div>
      <button class="btn ghost wide" data-a="files">📷 ${t.files}</button>
      <div class="picked"></div>
      <button class="btn wide" data-a="go">✨ 开始识别</button>
      ${t.manual ? `<button class="link-btn" data-a="manual">${t.manual}</button>` : ''}`;
    const ta = $('textarea', box);
    const picked = $('.picked', box);
    const drawPicked = () => {
      picked.innerHTML = files.map((f, i) => {
        const u = URL.createObjectURL(f);
        return /^video/.test(f.type)
          ? `<div class="pk"><video src="${u}" muted playsinline></video><span class="tag">视频</span><button data-rm="${i}" aria-label="移除">✕</button></div>`
          : `<div class="pk"><img src="${u}" alt=""><button data-rm="${i}" aria-label="移除">✕</button></div>`;
      }).join('');
    };
    box.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { files.splice(+rm.dataset.rm, 1); drawPicked(); return; }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'paste') {
        try { ta.value = await navigator.clipboard.readText(); } catch (err) { toast('请长按输入框选择「粘贴」'); ta.focus(); }
      }
      if (a.dataset.a === 'files') { files = files.concat(await pickFiles(t.accept, true)); drawPicked(); }
      if (a.dataset.a === 'manual') { sheet.close(); onManual(); }
      if (a.dataset.a === 'go') {
        const text = ta.value.trim();
        if (!text && !files.length) { toast('请粘贴链接或选择图片'); return; }
        if (text && !firstUrl(text) && !files.length) { toast('没找到链接'); return; }
        sheet.close();
        onGo({ text, files: files.slice() });
      }
    };
  });
}

// Turns the inputs into {src, pics, videos}. pic = {part (for AI), note, save(box) -> image id, preview()}.
// step(text, detail) reports progress.
export async function gather(kind, { text, files }, step) {
  let src = null;
  const pics = [];
  const videos = [];
  const videoBlobs = []; // the video files themselves (Gemini can watch & listen to small ones)
  if (text && firstUrl(text)) {
    step(`正在读取${SOURCE_LABEL[linkKind(firstUrl(text))] || ''}链接…`);
    try {
      src = await net.readLink(text);
    } catch (e) {
      // Link unreadable (e.g. rednote asks for login): carry on with the screenshots, keep the link as the source.
      if (!files.length) throw e;
      toast(`${e.message.split('。')[0]}，这次只用截图识别`, 3500);
      src = { ok: true, kind: linkKind(firstUrl(text)), url: firstUrl(text), input: firstUrl(text), title: '', desc: '', tags: [], images: [], video: null, subtitles: '' };
    }
    if (src.subtitles) src.subtitles = srtPlain(src.subtitles).slice(0, 8000);
    const urls = (src.images || []).slice(0, MAX_LINK_IMAGES);
    for (let i = 0; i < urls.length; i++) {
      step('正在下载图片…', `${i + 1} / ${urls.length}`);
      try { pics.push(await fromBlob(await net.downloadImage(urls[i]), src.video ? '封面' : '')); } catch (e) { /* skip a broken picture */ }
    }
    if (src.video && src.video.url && src.video.size > MAX_VIDEO) {
      toast('视频太长，只用封面、正文和字幕识别', 3000);
    } else if (src.video && src.video.url) {
      try {
        step('正在下载视频…');
        const blob = await net.downloadVideo(src.video.url, (got, total) => step('正在下载视频…', total ? `${Math.round((got / total) * 100)}%` : `${(got / 1e6).toFixed(1)} MB`), MAX_VIDEO);
        videoBlobs.push(blob);
        await addVideo(blob, kind, pics, videos, step);
      } catch (e) {
        toast(e.message || '视频读取失败，只用封面和文字');
      }
    }
  }
  for (const f of files) {
    if (/^video/.test(f.type)) { step('正在读取视频…'); videoBlobs.push(f); await addVideo(f, kind, pics, videos, step); }
    else { step('正在读取图片…'); pics.push(await fromBlob(f, '')); }
  }
  if (!pics.length && !(src && (src.desc || src.title))) throw new Error('没有可识别的内容');
  return { src, pics, videos, videoBlobs };
}

async function fromBlob(blob, note) {
  const bm = await img.bitmap(blob);
  return {
    note,
    part: await img.forAi(bm),
    save: (box) => img.save(bm, box),
    previewUrl: URL.createObjectURL(blob),
  };
}

async function addVideo(blob, kind, pics, videos, step) {
  const v = await img.openVideo(blob);
  videos.push(v);
  const frames = await img.sampleFrames(v, FRAMES[kind], (i, n) => step('正在截取视频画面…', `${i} / ${n}`));
  for (const f of frames) {
    pics.push({
      note: `视频 ${Math.floor(f.t / 60)}:${String(Math.floor(f.t % 60)).padStart(2, '0')}`,
      part: f.part,
      save: (box) => img.saveFrame(v, f.t, box),
      previewUrl: `data:image/jpeg;base64,${f.part.source.data}`,
    });
  }
}

export function release(g) {
  if (!g) return;
  for (const v of g.videos || []) img.closeVideo(v);
  for (const p of g.pics || []) if (p.previewUrl && p.previewUrl.startsWith('blob:')) URL.revokeObjectURL(p.previewUrl);
}

export function sourceOf(g, kind) {
  if (g.src) return { kind: g.src.kind, url: g.src.url || g.src.input, title: g.src.title || '', author: g.src.author || '', at: Date.now() };
  return { kind, url: '', title: '', at: Date.now() };
}

// A row of selectable thumbnails (used by review screens). Returns element with .value (selected indexes).
export function picPicker(pics, selected) {
  const sel = new Set(selected || []);
  const box = el(`<div class="pic-pick">${pics.map((p, i) => `<button type="button" class="pp ${sel.has(i) ? 'on' : ''}" data-i="${i}"><img src="${p.previewUrl}" alt=""><span>✓</span></button>`).join('')}</div>`);
  box.onclick = (e) => {
    const b = e.target.closest('.pp');
    if (!b) return;
    const i = +b.dataset.i;
    if (sel.has(i)) sel.delete(i); else sel.add(i);
    b.classList.toggle('on', sel.has(i));
  };
  Object.defineProperty(box, 'value', { get: () => [...sel].sort((a, b) => a - b) });
  return box;
}

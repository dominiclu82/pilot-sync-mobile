// 一次性腳本：抓 Google News RSS（TW + World）→ 取出前 10 條（同來源最多 2 條）
// 產出為 JSON 結構 news_tw / news_world，插回 data/morning/YYYY-MM-DD.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'morning', '2026-04-11.json');

function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const getTag = (tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
      const mm = re.exec(block);
      if (!mm) return '';
      let v = mm[1].trim();
      v = v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1');
      return v.trim();
    };
    const rawTitle = getTag('title').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    let link = getTag('link');
    const pubDate = getTag('pubDate');
    const source = getTag('source');
    // Google News 標題尾巴是 " - 來源名"，去掉
    const cleanTitle = rawTitle.replace(/\s*[-–—]\s*[^-–—]+$/, '').trim();
    if (cleanTitle && link) items.push({ title: cleanTitle, url: link, source, pubDate });
  }
  return items;
}

async function translate(text) {
  if (!text) return '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map(seg => seg[0]).join('');
    }
    return '';
  } catch (e) {
    console.warn('translate failed:', e.message);
    return '';
  }
}

function fmtTime(pubDate) {
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    // 轉成台北時間 HH:MM
    const tpe = new Date(d.getTime() + 8 * 3600 * 1000 - d.getTimezoneOffset() * 60000);
    const hh = String(tpe.getHours()).padStart(2, '0');
    const mm = String(tpe.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch (e) { return ''; }
}

// 同來源最多 N 條、取前 limit 條
function dedupeBySource(items, limit, maxPerSource) {
  const count = {};
  const out = [];
  for (const it of items) {
    const src = it.source || 'unknown';
    if ((count[src] || 0) >= maxPerSource) continue;
    count[src] = (count[src] || 0) + 1;
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

async function main() {
  const twXml = fs.readFileSync('./tw-rss.xml', 'utf-8');
  const worldXml = fs.readFileSync('./world-rss.xml', 'utf-8');

  const twAll = parseRss(twXml);
  const worldAll = parseRss(worldXml);

  console.log(`TW raw: ${twAll.length}, World raw: ${worldAll.length}`);

  const twTop = dedupeBySource(twAll, 10, 2).map(it => ({
    title: it.title,
    url: it.url,
    source: it.source || '',
    time: fmtTime(it.pubDate),
  }));

  const worldPicked = dedupeBySource(worldAll, 10, 2);
  console.log('Translating world news titles...');
  const worldTop = [];
  for (const it of worldPicked) {
    const title_zh = await translate(it.title);
    worldTop.push({
      title: it.title,
      title_zh,
      url: it.url,
      source: it.source || '',
      time: fmtTime(it.pubDate),
    });
  }

  // 讀原 JSON 並合併
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  data.news_tw = twTop;
  data.news_world = worldTop;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Updated ${DATA_FILE}`);
  console.log(`TW picked: ${twTop.length}, World picked: ${worldTop.length}`);
  if (twTop[0]) console.log(`First TW: ${twTop[0].source} — ${twTop[0].title.slice(0,40)}`);
  if (worldTop[0]) console.log(`First World: ${worldTop[0].source} — ${worldTop[0].title.slice(0,40)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

// ── EUROCONTROL NOP Public Portal：歐洲網路事件(機場關閉/罷工/維修/軍事/容量) ──
// 公開 portal 是 GWT-RPC,要瀏覽器鑄的 cookie(role=ext_public_portal_pr)。
// 流程:GitHub Action 鑄 cookie → POST 給我們 → server 帶 cookie 重放 networkevent → 本檔解碼。
// 解碼器:GWT-RPC 回應是「反向串流 + 字串表」,小正整數=字串表索引(1-based),ArrayList=型別→長度→元素。
// (已用 status_map 圖例對答案驗證過格式)

const NOP_BASE = 'https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/PORTAL.29.0.0.1.121/gwt/MainPages/';
const NOP_PERM = '4BDC1927B945490FDBC82DC46DD5EC4E';
const NOP_INDEX = 'https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/index.html';
// networkevent getEventsForCalendar 的 body(日期 token 為攔到的當月範圍;事件多為當下/進行中,先沿用,日後再動態生)
const NOP_EVENT_BODY = '7|0|6|' + NOP_BASE + '|71E27F6F6CCB07C511A73684BF8E15C0|eurocontrol.cfmu.cua.portal.networkevent.main.NetworkEventMainService|getEventsForCalendar|eurocontrol.cfmu.common.iem.DateTimePeriod/573018426|Z|1|2|3|4|2|5|6|5|Z8a$bQA|0|1|0|Z6AeuwA|0|1|0|0|';

type Tok = { num?: string; str?: string };

// 解析 //OK[...] → token 陣列(數字 / 字串 / 巢狀字串表)
function parsePayload(raw: string): any[] {
  let s = raw.replace(/^\/\/OK/, '').trim();
  let i = 0;
  function parseArray(): any[] {
    const out: any[] = []; i++;
    while (i < s.length) {
      while (s[i] === ',' || s[i] === ' ') i++;
      if (s[i] === ']') { i++; break; }
      if (s[i] === '[') out.push(parseArray());
      else if (s[i] === '"') {
        let j = i + 1, str = '';
        while (j < s.length && s[j] !== '"') { if (s[j] === '\\') { str += s[j] + s[j + 1]; j += 2; } else { str += s[j]; j++; } }
        try { out.push({ str: JSON.parse('"' + str + '"') }); } catch { out.push({ str }); }
        i = j + 1;
      } else { let j = i; while (j < s.length && s[j] !== ',' && s[j] !== ']') j++; out.push({ num: s.slice(i, j) }); i = j; }
    }
    return out;
  }
  return parseArray();
}

// 解碼 networkevent → [{icaos, text}]。依 EventSummary 型別切段,每段抓 Aerodrome ICAO + 可讀描述。
export function decodeNetworkEvents(raw: string): { icaos: string[]; texts: string[] }[] {
  if (!raw || !raw.startsWith('//OK')) return [];
  const arr = parsePayload(raw);
  const tableIdx = arr.findIndex(x => Array.isArray(x));
  if (tableIdx < 0) return [];
  const table: string[] = (arr[tableIdx] as Tok[]).map(x => x.str !== undefined ? x.str! : x.num!);
  const values = arr.slice(0, tableIdx) as Tok[];
  const clsName = (s?: string) => (s && /\//.test(s) && /^[a-z]+\.[a-z]/.test(s)) ? s.split('/')[0].split('.').pop()! : null;
  const events: { icaos: string[]; texts: string[] }[] = [];
  let cur: { icaos: string[]; texts: string[] } | null = null;
  for (let p = values.length - 1; p >= 0; p--) {
    const t = values[p];
    if (t.str !== undefined) continue;            // long token,略過
    const n = Number(t.num);
    const ts = (n > 0 && n <= table.length) ? table[n - 1] : null;
    const cls = clsName(ts || undefined);
    if (cls === 'EventSummary') { cur = { icaos: [], texts: [] }; events.push(cur); continue; }
    if (cls) continue;
    if (ts && cur) {
      if (/^[A-Z]{4}$/.test(ts)) { if (!cur.icaos.includes(ts)) cur.icaos.push(ts); }
      else if (/[a-z]/.test(ts) && ts.length > 3 && !/^[A-Z]{2,3}$/.test(ts)) cur.texts.push(ts);
    }
  }
  return events.filter(e => e.icaos.length);
}

// 自癒「配方」:鑄造時從 live portal 抓的當下 URL/body/permutation。寫死的當 fallback。
// → EUROCONTROL 改版時,下次鑄造會抓到新版本號/hash,server 自動跟上,不用改 code。
export interface NopRecipe { cookie: string; url?: string; body?: string; permutation?: string }

// 帶配方重放 networkevent + 解碼。配方由鑄造端(GitHub Action)抓好餵進來。
export async function fetchNopNetworkEvents(recipe: NopRecipe): Promise<{ icaos: string[]; texts: string[] }[]> {
  if (!recipe || !recipe.cookie) return [];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  const url = recipe.url || (NOP_BASE + 'networkevent');
  const body = recipe.body || NOP_EVENT_BODY;
  const perm = recipe.permutation || NOP_PERM;
  const moduleBase = url.slice(0, url.lastIndexOf('/') + 1);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);   // NOP 卡住最多 6 秒就放掉,不拖垮 /api/atfm?region=all
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/x-gwt-rpc; charset=UTF-8', 'X-GWT-Permutation': perm,
        'X-GWT-Module-Base': moduleBase, 'Referer': NOP_INDEX, 'User-Agent': UA, 'Cookie': recipe.cookie
      },
      body, signal: ac.signal
    });
    const t = await r.text();
    if (!t.startsWith('//OK')) throw new Error('NOP ' + (t.startsWith('//EX') ? 'session expired' : 'HTTP ' + r.status));
    return decodeNetworkEvents(t);
  } finally { clearTimeout(timer); }
}

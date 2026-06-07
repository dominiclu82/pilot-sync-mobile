// 鑄 EUROCONTROL NOP「配方」(cookie + 當下 url/body/permutation)投遞給 server(/api/nop-refresh)。
// 自癒:每次都從 live portal 即時抓 url/body/permutation → EUROCONTROL 改版時自動跟上,server 不用改 code。
// 哪裡有 node+playwright 都能跑:GitHub Action / 樹莓派 cron / 本機。
// env:NOP_REFRESH_SECRET(必填)、NOP_SERVER(預設 crew-sync.onrender.com)
import { chromium } from 'playwright';

const SERVER = process.env.NOP_SERVER || 'https://crew-sync.onrender.com';
const SECRET = process.env.NOP_REFRESH_SECRET;
if (!SECRET) { console.error('缺 NOP_REFRESH_SECRET'); process.exit(1); }

const b = await chromium.launch();
try {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  // 攔 networkevent 的 POST → 抓當下 url / body / permutation(載入日曆視圖時會自動發)
  let live = null;
  p.on('request', req => {
    if (req.method() === 'POST' && /\/networkevent$/.test(req.url())) {
      live = { url: req.url(), body: req.postData() || '', permutation: req.headers()['x-gwt-permutation'] || '' };
    }
  });
  await p.goto('https://www.public.nm.eurocontrol.int/PUBPORTAL/gateway/spec/index.html',
    { waitUntil: 'networkidle', timeout: 60000 }).catch(() => { });
  await p.waitForTimeout(10000);
  const cookies = await ctx.cookies();
  const cookie = cookies.map(c => c.name + '=' + c.value).join('; ');
  const hasRole = /ext_public_portal_pr/.test(cookie);
  console.log('cookies:', cookies.length, '| role:', hasRole ? 'yes' : 'NO', '| recipe:', live ? 'live(抓到)' : 'NONE');
  // 鑄不完整(沒 role cookie 或沒抓到 live 配方)就別投遞 → 保留 server 上次的好配方,不要覆蓋成壞的
  if (!hasRole || !live) { console.error('鑄造不完整(role=' + hasRole + ' recipe=' + !!live + '),不投遞,保留上次配方'); process.exit(1); }
  const payload = { cookie, url: live.url, body: live.body, permutation: live.permutation };
  const r = await fetch(SERVER + '/api/nop-refresh?token=' + encodeURIComponent(SECRET),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  console.log('delivered:', r.status, await r.text());
  if (!r.ok) process.exit(1);
} finally { await b.close(); }

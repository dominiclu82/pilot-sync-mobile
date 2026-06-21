// 「今日 Today」App（今日 + 投資組合 兩分頁）共用更新日誌 — 單一來源。
// 今日(morning.ts) 與 投資組合(portfolio/frontend.ts) 的 About 都呼叫 renderAppChangelog() 顯示同一份。
//
// 規則：每版「一行」短摘要（中英各一句），標 [今日]/[投資]/[全域] 區分改到哪個分頁。
// 版號全部保留可追溯；冗長的工程細節不進使用者介面（git commit 有完整紀錄）。
// 新增版次：在陣列「最上面」加一條即可，兩個分頁自動同步。

// 社群連結（單一來源；三個 app 共用同一顆）。只顯示文字、網址藏在連結裡，點了直接開 LINE。
export const COMMUNITY_URL = 'https://line.me/ti/g2/ArAw4k1D9vXEAMtBsButFLzSFjXzEvFXfKHQ2A';
export function renderCommunityLink(): string {
  return '<a href="' + COMMUNITY_URL + '" target="_blank" rel="noopener noreferrer" '
    + 'style="display:block;text-align:center;margin:0 0 12px;padding:10px 12px;background:#06C755;'
    + 'color:#fff;font-weight:700;font-size:.9em;border-radius:8px;text-decoration:none;letter-spacing:.3px">'
    + '💬 加入社群 · Money 回報區</a>';
}

export interface ChangelogEntry { v: string; zh: string; en: string; }

export const APP_CHANGELOG: ChangelogEntry[] = [
  { v: 'V2.0.20',
    zh: '[全域] 修正按鈕樣式。',
    en: '[All] Adjusted button styling.' },
  { v: 'V2.0.19',
    zh: '[全域] 日夜切換膠囊放大、跟 A+/A- 拉開一點，工具列高度不變。',
    en: '[All] Bigger day-night pill with a little more spacing from A+/A-; toolbar height unchanged.' },
  { v: 'V2.0.18',
    zh: '[全域] 日夜切換改成直立滑動膠囊（☀️上 / 🌙下，浮標停在目前模式）。',
    en: '[All] Day-night switch is now a vertical sliding pill (☀️ top / 🌙 bottom; slider rests on the current mode).' },
  { v: 'V2.0.17',
    zh: '[投資] 緊急修復：V2.0.16 錯誤訊息的換行字元害整頁程式載不進來（全用戶空白），已修好。',
    en: '[Portfolio] Hotfix: a stray newline in a V2.0.16 message broke the whole Portfolio page (blank for all users) — fixed.' },
  { v: 'V2.0.16',
    zh: '[投資] 儲存失敗時改跳「明確中文提示」（原本錯誤訊息被手機鍵盤蓋住、看起來像按了沒反應）；並加 15 秒逾時，避免請求卡住無聲無息。',
    en: '[Portfolio] Save failures now show a clear popup message (the error was hidden behind the phone keyboard, looking like "no response"); added a 15s timeout so a stuck request can no longer fail silently.' },
  { v: 'V2.0.15',
    zh: '[投資] 修正「編輯交易按儲存沒反應」——存檔流程的例外被靜默吞掉，現在會正常儲存；真有問題也會跳出明確錯誤而非沒反應。',
    en: '[Portfolio] Fixed "Save does nothing" when editing a transaction — the save flow no longer silently swallows errors; it now saves properly, and shows a clear message if anything fails.' },
  { v: 'V2.0.14',
    zh: '[全域] 離線可看上次內容了：抓不到資料（飛航模式／斷網）時，自動退回上次成功更新的那份並標示「OFFLINE」，不再只顯示「載入失敗」。',
    en: '[Global] Offline now shows your last content: when data cannot be fetched (airplane mode / no network) it falls back to the last successful update with an OFFLINE banner, instead of just "Load failed".' },
  { v: 'V2.0.13',
    zh: '[全域] 修正 iOS 離線：啟動頁改用可離線快取的標頭（原本 no-store 被 iPhone/iPad 拒存，導致飛航模式打不開）。',
    en: '[Global] iOS offline fix: the launch page now uses an offline-cacheable header (the old no-store was refused by iPhone/iPad, breaking airplane-mode launch).' },
  { v: 'V2.0.12',
    zh: '[投資] 加交易可只填「股數/價格/總額」其中兩格，第三格自動算（總額=股數×價格，不含手續費）；交易紀錄的編輯✏️/刪除🗑改成有外框上色的鈕，一眼看出能點。',
    en: '[Portfolio] Add-transaction lets you fill any two of shares / price / total and auto-computes the third (total = shares × price, excl. fee); the edit ✏️ / delete 🗑 buttons on transactions are now clearly tappable (outlined + colored).' },
  { v: 'V2.0.11',
    zh: '[全域] 修頂部：狀態列那塊補不透明底，從 Tools 入口/PWA（透明狀態列）捲動時，內容不再透到狀態列區。',
    en: '[Global] Top fix: an opaque strip now backs the status-bar area, so scrolling no longer bleeds content into it (Tools hub / translucent status bar).' },
  { v: 'V2.0.10',
    zh: '[全域] 版號移到右下角設定區（今日／投資兩頁統一）；從 Tools 入口進來時右下多一顆回 Tools 鈕（彩色四格）。',
    en: '[Global] Version moved to the bottom-right settings area (unified across Today/Portfolio); a Tools button appears bottom-right when launched from the Tools hub.' },
  { v: 'V2.0.08',
    zh: '[全域] 關於頁最上方加入社群連結（Money 回報區），點一下直接到 LINE。',
    en: '[Global] Added a community link at the top of About (Money 回報區) — tap to open LINE.' },
  { v: 'V2.0.07',
    zh: '[投資] 編輯賣出交易也防超賣；台股／美股快照先換成台幣再合計（修正混幣）。',
    en: '[Portfolio] Editing a sell now blocks overselling; daily snapshots convert US→TWD before totaling (mixed-currency fix).' },
  { v: 'V2.0.06',
    zh: '[今日] 天氣改由手機直接抓，解決一直「重抓失敗」(429)。 [投資] 持股可逐筆刪除。',
    en: '[Today] Weather refreshes directly from your device (fixes the 429 "refresh failed"). [Portfolio] Delete a holding’s transactions.' },
  { v: 'V2.0.05',
    zh: '[今日] 未實現損益標註講清楚（台股＋美股合計，美股換算台幣；數字未變）。',
    en: '[Today] Clarified the unrealized P&L caption (TW + US combined, US converted to TWD; figure unchanged).' },
  { v: 'V2.0.04',
    zh: '[全域] App 改名「晨報」→「今日 Today」。',
    en: '[Global] Renamed the app from “Morning” to “Today”.' },
  { v: 'V2.0.03',
    zh: '[今日] 不再保留每日歷史，只留最新一份（DB 瘦身）。',
    en: '[Today] Keeps only the latest report instead of daily history (DB slimming).' },
  { v: 'V2.0.01',
    zh: '[全域] 今日＋投資組合統一版號（共用 APP_VERSION）。',
    en: '[Global] Unified the version number across the Today + Portfolio tabs.' },
  { v: 'V1.x',
    zh: '[全域] 早期：今日（天氣／股市／匯率／新聞面板）與投資組合（買賣帳本／均價／持倉分析／PIN 保護）各自開發成形。',
    en: '[Global] Earlier: Today (weather/stocks/FX/news panel) and Portfolio (ledger/avg-cost/holdings views/PIN) were each built out.' },
];

/** 產生 About modal 用的更新日誌 HTML。最頂端帶社群連結，其下每版一行（最新色、其餘灰）。 */
export function renderAppChangelog(): string {
  return renderCommunityLink() + APP_CHANGELOG.map((e: ChangelogEntry, i: number): string => {
    const head = i === 0
      ? 'font-weight:700;margin-bottom:4px'
      : 'font-weight:700;margin-bottom:4px;color:var(--muted)';
    return '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">'
      + '<div style="' + head + '">' + e.v + '</div>'
      + '<div style="font-size:.82em;line-height:1.5;color:var(--muted)">' + e.zh
      + '<br><span style="opacity:.75">' + e.en + '</span></div>'
      + '</div>';
  }).join('');
}

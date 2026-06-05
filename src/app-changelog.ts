// 「今日 Today」App（今日 + 投資組合 兩分頁）共用更新日誌 — 單一來源。
// 今日(morning.ts) 與 投資組合(portfolio/frontend.ts) 的 About 都呼叫 renderAppChangelog() 顯示同一份。
//
// 規則：每版「一行」短摘要（中英各一句），標 [今日]/[投資]/[全域] 區分改到哪個分頁。
// 版號全部保留可追溯；冗長的工程細節不進使用者介面（git commit 有完整紀錄）。
// 新增版次：在陣列「最上面」加一條即可，兩個分頁自動同步。

export interface ChangelogEntry { v: string; zh: string; en: string; }

export const APP_CHANGELOG: ChangelogEntry[] = [
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

/** 產生 About modal 用的更新日誌 HTML。最新一條正常色、其餘灰色；只用 inline style + --border/--muted（兩分頁都有）。 */
export function renderAppChangelog(): string {
  return APP_CHANGELOG.map((e: ChangelogEntry, i: number): string => {
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

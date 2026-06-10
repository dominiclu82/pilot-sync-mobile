// 組員槽位「唯一定義來源」（V2.3 起）。routes / importers / 前端都引用這份，避免 slot 知識散落各檔（codex 計畫審查重點）。
// 設計取捨：沿用既有「物件 keyed by slot、值 {name,rank,eid}」模型擴充（不改成陣列），保留既有資料/標籤/程式碼全相容。
//   - 既有 6 槽（pic/crew2/crew3/crew4/cic/obs）原封不動 → 舊資料、舊自訂標籤、舊程式都不動。
//   - 飛航組增補：crew5/crew6（更多 Relief）、obs2（第 2 觀察員）。
//   - 客艙組新增：cabin1..cabin20（預設 "Cabin N"，可自訂標籤）。
export type CrewGroup = 'flight' | 'cabin';
export interface CrewSlotDef { slot: string; group: CrewGroup; label: string; }

export const CREW_SLOTS: CrewSlotDef[] = [
  // ── 飛航組員 ──（既有 6 槽 key 不可改；預設標籤給更有意義的值，使用者自訂仍覆蓋）
  { slot: 'pic', group: 'flight', label: 'PIC' },
  { slot: 'crew2', group: 'flight', label: 'SIC' },
  { slot: 'crew3', group: 'flight', label: 'Relief 1' },
  { slot: 'crew4', group: 'flight', label: 'Relief 2' },
  { slot: 'crew5', group: 'flight', label: 'Relief 3' },
  { slot: 'crew6', group: 'flight', label: 'Relief 4' },
  { slot: 'cic', group: 'flight', label: 'CIC' },
  { slot: 'obs', group: 'flight', label: 'Observer' },
  { slot: 'obs2', group: 'flight', label: 'Observer 2' },
  // ── 客艙組員 ──（cabin1..cabin20）
  ...Array.from({ length: 20 }, (_, i): CrewSlotDef => ({ slot: 'cabin' + (i + 1), group: 'cabin', label: 'Cabin ' + (i + 1) })),
];

export const CREW_SLOT_IDS: string[] = CREW_SLOTS.map((s) => s.slot);
export const CREW_DEFAULT_LABELS: Record<string, string> = Object.fromEntries(CREW_SLOTS.map((s) => [s.slot, s.label]));
export const CREW_CABIN_SLOTS: string[] = CREW_SLOTS.filter((s) => s.group === 'cabin').map((s) => s.slot);
export const CREW_FLIGHT_SLOTS: string[] = CREW_SLOTS.filter((s) => s.group === 'flight').map((s) => s.slot);
// 顯示模式：cic_only=只顯示在隊機長 / flight=只飛航組 / all=全部
export type CrewDisplayMode = 'cic_only' | 'flight' | 'all';
export const CREW_DISPLAY_MODES: CrewDisplayMode[] = ['cic_only', 'flight', 'all'];

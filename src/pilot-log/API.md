# Pilot Log REST API Contract

> 路徑前綴：`/api/pilot-log`
> 認證：除 `auth/*` 與 `config` 外，全部需要 `Authorization: Bearer <accessToken>` header
> 內容類型：JSON（除非另註明）

此文件供未來 native app（iOS / Android）開發直接參照。所有 endpoint 均為 stateless REST，不依賴 cookie 或 web-only 機制。

---

## Auth

### `POST /api/pilot-log/auth/login`

Google Sign-In ID token 換 access + refresh token。

**Body:**
```json
{ "idToken": "<Google ID token>" }
```

**200 Response:**
```json
{
  "accessToken": "<JWT>",
  "refreshToken": "<UUID>",
  "user": { "id": "<UUID>", "primaryEmail": "user@example.com", "createdAt": "..." }
}
```

- `accessToken` 壽命：1 小時
- `refreshToken` 壽命：90 天
- `accessToken` 為自簽 JWT（HMAC SHA256），payload `{ sub: userId, exp }`

**錯誤：** 400 `missing_id_token` / 401 `login_failed`

---

### `POST /api/pilot-log/auth/refresh`

Refresh token 輪轉換新 token pair。

**Body:**
```json
{ "refreshToken": "<UUID>" }
```

**200 Response:** 同 login。

⚠️ 舊 refresh token rotation 後立即作廢。前端必須做 in-flight singleton 保護，避免並發 refresh 撞 race（V1.0.07 修法）。

**錯誤：** 400 `missing_refresh_token` / 401 `invalid_refresh_token`

---

### `POST /api/pilot-log/auth/logout`

撤銷 refresh token。

**Body:**
```json
{ "refreshToken": "<UUID>" }
```

**200 Response:** `{}`（或空）。即使 token 已失效也回 200（idempotent）。

---

### `GET /api/pilot-log/config`

無 auth。回傳前端需要的非機密設定。

**200 Response:**
```json
{ "google_client_id": "..." }
```

---

## Account

### `GET /api/pilot-log/me`

取得當前使用者資料。

**200 Response:**
```json
{
  "user": { "id": "<UUID>", "created_at": "...", "last_login_at": "..." },
  "emails": [{ "email": "user@example.com", "is_primary": true }]
}
```

**錯誤：** 503 `database_unavailable` / 404 `user_not_found`

---

### `DELETE /api/pilot-log/account`

**Apple App Store 5.1.1(v) compliance** — 永久刪除帳號跟全部相關資料。

CASCADE 會清掉：
- `pilot_user_emails`（全部 email mapping）
- `pilot_user_sessions`（全部 session、含 refresh tokens）
- `pilot_log_entries`（全部飛行記錄）
- `pilot_aircraft`（全部機尾資料）

**不可復原**。前端應做雙段 confirm 才呼叫。

**204 Response:** 無 body（成功）。

**錯誤：** 503 `database_unavailable` / 404 `user_not_found` / 500 `delete_failed`

---

## Entries（飛行記錄）

### `GET /api/pilot-log/entries`

列出當前使用者的 entries。

**Query params:**
- `status` (optional): `draft` / `confirmed` / `roster_removed`
- `from` (optional): `YYYY-MM-DD`
- `to` (optional): `YYYY-MM-DD`
- `limit` (optional): default 100, max 500
- `offset` (optional): default 0

**200 Response:**
```json
{ "entries": [ { /* entry object */ } ], "total": 123 }
```

---

### `GET /api/pilot-log/entries/:id`

取得單筆 entry。

**200 Response:** `{ "entry": { ... } }`
**404:** `not_found`

---

### `POST /api/pilot-log/entries`

新增手動 entry。

**Body:** entry object（schema 見 `pilot_log_entries` 表）。`source` 自動填 `manual`。
**201 Response:** `{ "entry": { ... with id } }`

---

### `PUT /api/pilot-log/entries/:id`

修改 entry 或將 `draft` 確認為 `confirmed`。

**Body:** 部分欄位（PATCH 語意）。
**200 Response:** `{ "entry": { ... } }`

---

### `DELETE /api/pilot-log/entries/:id`

刪除單筆 entry。

**204 Response:** 無 body。

---

### `DELETE /api/pilot-log/entries?source=logten&confirm=true`

**批次刪除救援（V1.0.03+）** — 砍掉當前 user 所有 LogTen 來源 entries。

⚠️ 必須帶 `source=logten` AND `confirm=true`，缺一就 reject。
不影響 `manual` / `roster` 來源、不影響 `pilot_aircraft`。

**200 Response:** `{ "deleted": <count> }`

---

## Import

### `POST /api/pilot-log/import/logten-flights`

匯入 LogTen Pro 6 的 Dynamic Flights Tab export。

**Content-Type:** `text/plain`（body 為 TSV 文字，UTF-8）
**Query params:**
- `dryRun=true`（optional）：只預覽不寫入 DB

**200 Response:**
```json
{
  "inserted": 10,
  "updated": 2,
  "duplicate_skipped": 5,
  "parse_errors": 0,
  "preview": [ /* per-row diff */ ],
  "dry_run": false
}
```

**錯誤回應：**
- `empty_or_invalid_file`
- `missing_required_columns:Date,Flight #,From,...`
- `bad_date_in_N_row(s)`（含 `bad_rows` 陣列）

Smart re-import 行為：`confirmed` 不覆蓋（保護使用者編輯），`draft` / `roster_removed` 整筆覆蓋。

---

### `POST /api/pilot-log/import/logten-aircraft`

匯入 LogTen Aircraft（tail number registry）。

**Content-Type:** `text/plain`
**200 Response:** `{ "inserted": N, "updated": M, "parse_errors": K }`

---

### `POST /api/pilot-log/import/logten-addressbook` (V1.0.09)

匯入 LogTen Address Book（crew name 名單）。

**Content-Type:** `text/plain`（TSV，UTF-8）

**Required headers:** `Name`, `ID`, `This is Me`（其他欄位 optional）

**識別邏輯：**
- 主鍵為 `employee_id`（從 `ID` 欄解析、`/` split、trim、去空白、去重複）
- `display_name` 只當 fallback：當 row **完全沒 ID** 時，才用名字弱比對「也都沒 ID 的 crew」
- **Conflict 規則**（不自動合併、列在 `conflicts`、row 不寫入）：
  - 同一 row 的多個 ID 命中**多個既有 crew**
  - 沒 ID 的 row 用名字弱比對命中**多筆「也沒 ID 的 crew」**
- `is_self`：只有當檔案有明確的 `This is Me=1` 才更新；流程是 clear-then-set，包單一 TX
- **寫入保證**：每 row 自己 BEGIN/COMMIT，失敗整 row ROLLBACK，不留半套 crew + 部分 alias

**200 Response:**
```json
{
  "inserted": 50,
  "updated": 10,
  "conflicts": [
    { "row": 12, "name": "Allan Arguelles", "ids": ["A123", "B456"], "matched_crew_ids": ["uuid-1", "uuid-2"] }
  ],
  "parse_errors": 0,
  "bad_rows": [],
  "self_set": "Dominic Lu",
  "self_update_error": null
}
```

`self_update_error`（V1.0.09 補）：data import 全部成功了、但 `is_self` clear-then-set 那段獨立 TX 失敗時，把錯誤訊息帶到 caller，方便前端決定要不要提示「self 標記沒換掉、要不要重 import」。整批 import 不會因此整體 fail。

**錯誤回應：** `empty_or_invalid_file` / `missing_required_columns:Name,ID,This is Me`

---

## Aircraft

### `GET /api/pilot-log/aircraft`

當前 user 的機尾清單。

**200 Response:** `{ "aircraft": [{ "tail_no": "B-58502", "type_code": "A359", ... }] }`

---

### `POST /api/pilot-log/aircraft` (V1.0.10)

手動新增 / upsert 一筆機尾。Body 可空欄位，唯一必填 `tail_no`。

**Body:**
```json
{
  "tail_no": "B-58510",
  "type_code": "A359",
  "make": "AIRBUS INDUSTRIES",
  "model": "A-350-900",
  "operator": "Starlux",
  "notes": "新交機"
}
```

**Behavior:** `ON CONFLICT (user_id, tail_no) DO UPDATE` + COALESCE — 已存在的 tail 會用新值 merge，**空字串不會洗掉舊資料**。

**Response:**
- `201 Created`：新增成功 → `{ "aircraft": {...}, "inserted": true }`
- `200 OK`：原本就存在、被 upsert 更新 → `{ "aircraft": {...}, "inserted": false }`

**錯誤：** 400 `missing_tail_no` / 503 `database_unavailable` / 500 `create_failed`

---

## Stats

### `GET /api/pilot-log/stats`

當前 user 的時數統計（只算 `status = 'confirmed'`）。

**200 Response:**
```json
{
  "totals": {
    "total_minutes": 12345,
    "pic_minutes": 8000,
    "sic_minutes": 4000,
    "night_minutes": 2000,
    "entry_count": 800
  },
  "rolling": {
    "d7":  { "total_minutes": 600, "pic_minutes": ..., ... },
    "d28": { ... },
    "d90": { ... }
  },
  "by_type": [
    { "aircraft_type": "A359", "total_minutes": 2358, "entry_count": 271 }
  ]
}
```

---

### `GET /api/pilot-log/quick-suggest`

常用 tail / type / airport / crew（auto-complete 用）。

**200 Response:**
```json
{
  "tails": ["B-58502", ...],
  "types": ["A359", ...],
  "airports": ["RCTP", ...],
  "crew": ["Yoshi Terachi", ...]
}
```

---

## Admin（不走 user JWT）

### `GET /api/pilot-log/admin/stats?pw=<env PILOT_LOG_ADMIN_PW>&limit=10`

容量監控（共用 1 GB Postgres，必須能看成長）。Server-side admin secret，timing-safe compare。

**200 Response:**
```json
{
  "summary": {
    "total_users": ...,
    "active_7d": ...,
    "active_30d": ...,
    "with_entries": ...,
    "with_imports": ...,
    "entries_total": ...,
    "size_bytes": ...
  },
  "breakdown": {
    "tables": [{ "name": "pilot_log_entries", "total_size": ..., "relation_size": ..., "indexes_size": ..., "toast_size": ... }],
    "top_users": [{ "user_id": "...", "entry_count": ... }]
  }
}
```

60 秒 in-memory cache。

**錯誤：** 403（pw 缺 / pw 錯）

---

## 通用錯誤格式

所有錯誤回應都是：
```json
{ "error": "<error_code>" }
```

常見 code：
- `missing_token` / `invalid_or_expired_token`（401，認證問題）
- `database_unavailable`（503，DB 連不上）
- `user_not_found` / `entry_not_found`（404）
- `bad_request`（400，參數不對）

---

## Native client 注意事項

1. **Token 儲存**：iOS 用 Keychain、Android 用 EncryptedSharedPreferences；不要用 plain SharedPreferences / NSUserDefaults
2. **Refresh 並發保護**：必須做 singleton in-flight lock（同前端 V1.0.07 修法），否則並發 401 會把 user 登出
3. **Cert pinning**：可選，但建議
4. **背景刷新**：iOS Background Tasks / Android WorkManager
5. **Apple Sign In**：Phase 3 加，後端會新增 `POST /api/pilot-log/auth/apple` endpoint（目前未實作）

// Morning Report Builder — 整合所有資料源抓取
// 被 morning.ts 的 cron 和 refresh endpoint 呼叫

// ─── 預設清單（必須跟 morning.ts 前端的保持同步） ────────────────────
// 天氣抓全部 68 個預設地點（前端若手動加別的，前端自己呼叫 Open-Meteo）
const WX_LOCATIONS = [
  // 台灣城市
  { id: 'tw-taipei', name: '台北', lat: 25.03, lon: 121.56 },
  { id: 'tw-xinbei', name: '新北', lat: 24.98, lon: 121.54 },
  { id: 'tw-keelung', name: '基隆', lat: 25.13, lon: 121.74 },
  { id: 'tw-taoyuan', name: '桃園', lat: 24.99, lon: 121.31 },
  { id: 'tw-bade', name: '桃園八德', lat: 24.93, lon: 121.28 },
  { id: 'tw-guishan', name: '桃園龜山', lat: 25.04, lon: 121.35 },
  { id: 'tw-dayuan', name: '桃園大園', lat: 25.07, lon: 121.21 },
  { id: 'tw-hsinchu', name: '新竹', lat: 24.81, lon: 120.97 },
  { id: 'tw-zhubei', name: '新竹竹北', lat: 24.83, lon: 121.00 },
  { id: 'tw-miaoli', name: '苗栗', lat: 24.56, lon: 120.82 },
  { id: 'tw-taichung', name: '台中', lat: 24.14, lon: 120.68 },
  { id: 'tw-changhua', name: '彰化', lat: 24.08, lon: 120.54 },
  { id: 'tw-nantou', name: '南投', lat: 23.91, lon: 120.68 },
  { id: 'tw-yunlin', name: '雲林', lat: 23.71, lon: 120.54 },
  { id: 'tw-chiayi', name: '嘉義', lat: 23.48, lon: 120.45 },
  { id: 'tw-tainan', name: '台南', lat: 22.99, lon: 120.22 },
  { id: 'tw-kaohsiung', name: '高雄', lat: 22.63, lon: 120.30 },
  { id: 'tw-pingtung', name: '屏東', lat: 22.67, lon: 120.49 },
  { id: 'tw-yilan', name: '宜蘭', lat: 24.76, lon: 121.75 },
  { id: 'tw-hualien', name: '花蓮', lat: 23.98, lon: 121.61 },
  { id: 'tw-taitung', name: '台東', lat: 22.76, lon: 121.14 },
  { id: 'tw-penghu', name: '澎湖(馬公)', lat: 23.57, lon: 119.58 },
  { id: 'tw-kinmen', name: '金門', lat: 24.45, lon: 118.32 },
  { id: 'tw-matsu', name: '馬祖(南竿)', lat: 26.15, lon: 119.95 },
  // 台灣景點
  { id: 'at-sunmoon', name: '日月潭', lat: 23.86, lon: 120.91 },
  { id: 'at-alishan', name: '阿里山', lat: 23.51, lon: 120.80 },
  { id: 'at-yushan', name: '玉山', lat: 23.47, lon: 120.95 },
  { id: 'at-hehuan', name: '合歡山', lat: 24.14, lon: 121.27 },
  { id: 'at-yangmingshan', name: '陽明山', lat: 25.17, lon: 121.55 },
  { id: 'at-kenting', name: '墾丁', lat: 21.95, lon: 120.79 },
  { id: 'at-taroko', name: '太魯閣', lat: 24.15, lon: 121.49 },
  { id: 'at-jiufen', name: '九份', lat: 25.11, lon: 121.85 },
  { id: 'at-qingjing', name: '清境農場', lat: 24.05, lon: 121.17 },
  { id: 'at-wuling', name: '武陵農場', lat: 24.37, lon: 121.30 },
  { id: 'at-lalashan', name: '拉拉山', lat: 24.69, lon: 121.43 },
  { id: 'at-xitou', name: '溪頭', lat: 23.67, lon: 120.80 },
  { id: 'at-dasyueshan', name: '大雪山', lat: 24.26, lon: 121.00 },
  { id: 'at-aowanda', name: '奧萬大', lat: 24.03, lon: 121.18 },
  { id: 'at-fulong', name: '福隆', lat: 25.02, lon: 121.94 },
  { id: 'at-greenisland', name: '綠島', lat: 22.67, lon: 121.49 },
  { id: 'at-lanyu', name: '蘭嶼', lat: 22.05, lon: 121.55 },
  // 國際城市
  { id: 'in-tyo', name: '東京 TYO', lat: 35.68, lon: 139.69 },
  { id: 'in-osa', name: '大阪 OSA', lat: 34.69, lon: 135.50 },
  { id: 'in-spk', name: '札幌 SPK', lat: 43.06, lon: 141.35 },
  { id: 'in-fuk', name: '福岡 FUK', lat: 33.59, lon: 130.40 },
  { id: 'in-oki', name: '沖繩 OKA', lat: 26.21, lon: 127.68 },
  { id: 'in-sel', name: '首爾 SEL', lat: 37.57, lon: 126.98 },
  { id: 'in-pus', name: '釜山 PUS', lat: 35.18, lon: 129.08 },
  { id: 'in-bjs', name: '北京 BJS', lat: 39.90, lon: 116.41 },
  { id: 'in-sha', name: '上海 SHA', lat: 31.23, lon: 121.47 },
  { id: 'in-can', name: '廣州 CAN', lat: 23.13, lon: 113.26 },
  { id: 'in-hkg', name: '香港 HKG', lat: 22.32, lon: 114.17 },
  { id: 'in-mfm', name: '澳門 MFM', lat: 22.20, lon: 113.54 },
  { id: 'in-sin', name: '新加坡 SIN', lat: 1.35, lon: 103.82 },
  { id: 'in-bkk', name: '曼谷 BKK', lat: 13.75, lon: 100.50 },
  { id: 'in-kul', name: '吉隆坡 KUL', lat: 3.14, lon: 101.69 },
  { id: 'in-han', name: '河內 HAN', lat: 21.03, lon: 105.83 },
  { id: 'in-sgn', name: '胡志明 SGN', lat: 10.82, lon: 106.63 },
  { id: 'in-mnl', name: '馬尼拉 MNL', lat: 14.60, lon: 120.98 },
  { id: 'in-dps', name: '峇里島 DPS', lat: -8.65, lon: 115.22 },
  { id: 'in-syd', name: '雪梨 SYD', lat: -33.87, lon: 151.21 },
  { id: 'in-mel', name: '墨爾本 MEL', lat: -37.81, lon: 144.96 },
  { id: 'in-lax', name: '洛杉磯 LAX', lat: 34.05, lon: -118.24 },
  { id: 'in-sfo', name: '舊金山 SFO', lat: 37.77, lon: -122.42 },
  { id: 'in-sea', name: '西雅圖 SEA', lat: 47.60, lon: -122.33 },
  { id: 'in-nyc', name: '紐約 NYC', lat: 40.71, lon: -74.01 },
  { id: 'in-yvr', name: '溫哥華 YVR', lat: 49.28, lon: -123.12 },
  { id: 'in-lhr', name: '倫敦 LON', lat: 51.51, lon: -0.13 },
  { id: 'in-par', name: '巴黎 PAR', lat: 48.86, lon: 2.35 },
  { id: 'in-fra', name: '法蘭克福 FRA', lat: 50.11, lon: 8.68 },
  { id: 'in-ams', name: '阿姆斯特丹 AMS', lat: 52.37, lon: 4.90 },
  { id: 'in-zrh', name: '蘇黎世 ZRH', lat: 47.37, lon: 8.55 },
  { id: 'in-prg', name: '布拉格 PRG', lat: 50.08, lon: 14.44 },
  { id: 'in-phx', name: '鳳凰城 PHX', lat: 33.45, lon: -112.07 },
  // 國際機場（依 CrewSync airport-data.js Ops Spec C-6 清單）
  { id: 'ap-VHHH', name: 'VHHH 香港赤鱲角', lat: 22.309, lon: 113.914 },
  { id: 'ap-VMMC', name: 'VMMC 澳門', lat: 22.149, lon: 113.592 },
  { id: 'ap-RPLC', name: 'RPLC 克拉克', lat: 15.186, lon: 120.560 },
  { id: 'ap-RPLL', name: 'RPLL 馬尼拉', lat: 14.508, lon: 121.019 },
  { id: 'ap-RPMD', name: 'RPMD 達沃', lat: 7.125, lon: 125.646 },
  { id: 'ap-RPVM', name: 'RPVM 宿霧', lat: 10.307, lon: 123.978 },
  { id: 'ap-VVNB', name: 'VVNB 河內內排', lat: 21.221, lon: 105.807 },
  { id: 'ap-VVPQ', name: 'VVPQ 富國', lat: 10.227, lon: 103.967 },
  { id: 'ap-VVTS', name: 'VVTS 胡志明', lat: 10.819, lon: 106.652 },
  { id: 'ap-VDPP', name: 'VDPP 金邊', lat: 11.547, lon: 104.844 },
  { id: 'ap-VVCR', name: 'VVCR 芽莊', lat: 12.227, lon: 109.192 },
  { id: 'ap-VVDN', name: 'VVDN 峴港', lat: 16.044, lon: 108.199 },
  { id: 'ap-RJAA', name: 'RJAA 成田', lat: 35.764, lon: 140.386 },
  { id: 'ap-RJBB', name: 'RJBB 關西', lat: 34.427, lon: 135.244 },
  { id: 'ap-RJBE', name: 'RJBE 神戶', lat: 34.633, lon: 135.224 },
  { id: 'ap-RJCC', name: 'RJCC 新千歲', lat: 42.775, lon: 141.692 },
  { id: 'ap-RJCH', name: 'RJCH 函館', lat: 41.770, lon: 140.822 },
  { id: 'ap-RJFF', name: 'RJFF 福岡', lat: 33.585, lon: 130.451 },
  { id: 'ap-RJFK', name: 'RJFK 鹿兒島', lat: 31.804, lon: 130.719 },
  { id: 'ap-RJFT', name: 'RJFT 熊本', lat: 32.837, lon: 130.855 },
  { id: 'ap-RJFU', name: 'RJFU 長崎', lat: 32.917, lon: 129.914 },
  { id: 'ap-RJGG', name: 'RJGG 中部', lat: 34.858, lon: 136.805 },
  { id: 'ap-RJNK', name: 'RJNK 小松', lat: 36.395, lon: 136.407 },
  { id: 'ap-RJOS', name: 'RJOS 德島', lat: 34.133, lon: 134.607 },
  { id: 'ap-RJOT', name: 'RJOT 高松', lat: 34.214, lon: 134.016 },
  { id: 'ap-RJSN', name: 'RJSN 新潟', lat: 37.956, lon: 139.121 },
  { id: 'ap-RJSS', name: 'RJSS 仙台', lat: 38.140, lon: 140.917 },
  { id: 'ap-RJTT', name: 'RJTT 羽田', lat: 35.552, lon: 139.780 },
  { id: 'ap-ROAH', name: 'ROAH 那霸', lat: 26.196, lon: 127.646 },
  { id: 'ap-ROIG', name: 'ROIG 石垣', lat: 24.397, lon: 124.245 },
  { id: 'ap-RORS', name: 'RORS 下地島', lat: 24.827, lon: 125.145 },
  { id: 'ap-RKPC', name: 'RKPC 濟州', lat: 33.511, lon: 126.493 },
  { id: 'ap-RKPK', name: 'RKPK 釜山', lat: 35.180, lon: 128.938 },
  { id: 'ap-RKSI', name: 'RKSI 仁川', lat: 37.463, lon: 126.440 },
  { id: 'ap-RKSS', name: 'RKSS 金浦', lat: 37.558, lon: 126.790 },
  { id: 'ap-RKTN', name: 'RKTN 大邱', lat: 35.894, lon: 128.659 },
  { id: 'ap-VTBS', name: 'VTBS 素萬那普', lat: 13.690, lon: 100.750 },
  { id: 'ap-VTBD', name: 'VTBD 廊曼', lat: 13.912, lon: 100.606 },
  { id: 'ap-VTBU', name: 'VTBU 烏達保', lat: 12.680, lon: 101.005 },
  { id: 'ap-VTCC', name: 'VTCC 清邁', lat: 18.766, lon: 98.963 },
  { id: 'ap-VTSP', name: 'VTSP 普吉', lat: 8.113, lon: 98.317 },
  { id: 'ap-WSSS', name: 'WSSS 新加坡樟宜', lat: 1.364, lon: 103.991 },
  { id: 'ap-WMKK', name: 'WMKK 吉隆坡', lat: 2.746, lon: 101.707 },
  { id: 'ap-WMKP', name: 'WMKP 檳城', lat: 5.297, lon: 100.277 },
  { id: 'ap-WBGG', name: 'WBGG 古晉', lat: 1.485, lon: 110.347 },
  { id: 'ap-WIII', name: 'WIII 雅加達蘇卡諾', lat: -6.126, lon: 106.656 },
  { id: 'ap-WARR', name: 'WARR 泗水朱安達', lat: -7.379, lon: 112.787 },
  { id: 'ap-WADD', name: 'WADD 峇里島', lat: -8.748, lon: 115.167 },
  { id: 'ap-KLAX', name: 'KLAX 洛杉磯', lat: 33.942, lon: -118.408 },
  { id: 'ap-KSFO', name: 'KSFO 舊金山', lat: 37.619, lon: -122.375 },
  { id: 'ap-KSEA', name: 'KSEA 西雅圖', lat: 47.449, lon: -122.309 },
  { id: 'ap-KPHX', name: 'KPHX 鳳凰城', lat: 33.434, lon: -112.012 },
  { id: 'ap-KLAS', name: 'KLAS 拉斯維加斯', lat: 36.080, lon: -115.152 },
  { id: 'ap-KONT', name: 'KONT 安大略', lat: 34.056, lon: -117.601 },
  { id: 'ap-KOAK', name: 'KOAK 奧克蘭', lat: 37.721, lon: -122.221 },
  { id: 'ap-KPDX', name: 'KPDX 波特蘭', lat: 45.589, lon: -122.595 },
  { id: 'ap-KSMF', name: 'KSMF 沙加緬度', lat: 38.695, lon: -121.591 },
  { id: 'ap-KTUS', name: 'KTUS 土森', lat: 32.116, lon: -110.941 },
  { id: 'ap-PHNL', name: 'PHNL 檀香山', lat: 21.319, lon: -157.922 },
  { id: 'ap-PANC', name: 'PANC 安克拉治', lat: 61.174, lon: -149.998 },
  { id: 'ap-PAFA', name: 'PAFA 費爾班克斯', lat: 64.815, lon: -147.856 },
  { id: 'ap-PGUM', name: 'PGUM 關島', lat: 13.484, lon: 144.800 },
  { id: 'ap-PGSN', name: 'PGSN 塞班', lat: 15.119, lon: 145.729 },
  { id: 'ap-PTRO', name: 'PTRO 帛琉', lat: 7.367, lon: 134.544 },
  { id: 'ap-PACD', name: 'PACD Cold Bay', lat: 55.206, lon: -162.725 },
  { id: 'ap-PAKN', name: 'PAKN King Salmon', lat: 58.677, lon: -156.649 },
  { id: 'ap-PASY', name: 'PASY Shemya', lat: 52.712, lon: 174.114 },
  { id: 'ap-PMDY', name: 'PMDY 中途島', lat: 28.212, lon: -177.381 },
  { id: 'ap-PWAK', name: 'PWAK 威克島', lat: 19.281, lon: 166.638 },
  { id: 'ap-LKPR', name: 'LKPR 布拉格', lat: 50.101, lon: 14.264 },
  { id: 'ap-EDDB', name: 'EDDB 柏林布蘭登堡', lat: 52.366, lon: 13.503 },
  { id: 'ap-EDDM', name: 'EDDM 慕尼黑', lat: 48.354, lon: 11.786 },
  { id: 'ap-EPWA', name: 'EPWA 華沙蕭邦', lat: 52.166, lon: 20.967 },
  { id: 'ap-LOWL', name: 'LOWL 林茲', lat: 48.233, lon: 14.188 },
  { id: 'ap-LOWW', name: 'LOWW 維也納', lat: 48.110, lon: 16.570 },
  { id: 'ap-CYVR', name: 'CYVR 溫哥華', lat: 49.195, lon: -123.184 },
];

// 股票預設清單 (代號, 市場: 'tw' or 'us')
const TW_STOCK_CODES = [
  '2330','2454','2303','2408','2379','3034','3443','3661','3711','6488','8046',
  '2317','2308','2382','2357','2353','2376','2356','3231','2324','2412','2409',
  '2881','2882','2884','2886','2891','2892','5880',
  '1216','1301','1303','2002','2603','2609','2610','2618','2912',
];
const US_STOCK_CODES = [
  'AAPL','MSFT','GOOGL','META','AMZN','NVDA','TSLA','AMD','INTC','TSM','ORCL','CRM','ADBE','NFLX',
  'VOO','VT','VTI','QQQ','SPY','DIA','IWM','SCHD',
  'BRK.B','JPM','V','MA','BAC','WFC','GS',
  'DIS','NKE','COST','VST','KO','PEP','MCD',
];

const FX_PAIRS = {
  vsTwd: ['USD','JPY','EUR','CNY','HKD','SGD','GBP','AUD','CAD','KRW','THB'],
  cross: [
    ['EUR','USD'],['USD','JPY'],['GBP','USD'],['USD','CHF'],['USD','CNY'],
    ['USD','HKD'],['USD','SGD'],['AUD','USD'],['NZD','USD'],['USD','CAD'],
    ['EUR','JPY'],['GBP','JPY'],['EUR','GBP'],['AUD','JPY'],
  ],
};

// ────────────────────────────────────────────────────────────────────
// 1) Open-Meteo 天氣（批次多地點，一次 call）
// ────────────────────────────────────────────────────────────────────
async function fetchAirQuality(locs: Array<{ name: string; lat: number; lon: number }>) {
  if (!locs || locs.length === 0) return [];
  try {
    const lats = locs.map(l => l.lat).join(',');
    const lons = locs.map(l => l.lon).join(',');
    const params = new URLSearchParams({
      latitude: lats,
      longitude: lons,
      current: 'us_aqi,pm2_5',
      timezone: 'Asia/Taipei',
    });
    const url = 'https://air-quality-api.open-meteo.com/v1/air-quality?' + params.toString();
    const r = await fetch(url, { headers: { 'User-Agent': 'CrewSync-Morning/1.0' } });
    if (!r.ok) return locs.map(() => ({ aqi: null, pm25: null }));
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [data];
    return locs.map((_, i) => {
      const d = arr[i];
      if (!d || !d.current) return { aqi: null, pm25: null };
      return {
        aqi: d.current.us_aqi != null ? Math.round(d.current.us_aqi) : null,
        pm25: d.current.pm2_5 != null ? Math.round(d.current.pm2_5) : null,
      };
    });
  } catch (e) {
    return locs.map(() => ({ aqi: null, pm25: null }));
  }
}

async function fetchWeather(locs: Array<{ name: string; lat: number; lon: number }> = WX_LOCATIONS) {
  if (!locs || locs.length === 0) return [];
  const lats = locs.map(l => l.lat).join(',');
  const lons = locs.map(l => l.lon).join(',');
  const params = new URLSearchParams({
    latitude: lats,
    longitude: lons,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max',
    wind_speed_unit: 'kn',
    timezone: 'Asia/Taipei',
    forecast_days: '7',
  });
  const url = 'https://api.open-meteo.com/v1/forecast?' + params.toString();
  // 天氣與空氣品質並行抓
  // V1.3.15: 加 8 秒 fetch timeout + 1 次 retry (open-meteo 偶發 502 / 慢)
  let r: Response | null = null;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': 'CrewSync-Morning/1.0' },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!r.ok) throw new Error('open-meteo HTTP ' + r.status);
      break;  // success
    } catch (e: any) {
      clearTimeout(tid);
      lastErr = e;
      r = null;
      if (attempt < 1) await new Promise(res => setTimeout(res, 1500));
    }
  }
  if (!r) throw lastErr || new Error('open-meteo fetch failed');
  // 空氣品質獨立抓 (失敗不影響天氣)
  const airArr = await fetchAirQuality(locs).catch(() => locs.map(() => ({ aqi: null, pm25: null })));
  const data = await r.json();
  // 多地點回傳是陣列（每個地點一個物件）；單地點回傳單一物件。統一成陣列。
  const arr = Array.isArray(data) ? data : [data];
  return locs.map((loc, i) => {
    const d = arr[i];
    const air = airArr[i] || { aqi: null, pm25: null };
    if (!d || !d.current) return { name: loc.name, aqi: air.aqi, pm25: air.pm25, _error: 'no_data' };
    const c = d.current;
    const daily = d.daily || {};
    const dayNames = ['今','明','二','三','四','五','六'];
    // 依據今天星期幾動態標記未來幾天（今/明後/星期字）
    const today = new Date();
    const forecast = [];
    const nDays = Math.min(7, (daily.time || []).length);
    for (let j = 0; j < nDays; j++) {
      const dateStr = daily.time[j];
      let label;
      if (j === 0) label = '今';
      else if (j === 1) label = '明';
      else {
        // 用 UTC 建構避免伺服器時區影響 getDay()
        const [y, mo, dd] = (dateStr as string).split('-').map(Number);
        const dt = new Date(Date.UTC(y, mo - 1, dd));
        const wd = dt.getUTCDay();
        label = ['日','一','二','三','四','五','六'][wd];
      }
      forecast.push({
        day: label,
        code: daily.weather_code ? daily.weather_code[j] : null,
        tmax: daily.temperature_2m_max ? daily.temperature_2m_max[j] : null,
        tmin: daily.temperature_2m_min ? daily.temperature_2m_min[j] : null,
      });
    }
    // sunrise/sunset 取今天那筆 (index 0)，格式 "2026-04-11T05:32"
    const sunriseIso = (daily.sunrise || [])[0] || '';
    const sunsetIso = (daily.sunset || [])[0] || '';
    const hm = (iso) => iso ? iso.split('T')[1] : '—';
    return {
      name: loc.name,
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m != null ? Math.round(c.wind_speed_10m) : null,
      windDir: c.wind_direction_10m != null ? Math.round(c.wind_direction_10m) : null,
      uv: daily.uv_index_max ? Math.round(daily.uv_index_max[0]) : null,
      code: c.weather_code,
      sunrise: hm(sunriseIso),
      sunset: hm(sunsetIso),
      aqi: air.aqi,
      pm25: air.pm25,
      forecast,
    };
  });
}

// ────────────────────────────────────────────────────────────────────
// 2) cnyes 台股（批次）
// ────────────────────────────────────────────────────────────────────
// 單一 chunk 的 cnyes 呼叫
async function cnyesBatchOne(codes, marketPrefix) {
  if (!codes || codes.length === 0) return {};
  const symbols = codes.map(c => `${marketPrefix}:${c}:STOCK`).join(',');
  const url = `https://ws.api.cnyes.com/ws/api/v1/quote/quotes/${symbols}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return {};
  const json = await r.json();
  const out: any = {};
  for (const row of (json.data || [])) {
    const code = row['200010'];
    if (!code) continue;
    out[code] = {
      name: row['200009'] || code,
      price: row['6'] != null ? Number(row['6']) : null,
      change: row['11'] != null ? Number(row['11']) : null,
      changePct: row['56'] != null ? Number(row['56']) : null,
      prevClose: row['21'] != null ? Number(row['21']) : null,
      high: row['12'] != null ? Number(row['12']) : null,
      low: row['13'] != null ? Number(row['13']) : null,
      w52high: row['75'] != null ? Number(row['75']) : null,
      w52low: row['76'] != null ? Number(row['76']) : null,
    };
  }
  return out;
}
// Chunking：每 50 支拆一批，避免 URL 過長 / cnyes 拒絕大請求
// Phase 1.C: export 給 portfolio module 共用，避免 cnyes 邏輯 code duplication
export async function cnyesBatch(codes, marketPrefix) {
  if (!codes || codes.length === 0) return {};
  const CHUNK = 50;
  const out: any = {};
  const chunks = [];
  for (let i = 0; i < codes.length; i += CHUNK) chunks.push(codes.slice(i, i + CHUNK));
  // 並行打每個 chunk，單 chunk 失敗不影響其他
  const results = await Promise.all(chunks.map(async (ch) => {
    try { return await cnyesBatchOne(ch, marketPrefix); } catch (e) { return {}; }
  }));
  for (const r of results) Object.assign(out, r);
  return out;
}

// 台股：先試 TWS（上市）→ 沒撈到的 fallback 到 TWG（興櫃）
async function fetchTwStocks(codes: string[] = TW_STOCK_CODES) {
  if (!codes || codes.length === 0) return {};
  const out = await cnyesBatch(codes, 'TWS');
  const missing = codes.filter(c => !out[c]);
  if (missing.length > 0) {
    try {
      const twgOut = await cnyesBatch(missing, 'TWG');
      Object.assign(out, twgOut);
    } catch (e) { /* 興櫃 fallback 失敗就算了 */ }
  }
  return out;
}

async function fetchCnyesStocks(codes, marketPrefix) {
  return cnyesBatch(codes, marketPrefix);
}
async function fetchUsStocks(codes: string[] = US_STOCK_CODES) {
  if (!codes || codes.length === 0) return {};
  return fetchCnyesStocks(codes, 'USS');
}

// ────────────────────────────────────────────────────────────────────
// 3) 台銀匯率：CSV 主源 + HTML fallback
//   - 優先打 flcsv/0/day（簡潔最快），加 cache-busting
//   - 若 302/HTML/空 → fallback 解析 xrt?Lang=zh-TW 牌告
//   - 兩者都失敗才回 {}（前端顯示 —）
//   保留現金/即期買賣價，CSV 恢復後不用再改
// ────────────────────────────────────────────────────────────────────
type TwdRate = {
  rate: number | null;
  cashBuy: number | null;
  cashSell: number | null;
  spotBuy: number | null;
  spotSell: number | null;
};

function _fxNz(n: number): number | null { return isNaN(n) ? null : n; }
function _fxMid(cb: number | null, cs: number | null, sb: number | null, ss: number | null): number | null {
  if (sb != null && ss != null) return (sb + ss) / 2;
  if (cb != null && cs != null) return (cb + cs) / 2;
  return null;
}

// CSV：原本格式
//   0: 幣別 | 1: "本行買入" | 2: 現金買入 | 3: 即期買入 | 4-10: 遠期買入
//   11: "本行賣出" | 12: 現金賣出 | 13: 即期賣出 | 14-20: 遠期賣出
function _parseBotCsv(text: string): Record<string, TwdRate> | null {
  const cleaned = text.replace(/^﻿/, '').trim();
  if (!cleaned || cleaned.startsWith('<') || !cleaned.includes(',')) return null;
  const lines = cleaned.split(/\r?\n/);
  if (lines.length < 2) return null;
  const out: Record<string, TwdRate> = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 14) continue;
    const code = cols[0].trim();
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const cashBuy = _fxNz(parseFloat(cols[2]));
    const spotBuy = _fxNz(parseFloat(cols[3]));
    const cashSell = _fxNz(parseFloat(cols[12]));
    const spotSell = _fxNz(parseFloat(cols[13]));
    out[code] = { rate: _fxMid(cashBuy, cashSell, spotBuy, spotSell), cashBuy, cashSell, spotBuy, spotSell };
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function _fetchBotCsvRates(): Promise<Record<string, TwdRate> | null> {
  try {
    const url = 'https://rate.bot.com.tw/xrt/flcsv/0/day?t=' + Date.now();
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' },
      cache: 'no-store',
      redirect: 'manual',  // 不跟隨 302（被導到公告頁就算 CSV 失敗）
    });
    if (r.status < 200 || r.status >= 300) return null;
    const text = await r.text();
    return _parseBotCsv(text);
  } catch {
    return null;
  }
}

// HTML：每個幣別一段，內含「(CCY)」+ data-table="本行XX買入/賣出" 的 td 數值
// 同值會出現兩次（desktop / phone responsive）— 取第一個就行
function _pickHtmlRate(block: string, label: string): number | null {
  const re = new RegExp('data-table="' + label + '"[^>]*>\\s*([0-9.]+)', 'i');
  const m = block.match(re);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

function _parseBotHtml(html: string): Record<string, TwdRate> | null {
  const blocks = html.split(/<\/tr>/i);
  const out: Record<string, TwdRate> = {};
  for (const block of blocks) {
    const m = block.match(/\(([A-Z]{3})\)/);
    if (!m) continue;
    const code = m[1];
    if (out[code]) continue;
    const cashBuy = _pickHtmlRate(block, '本行現金買入');
    const cashSell = _pickHtmlRate(block, '本行現金賣出');
    const spotBuy = _pickHtmlRate(block, '本行即期買入');
    const spotSell = _pickHtmlRate(block, '本行即期賣出');
    if (cashBuy == null && spotBuy == null) continue;
    out[code] = { rate: _fxMid(cashBuy, cashSell, spotBuy, spotSell), cashBuy, cashSell, spotBuy, spotSell };
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function _fetchBotHtmlRates(): Promise<Record<string, TwdRate> | null> {
  try {
    const r = await fetch('https://rate.bot.com.tw/xrt?Lang=zh-TW', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const html = await r.text();
    return _parseBotHtml(html);
  } catch {
    return null;
  }
}

async function fetchFx(pairs: string[] = []) {
  // 若沒傳 pairs 則用預設清單（向後相容）
  const usePairs = (pairs && pairs.length > 0) ? pairs : [
    ...FX_PAIRS.vsTwd.map(c => `${c}/TWD`),
    ...FX_PAIRS.cross.map(([a, b]) => `${a}/${b}`),
  ];

  // 1) CSV 主源
  let twdRates = await _fetchBotCsvRates();
  let source: 'csv' | 'html' | null = twdRates ? 'csv' : null;

  // 2) Fallback：HTML 牌告
  if (!twdRates) {
    twdRates = await _fetchBotHtmlRates();
    if (twdRates) source = 'html';
  }

  if (!twdRates) {
    console.warn('[morning-builder] BOT FX: CSV + HTML 都失敗，回空');
    return {};
  }
  console.log(`[morning-builder] BOT FX 來源：${source} (${Object.keys(twdRates).length} 幣別)`);

  // 組成 pair-keyed 格式：任何 A/B，都用 (A/TWD)/(B/TWD) 去算
  const out: any = {};
  for (const pair of usePairs) {
    const [a, b] = pair.split('/');
    if (!a || !b) continue;
    if (b === 'TWD' && twdRates[a]) {
      out[pair] = { rate: twdRates[a].rate, cashSell: twdRates[a].cashSell };
    } else if (a === 'TWD' && twdRates[b] && twdRates[b].rate) {
      out[pair] = { rate: 1 / twdRates[b].rate };
    } else if (twdRates[a] && twdRates[b] && twdRates[a].rate && twdRates[b].rate) {
      out[pair] = { rate: twdRates[a].rate / twdRates[b].rate };
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// 4) Google News RSS（台灣 + 世界）
// ────────────────────────────────────────────────────────────────────
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
    const rawTitle = getTag('title')
      .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    let link = getTag('link').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const pubDate = getTag('pubDate');
    const source = getTag('source');
    // 只移除「 - 來源名」格式（dash 前後都有空格），避免砍掉 hard-fought、face-to-face 等
    const cleanTitle = rawTitle.replace(/\s+[-–—]\s+[^-–—]+$/, '').trim();
    if (cleanTitle && link) items.push({ title: cleanTitle, url: link, source, pubDate });
  }
  return items;
}

function fmtTime(pubDate) {
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    // 轉台北時間 HH:MM（公式與 taipeiNow 相同，同時對 UTC 伺服器與 Taipei local dev 正確）
    const tpe = new Date(d.getTime() + (8 * 60 + d.getTimezoneOffset()) * 60000);
    return String(tpe.getHours()).padStart(2, '0') + ':' + String(tpe.getMinutes()).padStart(2, '0');
  } catch (e) { return ''; }
}

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

// 台灣新聞分 10 類，每類 30 條
const TW_NEWS_CATEGORIES = [
  { key: '熱門', query: '' },  // 空 query = 首頁 trending
  { key: '娛樂', query: '娛樂' },
  { key: '股市', query: '股市+台股' },
  { key: '國際', query: '國際新聞' },
  { key: '天氣', query: '天氣+氣象' },
  { key: '玩樂', query: '旅遊+玩樂+景點' },
  { key: '理財', query: '理財+投資+基金' },
  { key: '電影', query: '電影+影評' },
  { key: '時尚', query: '時尚+穿搭+美妝' },
  { key: '健康', query: '健康+醫療+養生' },
];

async function fetchNewsTw() {
  const results = await Promise.all(
    TW_NEWS_CATEGORIES.map(async (cat) => {
      try {
        const base = 'https://news.google.com/rss';
        const url = cat.query
          ? base + '/search?q=' + encodeURIComponent(cat.query) + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant'
          : base + '?hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return { key: cat.key, items: [] };
        const xml = await r.text();
        const items = parseRss(xml);
        const top = dedupeBySource(items, 30, 2).map(it => ({
          title: it.title, url: it.url, source: it.source || '', time: fmtTime(it.pubDate),
        }));
        return { key: cat.key, items: top };
      } catch (e) {
        console.warn('[morning-builder] TW news category failed:', cat.key, e instanceof Error ? e.message : String(e));
        return { key: cat.key, items: [] };
      }
    })
  );
  // 回傳 object: { 熱門: [...], 娛樂: [...], ... }
  const out = {};
  for (const r of results) out[r.key] = r.items;
  return out;
}

async function translate(text) {
  if (!text) return '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0].map((seg) => seg[0]).join('');
    }
    return '';
  } catch (e) { return ''; }
}

// 世界新聞：從多個新聞社的 RSS 直接抓（不經 Google News redirect，URL 是真實文章連結）
const WORLD_RSS_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC' },
  { url: 'https://www.theguardian.com/world/rss', name: 'Guardian' },
  { url: 'https://feeds.npr.org/1004/rss.xml', name: 'NPR' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'NYT' },
  { url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', name: 'WSJ' },
  { url: 'http://rss.cnn.com/rss/edition_world.rss', name: 'CNN' },
  // Reuters 已停用公開 RSS feed（2023 年起）
];

async function fetchNewsWorld() {
  // 並行抓所有 feeds
  const results = await Promise.all(
    WORLD_RSS_FEEDS.map(async (feed) => {
      try {
        const r = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return [];
        const xml = await r.text();
        const items = parseRss(xml);
        // 用 feed name 當 source（有些 RSS 的 <source> tag 可能空）
        return items.map(it => ({ ...it, source: it.source || feed.name }));
      } catch (e) {
        console.warn('[morning-builder] world feed failed:', feed.name, e instanceof Error ? e.message : String(e));
        return [];
      }
    })
  );
  // 過濾掉非真正文章的 item（live update 標頭、太短標題等）
  const JUNK_TITLES = /^(here[\u2018\u2019'']?s the latest|live updates?|breaking news|latest news|watch live|the latest)/i;
  const allItems = results.flat()
    .filter(it => it.title && it.title.length > 15 && !JUNK_TITLES.test(it.title))
    .sort((a, b) => {
      const da = new Date(a.pubDate || 0).getTime();
      const db = new Date(b.pubDate || 0).getTime();
      return db - da;  // newest first
    });
  const top = dedupeBySource(allItems, 10, 2);
  // 翻譯標題（序列跑）
  const out = [];
  for (const it of top) {
    const title_zh = await translate(it.title);
    out.push({
      title: it.title,
      title_zh,
      url: it.url,
      source: it.source || '',
      time: fmtTime(it.pubDate),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// 主組裝器
// ────────────────────────────────────────────────────────────────────
function todayTaipeiStr() {
  const now = new Date();
  const tpe = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
  const y = tpe.getFullYear();
  const m = String(tpe.getMonth() + 1).padStart(2, '0');
  const d = String(tpe.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function safeRun(label, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    console.log(`[morning-builder] ${label} OK (${Date.now() - t0}ms)`);
    return { ok: true, value: result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[morning-builder] ${label} FAILED: ${msg}`);
    return { ok: false, error: msg };
  }
}

export interface BuildOpts {
  wxLocs?: Array<{ name: string; lat: number; lon: number }>;
  twCodes?: string[];
  usCodes?: string[];
  fxPairs?: string[];
}

// 單一欄位重抓（給 /api/morning-report/refresh-partial 用）
export async function fetchSection(section: string, opts: BuildOpts = {}) {
  if (section === 'weather') return await fetchWeather(opts.wxLocs);
  if (section === 'stocks_tw') return await fetchTwStocks(opts.twCodes);
  if (section === 'stocks_us') return await fetchUsStocks(opts.usCodes);
  if (section === 'fx') return await fetchFx(opts.fxPairs);
  throw new Error('unknown section: ' + section);
}

export async function buildMorningReport(opts: BuildOpts = {}) {
  const t0 = Date.now();
  const wxLocs = opts.wxLocs;
  const twCodes = opts.twCodes;
  const usCodes = opts.usCodes;
  const fxPairs = opts.fxPairs;
  console.log(`[morning-builder] start (wx=${wxLocs ? wxLocs.length : 'default'} tw=${twCodes ? twCodes.length : 'default'} us=${usCodes ? usCodes.length : 'default'} fx=${fxPairs ? fxPairs.length : 'default'})`);
  // 5 個資料源並行（I/O 為主，記憶體低）
  const [weather, stocksTw, stocksUs, fx, newsTw, newsWorld] = await Promise.all([
    safeRun('weather', () => fetchWeather(wxLocs)),
    safeRun('stocks_tw', () => fetchTwStocks(twCodes)),
    safeRun('stocks_us', () => fetchUsStocks(usCodes)),
    safeRun('fx', () => fetchFx(fxPairs)),
    safeRun('news_tw', fetchNewsTw),
    safeRun('news_world', fetchNewsWorld),
  ]);
  const errors = [];
  const nowIso = new Date().toISOString();
  const report = {
    date: todayTaipeiStr(),
    generated_at: nowIso,
    weather: weather.ok ? weather.value : (errors.push({ weather: weather.error }), null),
    weather_fetched_at: weather.ok ? nowIso : null,
    stocks_tw: stocksTw.ok ? stocksTw.value : (errors.push({ stocks_tw: stocksTw.error }), null),
    stocks_tw_fetched_at: stocksTw.ok ? nowIso : null,
    stocks_us: stocksUs.ok ? stocksUs.value : (errors.push({ stocks_us: stocksUs.error }), null),
    stocks_us_fetched_at: stocksUs.ok ? nowIso : null,
    fx: fx.ok ? fx.value : (errors.push({ fx: fx.error }), null),
    fx_fetched_at: fx.ok ? nowIso : null,
    news_tw: newsTw.ok ? newsTw.value : (errors.push({ news_tw: newsTw.error }), []),
    news_world: newsWorld.ok ? newsWorld.value : (errors.push({ news_world: newsWorld.error }), []),
    build_errors: errors.length > 0 ? errors : undefined,
  };
  console.log(`[morning-builder] done in ${Date.now() - t0}ms, ${errors.length} errors`);
  return report;
}

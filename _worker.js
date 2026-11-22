// ============================================================
// _worker.js  —  Cloudflare Pages「進階模式」單一 Worker
// 用「拖拉上傳」即可部署（不需要 functions 資料夾、不需要命令列 Wrangler）。
//
// 路由：
//   POST /api/gemini  → 轉接 Google Gemini（免費版），收/回 Anthropic 格式
//   GET/POST /api/sync → 用同步碼在 KV 存取資料（跨裝置同步）
//   GET /api/health   → 檢查連線：伺服器有沒有在跑、KV 讀得到嗎（加 ?write=1 會多做寫入測試）
//   其餘             → 交給靜態資源（env.ASSETS），也就是你的 index.html
// ------------------------------------------------------------
// 在 Cloudflare Pages 要設定的東西（都在 Settings 裡）：
//   環境變數：GEMINI_API_KEY = 你的 Google AI Studio 金鑰（必填，建議設 Secret）
//            GEMINI_MODEL   = （選用）模型名稱，預設 gemini-2.5-flash
//            APP_TOKEN      = （選用）防盜用權杖
//   綁定    ：KV namespace，Variable name 設為 SYNC_KV
// ============================================================

const DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

function withCORS(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
  return res;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function checkToken(request, env) {
  const appToken = env.APP_TOKEN || '';
  if (!appToken) return true;
  return (request.headers.get('x-app-token') || '') === appToken;
}

// ---------- /api/gemini ----------
function toGeminiContents(messages) {
  return (messages || []).map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = m.content.map((block) => {
        if (block && block.type === 'text') return { text: block.text || '' };
        if (block && block.type === 'image' && block.source && block.source.type === 'base64') {
          return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
        }
        return { text: '' };
      });
    } else {
      parts = [{ text: '' }];
    }
    return { role, parts };
  });
}

async function handleGemini(request, env) {
  if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
  if (request.method !== 'POST') return withCORS(json({ error: 'method not allowed' }, 405));
  if (!checkToken(request, env)) return withCORS(json({ error: 'unauthorized' }, 401));

  const apiKey = env.SmartDailyAssistant_GEMINI_API_KEY;
  if (!apiKey) return withCORS(json({ error: 'server missing GEMINI_API_KEY' }, 500));
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  let body;
  try { body = await request.json(); }
  catch (e) { return withCORS(json({ error: 'invalid JSON body' }, 400)); }

  const geminiBody = {
    contents: toGeminiContents(body.messages),
    generationConfig: {
      maxOutputTokens: body.max_tokens || 1024,
      // 關閉「思考」：避免 gemini-2.5-flash 把輸出額度花在思考上、導致回傳空白。
      // 若改用 Gemini 3.x 系列，請改用 thinkingLevel 或移除此行。
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (body.system) geminiBody.system_instruction = { parts: [{ text: String(body.system) }] };

  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent';
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(geminiBody),
    });
  } catch (e) {
    return withCORS(json({ error: 'upstream fetch failed', detail: String(e) }, 502));
  }

  const gdata = await upstream.json().catch(() => null);
  if (!upstream.ok || !gdata) {
    return withCORS(json({ error: 'gemini error', status: upstream.status, detail: gdata }, upstream.status || 502));
  }

  let text = '';
  const cand = gdata.candidates && gdata.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) {
    text = cand.content.parts.map((p) => (p && p.text) ? p.text : '').join('');
  }
  return withCORS(json({
    content: [{ type: 'text', text }],
    model,
    stop_reason: cand ? (cand.finishReason || null) : null,
  }));
}

// ---------- /api/sync ----------
const keyOf = (code) => 'sync:' + String(code).trim().toUpperCase();

// 把 KV 丟出的英文錯誤翻成看得懂的原因（只回傳原因，不含金鑰或內部資訊）。Cloudflare 免費方案：KV 每天最多寫入 1,000 次、同一個項目一秒內只能寫 1 次、每天最多讀取 100,000 次
function kvErrorMessage(e) {
  const m = String((e && e.message) || e || '');
  if (/429|too many requests|limit exceeded|quota/i.test(m)) return 'Cloudflare KV 拒絕了這次操作（429）：可能是今天的免費額度用完（免費方案每天寫入 1,000 次），或同一個項目一秒內被寫太多次';
  return 'KV 操作失敗：' + m.slice(0, 120);
}
async function handleSync(request, env) {
  try { return await handleSyncInner(request, env); }
  catch (e) { return withCORS(json({ error: 'kv_error', message: kvErrorMessage(e) }, 500)); }
}
async function handleSyncInner(request, env) {
  if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
  if (!checkToken(request, env)) return withCORS(json({ error: 'unauthorized' }, 401));

  const kv = env.SYNC_KV;
  if (!kv) return withCORS(json({ error: 'KV not bound (expected binding name: SYNC_KV)' }, 500));

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) return withCORS(json({ error: 'missing code' }, 400));
    const raw = await kv.get(keyOf(code));
    if (!raw) return withCORS(json({ data: null }));
    let rec; try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    return withCORS(json({ data: rec ? rec.data : null, updated_at: rec ? rec.updated_at : 0 }));
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); }
    catch (e) { return withCORS(json({ error: 'invalid JSON body' }, 400)); }
    const code = (body.code || '').trim();
    if (!code) return withCORS(json({ error: 'missing code' }, 400));
    // 版本號一律用伺服器的時間（單調遞增），網頁端把它當作「我同步到哪個版本」
    let prev = null;
    try { const raw0 = await kv.get(keyOf(code)); prev = raw0 ? JSON.parse(raw0) : null; } catch (e) { prev = null; }
    const incoming = body.data || {};
    // 保護 LINE 剛寫進來的紀錄：網頁端若是拿「舊的資料」上傳（上傳時還不知道這幾筆），不能把它們蓋掉。
    // 判斷方式：LINE 寫入時間（importedAt）比網頁端上次同步的版本（base）還新 → 網頁端不可能看過這筆，所以不是它刪的。
    const base = Number(body.base || 0);
    let preserved = 0;
    if (prev && prev.data && base > 0 && Number(prev.updated_at) > base) {
      ['boba_recs', 'meal_recs', 'travel_recs'].forEach((key) => {
        try {
          const remoteArr = prev.data[key] ? JSON.parse(prev.data[key]) : [];
          const inArr = incoming[key] ? JSON.parse(incoming[key]) : [];
          const have = new Set(inArr.map((r) => r && r.id));
          const keep = remoteArr.filter((r) => r && r.source === 'LINE' && Number(r.importedAt) > base && !have.has(r.id));
          if (keep.length) { incoming[key] = JSON.stringify(keep.concat(inArr)); preserved += keep.length; }
        } catch (e) { /* 這個欄位格式不對就不處理，照原樣存 */ }
      });
    }
    // V9：LINE 建立的「待確認草稿」（line_drafts）
    //  ① 舊版網頁不認識這個欄位，上傳時不會帶 → 保留伺服器上的草稿，不能讓它消失
    //  ② 新版網頁上傳時，如果缺少「它還沒看過的新草稿」（createdAt 比它上次同步的版本新）→ 不是它刪的，補回去
    if (prev && prev.data && prev.data[DRAFT_LS_KEY]) {
      if (!(DRAFT_LS_KEY in incoming)) {
        incoming[DRAFT_LS_KEY] = prev.data[DRAFT_LS_KEY];
      } else if (base > 0 && Number(prev.updated_at) > base) {
        try {
          const remoteArr = JSON.parse(prev.data[DRAFT_LS_KEY]);
          const inArr = JSON.parse(incoming[DRAFT_LS_KEY]);
          const have = new Set(inArr.map((d) => d && d.id));
          const keep = remoteArr.filter((d) => d && Number(d.createdAt) > base && !have.has(d.id));
          if (keep.length) { incoming[DRAFT_LS_KEY] = JSON.stringify(keep.concat(inArr)); preserved += keep.length; }
        } catch (e) { /* 格式不對就照原樣存 */ }
      }
    }
    const updated_at = nextVersion(prev && prev.updated_at);
    await kv.put(keyOf(code), JSON.stringify({ data: incoming, updated_at }));
    return withCORS(json({ ok: true, updated_at, preserved }));
  }

  return withCORS(json({ error: 'method not allowed' }, 405));
}

// ---------- /api/health：給 App「檢查連線」用 ----------
// 回報：伺服器有沒有在跑、KV（資料庫）有沒有綁定、讀得到嗎；加上 ?write=1 會多做一次「寫入測試」（只寫一個 60 秒就會消失的小項目，用掉 1 次當天寫入額度）。不回傳任何金鑰或設定內容。
async function handleHealth(request, env) {
  if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
  const out = { ok: true, time: Date.now(), worker: { lineVersion: BOT_LINE_VERSION, build: BOT_BUILD }, kv: { bound: !!env.SYNC_KV, read: null, write: null } };
  const kv = env.SYNC_KV;
  if (!kv) out.ok = false;
  else {
    try { await kv.get('health:probe'); out.kv.read = true; }
    catch (e) { out.kv.read = false; out.kv.readError = kvErrorMessage(e); out.ok = false; }
    if (new URL(request.url).searchParams.get('write') === '1') {
      try { await kv.put('health:probe', String(Date.now()), { expirationTtl: 60 }); out.kv.write = true; }
      catch (e) { out.kv.write = false; out.kv.writeError = kvErrorMessage(e); out.ok = false; }
    }
  }
  const res = withCORS(json(out));
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

// ---------- /api/line ----------
// 驗證訊息真的來自 LINE：用 Channel Secret 算 HMAC-SHA256，跟 LINE 給的簽章比對
async function verifyLineSignature(secret, body, signature) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
    return b64 === signature;
  } catch (e) {
    return false;
  }
}

// 回覆訊息給 LINE 使用者
async function lineReply(token, replyToken, text) {
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}

// 取得傳訊者的 LINE 顯示名稱（多人共用時用來標記是誰記的）
async function lineProfile(token, userId) {
  if (!userId) return null;
  try {
    const r = await fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d ? d.displayName : null;
  } catch (e) { return null; }
}

// 取得「群組聊天室」裡發言者的顯示名稱 —— 跟 1對1 用的 API 不一樣
// （1對1用 /v2/bot/profile/{userId}；群組要用 /v2/bot/group/{groupId}/member/{userId}）
async function lineGroupMemberProfile(token, groupId, userId) {
  if (!groupId || !userId) return null;
  try {
    const r = await fetch('https://api.line.me/v2/bot/group/' + groupId + '/member/' + userId, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d ? d.displayName : null;
  } catch (e) { return null; }
}

// 取得群組名稱，存進紀錄裡方便之後分辨是哪個LINE群組傳的
async function lineGroupSummary(token, groupId) {
  if (!groupId) return null;
  try {
    const r = await fetch('https://api.line.me/v2/bot/group/' + groupId + '/summary', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d ? d.groupName : null;
  } catch (e) { return null; }
}

// 用 Gemini 解析「珍奶 60」→ { item, amount, category }
async function parseExpense(text, env, hintCategory) {
  const apiKey = env.SmartDailyAssistant_GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const prompt =
    '你是記帳解析助手。使用者會傳一句話記帳，請解析出以下欄位，只回傳一個JSON，不要有任何其他文字、不要用程式碼區塊：\n' +
    '{"item":"品項名稱","amount":金額數字,"category":"分類",' +
    '"brand":品牌或null,"size":SIZE或null,"topping":加料或null,"sugar":甜度或null,"ice":冰塊或null,' +
    '"cuisine":菜系或null,"portion":份量或null,"diningType":早餐/午餐/晚餐/宵夜/下午茶或null,' +
    '"transportType":flight/ship/hsr/train/metro/taxi或null,"depPort":出發地或null,"arrPort":到達地或null,' +
    '"payment":付款方式或null}\n' +
    '分類只能是這五種之一：drink（手搖飲料、咖啡、飲品）、food（餐點、食物、小吃）、travel（交通、車票、油錢、停車、計程車）、split（訊息裡明確提到AA、分帳、幫付、代墊、每人多少這類分攤金錢的說法）、other（其他，包含收入/支出/薪水/轉帳等一般記帳）。\n' +
    '重要：分類完全只看訊息「內容」本身判斷，不能因為這則訊息是在LINE群組裡傳的就判斷為split，群組跟1對1的判斷方式要一樣。\n' +
    '如果句子裡沒有可辨識的金額，amount回傳null。\n' +
    '詳細欄位規則（非常重要，沒提到就填null，絕對不要自己猜測腦補）：\n' +
    '- brand/size/topping/sugar/ice：只有分類是drink才需要判斷\n' +
    '- cuisine/portion/diningType：只有分類是food才需要判斷\n' +
    '- transportType/depPort/arrPort：只有分類是travel才需要判斷\n' +
    '- payment：任何分類都可以判斷，只要訊息裡有明確講到付款方式\n' +
    '- 不屬於該分類的欄位一律填null\n' +
    (hintCategory ? '提示：使用者已經指定這則訊息的分類是「' + hintCategory + '」，category請直接回傳「' + hintCategory + '」，並依這個分類填寫對應的詳細欄位。\n' : '') +
    '使用者訊息：' + text;
  const geminiBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent';
  let up;
  try {
    up = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(geminiBody),
    });
  } catch (e) { return null; }
  const gdata = await up.json().catch(() => null);
  if (!up.ok || !gdata) return null;
  let out = '';
  const cand = gdata.candidates && gdata.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) {
    out = cand.content.parts.map((p) => (p && p.text) ? p.text : '').join('');
  }
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// ============================================================
// 🚩 旗艦版：LINE多輪問答引擎
//   Stage 0（地基）：對話狀態記憶（KV）+ 通用問答機制 + 快速回覆按鈕
//   Stage 1（試做）：飲料模組完整問答流程（單表單／雙表單兩種模式）
// 目前只支援 1對1 聊天（群組訊息不觸發，避免多人同時流程互相干擾）
// ============================================================
const FLAGSHIP_TRIGGER = '旗艦版';
const FLAGSHIP_SESSION_TTL = 30 * 60; // 30分鐘沒回應就視為放棄，重置

async function getFlagshipSession(userId, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return null;
  const raw = await kv.get('line:session:' + userId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function setFlagshipSession(userId, session, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return;
  await kv.put('line:session:' + userId, JSON.stringify(session), { expirationTtl: FLAGSHIP_SESSION_TTL });
}
async function clearFlagshipSession(userId, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return;
  try { await kv.delete('line:session:' + userId); } catch (e) {}
}

// 飲料模組的問題schema，分「核心資料」「交易資料」兩批 —— 對應App表單的「飲品詳情」「交易與紀錄」兩個區塊
// 日期/時間/飲用者/付款者/紀錄者不問，直接用「現在時間」跟「LINE顯示名稱」帶入，減少問題數
const FLAGSHIP_SCHEMAS = {
  drink: {
    label: '🧋 飲料',
    core: [
      { key: 'brand', q: '哪個品牌／店家？', quick: null },
      { key: 'drink', q: '飲品名稱是？', quick: null },
      { key: 'size', q: 'SIZE？', quick: ['S', 'M', 'L'] },
      { key: 'topping', q: '加料選擇？（沒有就打「無」）', quick: ['無', '珍珠', '椰果', '布丁'] },
      { key: 'sugar', q: '甜度？', quick: ['正常糖', '少糖', '半糖', '微糖(30%)', '無糖'] },
      { key: 'ice', q: '冰塊？', quick: ['正常冰', '少冰', '微冰', '去冰', '熱'] },
    ],
    extended: [
      { key: 'payment', q: '付款方式？', quick: ['現金', '信用卡', '行動支付'] },
      { key: 'amount', q: '金額多少？', quick: null, numeric: true },
      { key: 'rating', q: '評分幾顆星？（1-5，不評分打「跳過」）', quick: ['1', '2', '3', '4', '5', '跳過'] },
      { key: 'note', q: '有什麼想補充的嗎？（沒有就打「沒有」）', quick: ['沒有'] },
    ],
  },
};

async function lineReplyQuick(token, replyToken, text, quickOptions) {
  const messages = [{ type: 'text', text }];
  if (quickOptions && quickOptions.length) {
    messages[0].quickReply = {
      items: quickOptions.slice(0, 13).map((label) => ({
        type: 'action',
        action: { type: 'message', label: String(label).slice(0, 20), text: String(label) },
      })),
    };
  }
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// 跟 lineReplyQuick 一樣，但一定會附加「結束」選項——用在「還在等你回答」的問題上，
// 這樣任何一步都能直接點按鈕離開，不用特地打字
async function lineReplyAsk(token, replyToken, text, quickOptions) {
  const opts = (quickOptions || []).slice();
  if (!opts.includes('結束')) opts.push('結束');
  return lineReplyQuick(token, replyToken, text, opts);
}

// 送出「按鈕卡片」訊息（Buttons Template）—— 跟快速回覆不同，這種按鈕會留在對話紀錄裡（不會消失），
// 畫面上長得比較像截圖裡那種「文字+下面一顆按鈕」的卡片。最多4個按鈕、label最多20字。
async function lineReplyButtons(token, replyToken, altText, bodyText, buttons) {
  const messages = [{
    type: 'template',
    altText: altText,
    template: {
      type: 'buttons',
      text: bodyText,
      actions: buttons.slice(0, 4).map((b) => ({ type: 'message', label: String(b.label).slice(0, 20), text: b.text })),
    },
  }];
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ replyToken, messages }),
  });
}

function flagshipCurrentField(session) {
  const flow = FLAGSHIP_SCHEMAS[session.flow];
  if (!flow) return null;
  const list = session.stage === 'core' ? flow.core : flow.extended;
  return list[session.stepIndex] || null;
}

function flagshipBuildRecord(session, userId, userName, groupId, groupName, msgId) {
  const a = session.answers || {};
  const now = new Date();
  return {
    id: 'L' + now.getTime(),
    item: a.drink || '', amount: Math.round(Number(a.amount) || 0), category: 'drink',
    userId, userName, groupId: groupId || '', groupName: groupName || '', ts: now.getTime(),
    msgId: msgId || '',
    detailed: true, tier: 'flagship',
    brand: a.brand || '', drink: a.drink || '', size: a.size || '',
    topping: a.topping && a.topping !== '無' ? a.topping : '',
    sugar: a.sugar || '', ice: a.ice || '', payment: a.payment || '',
    rating: a.rating && a.rating !== '跳過' ? Number(a.rating) || 0 : 0,
    note: a.note && a.note !== '沒有' ? a.note : '',
  };
}

FLAGSHIP_SCHEMAS.simple = {
  label: '🟢 簡易版', kind: 'rigid',
  core: [{ key: 'item', q: '買了什麼？', quick: null }],
  extended: [{ key: 'amount', q: '多少錢？', quick: null, numeric: true }],
};
FLAGSHIP_SCHEMAS.standard = {
  label: '🟡 標準版', kind: 'freeform',
  core: [{ prompt: '跟我說說買了什麼、細節如何？（品牌/SIZE/甜度這些都可以一起講，我會自動抓）' }],
  extended: [{ prompt: '付款方式跟金額呢？' }],
};

const TIER_TRIGGERS = { '簡易版': 'simple', '標準版': 'standard', '旗艦版': 'drink' };
const MODULE_TRIGGERS = { '飲料': 'drink', '美食': 'food', '交通': 'travel', '記帳': 'split' };
const MODULE_LABELS = { drink: '🧋 飲料', food: '🍱 美食', travel: '🚆 交通', split: '💰 記帳' };
const TRAVEL_TYPE_TRIGGERS = { '✈️ 航班': 'flight', '🚢 船班': 'ship', '🚄 高鐵': 'hsr', '🚆 火車': 'train', '🚇 地鐵': 'metro', '🚖 打車': 'taxi' };
const TRAVEL_TYPE_OPTIONS = Object.keys(TRAVEL_TYPE_TRIGGERS);
const TRAVEL_TYPE_LABELS = { flight: '✈️ 航班', ship: '🚢 船班', hsr: '🚄 高鐵', train: '🚆 火車', metro: '🚇 地鐵', taxi: '🚖 打車' };

// 把 parseExpense() 解析出的結果組成一筆記錄 —— 直接訊息、標準版雙表單最後都靠這個組資料，邏輯統一
const DETAIL_KEYS = ['brand', 'size', 'topping', 'sugar', 'ice', 'cuisine', 'portion', 'diningType', 'transportType', 'depPort', 'arrPort', 'payment'];
const LINE_RECORD_CATEGORIES = ['drink', 'food', 'travel', 'split', 'other'];
// AI 有時會把「品項」回成數字或物件（例如訊息只有「7 60」）：存進去的品項一律是文字，網頁的「LINE紀錄」清單才不會因為一筆怪資料整頁當掉
function recordItemText(v) {
  if (v == null || typeof v === 'object') return '';
  return String(v).trim();
}
function buildRecordFromParsed(parsed, fallbackText, userId, userName, groupId, groupName, tierOverride, msgId) {
  const now = new Date();
  const hasDetail = DETAIL_KEYS.some((k) => parsed[k] != null && String(parsed[k]).trim() !== '');
  const record = {
    id: 'L' + now.getTime(),
    item: recordItemText(parsed.item) || recordItemText(fallbackText),
    amount: Math.round(Number(parsed.amount) || 0),
    category: LINE_RECORD_CATEGORIES.indexOf(parsed.category) >= 0 ? parsed.category : 'other',
    userId: userId,
    userName: userName,
    groupId: groupId || '',
    groupName: groupName || '',
    ts: now.getTime(),
    msgId: msgId || '',
  };
  if (tierOverride) {
    record.detailed = true;
    record.tier = tierOverride;
    DETAIL_KEYS.forEach((k) => { if (parsed[k] != null && String(parsed[k]).trim() !== '') record[k] = String(parsed[k]).trim(); });
  } else if (hasDetail) {
    record.detailed = true;
    record.tier = 'standard';
    DETAIL_KEYS.forEach((k) => { if (parsed[k] != null && String(parsed[k]).trim() !== '') record[k] = String(parsed[k]).trim(); });
  }
  return record;
}
function buildSimpleRecord(session, userId, userName, groupId, groupName, msgId) {
  const a = session.answers || {};
  const now = new Date();
  const catMap = { drink: 'drink', food: 'food', travel: 'travel', split: 'other' };
  const record = {
    id: 'L' + now.getTime(),
    item: recordItemText(a.item), amount: Math.round(Number(a.amount) || 0), category: catMap[session.module] || 'other',
    userId, userName, groupId: groupId || '', groupName: groupName || '', ts: now.getTime(),
    msgId: msgId || '',
  };
  if (session.travelType) record.transportType = session.travelType;
  return record;
}
// ⚠️ 完全自動同步：使用者已經確認接受風險（如果App端剛好有還沒同步的編輯，可能會被覆蓋）
// 把一筆LINE記錄轉成跟App localStorage一樣的欄位格式，準備直接寫進同步資料裡
// LINE顯示名稱 → App內部用的使用者名稱對照表（drinker/payer/recorder這些欄位要跟App一致，統計才不會被拆成兩個人）
// 沒有對照到的名字就原樣使用，之後家人朋友增加時可以再補進這個表
const APP_USER_NAME_MAP = { '洪小格': 'XiaoGe', 'yann': 'XiaoYan' };
function toAppUserName(lineDisplayName) {
  return APP_USER_NAME_MAP[lineDisplayName] || lineDisplayName || '';
}

function shapeForAutoSync(record) {
  const tp = tpParts(record.ts || Date.now()); // Cloudflare Worker 的時區是 UTC，必須換算成台灣時間（+8），否則日期、時間會差 8 小時
  // V10.3：四版本紀錄會帶 webFields＝網頁表單原始欄位（值已經是網頁認得的：甜度 '5'、冰塊 'normal'、國家 '臺灣'…）；有的欄位優先用它，沒有的才用舊流程的預設
  const W = record.webFields && typeof record.webFields === 'object' && !Array.isArray(record.webFields) ? record.webFields : null;
  const w = (k, d) => (W && W[k] !== undefined && W[k] !== null && W[k] !== '' ? W[k] : d);
  const date = w('date', W && record.category === 'travel' ? '' : tp.date); // 四版本的交通：日期沒提到就留空（不拿傳訊息的日期代替）
  const time = w('time', tp.time);
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const tierTag = record.detailed ? '（' + lineTierName(record.tier) + '）' : '';
  const me = toAppUserName(record.userName);
  const noteOf = (tail) => (w('note', record.note) ? w('note', record.note) + ' · ' : '') + '📱 LINE自動同步' + tierTag + (tail || '');

  if (record.category === 'drink') {
    return { lsKey: 'boba_recs', entry: {
      id: genId(), panel: '1', sn: '', snp: '',
      date, time, country: w('country', ''), area: w('area', ''),
      brand: w('brand', record.brand || ''), drink: w('drink', record.item || ''), category: w('category', ''), size: w('size', record.size || ''), topping: w('topping', record.topping || ''),
      sugar: w('sugar', record.sugar || ''), ice: w('ice', record.ice || ''), payment: w('payment', record.payment || ''), currency: w('currency', 'NT$'), amount: Number(w('amount', record.amount)) || 0,
      drinker: w('drinker', me), payer: w('payer', me), recorder: w('recorder', me),
      note: noteOf(''), ainote: '', rating: Number(w('rating', record.rating)) || 0,
      source: 'LINE',
    } };
  }
  if (record.category === 'food') {
    return { lsKey: 'meal_recs', entry: {
      id: genId(), panel: '1', sn: '', snp: '',
      date, time, category: w('category', ''),
      brand: w('brand', record.brand || ''), dish: w('dish', record.item || ''), cuisine: w('cuisine', record.cuisine || ''), portion: w('portion', W ? '' : (record.portion || '中份')), spicy: w('spicy', ''), diningType: w('diningType', record.diningType || ''),
      satiety: '', revisit: '', rating: Number(w('rating', record.rating)) || 0, payment: w('payment', record.payment || ''), currency: w('currency', 'NT$'), amount: Number(w('amount', record.amount)) || 0,
      eater: w('eater', me), payer: w('payer', me), recorder: w('recorder', me),
      note: noteOf(''), ainote: '',
      source: 'LINE',
    } };
  }
  if (record.category === 'travel') {
    return { lsKey: 'travel_recs', entry: {
      id: genId(), panel: 'a', type: w('type', record.transportType || 'taxi'),
      date, no: w('no', ''), company: w('company', ''),
      depPort: w('depPort', record.depPort || ''), arrPort: w('arrPort', record.arrPort || ''), transitPort: w('transitPort', ''),
      depTime: w('depTime', W ? '' : time), arrTime: w('arrTime', ''), duration: '', ticketPrice: Number(w('ticketPrice', record.amount)) || 0,
      vehicleType: w('vehicleType', ''), regNo: '', seat: w('seat', ''), plateNo: '',
      note: noteOf(!W && record.item ? ' · ' + record.item : ''),
      recorder: w('recorder', me), payment: w('payment', record.payment || ''),
      source: 'LINE',
    } };
  }
  return null; // 記帳/分帳目前不支援自動同步（要選群組+對成員，無法全自動）
}
// 紀錄上標示的版本名稱（舊紀錄只有 standard／flagship；V10.3 起多了 simple／advanced）
const LINE_TIER_NAME = { simple: '簡易版', standard: '標準版', advanced: '進階版', flagship: '旗艦版' };
function lineTierName(tier) { return LINE_TIER_NAME[tier] || '標準版'; }

// 嘗試把記錄直接寫進使用者已綁定的同步資料裡；沒綁同步碼、或分類不支援，就回傳false（照舊只存line:log等手動匯入）
// 把一筆 LINE 紀錄寫進使用者「同步碼」底下的網頁資料。回傳：
//   'ok' 已寫入（或同一筆早就在了）｜'unbound' 還沒綁定同步碼｜'nodata' 同步碼底下還沒有網頁資料｜'skip' 這類紀錄沒有對應的網頁模組｜'nouser' 群組裡看不到傳訊息的人是誰（沒有 LINE 身分，沒辦法對應到同步碼，也不會自動重試）｜'fail' 失敗（會自動重試）
// 同一則 LINE 訊息（lineMsgId）只會寫入一次，重送／重試都不會重複；寫完會再讀一次確認，萬一被同時進來的寫入蓋掉就重做。
function nextVersion(prev) { return Math.max(Date.now(), Number(prev || 0) + 1); }
async function syncRecordToApp(userId, record, env) {
  const kv = env.SYNC_KV;
  if (!kv) return 'fail';
  if (!userId) return 'nouser';
  let code;
  try { code = await kv.get('line:usersync:' + userId); } catch (e) { return 'fail'; }
  const shaped = shapeForAutoSync(record);
  if (!shaped) return 'skip';
  if (!code) return 'unbound';
  const msgId = record.msgId || '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await kv.get(keyOf(code));
      if (!raw) return 'nodata';
      const rec = JSON.parse(raw);
      const data = rec.data || {};
      let arr;
      try { arr = data[shaped.lsKey] ? JSON.parse(data[shaped.lsKey]) : []; } catch (e) { arr = []; }
      if (msgId && arr.some((x) => x && x.lineMsgId === msgId)) return 'ok';
      const entry = Object.assign({}, shaped.entry, { lineMsgId: msgId, importedAt: Date.now() });
      arr.unshift(entry);
      data[shaped.lsKey] = JSON.stringify(arr);
      await kv.put(keyOf(code), JSON.stringify({ data, updated_at: nextVersion(rec.updated_at) }));
      const back = JSON.parse((await kv.get(keyOf(code))) || 'null');
      const backArr = back && back.data && back.data[shaped.lsKey] ? JSON.parse(back.data[shaped.lsKey]) : [];
      if (backArr.some((x) => x && (msgId ? x.lineMsgId === msgId : x.id === entry.id))) return 'ok';
    } catch (e) { /* 再試一次 */ }
  }
  return 'fail';
}
async function autoSyncRecord(userId, record, env) {
  return (await syncRecordToApp(userId, record, env)) === 'ok';
}

// 存進line:log（清單/紀錄）之外，同時試著自動同步進App；回傳這筆有沒有自動同步成功
// ===== 🌟乖寶寶集點卡：LINE輸入 =====
// 讀取使用者已綁定同步碼底下，某個localStorage key的陣列內容（例如孩子清單、行為清單）；沒綁定回傳null，key不存在回傳[]
async function fetchSyncedArray(userId, lsKey, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return null;
  const code = await kv.get('line:usersync:' + userId);
  if (!code) return null;
  const raw = await kv.get(keyOf(code));
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  const data = rec.data || {};
  try { return data[lsKey] ? JSON.parse(data[lsKey]) : []; } catch (e) { return []; }
}
// 把一筆集點事件寫進使用者同步資料的 sticker_events 裡（跟autoSyncRecord同一套安全讀取-修改-寫回做法）
async function writeStickerEvent(userId, entry, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return false;
  const code = await kv.get('line:usersync:' + userId);
  if (!code) return false;
  const raw = await kv.get(keyOf(code));
  if (!raw) return false;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return false; }
  const data = rec.data || {};
  let arr;
  try { arr = data.sticker_events ? JSON.parse(data.sticker_events) : []; } catch (e) { arr = []; }
  arr.unshift(entry);
  data.sticker_events = JSON.stringify(arr);
  await kv.put(keyOf(code), JSON.stringify({ data, updated_at: Date.now() }));
  return true;
}
// 處理「集點卡」進行中的LINE對話：選孩子→選行為→自動記點（乖寶寶集點卡；互助集點卡目前還沒接LINE）。
// 開始集點卡的入口在 handleKeywordRouter（依管理設定檢查權限）；「群組＋私訊」模式的流程只在 1對1 聊天室繼續。
async function handleStickerCardMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const ctx = makeCtx(ev);
  const userId = ctx.userId;
  if (!userId) return false;

  const session = await getFlagshipSession(userId, env);
  if (!session || session.flow !== 'stickerkid') return false; // 不是集點卡的session，交給別的handler
  if (ctx.isGroup && session.private) return false; // 私訊模式：群組裡的訊息不處理，避免在群組公開孩子資料
  // 每一步都重新檢查權限（管理員可能在流程中途改了設定）
  const cfg = await loadLineConfig(env);
  const av = checkAvailability('sticker', ctx, cfg);
  if (!av.ok) { await clearFlagshipSession(userId, env); await lineReply(token, ev.replyToken, av.message); return true; }

  if (/^(取消|cancel|結束|結束此次對話|離開|退出|quit|exit)$/i.test(text)) {
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, '已取消這次集點。', null);
    return true;
  }

  if (session.stage === 'pickKid') {
    const kid = session.kids.find((k) => k.name === text);
    if (!kid) {
      await lineReplyAsk(token, ev.replyToken, '請從清單裡選一個孩子：', session.kids.map((k) => k.name));
      return true;
    }
    const behaviors = await fetchSyncedArray(userId, 'sticker_behaviors', env);
    if (!behaviors || !behaviors.length) {
      await clearFlagshipSession(userId, env);
      await lineReply(token, ev.replyToken, '還沒有設定任何行為，先到App「🌟集點卡→👶乖寶寶集點卡→⚙️管理行為/獎勵」新增幾個行為吧。');
      return true;
    }
    session.stage = 'pickBehavior';
    session.kidId = kid.id;
    session.kidName = kid.name;
    session.behaviors = behaviors;
    await setFlagshipSession(userId, session, env);
    await lineReplyAsk(token, ev.replyToken, kid.name + ' 做了什麼？', behaviors.map((b) => b.name + ' +' + b.points).concat(['↩️ 返回']));
    return true;
  }

  if (session.stage === 'pickBehavior') {
    if (/^↩️?\s*返回$/.test(text)) {
      session.stage = 'pickKid';
      await setFlagshipSession(userId, session, env);
      await lineReplyAsk(token, ev.replyToken, '🌟 要幫哪個孩子集點？', session.kids.map((k) => k.name));
      return true;
    }
    const behavior = session.behaviors.find((b) => (b.name + ' +' + b.points) === text || b.name === text);
    if (!behavior) {
      await lineReplyAsk(token, ev.replyToken, '請從清單裡選一個行為：', session.behaviors.map((b) => b.name + ' +' + b.points));
      return true;
    }
    // V10.1：已綁定同步碼、草稿模式開著 → 不在 LINE 直接記點，改成建立「待確認草稿」；到網頁資料卡片按【確認新增】才正式記點並產生流水號
    const eligS = await draftEligibility(userId, env, cfg);
    if (eligS) {
      const whoS = await lineWho(token, ctx);
      const rawS = { kind: 'sticker', card: 'kid', kid: session.kidName, behavior: behavior.name, points: Number(behavior.points) > 0 ? Number(behavior.points) : null };
      const stS = await createDraftsAndReply({
        ev, token, env, ctx, userName: whoS.userName, groupName: '', text: session.kidName + ' ' + behavior.name, rawItems: [rawS], via: 'flow',
        replyToken: ev.replyToken, cfg: eligS.cfg, ts: Number(ev.timestamp), quiet: true, lists: { kids: session.kids, behaviors: session.behaviors },
        failQuick: session.behaviors.map((b) => b.name + ' +' + b.points).concat(['↩️ 返回']),
      });
      if (stS === 'created' || stS === 'blocked') { await clearFlagshipSession(userId, env); return true; }
      if (stS === 'failed') return true; // 草稿沒建立成功：保留流程，讓使用者可以再選一次
    }
    let userName = '';
    try { userName = (await lineProfile(token, userId)) || ''; } catch (e) {}
    const now = new Date();
    const p2b = (n) => String(n).padStart(2, '0');
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      kidId: session.kidId, behaviorId: behavior.id, behaviorName: behavior.name, points: Number(behavior.points) || 0,
      date: now.getFullYear() + '-' + p2b(now.getMonth() + 1) + '-' + p2b(now.getDate()),
      time: p2b(now.getHours()) + ':' + p2b(now.getMinutes()),
      recorder: toAppUserName(userName), note: '📱 LINE紀錄',
    };
    const ok = await writeStickerEvent(userId, entry, env);
    const kidName = session.kidName;
    await clearFlagshipSession(userId, env);
    if (ok) {
      await lineReplyQuick(token, ev.replyToken, '✅ 已幫「' + kidName + '」記錄「' + behavior.name + '」+' + behavior.points + ' 點！', null);
    } else {
      await lineReplyQuick(token, ev.replyToken, '存檔時發生問題，請稍後再試 🙏', null);
    }
    return true;
  }
  return false;
}

// 讀出 line:log（LINE 暫存清單）。內容壞掉（不是合法的 JSON、或不是清單）時：先把原文備份到另一個 key（line:log:corrupt:時間），再當成空清單處理 ——
// 不然一筆壞資料就會讓 LINE 永遠記不進去、網頁也永遠讀不出來。回傳 { list, corrupt, raw }
async function readLineLog(kv) {
  const raw = await kv.get('line:log');
  if (!raw) return { list: [], corrupt: false, raw: '' };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { list: parsed, corrupt: false, raw };
  } catch (e) { /* 往下當成損壞 */ }
  return { list: [], corrupt: true, raw };
}
const LINE_LOG_WRITE_DELAYS = [0, 300, 700, 1200]; // 寫入沒成功時，每一輪重試前先等多久（毫秒）：同一個 key 一秒內不能寫太多次，所以要拉開
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 把一筆記錄存進 line:log。幾個人「同一兩秒內」各傳一筆時，不能互相蓋掉：
//   ① 慢的「同步到網頁」先做完，② 之後才（重新）讀出最新的清單 → 加上這一筆 → 寫入，③ 馬上讀回來確認真的在裡面，沒在（被別人蓋掉）或寫入失敗就再來一次（最多 4 輪）。
// 4 輪都沒成功就丟出錯誤 —— LINE 會回「記錄時發生問題」，而不是假裝已經存好。
async function saveLineLogRecord(record, env) {
  const kv = env.SYNC_KV;
  if (!kv) throw new Error('no kv');
  // 同一則 LINE 訊息只會存一筆（LINE 重送、連按兩次「確認儲存」都不會重複新增）
  const isOurs = (r) => !!(r && (record.msgId
    ? (r.msgId === record.msgId && r.userId === record.userId && r.category === record.category)
    : (r.id === record.id && r.userId === record.userId && r.ts === record.ts)));
  const adopt = (dup) => { record.synced = !!dup.synced; record.syncStatus = dup.syncStatus; record.id = dup.id; return !!dup.synced; };
  const first = await readLineLog(kv);
  if (first.corrupt) { try { await kv.put('line:log:corrupt:' + Date.now(), first.raw); } catch (e) { /* 備份失敗也要讓新紀錄能存進去 */ } }
  const dup0 = first.list.find(isOurs);
  if (dup0) return adopt(dup0);

  const status = await syncRecordToApp(record.userId, record, env);
  record.syncStatus = status;
  record.synced = status === 'ok';
  if (status === 'fail') { record.syncTries = 1; try { await kv.put('line:retry:' + record.userId, '1'); } catch (e) {} }

  for (let attempt = 0; attempt < LINE_LOG_WRITE_DELAYS.length; attempt++) {
    if (LINE_LOG_WRITE_DELAYS[attempt]) await sleepMs(LINE_LOG_WRITE_DELAYS[attempt] + Math.floor(Math.random() * 150));
    try {
      const cur = await readLineLog(kv); // 重新讀最新的：別人剛存進來的不能被蓋掉
      const dup = cur.list.find(isOurs);
      if (dup) return adopt(dup); // 已經在裡面了（上一輪其實寫成功，或 LINE 同時重送了同一則）
      if (cur.list.some((r) => r && r.id === record.id)) record.id = record.id + '-' + Math.random().toString(36).slice(2, 6); // 同一毫秒進來的另一筆撞到編號：換一個，網頁匯入／移除才不會混在一起
      cur.list.push(record);
      await kv.put('line:log', JSON.stringify(cur.list));
      const back = await readLineLog(kv); // 讀回來確認真的存進去了
      if (back.list.some(isOurs)) return record.synced;
    } catch (e) { /* KV 暫時寫不進去（例如同一個 key 一秒內被寫太多次）→ 下一輪再試 */ }
  }
  throw new Error('line:log write not confirmed');
}

// 使用者在「確認取消」時選擇不取消 → 重新提示目前該回答的問題，讓他知道接著回答什麼
async function flagshipReprompt(session, token, replyToken) {
  if (!session.module) {
    await lineReplyButtons(token, replyToken, '請選擇模組', '（接續剛剛的紀錄）要記錄哪個模組呢？', [
      { label: '🧋 飲料', text: '飲料' },
      { label: '🍱 美食', text: '美食' },
      { label: '🚆 交通', text: '交通' },
      { label: '💰 記帳', text: '記帳' },
    ]);
    return;
  }
  if (session.module === 'travel' && !session.travelType) {
    await lineReplyAsk(token, replyToken, '（接續剛剛的紀錄）要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS);
    return;
  }
  if (!session.mode) {
    const flow = FLAGSHIP_SCHEMAS[session.flow];
    await askFormMode(token, replyToken, '（接續剛剛的紀錄）\n' + flow.label + '：要用哪種模式？', '要用哪一種？', ['單表單模式', '雙表單模式']);
    return;
  }
  const flow = FLAGSHIP_SCHEMAS[session.flow];
  if (flow.kind === 'freeform') {
    const prompt = session.stage === 'core' ? flow.core[0].prompt : flow.extended[0].prompt;
    await lineReplyAsk(token, replyToken, '（接續剛剛的紀錄）\n' + prompt, null);
    return;
  }
  const field = flagshipCurrentField(session);
  if (field) await lineReplyAsk(token, replyToken, '（接續剛剛的紀錄）\n' + field.q, field.quick);
}

// 表單模式提醒（使用者指定的用語；網頁新增紀錄表單最上方用的是同一段文字）
// v26.10.3：使用者說「選擇表單模式後沒有顯示提示」，網頁那邊補上一句「儲存後效果」粗體提醒（見 index.html 的 FM_TIP_SINGLE/DUAL）；
//   使用者接著說「LINE也要顯示」——LINE 的一般文字訊息完全沒有粗體／顏色可以用，所以這裡拆成 FORM_MODE_TEXT 結構化資料，LINE 那三個問「要用哪種模式」的地方改送 Flex 卡片（askFormMode，見下面），
//   「儲存後效果」那句用跟網頁一樣的顏色（#8b7355）＋粗體顯示，真的做到跟網頁一樣；FORM_MODE_REMINDER 這個純文字版留著不刪，給後台「版本規格頁」顯示、以及 Flex 卡片送失敗時的文字備援用。
//   雙表單這句跟網頁同步改短（原本多補的「（帶同一個配對編號）」在較窄螢幕會多繞一行、擠掉填寫區版面，見 index.html FM_TIP_DUAL 旁的說明），改回貼近使用者原本的用語。
const FORM_MODE_TEXT = {
  single: { label: '單表單模式（只填寫用戶 A）', desc: '適用於單一對象的獨立紀錄、個人資料異動或單向操作。', hi: '儲存後只新增這 1 筆個人紀錄。' },
  dual: { label: '雙表單模式（只填寫用戶 A＋用戶B）', desc: '針對「一次填寫兩個人的紀錄（先填用戶 A，再填用戶 B）」，核心在連貫性與資料關聯性。', hi: '單次儲存，雙方紀錄即時歸檔。' },
};
const FORM_MODE_REMINDER = FORM_MODE_TEXT.single.label + '：' + FORM_MODE_TEXT.single.desc + FORM_MODE_TEXT.single.hi + '\n' + FORM_MODE_TEXT.dual.label + '：' + FORM_MODE_TEXT.dual.desc + FORM_MODE_TEXT.dual.hi;
// V10.10：「表單模式」正式接進 LINE 的 REC4 引擎（六大功能×四版本）——使用者確認過的範圍與做法：
//   ・6 個模組都要，後台可以個別開關（預設全部關閉，cfg.formMode.modules）；
//   ・問法＝先把用戶A整套欄位問完，再整套問一次用戶B（跟網頁「先填➊再填➋」一樣）；兩筆用配對編號（pairId）連起來，做法跟網頁 fmPairUp 一致。
//   ・只支援「直接寫入」（saveLineLogRecord）這條路：草稿系統（createDraftsAndReply／buildDrafts）目前整批草稿只認一個 owner，沒有「同一批兩筆各自歸屬不同人」的機制，
//     擴充草稿系統是另一個獨立工程，這次沒有做——使用者開著「LINE 草稿模式」、或分帳／集點卡／待去清單（一律只能走草稿）時，雙表單會禮貌退回單表單並說明原因，不會送出歸屬錯誤的資料。
// V10.12：拿掉「雙表單模式下用戶A／用戶B要先在後台綁定LINE User ID」這個前提——使用者實際用過 V10.10.0 之後，
//   明確表示後台先設定太麻煩，要求「機器人主動辨識，不用設定」。改成：選了雙表單模式之後，當場從「已經傳過訊息給機器人、
//   查得到LINE顯示名稱」的已知使用者名單裡列出來（排除正在講話的這個人自己），點選哪一位就是這次的對方；一個都沒有時
//   （例如全新安裝、目前只有自己跟機器人說過話）就說明原因、退回單表單，不卡流程。cfg.formMode.aId／bId 這兩個舊欄位
//   不再被讀取（後台也拿掉對應的設定介面），但保留在設定檔結構裡不特別清除，避免沒必要的資料搬移風險。
const FORM_MODE_MODULE_KEYS = ['drink', 'food', 'travel', 'split', 'sticker', 'wish'];
// 這個模組有沒有開啟「表單模式」步驟（後台設定，預設全部關閉）
function formModeEnabled(cfg, modFn) { return !!(cfg && cfg.formMode && cfg.formMode.modules && cfg.formMode.modules[modFn]); }
// V10.13.0：這個模組的「選擇紀錄版本」卡／起手訊息要不要列出規則／互動規則文字（後台設定，預設全部關閉＝隱藏；跟表單模式一樣六個模組各自一個開關，LINE對話裡的任何指令都不能切換）
function ruleVisibleEnabled(cfg, modFn) { return !!(cfg && cfg.ruleVisible && cfg.ruleVisible.modules && cfg.ruleVisible.modules[modFn]); }
// 已知使用者名冊（line:registry 裡的 users，任何跟機器人說過話的人都會被記錄 LINE 顯示名稱）——V10.12 雙表單「對方是誰」當場選用的資料來源，跟後台「版本規格」頁列出的已知使用者是同一份。
async function rec4KnownUsers(env) {
  let reg = {};
  try { reg = JSON.parse((env.SYNC_KV ? await env.SYNC_KV.get(REGISTRY_KEY) : null) || '{}'); } catch (e) { reg = {}; }
  return (reg && reg.users && typeof reg.users === 'object' && !Array.isArray(reg.users)) ? reg.users : {};
}
// 雙表單「對方」候選名單：已知使用者裡排除自己、排除查不到LINE顯示名稱的人（按鈕要給使用者認人用，沒有名字沒辦法選、也不猜）。
async function rec4MateCandidates(env, selfId) {
  const users = await rec4KnownUsers(env);
  return Object.keys(users)
    .filter((uid) => uid !== selfId && users[uid] && users[uid].name)
    .map((uid) => ({ userId: uid, name: users[uid].name }));
}
// 問「要用哪種模式」的 Flex 卡片訊息物件（REC4 用——跟 askFormMode 共用同一套 formModeBubbleContents／FORM_MODE_TEXT 文字與樣式，
// 但用 REC4 既有的「回傳訊息物件、由 rec4Reply 統一送出、送失敗自動退回 altText」機制，不另外直接呼叫 lineReplyMessages）
function rec4FormModeMsg(sch) {
  const headingText = sch.icon + ' ' + sch.name + '：要用哪種模式？';
  const trailingText = '要用哪一種？';
  const altText = (headingText + '\n' + FORM_MODE_TEXT.single.label.replace(/（.*/, '') + '：' + FORM_MODE_TEXT.single.hi + '\n' + FORM_MODE_TEXT.dual.label.replace(/（.*/, '') + '：' + FORM_MODE_TEXT.dual.hi + '\n' + trailingText).slice(0, 390);
  return { type: 'flex', altText, contents: formModeBubbleContents(headingText, trailingText), quickReply: quickReplyItems(['單表單模式', '雙表單模式', '結束']) };
}
// V10.12：問「這次的另一位是誰」——選了雙表單模式之後，把候選人姓名直接列成快速回覆按鈕（最多 12 位＋「結束」，LINE快速回覆上限13顆）。
// 候選名單在問這一題的當下就固定住（存在 S.mateCandidates），使用者回答時照這份名單核對，不會因為名冊在回答途中又多了新人而改變這一題的選項。
function rec4PickMateMsg(sch, mates) {
  const text = sch.icon + ' ' + sch.name + '（雙表單）：這次的另一位是誰？';
  const opts = mates.slice(0, 12).map((m) => ({ label: m.name, text: m.name }));
  opts.push('結束');
  return rec4TextMsg(text, opts);
}
// 配對編號——做法跟網頁 fmNewPairId() 一致（同一個前綴格式），雙表單兩筆記錄共用同一個，才看得出是同一次存的
function rec4NewPairId() { return 'PR' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(); }
// LINE Flex 卡片版的表單模式提醒：headingText 放最上面（可省略）、trailingText 放最下面（例如「要用哪一種？」，可省略），中間固定是單表單／雙表單各一段（說明＋粗體「儲存後效果」，顏色跟網頁 --br 一致）
// V10.13.2：使用者逐行標出這張卡片原本太擠（標題／說明／「儲存後效果」／分隔線／另一個模式都幾乎沒有間距），
//   六處各補一個空一行（margin 從 'md'／沒設定 改成 'xl'，跟版本卡的空一行用同一個視覺語言）；分隔線本身沒有粗細可調（LINE Flex 的 separator 只有 type/margin/color 三個欄位），
//   改成跟「儲存後效果」同一個強調色 #8b7355（原本沒設定顏色，用 LINE 預設的淺灰），讓它更明顯。
function formModeBubbleContents(headingText, trailingText) {
  const body = [];
  if (headingText) body.push({ type: 'text', text: headingText, size: 'sm', wrap: true, weight: 'bold', color: '#5c4b37' });
  const block = (m, withTopMargin) => {
    body.push({ type: 'text', text: m.label, size: 'sm', weight: 'bold', color: '#5c4b37', margin: withTopMargin ? 'xl' : 'none' });
    body.push({ type: 'text', text: m.desc, size: 'xs', wrap: true, color: '#5c4b37' });
    body.push({ type: 'text', text: m.hi, size: 'xs', wrap: true, weight: 'bold', color: '#8b7355', margin: 'xl' });
  };
  block(FORM_MODE_TEXT.single, !!headingText);
  body.push({ type: 'separator', margin: 'xl', color: '#8b7355' });
  block(FORM_MODE_TEXT.dual, true);
  if (trailingText) body.push({ type: 'text', text: trailingText, size: 'sm', wrap: true, weight: 'bold', color: '#5c4b37', margin: 'xl' });
  return { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '16px', backgroundColor: '#f5ede4', contents: body } };
}
// 問「要用哪種模式」：送 Flex 卡片（有粗體、有顏色，跟網頁的視覺效果一致）＋快速回覆按鈕；LINE 拒絕卡片格式時，改送純文字備援（FORM_MODE_REMINDER），一樣帶按鈕，確保使用者一定看得到、一定能選
async function askFormMode(token, replyToken, headingText, trailingText, quickOptions) {
  const opts = (quickOptions || []).slice();
  if (!opts.includes('結束')) opts.push('結束');
  const altText = (headingText || '單表單模式／雙表單模式').replace(/\n/g, ' ').slice(0, 300);
  const msg = { type: 'flex', altText, contents: formModeBubbleContents(headingText, trailingText), quickReply: quickReplyItems(opts) };
  let res = null;
  try { res = await lineReplyMessages(token, replyToken, [msg]); } catch (e) { res = null; }
  if (!res || !res.ok) {
    try { console.log('LINE reply failed', res ? res.status : 'no response', res ? await res.text() : ''); } catch (e) {}
    const fallbackText = [headingText, FORM_MODE_REMINDER, trailingText].filter(Boolean).join('\n\n');
    try { await lineReplyMessages(token, replyToken, [rec4TextMsg(fallbackText, opts)]); } catch (e) {}
  }
}
// 表單模式的補充說明（V10.5.1，使用者 2026-11-12 的「表單模式設定與應用」）：適用場景與介面特點。後台「表單模式提醒」顯示；網頁表單的「適用場景與特點」用同樣的文字。
//   使用者原稿的資料庫用語（主表、主鍵／外鍵）和「僅用戶 A 欄位：姓名／ID、金額／項目、備註」這個 App 沒有這樣的設計，改寫成不會說錯的白話：只新增 1 筆紀錄、只關聯用戶 A、欄位沿用該功能原本的表單
const FORM_MODE_MORE = [
  { title: '單表單模式（只填寫用戶 A）', lines: [
    '適用場景：個人日常紀錄（用戶 A 的個人消費、個人點數異動、簽到）、單人業務申請（個人資料修改、單人預約）。',
    '欄位與介面特點：介面精簡，只填「用戶 A」一份表單，欄位就是該功能原本的表單；操作流暢，預設帶入目前操作者或選定的用戶 A；儲存時只新增 1 筆紀錄，只關聯用戶 A。',
  ] },
  { title: '雙表單模式（只填寫用戶 A＋用戶B）', lines: [
    '常用於：雙人點數發放／扣除、轉帳紀錄、同房／同行登記、管理員一次性批次登錄兩位用戶資料。',
    '儲存時一次寫入 2 筆紀錄（➊、➋ 各一筆），兩筆會帶同一個配對編號連在一起；之後編輯其中一筆，畫面會提醒這是同一次的另一筆。',
  ] },
];

// 選完模組（交通還要選完子類型）之後共用的下一步：旗艦版非飲料先誠實告知還在開發；其餘進到選模式
async function flagshipProceedAfterModule(session, userId, env, token, replyToken) {
  if (session.flow === 'drink' && session.module !== 'drink') {
    await clearFlagshipSession(userId, env);
    const moduleLabel = session.module === 'travel'
      ? (TRAVEL_TYPE_LABELS[session.travelType] || MODULE_LABELS.travel)
      : MODULE_LABELS[session.module];
    await lineReplyQuick(token, replyToken, moduleLabel + ' 的旗艦版問答還在開發中，目前只有🧋飲料做完整套流程，其他會陸續完成，敬請期待 🙏', null);
    return;
  }
  await setFlagshipSession(userId, session, env);
  const flow = FLAGSHIP_SCHEMAS[session.flow];
  await askFormMode(token, replyToken, flow.label + '：要用哪種模式？', '要用哪一種？', ['單表單模式', '雙表單模式', '↩️ 返回']);
}

// 處理旗艦版／簡易版／標準版的多輪問答訊息（三種tier共用同一套引擎，用session.flow分辨）。
// 回傳 true 代表這則訊息已經處理完畢；回傳 false 代表跟這套機制無關，交給 handleExpenseMessage 處理。
// ============================================================
// 📋 LINE 功能選單／關鍵字辨識／群組權限
//   設定存在 KV（line:config），在 App「設定」頁面管理；從來沒存過設定時，使用下面的預設值。
//   ・功能選單：輸入「功能選單」或「紀錄」，內容由設定決定（主選單、子選單、順序、啟用、適用聊天室）。
//   ・關鍵字：精確／部分／包含／模糊，全部走同一套規則；選單按鈕送出的文字 = 子選單名稱（等同精確關鍵字），
//     所以「點按鈕」跟「直接打字」一定進到同一個功能。
//   ・權限：每個功能可設定 1對1／群組、群組是否需授權、可使用的人、群組能否新增資料、個人資料的回覆方式；
//     一律在「功能真的執行時」由伺服器檢查，不是只藏按鈕。
// ============================================================
const DEFAULT_APP_URL = 'https://sda.hongxiaoge0615.workers.dev';
const CONFIG_KEY = 'line:config';
const REGISTRY_KEY = 'line:registry';
const BACK_LABEL = '\u21A9\uFE0F 返回';
const BACK_RE = /^\u21A9\uFE0F?\s*返回$/;
const QUICK_CANCEL_RE = /^(取消|cancel|結束|結束此次對話|離開|退出|quit|exit)$/i;
const SCOPE_LIST = ['both', 'direct', 'group'];
const TYPE_LIST = ['exact', 'partial', 'contains', 'fuzzy'];
const MODULE_NAMES = ['飲料', '美食', '交通', '記帳']; // 舊版簡易版／標準版／旗艦版「選模組」按鈕的文字

// 程式裡真的有實作的功能（管理員可以決定「哪些關鍵字、哪個選單、哪裡能用」，但功能本身要有程式才能新增）
const FUNCTION_CATALOG = {
  menu: { label: '功能選單', writes: false, personal: false },
  drink: { label: '飲料紀錄', writes: true, personal: false },
  food: { label: '美食紀錄', writes: true, personal: false },
  travel: { label: '交通紀錄', writes: true, personal: false },
  ledger: { label: '記帳', writes: true, personal: false },
  split: { label: '分帳管理', writes: false, personal: false },
  split_add: { label: '記一筆分帳', writes: true, personal: false },
  sticker: { label: '集點卡', writes: true, personal: true },
  wishlist: { label: '待去清單', writes: false, personal: true },
  wish_add: { label: '新增待去地點', writes: true, personal: true }, // V10.1：LINE 新增待去地點（先變成待確認草稿，到網頁確認後才寫入待去清單）
  drafts: { label: '待確認草稿', writes: false, personal: true },
  device: { label: '設備管理中心', writes: false, personal: false }, // V10.4：選單項目；功能內容待確認，目前只回覆說明
  tool_compass: { label: '奇遇羅盤', writes: false, personal: false }, // V10.4：LINE 工具（選地點）
  tool_surprise: { label: '驚喜製造所', writes: false, personal: false }, // （選店家）
  tool_wheel: { label: '轉盤', writes: false, personal: false },
  tool_coin: { label: '拋硬幣', writes: false, personal: false },
  tool_bottle: { label: '轉瓶子', writes: false, personal: false },
  tool_box: { label: '隨機盒子', writes: false, personal: false },
  tool_dice: { label: '骰子', writes: false, personal: false },
  tool_rps: { label: '剪刀石頭布', writes: false, personal: false }, // 手動出拳（互動對決）
  tool_rps_auto: { label: '自動剪刀石頭布', writes: false, personal: false }, // V10.6.0：一鍵自動對決（點一下就出結果）
  // 新增：FAQ常見問答（25題，使用者提供的標準文案核對過實際行為後的版本；純文字回覆，不開始任何流程、不寫入任何資料）
  faq_name: { label: 'FAQ：自我介紹', writes: false, personal: false },
  faq_capability: { label: 'FAQ：功能說明', writes: false, personal: false },
  faq_version: { label: 'FAQ：版本選擇說明', writes: false, personal: false },
  faq_howto: { label: 'FAQ：系統與LINE使用說明', writes: false, personal: false },
  faq_linename: { label: 'FAQ：LINE機器人名稱', writes: false, personal: false },
  faq_lineuse: { label: 'FAQ：LINE操作方式', writes: false, personal: false },
  faq_formmode: { label: 'FAQ：單雙表單差別', writes: false, personal: false },
  faq_groupsilent: { label: 'FAQ：群組沒反應說明', writes: false, personal: false },
  faq_restart: { label: 'FAQ：重新開始操作', writes: false, personal: false },
  faq_draftmode: { label: 'FAQ：草稿模式說明', writes: false, personal: false },
  faq_iconissue: { label: 'FAQ：圖示異常排除', writes: false, personal: false },
  faq_forgotpw: { label: 'FAQ：忘記密碼', writes: false, personal: false },
  faq_tools: { label: 'FAQ：互動小工具列表', writes: false, personal: false },
  faq_crosssync: { label: 'FAQ：跨裝置同步說明', writes: false, personal: false },
  faq_statcenter: { label: 'FAQ：統計中心分類', writes: false, personal: false },
  faq_customopt: { label: 'FAQ：自訂選項說明', writes: false, personal: false },
  faq_dualsave: { label: 'FAQ：雙表單儲存方式', writes: false, personal: false },
  faq_dualpartial: { label: 'FAQ：雙人紀錄中途離開', writes: false, personal: false },
  faq_bizhours: { label: 'FAQ：待去清單營業狀態', writes: false, personal: false },
  faq_photolimit: { label: 'FAQ：照片限制說明', writes: false, personal: false },
  faq_midnight: { label: 'FAQ：午夜時區說明', writes: false, personal: false },
  faq_doubletap: { label: 'FAQ：防重複送出說明', writes: false, personal: false },
  faq_snnoreuse: { label: 'FAQ：流水號不補號', writes: false, personal: false },
  faq_csvexport: { label: 'FAQ：CSV匯出說明', writes: false, personal: false },
  faq_synccode: { label: 'FAQ：同步碼說明', writes: false, personal: false },
};
// FAQ：每個 fn 對應的固定回覆文字。內容已對照程式實際行為核對過，跟使用者原始文案描述不一致的地方（忘記密碼、草稿模式、待去清單營業狀態判斷、互動小工具名稱、同步碼用語）已修正為真實行為，不是照抄原文。
const FAQ_REPLIES = {
  faq_name: '我是「日常小秘書」！專門協助你整理日常飲食消費、同行分帳、集點與待去清單，個人視窗或群組都能用。',
  faq_capability: '我可以幫你管理生活紀錄，主要有：\n・六大模組：飲料、美食、交通、分帳、集點卡、待去清單，快速建檔與查詢\n・8種免開網頁的互動小工具，直接對話就能玩\n・LINE與網頁版資料即時互通',
  faq_version: '輸入「紀錄○○」（例如紀錄飲料）或「日常小秘書」會跳出選版本卡：🟢簡易版／🟡標準版／🟠進階版／🔵旗艦版。旗艦版目前只有🧋飲料做完整流程，其他模組的旗艦版還在開發中，會誠實告知。',
  faq_howto: 'LINE適合外出時單手快速記帳、拍照上傳或玩小工具；網頁版適合一次檢視雙表單並列輸入、看統計中心報表、做進階設定。兩邊資料即時互通。',
  faq_linename: '我在LINE上的名字是「日常小秘書」。1對1聊天室可以直接輸入指令或點選單；群組裡要打對關鍵字（模組名稱＋「紀錄」，或輸入「日常小秘書」）我才會回應——目前還不支援用@標註我來啟動。',
  faq_lineuse: '在LINE使用很簡單：①點底部圖文選單直接選功能；②照卡片提示一步步填寫；③操作到一半想重新開始，隨時輸入「返回主選單」清空暫存。',
  faq_formmode: '單表單模式只填一位使用者，存檔後建立1筆個人紀錄；雙表單模式左右兩側同時填兩位使用者，存檔後雙方紀錄一次建立。',
  faq_groupsilent: '為了不打擾大家在群組裡聊天，群組模式需要明確指令（按鈕或關鍵字）才會啟動回覆；一般聊天我會保持安靜、不插話。',
  faq_restart: '請直接點卡片下方「返回主選單」，或在對話框輸入「返回主選單」或「取消」，會立即清空剛剛未完成的暫存步驟。',
  faq_draftmode: '這是你自己設定的開關：到網頁「系統設定」打開「草稿模式」，六個模組在LINE送出後都會先進網頁「待確認草稿」，到網頁確認後才正式寫入；關閉的話就直接寫入，不用再到網頁確認。',
  faq_iconissue: '圖示沒顯示通常是網路不穩或圖床暫時延遲，建議切換網路（Wi-Fi／行動網路）或重新開啟對話視窗，持續發生可以輸入「功能選單」確認其他功能是否正常。',
  faq_forgotpw: '請在網頁登入畫面點「忘記密碼」，目前會引導你點「建立新帳號」重新註冊——目前沒有寄送Email驗證信重設密碼的機制。',
  faq_tools: '免開網頁的互動小工具共8個，LINE點選互動選單就能玩：🧭奇遇羅盤（選地點）、🎁驚喜製造所（選店家）、🎡轉盤、🪙拋硬幣、🍾轉瓶子、📦隨機盒子、🎲骰子，以及✌️剪刀／✊石頭／✋布／🤖自動對決。',
  faq_crosssync: '可以！只要兩台裝置輸入同一組「同步碼」，手機LINE確認送出的紀錄會即時同步到電腦、平板的網頁版，編號也會自動排序不重複。',
  faq_statcenter: '統計中心提供7項分類檢視：🌐全館、🧋飲料、🍱美食、🚆交通、🧾分帳、🌟集點卡、🗺️待去清單，可以隨時切換分類查看明細與累積紀錄。',
  faq_customopt: '下拉選單找不到想要的項目時，點選「自訂...」就會展開輸入框讓你手動填寫；常用的項目建議到上方參數設定新增，之後可以直接點選。',
  faq_dualsave: '雙表單模式下，畫面左側是用戶A、右側是用戶B，兩邊可以同時各自填寫，全部填妥後點畫面下方共用的「確認儲存」一次送出，系統會自動檢查兩側必填欄位。',
  faq_dualpartial: '不會喔！填寫過程中資料只會先放在暫存區，必須等你按下最後的「確認」才會正式寫入資料庫；中途離開不會留下殘缺的單邊紀錄。',
  faq_bizhours: '待去清單的營業狀態是即時比對「現在的時間」與店家營業時間自動判斷的（不是你預計到訪的時間），每30秒自動更新，狀態分5種：🟢營業中／🟡即將打烊／🟠即將營業／🔴休息中／⚪資訊未提供。',
  faq_photolimit: '單張照片請盡量不要太大，建議用LINE一般畫質傳送，避免傳送超大原始檔；如果傳了沒反應，可能是檔案過大或網路不穩，建議重新用一般畫質傳送一次。',
  faq_midnight: '系統統一鎖定台灣標準時間（GMT+8），只要過了午夜00:00，所有建檔紀錄都會精準歸入當天的日期。',
  faq_doubletap: '系統有防重複寫入機制，短時間內重複點擊同一個送出指令只會執行一次寫入，不會產生重複紀錄。',
  faq_snnoreuse: '不會。每一筆資料的流水號都是獨立且鎖定的，刪除舊紀錄後，新紀錄一律依目前最大號往後加1，不會回收或補用舊編號。',
  faq_csvexport: '可以！在網頁版的資料管理或設定區，支援將紀錄匯出成通用的.csv表格檔案，用Excel就能直接檢視、篩選與備份。',
  faq_synccode: '只要在兩台裝置的「系統設定」輸入同一組「同步碼」，你的收藏、資料夾與紀錄就會在手機、平板、電腦之間自動即時同步。',
};
const QUICK_KINDS = {
  food: { fn: 'food', label: '🍽️ 美食紀錄', category: 'food', examples: ['拉麵 180', '鼎泰豐小籠包中份現金380'] },
  travel: { fn: 'travel', label: '🚗 交通紀錄', category: 'travel', examples: ['台北到台中 1490', '計程車 250'] },
  other: { fn: 'ledger', label: '🧾 記帳', category: 'other', examples: ['薪水 30000', '房租 12000'] },
  split: { fn: 'split_add', label: '💰 分帳', category: 'split', examples: ['晚餐 1200 AA', '唱歌 3000 我先付'] },
  wish: { fn: 'wish_add', label: '📍 新增待去地點', category: 'wish', examples: ['九份老街', '台南 林百貨 週末想去', '日本京都 賞楓 11月'] },
};
const CATEGORY_FN = { drink: 'drink', food: 'food', travel: 'travel', split: 'split_add', wish: 'wish_add', other: 'ledger' };
const MODULE_FN = { drink: 'drink', food: 'food', travel: 'travel', split: 'ledger' };

function isGroupSource(src) { return !!(src && (src.type === 'group' || src.type === 'room')); }
function sourceGroupId(src) { return src ? (src.groupId || src.roomId || '') : ''; }
function makeCtx(ev) {
  const isGroup = isGroupSource(ev.source);
  return { isGroup, chat: isGroup ? 'group' : 'direct', groupId: sourceGroupId(ev.source), userId: (ev.source && ev.source.userId) || '' };
}

// ---------- 預設設定 ----------
// 功能選單顯示規則的版本：1＝V10.3 以前（根選單把全部展開）；2＝V10.4（根選單只列第一層，每個選單只顯示自己的項目）
const MENU_RULES_V = 2;
// V10.6.0：「工具」格子的版本。2＝多了「自動剪刀石頭布」；V10.9.0：3＝「✌️ 剪刀石頭布」（手動單一格，按了要再選一次）拆成「剪刀」「石頭」「布」3 個各自一點就直接出結果的格子。存過設定、但 menu 裡沒有 toolsV 的舊設定視為 1：載入時（upgradeToolsMenu）補上新格子；管理員到後台存檔後，設定裡就有 toolsV=3，不會再補
const TOOLS_V = 3;
// 新增：FAQ常見問答關鍵字的版本。存過設定、但 menu 裡沒有 faqKwV 的舊設定視為 0：載入時（upgradeFaqKeywords）自動補上這批新關鍵字；
//   已經存在的關鍵字（不論是不是這批新增的）不會被覆蓋或重複加；管理員到後台存檔後，設定裡就是目前這個版本號，不會再補。
//   V10.15（2→）：25題原本只有「完全比對規格原句」，使用者實際上幾乎打不出一字不差的句子，等於形同沒有這個功能——
//   每題再補2～3組口語版關鍵字（contains・1對1限定），upgradeFaqKeywords 不用改，既有的「用keyword文字比對是否已存在」邏輯會自動連這批也一起補上。
const FAQ_KW_V = 2;
// V10.3.0 以前的預設選單與關鍵字（只用來判斷「存在 KV 裡的設定有沒有被使用者改過」；不要修改）
function legacyDefaultLineConfigV103() {
  let n = 0;
  const kw = (keyword, fn, type, scope, priority, extra) => Object.assign({ id: 'kw' + (++n), keyword, fn, type, priority, scope, enabled: true, confirm: false, note: '' }, extra || {});
  const perm = (extra) => Object.assign({ enabled: true, chat: 'both', requireGroupAuth: false, groupWrite: true, groupReply: 'private', allowedUsers: [] }, extra || {});
  return {
    v: 1,
    mainMenus: [
      { id: 'm_log', name: '飲食與交通紀錄', emoji: '🥤', order: 1, enabled: true, scope: 'both', functionId: null },
      { id: 'm_acct', name: '帳務管理', emoji: '💰', order: 2, enabled: true, scope: 'both', functionId: null },
      { id: 'm_sticker', name: '集點卡', emoji: '🎟️', order: 3, enabled: true, scope: 'both', functionId: 'sticker' },
      { id: 'm_wish', name: '待去清單', emoji: '📍', order: 4, enabled: true, scope: 'both', functionId: 'wishlist' },
    ],
    subMenus: [
      { id: 's_drink', mainId: 'm_log', name: '飲料紀錄', emoji: '🥤', order: 1, enabled: true, functionId: 'drink' },
      { id: 's_food', mainId: 'm_log', name: '美食紀錄', emoji: '🍽️', order: 2, enabled: true, functionId: 'food' },
      { id: 's_travel', mainId: 'm_log', name: '交通紀錄', emoji: '🚗', order: 3, enabled: true, functionId: 'travel' },
      { id: 's_ledger', mainId: 'm_acct', name: '記帳', emoji: '🧾', order: 1, enabled: true, functionId: 'ledger' },
      { id: 's_split', mainId: 'm_acct', name: '分帳管理', emoji: '💰', order: 2, enabled: true, functionId: 'split' },
    ],
    keywords: [
      kw('功能選單', 'menu', 'exact', 'both', 1), kw('紀錄', 'menu', 'exact', 'both', 1),
      kw('記錄', 'menu', 'exact', 'direct', 5), kw('主選單', 'menu', 'exact', 'direct', 5), kw('回主選單', 'menu', 'exact', 'direct', 5),
      kw('menu', 'menu', 'exact', 'direct', 5), kw('home', 'menu', 'exact', 'direct', 5),
      kw('功能選單', 'menu', 'contains', 'direct', 20), kw('功能選單', 'menu', 'fuzzy', 'direct', 90),
      kw('飲料紀錄', 'drink', 'exact', 'both', 1), kw('飲料', 'drink', 'exact', 'both', 2),
      kw('飲料紀錄', 'drink', 'contains', 'direct', 20), kw('飲料紀錄', 'drink', 'fuzzy', 'direct', 90),
      kw('美食紀錄', 'food', 'exact', 'both', 1), kw('美食', 'food', 'exact', 'both', 2),
      kw('美食紀錄', 'food', 'contains', 'direct', 20), kw('美食紀錄', 'food', 'fuzzy', 'direct', 90),
      kw('交通紀錄', 'travel', 'exact', 'both', 1), kw('交通', 'travel', 'exact', 'both', 2),
      kw('交通紀錄', 'travel', 'contains', 'direct', 20), kw('交通紀錄', 'travel', 'fuzzy', 'direct', 90),
      kw('帳務管理', 'menu:m_acct', 'exact', 'both', 1), kw('帳務管理', 'menu:m_acct', 'contains', 'direct', 20),
      kw('記帳', 'ledger', 'exact', 'both', 1),
      kw('分帳管理', 'split', 'exact', 'both', 1), kw('分帳', 'split', 'exact', 'both', 2),
      kw('分帳管理', 'split', 'contains', 'direct', 20), kw('分帳管理', 'split', 'fuzzy', 'direct', 90),
      kw('記一筆分帳', 'split_add', 'exact', 'both', 1),
      kw('集點卡', 'sticker', 'exact', 'both', 1), kw('集點', 'sticker', 'exact', 'both', 2),
      kw('集', 'sticker', 'exact', 'both', 9, { confirm: true, note: '單字容易誤判，輸入時會先請使用者確認' }),
      kw('集點卡', 'sticker', 'contains', 'direct', 20), kw('集點卡', 'sticker', 'fuzzy', 'direct', 90),
      kw('待去清單', 'wishlist', 'exact', 'both', 1), kw('待去', 'wishlist', 'exact', 'both', 2),
      kw('待去清單', 'wishlist', 'contains', 'direct', 20), kw('待去清單', 'wishlist', 'fuzzy', 'direct', 90),
      kw('待確認草稿', 'drafts', 'exact', 'both', 1), kw('草稿', 'drafts', 'exact', 'both', 2), kw('待確認', 'drafts', 'exact', 'both', 3),
    ],
    permissions: {
      drink: perm(), food: perm(), travel: perm(), ledger: perm(), split: perm(), split_add: perm(),
      sticker: perm({ requireGroupAuth: true, groupReply: 'private' }),
      wishlist: perm({ requireGroupAuth: true, groupReply: 'private' }),
      wish_add: perm({ requireGroupAuth: true, groupReply: 'private' }),
      drafts: perm({ groupReply: 'private' }),
    },
    groups: {},
    fuzzy: { suggest: 0.6, auto: 0.9 },
    query: { defaultVersion: '' },
    draft: { enabled: true }, // V9：LINE 輸入的飲料／美食／交通，先建立「待確認草稿」到網頁確認後才儲存（關閉＝回到 LINE 裡確認儲存）
  };
}

function defaultLineConfig() {
  let n = 0;
  const kw = (keyword, fn, type, scope, priority, extra) => Object.assign({ id: 'kw' + (++n), keyword, fn, type, priority, scope, enabled: true, confirm: false, note: '' }, extra || {});
  const perm = (extra) => Object.assign({ enabled: true, chat: 'both', requireGroupAuth: false, groupWrite: true, groupReply: 'private', allowedUsers: [] }, extra || {});
  const cfg = {
    v: 1,
    mainMenus: [
      { id: 'm_log', name: '紀錄', emoji: '📝', order: 1, enabled: true, scope: 'both', functionId: null },
      { id: 'm_acct', name: '帳務管理', emoji: '💰', order: 6, enabled: false, scope: 'both', functionId: null },
      { id: 'm_sticker', name: '集點卡', emoji: '🎟️', order: 2, enabled: true, scope: 'both', functionId: 'sticker' },
      { id: 'm_wish', name: '待去清單', emoji: '📍', order: 3, enabled: true, scope: 'both', functionId: 'wishlist' },
      { id: 'm_device', name: '設備管理中心', emoji: '🛠️', order: 4, enabled: true, scope: 'both', functionId: 'device' },
      { id: 'm_tools', name: '工具', emoji: '🧰', order: 5, enabled: true, scope: 'both', functionId: null, layout: 'grid' }, // V10.5：工具＝九宮格（每 3 格一列，最後一格固定是「返回主選單」）；V10.6.0 起 9 個工具（含「自動剪刀石頭布」）＋返回主選單＝10 格（4 列）；V10.9.0 起剪刀石頭布拆成剪刀／石頭／布／自動 4 格，11 個工具＋返回主選單＝12 格（4 列）；其他選單維持清單
    ],
    subMenus: [
      { id: 's_drink', mainId: 'm_log', name: '飲料紀錄', emoji: '🥤', order: 2, enabled: true, functionId: 'drink' },
      { id: 's_food', mainId: 'm_log', name: '美食紀錄', emoji: '🍽️', order: 1, enabled: true, functionId: 'food' },
      { id: 's_travel', mainId: 'm_log', name: '交通紀錄', emoji: '🚗', order: 3, enabled: true, functionId: 'travel' },
      { id: 's_split_add', mainId: 'm_log', name: '分帳', emoji: '💰', order: 4, enabled: true, functionId: 'split_add' },
      { id: 's_sticker', mainId: 'm_log', name: '集點卡', emoji: '🎟️', order: 5, enabled: true, functionId: 'sticker' },
      { id: 's_wish', mainId: 'm_log', name: '待去清單', emoji: '📍', order: 6, enabled: true, functionId: 'wishlist' },
      { id: 's_t_compass', mainId: 'm_tools', name: '奇遇羅盤（選地點）', emoji: '🧭', order: 1, enabled: true, functionId: 'tool_compass', hint: '選地點' },
      { id: 's_t_surprise', mainId: 'm_tools', name: '驚喜製造所（選店家）', emoji: '🎁', order: 2, enabled: true, functionId: 'tool_surprise', hint: '選店家' },
      { id: 's_t_wheel', mainId: 'm_tools', name: '轉盤', emoji: '🎡', order: 3, enabled: true, functionId: 'tool_wheel', hint: '幫你決定' },
      { id: 's_t_coin', mainId: 'm_tools', name: '拋硬幣', emoji: '🪙', order: 4, enabled: true, functionId: 'tool_coin', hint: '正面或反面' },
      { id: 's_t_bottle', mainId: 'm_tools', name: '轉瓶子', emoji: '🍾', order: 5, enabled: true, functionId: 'tool_bottle', hint: '誰請客' },
      { id: 's_t_box', mainId: 'm_tools', name: '隨機盒子', emoji: '📦', order: 6, enabled: true, functionId: 'tool_box', hint: '開獎' },
      { id: 's_t_dice', mainId: 'm_tools', name: '骰子', emoji: '🎲', order: 7, enabled: true, functionId: 'tool_dice', hint: '擲骰子' },
      // V10.9.0：剪刀石頭布拆成剪刀／石頭／布／自動 4 格，每格一點就直接出結果（不用像以前「剪刀石頭布」單一格一樣，按了還要再選一次）。
      //   name 是格子上顯示的名稱，cmd 是實際送出的隱藏指令（見 buildMenuMessage；沒有 cmd 的格子，送出的還是 name，跟以前一樣）。
      { id: 's_t_rps_scissors', mainId: 'm_tools', name: '剪刀', emoji: '✌️', order: 8, enabled: true, functionId: 'tool_rps', hint: '一點就出', cmd: '出拳 剪刀' },
      { id: 's_t_rps_rock', mainId: 'm_tools', name: '石頭', emoji: '✊', order: 9, enabled: true, functionId: 'tool_rps', hint: '一點就出', cmd: '出拳 石頭' },
      { id: 's_t_rps_paper', mainId: 'm_tools', name: '布', emoji: '✋', order: 10, enabled: true, functionId: 'tool_rps', hint: '一點就出', cmd: '出拳 布' },
      { id: 's_t_rps_auto', mainId: 'm_tools', name: '自動', emoji: '🤖', order: 11, enabled: true, functionId: 'tool_rps_auto', hint: '一鍵出結果', cmd: '自動剪刀石頭布' },
      { id: 's_ledger', mainId: 'm_acct', name: '記帳', emoji: '🧾', order: 1, enabled: true, functionId: 'ledger' },
      { id: 's_split', mainId: 'm_acct', name: '分帳管理', emoji: '💰', order: 2, enabled: true, functionId: 'split' },
    ],
    keywords: [
      kw('功能選單', 'menu', 'exact', 'both', 1), // 「紀錄」「工具」…這些主選單名稱，由系統自動對應到各自的選單（見 buildRules），不在這裡重複寫
      kw('記錄', 'menu:m_log', 'exact', 'direct', 5), kw('主選單', 'menu', 'exact', 'direct', 5), kw('回主選單', 'menu', 'exact', 'direct', 5),
      kw('menu', 'menu', 'exact', 'direct', 5), kw('home', 'menu', 'exact', 'direct', 5),
      kw('功能選單', 'menu', 'contains', 'direct', 20), kw('功能選單', 'menu', 'fuzzy', 'direct', 90),
      kw('飲料紀錄', 'drink', 'exact', 'both', 1), kw('飲料', 'drink', 'exact', 'both', 2),
      kw('飲料紀錄', 'drink', 'contains', 'direct', 20), kw('飲料紀錄', 'drink', 'fuzzy', 'direct', 90),
      kw('美食紀錄', 'food', 'exact', 'both', 1), kw('美食', 'food', 'exact', 'both', 2),
      kw('美食紀錄', 'food', 'contains', 'direct', 20), kw('美食紀錄', 'food', 'fuzzy', 'direct', 90),
      kw('交通紀錄', 'travel', 'exact', 'both', 1), kw('交通', 'travel', 'exact', 'both', 2),
      kw('交通紀錄', 'travel', 'contains', 'direct', 20), kw('交通紀錄', 'travel', 'fuzzy', 'direct', 90),
      kw('記帳', 'ledger', 'exact', 'both', 1),
      kw('分帳管理', 'split', 'exact', 'both', 1), kw('分帳', 'split_add', 'exact', 'both', 2),
      kw('分帳管理', 'split', 'contains', 'direct', 20), kw('分帳管理', 'split', 'fuzzy', 'direct', 90),
      kw('記一筆分帳', 'split_add', 'exact', 'both', 1),
      kw('集點卡', 'sticker', 'exact', 'both', 1), kw('集點', 'sticker', 'exact', 'both', 2),
      kw('集', 'sticker', 'exact', 'both', 9, { confirm: true, note: '單字容易誤判，輸入時會先請使用者確認' }),
      kw('集點卡', 'sticker', 'contains', 'direct', 20), kw('集點卡', 'sticker', 'fuzzy', 'direct', 90),
      kw('待去清單', 'wishlist', 'exact', 'both', 1), kw('待去', 'wishlist', 'exact', 'both', 2),
      kw('待去清單', 'wishlist', 'contains', 'direct', 20), kw('待去清單', 'wishlist', 'fuzzy', 'direct', 90),
      kw('待確認草稿', 'drafts', 'exact', 'both', 1), kw('草稿', 'drafts', 'exact', 'both', 2), kw('待確認', 'drafts', 'exact', 'both', 3),
      kw('擲骰子', 'tool_dice', 'exact', 'both', 2), kw('骰骰子', 'tool_dice', 'exact', 'both', 2), kw('猜拳', 'tool_rps', 'exact', 'both', 2),
      kw('擲硬幣', 'tool_coin', 'exact', 'both', 2), kw('丟硬幣', 'tool_coin', 'exact', 'both', 2), kw('選地點', 'tool_compass', 'exact', 'both', 2), kw('選店家', 'tool_surprise', 'exact', 'both', 2),
      kw('自動猜拳', 'tool_rps_auto', 'exact', 'both', 2, { id: 'kw_rps_auto' }),
      // 新增：FAQ常見問答（25題）——關鍵字＝使用者會問的完整問句，完全比對才觸發，不影響其他較短的關鍵字
      // V10.15：每題再補2～3組口語版關鍵字（contains・優先度20）。
      // V10.16：口語版改成跟規格原句一樣 scope:'both'，群組也會生效（使用者明確要求）——
      //   跟專案裡其他模組的 contains 版本（例如「飲料紀錄」）只限1對1不同，這批FAQ口語詞是刻意的例外，見交付說明裡的風險提醒。
      kw('請告訴我你的名字', 'faq_name', 'exact', 'both', 3),
      kw('你叫什麼名字', 'faq_name', 'contains', 'both', 20), kw('你的名字是什麼', 'faq_name', 'contains', 'both', 20), kw('你是誰', 'faq_name', 'contains', 'both', 20),
      kw('請告訴我你可以做什麼？', 'faq_capability', 'exact', 'both', 3),
      kw('你可以做什麼', 'faq_capability', 'contains', 'both', 20), kw('你有什麼功能', 'faq_capability', 'contains', 'both', 20), kw('你能幫我做什麼', 'faq_capability', 'contains', 'both', 20),
      kw('請告知我如何使用，並選擇要詢問的版本', 'faq_version', 'exact', 'both', 3),
      kw('版本有哪些', 'faq_version', 'contains', 'both', 20), kw('版本差在哪', 'faq_version', 'contains', 'both', 20), kw('版本怎麼選', 'faq_version', 'contains', 'both', 20),
      kw('請告知我系統及LINE怎麼使用', 'faq_howto', 'exact', 'both', 3),
      kw('LINE跟網頁差別', 'faq_howto', 'contains', 'both', 20), kw('手機跟電腦差別', 'faq_howto', 'contains', 'both', 20), kw('怎麼用這個系統', 'faq_howto', 'contains', 'both', 20),
      kw('請告知我LINE聊天機器人的名字', 'faq_linename', 'exact', 'both', 3),
      kw('LINE上的名字', 'faq_linename', 'contains', 'both', 20), kw('LINE機器人叫什麼', 'faq_linename', 'contains', 'both', 20), kw('機器人叫什麼名字', 'faq_linename', 'contains', 'both', 20),
      kw('請告知我LINE聊天機器人如何使用', 'faq_lineuse', 'exact', 'both', 3),
      kw('LINE怎麼用', 'faq_lineuse', 'contains', 'both', 20), kw('LINE怎麼操作', 'faq_lineuse', 'contains', 'both', 20), kw('怎麼在LINE使用', 'faq_lineuse', 'contains', 'both', 20),
      kw('單表單模式與雙表單模式有什麼差別？', 'faq_formmode', 'exact', 'both', 3),
      kw('表單模式差別', 'faq_formmode', 'contains', 'both', 20), kw('單雙表單差在哪', 'faq_formmode', 'contains', 'both', 20), kw('單人雙人模式差別', 'faq_formmode', 'contains', 'both', 20),
      kw('為什麼我在群組傳訊息，機器人沒有反應？', 'faq_groupsilent', 'exact', 'both', 3),
      kw('群組沒反應', 'faq_groupsilent', 'contains', 'both', 20), kw('群組叫不動', 'faq_groupsilent', 'contains', 'both', 20), kw('群組沒用', 'faq_groupsilent', 'contains', 'both', 20),
      kw('操作到一半按錯或畫面卡住，要怎麼重新開始？', 'faq_restart', 'exact', 'both', 3),
      kw('卡住怎麼辦', 'faq_restart', 'contains', 'both', 20), kw('按錯怎麼重來', 'faq_restart', 'contains', 'both', 20), kw('怎麼重新開始', 'faq_restart', 'contains', 'both', 20),
      kw('哪些紀錄在LINE會直接儲存，哪些會變成網頁草稿？', 'faq_draftmode', 'exact', 'both', 3),
      kw('草稿模式是什麼', 'faq_draftmode', 'contains', 'both', 20), kw('什麼是草稿模式', 'faq_draftmode', 'contains', 'both', 20), kw('草稿怎麼用', 'faq_draftmode', 'contains', 'both', 20),
      kw('為什麼畫面上的Icon圖示沒有顯示出來？', 'faq_iconissue', 'exact', 'both', 3),
      kw('圖示不見了', 'faq_iconissue', 'contains', 'both', 20), kw('圖示顯示不出來', 'faq_iconissue', 'contains', 'both', 20), kw('圖示壞了', 'faq_iconissue', 'contains', 'both', 20),
      kw('忘記網頁版的登入帳號或密碼怎麼辦？', 'faq_forgotpw', 'exact', 'both', 3),
      kw('忘記密碼', 'faq_forgotpw', 'contains', 'both', 20), kw('密碼忘記了', 'faq_forgotpw', 'contains', 'both', 20), kw('忘記帳號', 'faq_forgotpw', 'contains', 'both', 20),
      kw('免開網頁的互動小工具有哪些？怎麼玩？', 'faq_tools', 'exact', 'both', 3),
      kw('有什麼小工具', 'faq_tools', 'contains', 'both', 20), kw('小工具怎麼玩', 'faq_tools', 'contains', 'both', 20), kw('好玩的工具', 'faq_tools', 'contains', 'both', 20),
      kw('我在手機LINE記的資料，電腦網頁版看得到嗎？', 'faq_crosssync', 'exact', 'both', 3),
      kw('手機跟電腦會同步嗎', 'faq_crosssync', 'contains', 'both', 20), kw('資料會同步嗎', 'faq_crosssync', 'contains', 'both', 20), kw('手機記的電腦看得到嗎', 'faq_crosssync', 'contains', 'both', 20),
      kw('統計中心可以查看哪些資料？', 'faq_statcenter', 'exact', 'both', 3),
      kw('統計中心是什麼', 'faq_statcenter', 'contains', 'both', 20), kw('統計中心可以看什麼', 'faq_statcenter', 'contains', 'both', 20), kw('哪裡看統計', 'faq_statcenter', 'contains', 'both', 20),
      kw('選單裡沒有我要的品項、店家或平台怎麼辦？', 'faq_customopt', 'exact', 'both', 3),
      kw('沒有我要的選項', 'faq_customopt', 'contains', 'both', 20), kw('找不到我要的店家', 'faq_customopt', 'contains', 'both', 20), kw('選單沒有我要的', 'faq_customopt', 'contains', 'both', 20),
      kw('網頁版的「左A右B」雙表單要怎麼一起儲存？', 'faq_dualsave', 'exact', 'both', 3),
      kw('雙表單怎麼存', 'faq_dualsave', 'contains', 'both', 20), kw('左A右B怎麼儲存', 'faq_dualsave', 'contains', 'both', 20), kw('雙人表單怎麼一起存', 'faq_dualsave', 'contains', 'both', 20),
      kw('填雙人紀錄填到一半離開，資料會留一半嗎？', 'faq_dualpartial', 'exact', 'both', 3), // 原文含①②➊➋➔特殊符號，使用者實際打不出來，改成可以直接輸入的同義問句
      kw('填一半會不會存檔', 'faq_dualpartial', 'contains', 'both', 20), kw('填到一半離開會怎樣', 'faq_dualpartial', 'contains', 'both', 20), kw('雙人紀錄填一半', 'faq_dualpartial', 'contains', 'both', 20),
      kw('「待去清單」要怎麼知道店家現在有沒有營業？', 'faq_bizhours', 'exact', 'both', 3),
      kw('怎麼知道店家有沒有營業', 'faq_bizhours', 'contains', 'both', 20), kw('店家現在營業嗎', 'faq_bizhours', 'contains', 'both', 20), kw('待去清單營業狀態', 'faq_bizhours', 'contains', 'both', 20),
      kw('傳送照片給機器人有什麼限制？為什麼有時候傳了沒反應？', 'faq_photolimit', 'exact', 'both', 3),
      kw('照片傳不出去', 'faq_photolimit', 'contains', 'both', 20), kw('傳照片沒反應', 'faq_photolimit', 'contains', 'both', 20), kw('照片有限制嗎', 'faq_photolimit', 'contains', 'both', 20),
      kw('凌晨12點過後記帳，日期會算在今天還是昨天？', 'faq_midnight', 'exact', 'both', 3),
      kw('凌晨記帳算哪天', 'faq_midnight', 'contains', 'both', 20), kw('跨過午夜算今天還是昨天', 'faq_midnight', 'contains', 'both', 20), kw('半夜記帳日期算誰', 'faq_midnight', 'contains', 'both', 20),
      kw('不小心連點了兩次儲存按鈕，會變成兩筆重複的紀錄嗎？', 'faq_doubletap', 'exact', 'both', 3),
      kw('連點兩次會不會重複', 'faq_doubletap', 'contains', 'both', 20), kw('按兩次儲存會怎樣', 'faq_doubletap', 'contains', 'both', 20), kw('點太多次會重複紀錄嗎', 'faq_doubletap', 'contains', 'both', 20),
      kw('刪除紀錄後，原本的流水編號會補號或重複使用嗎？', 'faq_snnoreuse', 'exact', 'both', 3),
      kw('刪除後編號會補回來嗎', 'faq_snnoreuse', 'contains', 'both', 20), kw('流水號會重複用嗎', 'faq_snnoreuse', 'contains', 'both', 20), kw('編號刪掉會不會補', 'faq_snnoreuse', 'contains', 'both', 20),
      kw('我可以把系統裡的紀錄匯出成Excel檔案備份嗎？', 'faq_csvexport', 'exact', 'both', 3),
      kw('可以匯出excel嗎', 'faq_csvexport', 'contains', 'both', 20), kw('怎麼備份', 'faq_csvexport', 'contains', 'both', 20), kw('匯出csv', 'faq_csvexport', 'contains', 'both', 20),
      kw('什麼是「同步空間代碼」？怎麼跟另一台手機或電腦同步？', 'faq_synccode', 'exact', 'both', 3),
      kw('同步碼是什麼', 'faq_synccode', 'contains', 'both', 20), kw('怎麼跟另一台同步', 'faq_synccode', 'contains', 'both', 20), kw('同步碼怎麼用', 'faq_synccode', 'contains', 'both', 20),
    ],
    permissions: {
      drink: perm(), food: perm(), travel: perm(), ledger: perm(), split: perm(), split_add: perm(),
      sticker: perm({ requireGroupAuth: true, groupReply: 'private' }),
      wishlist: perm({ requireGroupAuth: true, groupReply: 'private' }),
      wish_add: perm({ requireGroupAuth: true, groupReply: 'private' }),
      drafts: perm({ groupReply: 'private' }),
      device: perm({ chat: 'direct' }),
    },
    groups: {},
    fuzzy: { suggest: 0.6, auto: 0.9 },
    query: { defaultVersion: '' },
    draft: { enabled: true }, // V9：LINE 輸入的飲料／美食／交通，先建立「待確認草稿」到網頁確認後才儲存（關閉＝回到 LINE 裡確認儲存）
    menu: { style: 'collapsed', rulesV: MENU_RULES_V, toolsV: TOOLS_V, faqKwV: FAQ_KW_V }, // V10.4：功能選單只列第一層；各選單只顯示自己的項目（toolsV：V10.6.0「工具」格子的版本；faqKwV：FAQ常見問答關鍵字的版本）
    // V10.10：「表單模式」正式接進 LINE（飲料／美食／交通／分帳／集點卡／待去清單紀錄時可以選單表單／雙表單）。
    //   aId／bId：V10.10.0 原本用來綁定用戶A／用戶B的LINE User ID；V10.12 起不再讀取（雙表單的「對方是誰」改成當場從已知使用者選），
    //     這兩個欄位留著只是不破壞舊設定檔結構，沒有實際作用；
    //   modules：6個模組各自的開關，預設全部關閉，後台設定頁打開才會在對應模組問「要用哪種模式」。
    formMode: { aId: '', bId: '', modules: { drink: false, food: false, travel: false, split: false, sticker: false, wish: false } },
    // V10.13.0：「規則顯示」開關——6個模組各自控制「選擇紀錄版本」卡、起手訊息要不要列出規則／互動規則文字；
    //   預設全部關閉＝隱藏（不主動說明、複述或暗示規則存在），使用者在LINE對話裡輸入任何指令都無法切換，只能在後台開。
    ruleVisible: { modules: { drink: false, food: false, travel: false, split: false, sticker: false, wish: false } },
  };
  TOOL_FNS.forEach((f) => { cfg.permissions[f] = perm(); }); // 工具：1 對 1、群組都能用，結果直接回在同一個聊天室
  Object.keys(FAQ_REPLIES).forEach((f) => { cfg.permissions[f] = perm(); }); // FAQ：1對1、群組都能用，純文字回覆，不寫入任何資料
  return cfg;
}

// ---------- 驗證／整理設定（存檔時嚴格檢查，讀取時寬鬆處理）----------
const LAYOUT_LIST = ['list', 'grid'];
function normalizeScopeOverlap(a, b) { return a === 'both' || b === 'both' || a === b; }
function isValidFn(fn, mainIds) {
  if (FUNCTION_CATALOG[fn]) return true;
  if (typeof fn === 'string' && fn.indexOf('url:') === 0) return fn.slice(4).trim().length > 0; // V10.14：對應功能可以是自訂網址（'url:'開頭）；網址格式（必須是http/https）在 sanitizeConfig 另外驗證
  return typeof fn === 'string' && fn.indexOf('menu:') === 0 && mainIds.has(fn.slice(5));
}
function sanitizeConfig(input) {
  const errors = [];
  const warnings = [];
  const d = defaultLineConfig();
  const inp = input && typeof input === 'object' ? input : {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const num = (v, def) => { const x = Number(v); return isFinite(x) ? x : def; };
  const bool = (v, def) => (v === undefined || v === null ? def : !!v);
  const pick = (v, list, def) => (list.indexOf(v) >= 0 ? v : def);

  const mains = [];
  const mainIds = new Set();
  (Array.isArray(inp.mainMenus) ? inp.mainMenus : d.mainMenus).slice(0, 20).forEach((m, i) => {
    m = m || {};
    const name = str(m.name, 40); // V10.14：按鈕名稱上限跟著 iconButton 實際能顯示的長度放寬（20→40），避免「打得出來、畫面卻被裁掉」
    if (!name) { errors.push('第 ' + (i + 1) + ' 個主選單沒有名稱'); return; }
    const id = str(m.id, 40) || ('m_' + Date.now().toString(36) + i);
    if (mainIds.has(id)) { errors.push('主選單 ID 重複：' + id); return; }
    mainIds.add(id);
    const dm = d.mainMenus.find((x) => x.id === id);
    const mFidRaw = String(m.functionId || '');
    mains.push({ id, name, emoji: str(m.emoji, 8), order: num(m.order, i + 1), enabled: bool(m.enabled, true), scope: pick(m.scope, SCOPE_LIST, 'both'), functionId: m.functionId ? (mFidRaw.indexOf('url:') === 0 ? 'url:' + str(mFidRaw.slice(4), 500) : str(mFidRaw, 60)) : null, layout: pick(m.layout, LAYOUT_LIST, (dm && dm.layout) || 'list') }); // V10.5：沒存過 layout 的舊設定，照預設選單（工具＝九宮格，其餘＝清單）；存過的就尊重。V10.14：對應功能若是自訂網址（'url:'開頭），放寬到500字（一般功能ID仍是60字）
  });
  mains.forEach((m) => {
    if (m.functionId && m.functionId === 'menu:' + m.id) { errors.push('主選單「' + m.name + '」不能指向自己'); m.functionId = null; }
    else if (m.functionId && m.functionId.indexOf('url:') === 0 && !/^url:https?:\/\/.+/i.test(m.functionId)) { errors.push('主選單「' + m.name + '」的自訂網址格式不正確，網址開頭要是 http:// 或 https://'); m.functionId = null; }
    else if (m.functionId && !isValidFn(m.functionId, mainIds)) { errors.push('主選單「' + m.name + '」對應的功能不存在：' + m.functionId); m.functionId = null; }
  });

  const subs = [];
  const subIds = new Set();
  (Array.isArray(inp.subMenus) ? inp.subMenus : d.subMenus).slice(0, 100).forEach((s, i) => {
    s = s || {};
    const name = str(s.name, 40); // V10.14：按鈕名稱上限跟著 iconButton 實際能顯示的長度放寬（20→40）
    if (!name) { errors.push('第 ' + (i + 1) + ' 個子選單沒有名稱'); return; }
    const id = str(s.id, 40) || ('s_' + Date.now().toString(36) + i);
    if (subIds.has(id)) { errors.push('子選單 ID 重複：' + id); return; }
    if (!mainIds.has(str(s.mainId, 40))) { errors.push('子選單「' + name + '」所屬的主選單不存在'); return; }
    const sFidRaw = String(s.functionId || '');
    const functionId = sFidRaw.indexOf('url:') === 0 ? 'url:' + str(sFidRaw.slice(4), 500) : str(sFidRaw, 60); // V10.14：自訂網址放寬到500字
    if (functionId.indexOf('url:') === 0 && !/^url:https?:\/\/.+/i.test(functionId)) { errors.push('子選單「' + name + '」的自訂網址格式不正確，網址開頭要是 http:// 或 https://'); return; }
    if (!isValidFn(functionId, mainIds)) { errors.push('子選單「' + name + '」沒有對應到有效的功能'); return; }
    subIds.add(id);
    const ds = d.subMenus.find((x) => x.id === id);
    subs.push({ id, mainId: str(s.mainId, 40), name, emoji: str(s.emoji, 8), order: num(s.order, i + 1), enabled: bool(s.enabled, true), functionId, hint: s.hint === undefined ? (ds && ds.hint) || '' : str(s.hint, 12), cmd: s.cmd === undefined ? (ds && ds.cmd) || '' : str(s.cmd, 40) }); // V10.5：九宮格格子上的小字；沒存過的舊設定照預設，存成空白的就是不顯示。V10.9.0：cmd＝格子實際送出的隱藏指令（沒設就送 name，見 buildMenuMessage）；一樣是沒存過照預設、存成空白就是沒有覆蓋
  });

  const kws = [];
  const kwIds = new Set();
  (Array.isArray(inp.keywords) ? inp.keywords : d.keywords).slice(0, 300).forEach((k, i) => {
    k = k || {};
    const keyword = str(k.keyword, 30);
    if (!keyword) { errors.push('第 ' + (i + 1) + ' 筆關鍵字是空的'); return; }
    const fnRaw = String(k.fn || '');
    const fn = fnRaw.indexOf('url:') === 0 ? 'url:' + str(fnRaw.slice(4), 500) : str(fnRaw, 60); // V10.14：自訂網址放寬到500字
    if (fn.indexOf('url:') === 0 && !/^url:https?:\/\/.+/i.test(fn)) { errors.push('關鍵字「' + keyword + '」的自訂網址格式不正確，網址開頭要是 http:// 或 https://'); return; }
    if (!isValidFn(fn, mainIds)) { errors.push('關鍵字「' + keyword + '」沒有對應到有效的功能'); return; }
    let id = str(k.id, 40) || ('kw_' + Date.now().toString(36) + i);
    if (kwIds.has(id)) id = id + '_' + i;
    kwIds.add(id);
    kws.push({ id, keyword, fn, type: pick(k.type, TYPE_LIST, 'exact'), priority: Math.max(1, Math.min(999, Math.round(num(k.priority, 10)))), scope: pick(k.scope, SCOPE_LIST, 'both'), enabled: bool(k.enabled, true), confirm: bool(k.confirm, false), note: str(k.note, 100) });
  });

  const perms = {};
  const inpPerms = inp.permissions && typeof inp.permissions === 'object' ? inp.permissions : {};
  Object.keys(FUNCTION_CATALOG).forEach((fn) => {
    if (fn === 'menu') return;
    const p = Object.assign({}, d.permissions[fn], inpPerms[fn] || {});
    perms[fn] = {
      enabled: bool(p.enabled, true), chat: pick(p.chat, SCOPE_LIST, 'both'), requireGroupAuth: bool(p.requireGroupAuth, false),
      groupWrite: bool(p.groupWrite, true), groupReply: pick(p.groupReply, ['private', 'public'], 'private'),
      allowedUsers: Array.isArray(p.allowedUsers) ? p.allowedUsers.map((u) => str(u, 64)).filter(Boolean).slice(0, 50) : [],
    };
  });

  const groups = {};
  const inpGroups = inp.groups && typeof inp.groups === 'object' ? inp.groups : {};
  Object.keys(inpGroups).slice(0, 200).forEach((gid) => { const g = inpGroups[gid] || {}; groups[str(gid, 64)] = { name: str(g.name, 40), authorized: !!g.authorized }; });

  const fz = inp.fuzzy && typeof inp.fuzzy === 'object' ? inp.fuzzy : d.fuzzy;
  const fuzzy = { suggest: Math.max(0.4, Math.min(0.95, num(fz.suggest, 0.6))), auto: Math.max(0.7, Math.min(1, num(fz.auto, 0.9))) };
  if (fuzzy.suggest >= fuzzy.auto) errors.push('模糊比對：「提示建議」的門檻必須小於「自動執行」的門檻');

  const qd = inp.query && typeof inp.query === 'object' ? inp.query.defaultVersion : '';
  const query = { defaultVersion: ['simple', 'standard', 'flagship'].indexOf(qd) >= 0 ? qd : '' };
  const drIn = inp.draft && typeof inp.draft === 'object' ? inp.draft : d.draft;
  const draft = { enabled: drIn.enabled === false ? false : true };
  // V10.10：表單模式（單／雙）正式接進 LINE——用戶A／B的LINE User ID綁定＋6個模組各自的開關
  const fmIn = inp.formMode && typeof inp.formMode === 'object' ? inp.formMode : {};
  const fmModIn = fmIn.modules && typeof fmIn.modules === 'object' ? fmIn.modules : {};
  const formMode = { aId: str(fmIn.aId, 64), bId: str(fmIn.bId, 64), modules: {} };
  FORM_MODE_MODULE_KEYS.forEach((k) => { formMode.modules[k] = bool(fmModIn[k], false); });
  if (formMode.aId && formMode.bId && formMode.aId === formMode.bId) { errors.push('表單模式：用戶A、用戶B不能是同一個 LINE 帳號'); formMode.bId = ''; }
  // V10.13.0：「規則顯示」開關——沿用表單模式同一組六個模組 key；預設全部關閉（隱藏）
  const rvIn = inp.ruleVisible && typeof inp.ruleVisible === 'object' ? inp.ruleVisible : {};
  const rvModIn = rvIn.modules && typeof rvIn.modules === 'object' ? rvIn.modules : {};
  const ruleVisible = { modules: {} };
  FORM_MODE_MODULE_KEYS.forEach((k) => { ruleVisible.modules[k] = bool(rvModIn[k], false); });
  const mIn = inp.menu && typeof inp.menu === 'object' ? inp.menu : null;
  const legacySaved = !mIn && Array.isArray(inp.mainMenus) && inp.mainMenus.length > 0; // 有存選單、但沒有 menu 欄位＝V10.3 以前存下來的設定：維持舊的展開方式，後台會提示可以套用新版（完全沒存選單的不算）
  const menu = legacySaved
    ? { style: 'expanded', rulesV: 1 }
    : { style: pick(mIn && mIn.style, ['collapsed', 'expanded'], d.menu.style), rulesV: mIn ? Math.max(1, Math.min(MENU_RULES_V, Math.floor(num(mIn.rulesV, MENU_RULES_V)))) : d.menu.rulesV, toolsV: mIn ? Math.max(1, Math.min(TOOLS_V, Math.floor(num(mIn.toolsV, 1)))) : d.menu.toolsV, faqKwV: mIn ? Math.max(0, Math.min(FAQ_KW_V, Math.floor(num(mIn.faqKwV, 0)))) : d.menu.faqKwV }; // V10.6.0：存過設定、但沒有 toolsV ＝ 1（還沒有「自動剪刀石頭布」格子）；沒有 faqKwV ＝ 0（還沒有這批FAQ關鍵字）
  const cfg = { v: 1, mainMenus: mains, subMenus: subs, keywords: kws, permissions: perms, groups, fuzzy, query, draft, menu, formMode, ruleVisible };

  // 衝突檢查：同一個「完全相同的關鍵字」，在同一種聊天室裡不能同時指向兩個不同的功能
  const exact = buildRules(cfg).filter((r) => r.enabled && r.type === 'exact');
  const seen = [];
  const reported = new Set();
  exact.forEach((r) => {
    const nk = normalizeKeyword(r.keyword);
    seen.forEach((o) => {
      if (o.nk === nk && o.fn !== r.fn && normalizeScopeOverlap(o.scope, r.scope)) {
        const key = nk + '|' + [o.fn, r.fn].sort().join('|');
        if (reported.has(key)) return;
        reported.add(key);
        errors.push('關鍵字「' + r.keyword + '」同時指向「' + fnLabel(o.fn, cfg) + '」和「' + fnLabel(r.fn, cfg) + '」，請先修改其中一個');
      }
    });
    seen.push({ nk, fn: r.fn, scope: r.scope });
  });
  mains.forEach((m) => { if (m.enabled && !m.functionId && !subs.some((s) => s.mainId === m.id && s.enabled)) warnings.push('主選單「' + m.name + '」目前沒有任何啟用的子選單，LINE 選單不會顯示它'); });
  return { config: cfg, errors, warnings };
}
function fnLabel(fn, cfg) {
  const info = fnInfo(fn, cfg);
  return info ? info.label : fn;
}
function fnInfo(fn, cfg) {
  if (FUNCTION_CATALOG[fn]) return FUNCTION_CATALOG[fn];
  if (typeof fn === 'string' && fn.indexOf('url:') === 0) return { label: '🔗 開啟網址', writes: false, personal: false }; // V10.14：自訂網址
  if (typeof fn === 'string' && fn.indexOf('menu:') === 0) {
    const m = ((cfg && cfg.mainMenus) || []).find((x) => x.id === fn.slice(5));
    return m ? { label: m.name, writes: false, personal: false } : null;
  }
  return null;
}
// V10.6.0：存在 KV 裡的設定，「工具」九宮格還沒有「自動剪刀石頭布」（menu.toolsV < 2）→ 載入時補上；
// V10.9.0：「✌️ 剪刀石頭布」（手動單一格，按了要再選一次）拆成「剪刀」「石頭」「布」3 個各自一點就直接出結果的格子（menu.toolsV < 3）。
//   都不寫回 KV；管理員到後台按儲存後，就是他自己的設定了。
//   ・只在有「工具」主選單時才補／拆格子；自動剪刀石頭布已經有任何格子指向這個功能就不重複補（補上的格子排在工具清單最後面）；
//     已經拆過、或已經刪掉／改掉「剪刀石頭布」這一格（id 或 functionId 不是原來的）的人，不會被動補回來或重新拆。
//   ・剪刀／石頭／布 3 個新格子一律用新的預設圖示與小字（✌️／✊／✋、一點就出）——這是結構性的拆分，不是外觀微調，不保留舊格子被改過的名稱或圖示。
//   ・拆格、補格之後，「工具」底下的格子統一按目前排序重新編號（1、2、3…），避免拆 3 格、補 1 格造成順序號彼此衝突；其他選單的排序不動。
//   ・預設關鍵字「自動猜拳」同樣補上（管理員已經拿這個詞去用的就不補）。
function upgradeToolsMenu(cfg) {
  if (!cfg || !cfg.menu || (cfg.menu.toolsV || 1) >= TOOLS_V) return cfg;
  const d = defaultLineConfig();
  const subs = (cfg.subMenus || []).map((s) => Object.assign({}, s));
  const kws = (cfg.keywords || []).map((k) => Object.assign({}, k));
  if ((cfg.mainMenus || []).some((m) => m.id === 'm_tools')) {
    const rpsIdx = subs.findIndex((s) => s.id === 's_t_rps' && s.functionId === 'tool_rps');
    if (rpsIdx >= 0) {
      const old = subs[rpsIdx];
      const base = Number(old.order) || 0;
      const wasEnabled = old.enabled !== false; // 原本停用的話，拆出來的 3 格也要維持停用
      const fresh = ['s_t_rps_scissors', 's_t_rps_rock', 's_t_rps_paper'].map((id, i) => Object.assign({}, d.subMenus.find((s) => s.id === id), { order: base + i / 1000, enabled: wasEnabled }));
      subs.splice(rpsIdx, 1, ...fresh);
    }
    if (!subs.some((s) => s.functionId === 'tool_rps_auto')) {
      const ds = d.subMenus.find((s) => s.id === 's_t_rps_auto');
      const last = subs.filter((s) => s.mainId === 'm_tools').reduce((a, s) => Math.max(a, Number(s.order) || 0), 0);
      const id = subs.some((s) => s.id === ds.id) ? ds.id + '_' + subs.length : ds.id;
      subs.push(Object.assign({}, ds, { id, order: last + 1 }));
    }
    let n = 0;
    subs.filter((s) => s.mainId === 'm_tools').sort((a, b) => a.order - b.order).forEach((s) => { s.order = ++n; });
  }
  const dk = d.keywords.find((k) => k.fn === 'tool_rps_auto');
  if (dk && !kws.some((k) => normalizeKeyword(k.keyword) === normalizeKeyword(dk.keyword))) kws.push(Object.assign({}, dk));
  return Object.assign({}, cfg, { subMenus: subs, keywords: kws, menu: Object.assign({}, cfg.menu, { toolsV: TOOLS_V }) });
}
// 新增：存在KV裡、已經是目前選單版本（rulesV）的舊設定，載入時自動補上這批FAQ關鍵字（見FAQ_REPLIES／FAQ_KW_V）；
//   管理員已經刪掉或改過某一題的關鍵字，不會被動補回來；都不寫回KV，管理員到後台存檔後才算定案（跟 upgradeToolsMenu 同一套做法）
function upgradeFaqKeywords(cfg) {
  if (!cfg || !cfg.menu || (cfg.menu.faqKwV || 0) >= FAQ_KW_V) return cfg;
  const d = defaultLineConfig();
  const kws = (cfg.keywords || []).map((k) => Object.assign({}, k));
  d.keywords.filter((k) => FAQ_REPLIES[k.fn]).forEach((dk2) => {
    if (!kws.some((k) => normalizeKeyword(k.keyword) === normalizeKeyword(dk2.keyword))) kws.push(Object.assign({}, dk2));
  });
  return Object.assign({}, cfg, { keywords: kws, menu: Object.assign({}, cfg.menu, { faqKwV: FAQ_KW_V }) });
}
async function loadLineConfig(env) {
  let stored = null;
  try { const raw = env.SYNC_KV ? await env.SYNC_KV.get(CONFIG_KEY) : null; if (raw) stored = JSON.parse(raw); } catch (e) { stored = null; }
  const cfg = sanitizeConfig(stored || {}).config;
  if (!stored) return cfg;
  if (cfg.menu && cfg.menu.rulesV >= MENU_RULES_V) return upgradeFaqKeywords(upgradeToolsMenu(cfg));
  // V10.3 以前存下來的設定：選單和關鍵字跟當時的預設一模一樣（沒被改過）→ 直接換成新版預設；改過的 → 原樣保留（不偷偷覆蓋），後台會提示可以一鍵套用
  const legacy = sanitizeConfig(legacyDefaultLineConfigV103()).config;
  if (menuSignature(cfg) === menuSignature(legacy)) {
    const nd = defaultLineConfig();
    return upgradeFaqKeywords(sanitizeConfig(Object.assign({}, stored, { mainMenus: nd.mainMenus, subMenus: nd.subMenus, keywords: nd.keywords, menu: nd.menu })).config);
  }
  return upgradeFaqKeywords(cfg);
}
// 只比會影響行為的欄位（不比 id、說明文字）
function menuSignature(c) {
  return JSON.stringify([
    (c.mainMenus || []).map((m) => [m.id, m.name, m.emoji || '', m.order, !!m.enabled, m.scope, m.functionId || null]),
    (c.subMenus || []).map((s) => [s.id, s.mainId, s.name, s.emoji || '', s.order, !!s.enabled, s.functionId]),
    (c.keywords || []).map((k) => [k.keyword, k.fn, k.type, k.scope, k.priority, !!k.enabled, !!k.confirm]),
  ]);
}

// ---------- 關鍵字規則 ----------
function normalizeKeyword(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[。.!！?？~～]+$/, '').toLowerCase();
}
// 規則 = 管理員設定的關鍵字 ＋ 系統自動加的「完全相同」規則（功能名稱、子選單名稱、主選單名稱），
// 後者保證選單按鈕送出的文字一定找得到對應功能，不會因為誤刪關鍵字而讓按鈕失效
function buildRules(cfg) {
  const rules = (cfg.keywords || []).map((k) => ({ keyword: k.keyword, fn: k.fn, type: k.type, scope: k.scope, priority: k.priority, enabled: k.enabled, confirm: k.confirm, id: k.id }));
  Object.keys(FUNCTION_CATALOG).forEach((fn) => rules.push({ keyword: FUNCTION_CATALOG[fn].label, fn, type: 'exact', scope: 'both', priority: 0, enabled: true, confirm: false, implicit: true }));
  (cfg.mainMenus || []).forEach((m) => { if (m.enabled) rules.push({ keyword: m.name, fn: m.functionId || ('menu:' + m.id), type: 'exact', scope: 'both', priority: 0, enabled: true, confirm: false, implicit: true }); });
  (cfg.subMenus || []).forEach((s) => { if (s.enabled) rules.push({ keyword: s.name, fn: s.functionId, type: 'exact', scope: 'both', priority: 0, enabled: true, confirm: false, implicit: true }); });
  return rules;
}
function similarity(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length || !y.length) return 0;
  let prev = [];
  for (let j = 0; j <= y.length; j++) prev.push(j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}
// 回傳 {kind:'none'} | {kind:'hit',fn,rule,rank,confirm} | {kind:'ambiguous',fns} | {kind:'suggest',fns}
// 優先順序：①完全相同 ②關鍵字越長越具體 ③再比優先順序 ④模糊只用來「提示建議」；無法確定唯一功能 → 回傳候選讓使用者選
function matchKeyword(text, rules, chat, inSession, fuzzyCfg) {
  const key = normalizeKeyword(text);
  if (!key) return { kind: 'none' };
  const hasDigits = /[0-9０-９]/.test(key); // 句子裡有金額 → 多半是在記帳，只接受「完全相同」的關鍵字
  const fz = fuzzyCfg || { suggest: 0.6, auto: 0.9 };
  const cands = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.scope !== 'both' && r.scope !== chat) continue;
    const kw = normalizeKeyword(r.keyword);
    if (!kw) continue;
    if (key === kw) { cands.push({ r, rank: 0, spec: kw.length }); continue; }
    if (inSession || hasDigits) continue; // 流程進行中：輸入的是答案，只有「完全相同」才會切換功能
    if (r.type === 'contains' && kw.length >= 2 && key.indexOf(kw) >= 0) cands.push({ r, rank: 1, spec: kw.length });
    else if (r.type === 'partial' && key.length >= 2 && key.length < kw.length && kw.indexOf(key) === 0) cands.push({ r, rank: 1, spec: key.length });
    else if (r.type === 'fuzzy' && key.length >= 3 && key.length <= 12) {
      const s = similarity(key, kw);
      if (s >= fz.suggest) cands.push({ r, rank: 2, score: s });
    }
  }
  if (!cands.length) return { kind: 'none' };
  const best = Math.min.apply(null, cands.map((c) => c.rank));
  const top = cands.filter((c) => c.rank === best);
  if (best === 2) {
    const byFn = new Map();
    top.forEach((c) => { const cur = byFn.get(c.r.fn); if (!cur || c.score > cur.score) byFn.set(c.r.fn, c); });
    const list = Array.from(byFn.values()).sort((a, b) => b.score - a.score);
    if (list[0].score >= fz.auto && (!list[1] || list[0].score - list[1].score >= 0.1)) return { kind: 'hit', fn: list[0].r.fn, rule: list[0].r, rank: 2, confirm: !!list[0].r.confirm };
    return { kind: 'suggest', fns: list.slice(0, 3).map((c) => c.r.fn) };
  }
  const maxSpec = Math.max.apply(null, top.map((c) => c.spec));
  let pool = top.filter((c) => c.spec === maxSpec);
  const minPri = Math.min.apply(null, pool.map((c) => c.r.priority));
  pool = pool.filter((c) => c.r.priority === minPri);
  const fns = Array.from(new Set(pool.map((c) => c.r.fn)));
  if (fns.length === 1) return { kind: 'hit', fn: fns[0], rule: pool[0].r, rank: best, confirm: pool.every((p) => p.r.confirm) };
  return { kind: 'ambiguous', fns };
}

// ---------- 權限檢查（伺服器端，功能真的執行時才檢查）----------
function permOf(cfg, fn) {
  return Object.assign({ enabled: true, chat: 'both', requireGroupAuth: false, groupWrite: true, groupReply: 'private', allowedUsers: [] }, (cfg.permissions || {})[fn] || {});
}
function checkAvailability(fn, ctx, cfg, opts) {
  const readOnly = !!(opts && opts.read);
  const viewOnly = !!(opts && opts.view); // V10.7.0：只是「看版本說明」（不讀任何人的清單、不寫入、不開始紀錄）：群組授權、「只限 1 對 1」、「群組不開放新增」都不擋；功能停用、「只限指定的人」照樣擋
  const info = fnInfo(fn, cfg);
  if (!info) return { ok: false, message: '找不到這個功能，可能已經被管理員移除。' };
  if (fn === 'menu' || fn.indexOf('menu:') === 0 || fn.indexOf('url:') === 0) return { ok: true, info, perm: permOf(cfg, fn) }; // V10.14：自訂網址一律可用，跟開啟主選單一樣不受權限設定限制
  const p = permOf(cfg, fn);
  const name = '「' + info.label + '」';
  if (!p.enabled) return { ok: false, message: name + '目前已停用。' };
  if (ctx.isGroup && p.chat === 'direct' && !viewOnly) return { ok: false, message: name + '目前只開放在跟我的 1 對 1 聊天室使用，請私訊我輸入' + name + '。' };
  if (!ctx.isGroup && p.chat === 'group') return { ok: false, message: name + '目前只開放在 LINE 群組使用。' };
  if (ctx.isGroup && p.requireGroupAuth && !viewOnly) {
    const g = (cfg.groups || {})[ctx.groupId];
    if (!g || !g.authorized) return { ok: false, message: '這個群組還沒有被授權使用' + name + '。請管理員到 App「設定 → LINE官方帳號 × 智慧關鍵字辨識 × LINE群組使用權限」，把這個群組設為已授權。' };
  }
  if (p.allowedUsers.length && p.allowedUsers.indexOf(ctx.userId) < 0) return { ok: false, message: '你沒有使用' + name + '的權限。' };
  if (ctx.isGroup && info.writes && !readOnly && !viewOnly && !p.groupWrite) return { ok: false, message: '群組裡目前不開放' + name + '新增資料，請改在跟我的 1 對 1 聊天室使用。' };
  return { ok: true, info, perm: p };
}

// ---------- LINE 訊息工具 ----------
async function lineReplyMessages(token, replyToken, messages) {
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ replyToken, messages }),
  });
}
// 私訊：LINE 的 Push API。對方要是官方帳號的好友才送得出去（也會用掉官方帳號的每月訊息額度）
async function linePush(token, to, messages) {
  try {
    return await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ to, messages }),
    });
  } catch (e) { return null; }
}
// 送「卡片類」訊息；萬一LINE拒絕（例如卡片格式有問題），改用純文字備援，確保使用者一定看得到東西
async function lineReplyCards(token, replyToken, messages, fallbackText) {
  let res = null;
  try { res = await lineReplyMessages(token, replyToken, messages); } catch (e) { res = null; }
  if (!res || !res.ok) {
    try { console.log('LINE reply failed', res ? res.status : 'no response', res ? await res.text() : ''); } catch (e) {}
    try { await lineReply(token, replyToken, fallbackText); } catch (e) {}
  }
}
// V10.5：隱藏指令（postback）。按鈕按下去，聊天室裡不會多出一句「使用者說的話」，不洗版；
//   伺服器收到後，當成「使用者打了這串字」，走和打字完全相同的處理流程（同樣的權限檢查、同樣的名稱對應），沒有另一套規則。
//   格式：data = 'k=' + 那串字（LINE 對 data 的上限是 300 個字，超過就改用一般按鈕，不會送出被拒絕的按鈕）
const POSTBACK_PREFIX = 'k=';
const POSTBACK_MAX = 300;
function postbackData(text) {
  const d = POSTBACK_PREFIX + String(text == null ? '' : text);
  return d.length <= POSTBACK_MAX ? d : '';
}
function postbackText(data) {
  const s = String(data == null ? '' : data);
  return s.indexOf(POSTBACK_PREFIX) === 0 ? s.slice(POSTBACK_PREFIX.length).trim() : '';
}
// 把 postback 事件變成「一則文字訊息」事件；不認得的格式回傳 null（直接略過，不回覆、不報錯）
function postbackAsTextEvent(ev) {
  const text = ev && ev.postback ? postbackText(ev.postback.data) : '';
  if (!text || !ev.replyToken) return null;
  return Object.assign({}, ev, { type: 'message', fromPostback: true, message: { type: 'text', id: 'pb:' + String(ev.webhookEventId || ev.timestamp || ''), text } });
}
// ---------- Icon 圖示（emoji → 自訂圖示，圖檔放在 public/icons/，走靜態資源）----------
//   LINE 的三種畫面元件，能不能放「圖示」規則不一樣：
//   · Flex 文字（type:'text'）本身不能放圖，要拆成「圖＋文字」兩個元件橫排，看起來才像「圖示＋文字」
//   · Flex 按鈕（type:'button'）沒有圖示欄位，要整個改成「長得像按鈕的 box」（action 放在 box 上）才能塞圖
//   · 快速回覆（quick reply）的每一項本來就有 imageUrl 欄位，不用重搭結構，直接補網址即可
//   以下三組 helper 對應這三種情況，共用同一份 ICON_MAP（emoji → 圖示檔名）判斷「有沒有圖示可以換」。
//   查不到對應圖示時，全部照舊顯示原來的 emoji／文字，不會壞掉、不會漏字——這是刻意設計的保底行為：
//   選單 emoji 是後台可自由輸入的文字欄位（見 lcMainFields／lcSubFields），不是固定在這 52 個字以內，
//   管理員之後新增的選單如果用了圖示清單外的 emoji，是正常狀況，不是錯誤。
const ICON_BASE_URL = 'https://sda.hongxiaoge0615.workers.dev/icons/';
const ICON_MAP = {
  '↩': 'return_menu', // 返回／回功能選單
  '⚠': 'warning', // 不確定提醒
  '⚪': 'dot_white', // 營業狀態：資訊未提供
  '✅': 'check', // 已送出／完成
  '✊': 'rps_rock', // 剪刀石頭布：石頭
  '✋': 'rps_paper', // 剪刀石頭布：布
  '✌': 'rps_scissors', // 剪刀石頭布：剪刀
  '✍': 'write', // 自己輸入
  '❌': 'close', // 取消
  '❓': 'circle_help', // V11.0：FAQ（選單）
  '➡': 'arrow_right', // 下一頁
  '⬅': 'arrow_left', // 上一頁
  '⭐': 'star', // 推薦星等
  '🌟': 'star_sparkle', // 集點卡
  '🍱': 'bento', // 美食
  '🍽': 'fork_knife', // 美食紀錄（選單）
  '🍾': 'bottle-wine', // 轉瓶子
  '🎁': 'gift', // 驚喜製造所
  '🎟': 'ticket', // 集點卡（選單）
  '🎡': 'ferris_wheel', // 轉盤
  '🎲': 'dice', // 骰子
  '🏷': 'tag', // 分類
  '💬': 'chat', // 原因／備註
  '💰': 'money', // 記帳／分帳（選單）
  '📋': 'clipboard', // 待確認草稿
  '📌': 'pushpin', // 狀態
  '📍': 'map_pin', // 待去清單／地址
  '📝': 'memo', // 紀錄（選單）／草稿標題
  '📦': 'package', // 隨機盒子
  '📱': 'phone', // 開啟 App
  '📷': 'camera', // 拍照
  '🔎': 'search', // 查詢
  '🔒': 'lock', // 僅限 1 對 1
  '🔙': 'back', // 返回主選單
  '🔭': 'telescope', // V11.0：探索更多（選單）
  '🔴': 'dot_red', // 營業狀態：休息中
  '🔵': 'dot_blue', // 旗艦版
  '🕒': 'clock', // 營業時間
  '🖼': 'picture', // 相簿
  '🗃': 'archive', // V11.0：Collect & Tidy（選單）
  '🗓': 'calendar', // 預計時間
  '🗺': 'map', // 在地圖開啟
  '🚆': 'train', // 交通紀錄
  '🚗': 'car', // 交通紀錄（選單）
  '🛠': 'tools', // 設備管理中心
  '🟠': 'dot_orange', // 營業狀態：即將營業／進階版
  '🟡': 'dot_yellow', // 營業狀態：即將打烊／標準版
  '🟢': 'dot_green', // 營業狀態：營業中／簡易版
  '🤖': 'robot', // 自動剪刀石頭布
  '🥤': 'cup', // 飲料紀錄（選單）
  '🧋': 'tea', // 飲料（模組圖示）
  '🧭': 'compass', // 奇遇羅盤
  '🧰': 'toolbox', // 工具（選單）
  '🧾': 'receipt', // 分帳／記帳
  '🪙': 'coin', // 拋硬幣
};
// ICON_MAP 的 key 跟程式裡實際的 emoji 字面值，都先拿掉「變化選擇符」(U+FE0F) 再比對——
// 有些複製來的 emoji 後面會多帶這個看不見的字（例如 '↩️' 其實是 '↩' + FE0F），兩邊沒統一處理會比對不到。
const stripVS16 = (s) => String(s == null ? '' : s).replace(/️/g, '');
function iconUrl(emoji) {
  const slug = ICON_MAP[stripVS16(emoji)];
  // encodeURIComponent：以防萬一之後上傳的圖示檔名又不小心帶了空格、中文字等網址不能直接用的字元；
  // 對現在全部都是純英數字、底線的檔名（例如 archive、star_sparkle）編碼前後完全一樣，不影響任何現有圖示。
  return slug ? ICON_BASE_URL + encodeURIComponent(slug) + '.png' : '';
}
// 抓一串字「開頭」的 emoji（含後面可能跟著的 FE0F），例如 '🧋 飲料' → '🧋'；抓不到回傳空字串。
const LEADING_EMOJI_RE = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}])️?/u;
function leadingEmoji(s) {
  const m = String(s == null ? '' : s).match(LEADING_EMOJI_RE);
  return m ? m[1] : '';
}
// 把「emoji 開頭的一串字」拆成 { icon, rest }：icon 是圖示網址（查不到就是空字串，這時 rest 會是原始整串字，emoji 留著不拆）；
// rest 是拿掉 emoji、trim 過的剩下文字——但如果拿掉以後變成空字串（這串字整個就是一顆 emoji，沒有其他文字），
// 保留原始整串字當 rest，避免畫面出現「有圖示、旁邊文字空白」的怪狀況。
function splitIcon(s) {
  const str = String(s == null ? '' : s);
  const e = leadingEmoji(str);
  const url = e ? iconUrl(e) : '';
  if (!url) return { icon: '', rest: str };
  const rest = str.slice(str.indexOf(e) + e.length).replace(/^️?\s*/, '');
  return { icon: url, rest: rest && rest.trim() ? rest : str };
}
// Flex 文字元件（例如 {type:'text', text:'🧋 飲料', ...其他樣式}）：開頭 emoji 換成圖示＋文字橫排的 box；
// 查無圖示時原封不動傳回同一個文字元件（emoji 仍留在文字開頭），畫面跟轉換前完全一樣。
function iconRow(textNode) {
  const { icon, rest } = splitIcon(textNode.text);
  if (!icon) return textNode;
  const text = Object.assign({}, textNode, { text: rest, flex: 1 });
  delete text.margin; // margin 移到外層 box，裡面的文字不用重複留白
  const box = { type: 'box', layout: 'horizontal', spacing: 'xs', alignItems: 'center', contents: [
    { type: 'image', url: icon, flex: 0, size: 'xs', aspectRatio: '1:1', gravity: 'center' },
    text,
  ] };
  if (textNode.margin) box.margin = textNode.margin;
  return box;
}
// Flex 按鈕：一律用「長得像按鈕的 box」呈現（底色＋邊框＋圓角，action 放在 box 上），查到圖示就多塞一顆小圖在文字前面。
// style 只接受 'primary'／'secondary'／'link'（對應原本 Flex 按鈕的樣式）。
// V11.0：之前「查無圖示時退回LINE原生 type:'button'」——原生按鈕的顏色是LINE客戶端依亮/暗模式決定的，跟這裡固定的底色／邊框／文字色
// 對不起來。選單上的 emoji 是後台可自由輸入的文字欄位（見 lcMainFields／lcSubFields），新增主選單時留白、或剛好打了 ICON_MAP 以外
// 的 emoji 都很常見、不是錯誤——但只要發生，那顆按鈕就會退回原生樣式，跟其他按鈕顏色不一致，在亮色／暗色模式下都是如此（這正是使用者
// 回報「功能選單」裡「Collect & Tidy」「FQA」兩顆按鈕顏色跟其他顆不一樣的真正原因）。改成不管查不查得到圖示都走同一顆 box，兩種情況
// 底色／邊框／文字色就會完全一致，差別只在查到圖示時文字前面多一顆小圖。
function iconButton(label, text, style, opts) {
  opts = opts || {}; // opts.action：自訂 action 的其他欄位（例如 uri），label 仍統一由這裡算；opts.color：原本按鈕的 color 屬性（primary 樣式常見）
  const { icon, rest } = splitIcon(label); // 查無圖示時 rest 是原始整串字（見 splitIcon），直接當文字內容用即可
  const action = opts.action ? Object.assign({}, opts.action, { label: String(icon ? rest : label).slice(0, 40) }) : { type: 'message', label: String(icon ? rest : label).slice(0, 40), text: String(text) };
  // style:'link' 原本是「純文字可以點」，沒有底色、沒有邊框——文字（＋圖示）的 box 也不給底色／邊框，看起來才一致。
  const isLink = style === 'link';
  const palette = style === 'primary' ? { fg: '#ffffff', bg: opts.color || '#8b7355', border: opts.color || '#8b7355' } : isLink ? { fg: opts.color || '#8b7355', bg: '', border: '' } : { fg: '#5c4b37', bg: '#ffffff', border: '#d9cfc2' };
  const box = {
    // 注意：box 的 height 只能給像素／百分比（例如 '40px'），不能像 button 一樣用 'sm'／'md' 這種關鍵字——
    // 之前這裡誤寫成 height:'sm'，LINE 收到後會整則判定格式錯誤直接拒絕，導致「按了沒反應、卡片消失」。
    // box 不設 height 也沒關係，靠 paddingAll／裡面文字的行高自然撐出跟原按鈕差不多的高度。
    type: 'box', layout: 'horizontal', paddingAll: isLink ? 'none' : 'sm', spacing: 'xs',
    alignItems: 'center', justifyContent: 'center', action,
    contents: icon ? [
      // 使用者反應功能選單的圖示太大：先從 'sm' 降到 'xs' 不夠明顯，這裡再降到 LINE 官方清單裡最小的關鍵字 'xxs'
      // （官方文件列出的完整順序由小到大是 xxs/xs/sm/md/lg/xl/xxl/3xl/4xl/5xl/full，xxs 已經是最小的）。
      { type: 'image', url: icon, flex: 0, size: 'xxs', aspectRatio: '1:1', gravity: 'center' },
      { type: 'text', text: rest, size: 'sm', color: palette.fg, align: 'center', gravity: 'center', wrap: true },
    ] : [
      { type: 'text', text: rest, size: 'sm', color: palette.fg, align: 'center', gravity: 'center', wrap: true },
    ],
  };
  if (!isLink) { box.cornerRadius = 'md'; box.backgroundColor = palette.bg; box.borderWidth = '1px'; box.borderColor = palette.border; }
  return box;
}
const hq = (label, text) => ({ label, text, hidden: true }); // 隱藏指令的快速回覆按鈕
function quickReplyItems(list) {
  // V10.? LINE Emoji → Icon：快速回覆每一項本來就有 imageUrl 欄位，不用重搭結構。
  //   做法：label 開頭有對應圖示就補上 imageUrl，並把 emoji 從顯示文字拿掉（不然會「圖示＋emoji＋文字」重複兩次）；
  //   查無圖示時完全不動，label 原封不動（含 emoji），跟轉換前一模一樣。這一個函式改完，全部 Category B 的
  //   快速回覆按鈕（含隱藏指令、camera 類型）都會自動套用，不用一個個按鈕改。
  return {
    items: list.slice(0, 13).map((x) => {
      if (x && typeof x === 'object' && x.lineAction) { // V10.3：camera／cameraRoll（拍照、相簿）
        const { icon, rest } = splitIcon(x.label);
        const item = { type: 'action', action: { type: x.lineAction, label: String(icon ? rest : x.label).slice(0, 20) } };
        return icon ? Object.assign({ imageUrl: icon }, item) : item;
      }
      const rawLabel = typeof x === 'string' ? x : x.label;
      const text = typeof x === 'string' ? x : x.text;
      const { icon, rest } = splitIcon(rawLabel);
      const label = icon ? rest : rawLabel;
      if (x && typeof x === 'object' && x.hidden) {
        const d = postbackData(text); // 字太長塞不進 data → 退回一般按鈕
        if (d) { const item = { type: 'action', action: { type: 'postback', label: String(label).slice(0, 20), data: d } }; return icon ? Object.assign({ imageUrl: icon }, item) : item; }
      }
      const item = { type: 'action', action: { type: 'message', label: String(label).slice(0, 20), text: String(text) } };
      return icon ? Object.assign({ imageUrl: icon }, item) : item;
    }),
  };
}

// ---------- V10.5：九宮格選單（目前用在「工具」）----------
//   一張 Flex 卡片：直向大盒子 → 每 3 格一列 → 每格是一個可以整格點的盒子（白底淺灰、上面 emoji、中間名稱、下面小字）。
//   格子送出的是「隱藏指令」（postback），聊天室不會多出一句使用者說的話；伺服器收到後和「打名稱」走完全一樣的流程。
//   最後一格固定是「🔙 返回主選單」（送出「功能選單」）。格子數不是 9 的倍數（管理員停用、新增了項目）時，最後一列用空格補齊，格子寬度才會一致。
const GRID_COLS = 3;
const GRID_BACK = { label: '🔙 返回主選單', text: '功能選單', emoji: '🔙', main: '返回主選單', hint: '回功能選單' };
function gridLabelParts(name, hint) {
  // 「奇遇羅盤（選地點）」→ 大字「奇遇羅盤」＋小字「選地點」；有另外設定小字就用設定的
  const m = String(name).match(/^(.*?)\s*[（(]([^）)]*)[）)]\s*$/);
  const main = m && m[1].trim() ? m[1].trim() : String(name);
  return { main, hint: String(hint || '').trim() || (m && m[1].trim() ? m[2].trim() : '') };
}
function gridCell(c) {
  const contents = [];
  if (c.emoji) { const url = iconUrl(c.emoji); contents.push(url ? { type: 'image', url, size: 'xxl', aspectRatio: '1:1', align: 'center' } : { type: 'text', text: c.emoji, size: 'xxl', align: 'center' }); }
  contents.push({ type: 'text', text: c.main, size: 'xs', weight: 'bold', color: '#5c4b37', align: 'center', wrap: true, margin: 'sm' });
  if (c.hint) contents.push({ type: 'text', text: c.hint, size: 'xxs', color: '#8b8b8b', align: 'center', wrap: true });
  const data = postbackData(c.text);
  const action = data ? { type: 'postback', label: String(c.label).slice(0, 20), data } : { type: 'message', label: String(c.label).slice(0, 20), text: String(c.text).slice(0, 300) };
  return { type: 'box', layout: 'vertical', flex: 1, paddingAll: 'md', spacing: 'xs', cornerRadius: 'md', backgroundColor: '#f7f5f2', borderWidth: '1px', borderColor: '#e6e0d6', alignItems: 'center', justifyContent: 'center', action, contents };
}
function gridRows(cells) {
  const rows = [];
  for (let i = 0; i < cells.length; i += GRID_COLS) {
    const row = cells.slice(i, i + GRID_COLS).map(gridCell);
    while (row.length < GRID_COLS) row.push({ type: 'box', layout: 'vertical', flex: 1, contents: [{ type: 'filler' }] });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: row });
  }
  return rows;
}

// ---------- 功能選單（依設定產生）----------
function buildMenuMessage(cfg, ctx, onlyMainId) {
  const btn = (label, text) => iconButton(label, text, 'secondary'); // 查到圖示會自動變成「長得像按鈕的 box」，查不到維持原來的 type:'button'
  const withEmoji = (e, n) => (e ? e + ' ' + n : n);
  // 顯示規則：根選單（功能選單）只列第一層——每個主選單一顆按鈕；按下去才看到它自己的子項目（或直接執行它對應的單一功能）。
  // 設定 menu.style 改成 'expanded' 可以回到「全部展開」的舊樣子。
  const collapsed = !onlyMainId && !(cfg.menu && cfg.menu.style === 'expanded');
  const sections = [];
  const mains = (cfg.mainMenus || []).filter((m) => m.enabled && (m.scope === 'both' || m.scope === ctx.chat) && (!onlyMainId || m.id === onlyMainId)).sort((a, b) => a.order - b.order);
  mains.forEach((m) => {
    const subs = (cfg.subMenus || []).filter((s) => s.mainId === m.id && s.enabled).sort((a, b) => a.order - b.order);
    const buttons = [];
    const names = [];
    const cells = [];
    subs.forEach((s) => { if (checkAvailability(s.functionId, ctx, cfg).ok) { const sendText = s.cmd || s.name; /* V10.9.0：格子／按鈕上顯示的是 name，實際送出的是 cmd（沒設就跟以前一樣送 name）；給「顯示要乾淨、但指令要帶參數」的格子用，例如剪刀石頭布拆成 4 格 */ buttons.push(btn(withEmoji(s.emoji, s.name), sendText)); names.push(s.name); cells.push(Object.assign({ label: withEmoji(s.emoji, s.name), text: sendText, emoji: s.emoji }, gridLabelParts(s.name, s.hint))); } });
    const direct = !!(m.functionId && checkAvailability(m.functionId, ctx, cfg).ok);
    if (collapsed) {
      if (buttons.length || direct) sections.push({ title: '', buttons: [btn(withEmoji(m.emoji, m.name), m.name)], names: [m.name], main: m });
      return;
    }
    if (!buttons.length && direct) { buttons.push(btn(withEmoji(m.emoji, m.name), m.name)); names.push(m.name); }
    if (buttons.length) sections.push({ title: withEmoji(m.emoji, m.name), buttons, names, main: m, cells });
  });
  const gridSec = onlyMainId && sections.length && sections[0].main.layout === 'grid' && sections[0].cells.length ? sections[0] : null; // 只有「點進某個選單」時才用九宮格；根選單與全部展開的舊樣子維持清單
  const heading = onlyMainId && sections.length ? withEmoji(sections[0].main.emoji, sections[0].main.name) : '📋 功能選單';
  const lines = collapsed ? sections.map((s) => '・' + s.names[0]) : sections.map((s) => '・' + s.names.join('／'));
  const fallback = sections.length ? heading + '\n請直接輸入想用的功能名稱：\n' + lines.join('\n') : '目前沒有可用的功能。';
  if (!sections.length) return { message: { type: 'text', text: fallback }, fallback };
  const body = [
    iconRow({ type: 'text', text: heading, weight: 'bold', size: 'xl', color: '#5c4b37', wrap: true }),
    { type: 'text', text: gridSec ? '點一下就開始（結果直接回在這個聊天室）' : onlyMainId ? '請選擇，或直接輸入名稱（輸入「功能選單」回到主選單）' : '請選擇要使用的功能，也可以直接輸入功能名稱', size: 'xs', color: '#8b8b8b', wrap: true, margin: 'sm' },
  ];
  if (gridSec) body.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: gridRows(gridSec.cells.concat([GRID_BACK])) });
  else if (collapsed) body.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: sections.map((s) => s.buttons[0]) });
  else if (onlyMainId) body.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: sections[0].buttons.concat([btn('↩️ 功能選單', '功能選單')]) }); // V10.9.1：點進某個主選單（非九宮格）看子項目時，原本只有子項目按鈕、沒有能點的「返回主選單」（九宮格、待去清單／分帳管理這類範本式選單都有，只有這裡缺），補上
  else sections.forEach((s) => body.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: [iconRow({ type: 'text', text: s.title, weight: 'bold', size: 'sm', color: '#8b7355' })].concat(s.buttons) }));
  const alt = (onlyMainId ? heading : '功能選單') + '：' + (collapsed ? sections.map((s) => s.names[0]) : sections.map((s) => s.names.join('／'))).join('／');
  return {
    message: { type: 'flex', altText: alt.slice(0, 300), contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: body } } },
    fallback,
  };
}
async function sendMenuFor(token, ev, cfg, onlyMainId) {
  const built = buildMenuMessage(cfg, makeCtx(ev), onlyMainId);
  await lineReplyCards(token, ev.replyToken, [built.message], built.fallback);
}
async function sendRecordMenu(token, ev, env) {
  await sendMenuFor(token, ev, await loadLineConfig(env), null);
}
async function sendCandidates(token, ev, cfg, fns, suggest) {
  const items = fns.map((fn) => ({ label: fnLabel(fn, cfg), text: fnLabel(fn, cfg) })).concat([{ label: '功能選單', text: '功能選單' }]);
  await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: suggest ? '你是不是想用這些功能？' : '這個詞可以對應到好幾個功能，你想用哪一個呢？', quickReply: quickReplyItems(items) }]).catch(() => {});
}

// ---------- 快速記錄（美食紀錄／交通紀錄／記帳／記一筆分帳）----------
function quickPromptText(kind, travelType) {
  const k = QUICK_KINDS[kind];
  if (kind === 'wish') return k.label + '：請輸入想去的地點（可以加上城市、想去的原因、預計時間），例如：\n・' + k.examples.join('\n・');
  const head = kind === 'travel' && travelType ? TRAVEL_TYPE_LABELS[travelType] + ' 交通紀錄' : k.label;
  return head + '：請輸入內容與金額，例如：\n・' + k.examples.join('\n・');
}
async function startQuickRecord(kind, userId, env, token, replyToken, lead) {
  if (kind === 'travel') {
    await setFlagshipSession(userId, { flow: 'quick', kind, stage: 'pickType', travelType: null }, env);
    await lineReplyAsk(token, replyToken, '🚗 交通紀錄：要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS.concat([BACK_LABEL]));
    return;
  }
  await setFlagshipSession(userId, { flow: 'quick', kind, stage: 'await' }, env);
  await lineReplyAsk(token, replyToken, (lead || '') + quickPromptText(kind, null), [BACK_LABEL]);
}
async function handleQuickMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const ctx = makeCtx(ev);
  const userId = ctx.userId;
  if (!userId) return false;
  const session = await getFlagshipSession(userId, env);
  if (!session || session.flow !== 'quick') return false;
  const k = QUICK_KINDS[session.kind];
  if (!k) { await clearFlagshipSession(userId, env); return false; }
  if (session.stage === 'confirm' && session.pending) return finishPending(ev, token, env, session);

  if (QUICK_CANCEL_RE.test(text)) {
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, '已取消。', ['功能選單']);
    return true;
  }
  if (BACK_RE.test(text)) {
    if (session.kind === 'travel' && session.stage === 'await') {
      session.stage = 'pickType';
      session.travelType = null;
      await setFlagshipSession(userId, session, env);
      await lineReplyAsk(token, ev.replyToken, '🚗 交通紀錄：要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS.concat([BACK_LABEL]));
      return true;
    }
    await clearFlagshipSession(userId, env);
    await sendRecordMenu(token, ev, env);
    return true;
  }
  // 每一步都重新檢查權限（管理員可能在流程中途改了設定）
  const cfg = await loadLineConfig(env);
  const av = checkAvailability(k.fn, ctx, cfg);
  if (!av.ok) { await clearFlagshipSession(userId, env); await lineReply(token, ev.replyToken, av.message); return true; }

  if (session.stage === 'pickType') {
    const tt = TRAVEL_TYPE_TRIGGERS[text];
    if (!tt) {
      await lineReplyAsk(token, ev.replyToken, '請從清單裡選一種交通：', TRAVEL_TYPE_OPTIONS.concat([BACK_LABEL]));
      return true;
    }
    session.travelType = tt;
    session.stage = 'await';
    await setFlagshipSession(userId, session, env);
    await lineReplyAsk(token, ev.replyToken, quickPromptText('travel', tt), [BACK_LABEL]);
    return true;
  }

  // stage === 'await'：這句話就是紀錄內容
  // V9：已綁定同步碼 → 美食／交通先走「草稿」（可一次多個品項，沒寫金額也可以；沒提到的欄位留空）
  if (DRAFT_KIND_BY_CAT[k.category]) {
    const eligQ = await draftEligibility(userId, env, cfg);
    if (eligQ) {
      const whoQ = await lineWho(token, ctx);
      const stQ = await tryDraftFromText(ev, token, env, ctx, whoQ.userName, whoQ.groupName, text, eligQ, { forceKind: k.category, forceType: k.category === 'travel' ? (session.travelType || '') : '' });
      if (stQ !== 'skip') {
        if (stQ !== 'failed') await clearFlagshipSession(userId, env); // 失敗時保留流程，讓使用者可以直接再傳一次
        return true;
      }
    }
  }
  if (k.category === 'wish') { // 待去地點只有「草稿」這條路，沒有 LINE 端直接存的舊流程：說明原因並結束
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, WISH_NEED_DRAFT_TEXT, ['功能選單']);
    return true;
  }
  let parsed = null;
  try { parsed = await parseExpense(text, env, k.category); } catch (e) { parsed = null; }
  if (!parsed || parsed.amount == null || isNaN(Number(parsed.amount))) {
    await lineReplyAsk(token, ev.replyToken, '沒有抓到金額 😅 請再輸入一次，要包含內容跟金額，例如：\n・' + k.examples.join('\n・'), [BACK_LABEL]);
    return true; // 保留流程，讓使用者直接重打
  }
  let userName = '';
  let groupName = '';
  try {
    userName = (ctx.isGroup ? await lineGroupMemberProfile(token, ctx.groupId, userId) : await lineProfile(token, userId)) || '';
  } catch (e) {}
  if (ctx.isGroup) { try { groupName = (await lineGroupSummary(token, ctx.groupId)) || ''; } catch (e) {} }
  const record = buildRecordFromParsed(parsed, text, userId, userName, ctx.groupId, groupName, undefined, ev.message.id);
  record.category = k.category; // 依選的功能固定分類
  if (session.kind === 'travel' && session.travelType) record.transportType = session.travelType;
  await askConfirm(userId, session, record, ev.replyToken, token, env, ev);
  return true;
}

// ---------- 分帳管理／待去清單：LINE裡能做的事＋「開啟App」按鈕 ----------
async function sendSplitCard(token, ev) {
  const url = (ev.appOrigin || DEFAULT_APP_URL) + '/?open=split&openExternalBrowser=1';
  await lineReplyCards(token, ev.replyToken, [{
    type: 'template', altText: '分帳管理',
    template: {
      type: 'buttons',
      text: '💰 分帳管理\n記一筆分帳：先記在這裡，之後到App匯入分帳群組。完整的群組與結算在App裡。',
      actions: [
        { type: 'message', label: '✍️ 記一筆分帳', text: '記一筆分帳' },
        { type: 'uri', label: '📱 開啟App分帳管理', uri: url },
        { type: 'message', label: '↩️ 功能選單', text: '功能選單' },
      ],
    },
  }], '💰 分帳管理\n・記一筆分帳：輸入「記一筆分帳」\n・完整的群組與結算：' + url);
}
async function fetchSyncedObject(userId, lsKey, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return null;
  const code = await kv.get('line:usersync:' + userId);
  if (!code) return null;
  const raw = await kv.get(keyOf(code));
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return null; }
  const data = rec.data || {};
  try { return data[lsKey] ? JSON.parse(data[lsKey]) : {}; } catch (e) { return {}; }
}
function wishlistSummaryText(obj) {
  const items = obj && Array.isArray(obj.wishItems) ? obj.wishItems : [];
  if (!items.length) return '📍 待去清單\n目前還沒有任何地點，按下面的按鈕到App新增第一個吧！';
  const count = {};
  items.forEach((it) => { const s = (it && it.status) || '待去'; count[s] = (count[s] || 0) + 1; });
  const order = ['待去', '已安排', '已完成', '暫不去', '取消'];
  const parts = order.filter((s) => count[s]).map((s) => s + ' ' + count[s]);
  Object.keys(count).filter((s) => order.indexOf(s) < 0).forEach((s) => parts.push(s + ' ' + count[s]));
  const pending = items.filter((it) => it && ((it.status || '待去') === '待去')).slice(0, 5); // App新增的項目放在最前面，所以前5個就是最近新增的
  let text = '📍 待去清單\n共 ' + items.length + ' 個地點：' + parts.join('・');
  if (pending.length) {
    text += '\n\n最近新增的待去地點：\n' + pending.map((it) => '・' + (it.name || '（未命名）') + (it.city ? '（' + it.city + '）' : '')).join('\n');
  }
  return text;
}
async function buildWishlistMessages(ev, userId, env) {
  const url = (ev.appOrigin || DEFAULT_APP_URL) + '/?open=wishlist&openExternalBrowser=1';
  let code = null;
  try { code = env.SYNC_KV ? await env.SYNC_KV.get('line:usersync:' + userId) : null; } catch (e) {}
  let summary;
  if (!code) {
    summary = '📍 待去清單\n你還沒綁定同步碼，所以這裡看不到清單摘要。傳「同步碼 你的碼」綁定後就會顯示（App 首頁的「雲端同步」可以看到同步碼）。\n\n完整的待去清單（表格／看板／地圖）在App裡，按下面的按鈕開啟。';
  } else {
    let obj = null;
    try { obj = await fetchSyncedObject(userId, 'wishlist_data_v2', env); } catch (e) {}
    summary = wishlistSummaryText(obj);
  }
  return {
    messages: [
      { type: 'text', text: summary },
      { type: 'template', altText: '待去清單', template: { type: 'buttons', text: '要開啟完整的待去清單，或新增一個想去的地點嗎？', actions: [{ type: 'uri', label: '📱 開啟待去清單', uri: url }, { type: 'message', label: '✍️ 新增待去地點', text: '新增待去地點' }, { type: 'message', label: '↩️ 功能選單', text: '功能選單' }] } },
    ],
    fallback: summary + '\n\n開啟待去清單：' + url + '\n新增待去地點：輸入「新增待去地點」，或直接傳「想去 九份老街」',
  };
}

// ---------- 集點卡：開始流程（進行中的對話由 handleStickerCardMessage 處理）----------
async function startStickerFlow(userId, env, priv) {
  const kids = await fetchSyncedArray(userId, 'sticker_kids', env);
  if (kids === null) return { ok: false, text: '你還沒綁定同步碼喔，先傳「同步碼 你的碼」綁定（App 首頁的「雲端同步」可以看到），才能用LINE記集點卡。' };
  if (!kids.length) return { ok: false, text: '你的集點卡裡還沒有任何孩子，先到App「🌟集點卡→👶乖寶寶集點卡」新增一位孩子吧。' };
  await setFlagshipSession(userId, { flow: 'stickerkid', stage: 'pickKid', kids, kidId: null, private: !!priv }, env);
  return { ok: true, text: '🌟 要幫哪個孩子集點？', options: kids.map((k) => k.name) };
}
const PRIVATE_FAIL_TEXT = '我沒辦法私訊你（需要先把我加為好友），為了保護個人資料，群組裡不會顯示內容。請先加我為好友後再試一次，或直接私訊我。';
async function enterSticker(ctx, ev, token, env, perm, lead) {
  const priv = ctx.isGroup && perm.groupReply !== 'public';
  const r = await startStickerFlow(ctx.userId, env, priv);
  if (!r.ok) { await lineReply(token, ev.replyToken, r.text); return; }
  if (!priv) { await lineReplyAsk(token, ev.replyToken, (lead || '') + r.text, r.options); return; } // lead：V10.4 四種版本用不了時，先說明原因再接原本的流程
  // 群組＋私訊模式：孩子的名字不放在群組裡，改傳到本人的 1 對 1 聊天室，之後在那邊繼續
  const res = await linePush(token, ctx.userId, [{ type: 'text', text: r.text, quickReply: quickReplyItems(r.options.concat(['結束'])) }]);
  if (res && res.ok) { await lineReply(token, ev.replyToken, '🌟 集點卡的選項已私訊給你，請到我的聊天室繼續 ✉️'); return; }
  await clearFlagshipSession(ctx.userId, env);
  await lineReply(token, ev.replyToken, PRIVATE_FAIL_TEXT);
}
async function enterWishlist(ctx, ev, token, env, perm) {
  const built = await buildWishlistMessages(ev, ctx.userId, env);
  if (!ctx.isGroup || perm.groupReply === 'public') { await lineReplyCards(token, ev.replyToken, built.messages, built.fallback); return; }
  const res = await linePush(token, ctx.userId, built.messages);
  if (res && res.ok) { await lineReply(token, ev.replyToken, '📍 待去清單已私訊給你 ✉️'); return; }
  await lineReply(token, ev.replyToken, PRIVATE_FAIL_TEXT);
}

// ============================================================
// 🧭 統一操作架構：先選主功能 → 再選「紀錄／查詢」→ 最後選版本（簡易／標準／旗艦）或輸入查詢條件
//   ・主功能（飲料／美食／交通／待去清單）的別名，沿用「LINE 關鍵字」設定；也能直接輸入完整指令：
//     「查詢飲料」「紀錄飲料」「查詢飲料 2026年10月 咖啡」「查詢飲料 標準版 2026年10月」。
//   ・選單按鈕送出的文字就是完整指令，所以逐步點選與直接輸入，結果一定相同。
//   ・規格沒有確認的地方（例如美食／交通的旗艦版表單）不自己猜，直接說明「待確認」。
//   ・V10.1：待去清單在 LINE 不分版本 —— 「紀錄待去清單」＝「新增待去地點」，先建立草稿，到網頁資料卡片確認後才寫入。
// ============================================================
const MODULES = {
  drink: { fn: 'drink', name: '飲料', label: '飲料紀錄', tier: 'drink', blobKey: 'boba_recs', cat: 'drink', dateKey: 'date', amountKey: 'amount', record: { simple: true, standard: true, advanced: true, flagship: true } },
  food: { fn: 'food', name: '美食', label: '美食紀錄', tier: 'food', blobKey: 'meal_recs', cat: 'food', dateKey: 'date', amountKey: 'amount', record: { simple: true, standard: true, advanced: true, flagship: false } },
  travel: { fn: 'travel', name: '交通', label: '交通紀錄', tier: 'travel', blobKey: 'travel_recs', cat: 'travel', dateKey: 'date', amountKey: 'ticketPrice', record: { simple: true, standard: true, advanced: true, flagship: false } },
  wishlist: { fn: 'wishlist', name: '待去清單', label: '待去清單', blobKey: 'wishlist_data_v2', wish: true, dateKey: 'suggestDate', record: { simple: false, standard: false, flagship: false } },
};
const WISH_DATE_KEYS = { suggestDate: '提議日期', targetTime: '預計時間', completedDate: '完成日期' };
const VERSION_INFO = { simple: '簡易版', standard: '標準版', advanced: '進階版', flagship: '旗艦版' };
const VERSION_WORDS = [['simple', ['簡易版', '簡易']], ['standard', ['標準版', '標準']], ['advanced', ['進階版', '進階']], ['flagship', ['旗艦版', '旗艦']]];
const QUERY_OP_RE = /^(查詢|搜尋|搜索|查)$/;
const RECORD_OP_RE = /^(紀錄|記錄|新增)$/;
const QUERY_PAGE_SIZE = { simple: 5, standard: 8, flagship: 3 };
const CATEGORY_NAME = { drink: '飲料', food: '美食', travel: '交通', split: '分帳', other: '記帳' };
const MODULE_CAT = { drink: 'drink', food: 'food', travel: 'travel', split: 'other' };
const AGAIN_CMD = { drink: '紀錄飲料', food: '紀錄美食', travel: '紀錄交通', other: '記帳', split: '記一筆分帳' };
const FIELD_LABELS = {
  date: '日期', time: '時間', brand: '品牌／店家', drink: '飲品', dish: '餐點', size: 'SIZE', topping: '加料', sugar: '甜度', ice: '冰塊',
  cuisine: '菜系', portion: '份量', spicy: '辣度', diningType: '用餐方式', satiety: '飽足感', revisit: '回訪意願', rating: '評分',
  payment: '付款方式', currency: '幣別', amount: '金額', drinker: '飲用者', eater: '用餐者', payer: '付款者', recorder: '記錄者', note: '備註',
  country: '國家／地區', area: '地區', city: '城市', type: '類型', no: '編號', company: '公司', depPort: '出發地', arrPort: '到達地', transitPort: '轉乘／經停',
  depTime: '出發時間', arrTime: '到達時間', duration: '時長', ticketPrice: '票價', vehicleType: '機型／船型', regNo: '機身／船舶編號', seat: '座位／艙位', plateNo: '車牌',
  sn: '流水號', source: '來源', name: '項目名稱', detailPlace: '詳細地點／商家', status: '狀態', reason: '推薦原因', proposer: '提議者', suggestDate: '提議日期',
  targetTime: '預計時間', completedDate: '完成日期', category: '分類', openHours: '營業時間', suggestTime: '提議時間',
};
const HIDDEN_FIELDS = ['id', 'panel', 'snp', 'importedAt', 'lineMsgId', 'lineKey', 'draftId', 'ainote', '_pending', 'ts'];

// ---------- 讓使用者知道「有沒有同步到網頁」：沒同步成功前，不說「已完成」----------
function syncWording(record) {
  if (record.synced) return '✅ 已同步到網頁';
  if (record.syncStatus === 'nouser') return '📝 已暫存在 LINE（我在群組裡看不到你是誰，沒辦法自動同步到網頁：請先加我為好友並同意服務條款，再私訊我「同步碼 你的碼」綁定；這筆也可以到 App「📱LINE紀錄」手動匯入）';
  if (record.syncStatus === 'fail') return '⚠️ 已暫存在 LINE，但同步到網頁失敗，稍後會自動重試（也可以到 App「📱LINE紀錄」手動匯入）';
  if (record.syncStatus === 'nodata') return '📝 已暫存在 LINE（這組同步碼底下還沒有網頁資料，請先在 App 按一次雲端同步上傳）';
  if (record.syncStatus === 'unbound') return '📝 已暫存在 LINE（還沒綁定同步碼，網頁看不到；綁定同步碼後，或到 App「📱LINE紀錄」匯入）';
  return '📝 已暫存在 LINE，請到 App「📱LINE紀錄」匯入'; // 記帳／分帳：App 還沒有對應的模組，不會自動同步
}
function recordSummaryText(r) {
  const lines = [];
  const add = (label, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(label + '：' + v); };
  add('品項', r.item || r.drink);
  add('金額', r.amount != null ? '$' + r.amount : '');
  if (r.transportType) add('交通類型', TRAVEL_TYPE_LABELS[r.transportType] || r.transportType);
  ['brand', 'size', 'topping', 'sugar', 'ice', 'cuisine', 'portion', 'diningType', 'depPort', 'arrPort', 'payment', 'rating', 'note'].forEach((k) => add(FIELD_LABELS[k] || k, r[k]));
  return lines.join('\n');
}
// 流程填完後，先讓使用者確認，按「確認儲存」才真的寫入
async function askConfirm(userId, session, record, replyToken, token, env, ev) {
  // V9：已綁定同步碼的使用者 → 飲料／美食／交通不在 LINE 裡確認，改成建立「待確認草稿」，到網頁表單確認後才正式儲存
  if (ev && (await tryDraftFromRecord(userId, record, replyToken, token, env, ev, session)) === 'done') return;
  session.stage = 'confirm';
  session.pending = record;
  await setFlagshipSession(userId, session, env);
  const retry = !!session.draftRetry;
  await lineReplyMessages(token, replyToken, [{
    type: 'text',
    text: (retry ? '📋 這筆還沒有建立成草稿：\n' : '📋 請確認這筆「' + (CATEGORY_NAME[record.category] || '') + '」紀錄：\n') + recordSummaryText(record) + (retry ? '\n\n按「確認儲存」再試一次；不要的話按「放棄」。' : '\n\n按「確認儲存」才會寫入；不要的話按「放棄」。'),
    quickReply: quickReplyItems([{ label: '✅ 確認儲存', text: '✅ 確認儲存' }, { label: '❌ 放棄', text: '❌ 放棄' }]),
  }]);
}
const CONFIRM_YES_RE = /^(✅\s*)?(確認儲存|確認|儲存|好|是)$/;
const CONFIRM_NO_RE = /^(❌\s*)?(放棄|取消|不要|否|結束)$/;
async function finishPending(ev, token, env, session) {
  const text = (ev.message.text || '').trim();
  const userId = (ev.source && ev.source.userId) || '';
  const record = session.pending;
  if (!record) { await clearFlagshipSession(userId, env); return false; }
  if (CONFIRM_NO_RE.test(text)) {
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, '已放棄，這筆沒有儲存。', ['功能選單']);
    return true;
  }
  if (!CONFIRM_YES_RE.test(text)) {
    await askConfirm(userId, session, record, ev.replyToken, token, env);
    return true;
  }
  // V9：已綁定同步碼 → 建立「待確認草稿」而不是直接存檔（也處理「草稿建立失敗後，按確認儲存重試」）
  if ((await tryDraftFromRecord(userId, record, ev.replyToken, token, env, ev, session)) === 'done') return true;
  try {
    await saveLineLogRecord(record, env);
  } catch (e) {
    await lineReplyQuick(token, ev.replyToken, '儲存時發生問題，這筆還沒有存進去。請再按一次「✅ 確認儲存」重試 🙏', ['✅ 確認儲存', '❌ 放棄']);
    return true; // 保留流程，讓使用者可以重試（不會重複新增：同一筆有唯一識別）
  }
  await clearFlagshipSession(userId, env);
  const label = CATEGORY_NAME[record.category] || '';
  const who = record.userName ? '（' + record.userName + '）' : '';
  const head = record.synced ? '✅ ' + label + '紀錄完成' : '📝 ' + label + '紀錄已暫存';
  const doneText = head + who + '\n' + recordSummaryText(record) + '\n' + syncWording(record);
  await lineReplyCards(token, ev.replyToken, [{
    type: 'text', text: doneText,
    quickReply: quickReplyItems([{ label: '再記一筆', text: AGAIN_CMD[record.category] || '功能選單' }, { label: '📋 功能選單', text: '功能選單' }]),
  }], doneText);
  return true;
}
// 同步失敗的紀錄：使用者下次傳訊息時自動重試（不會重複新增）
async function retryUnsynced(userId, env) {
  try {
    const kv = env.SYNC_KV;
    if (!kv || !userId) return;
    if (!(await kv.get('line:retry:' + userId))) return;
    const first = await readLineLog(kv);
    const updates = {}; // 編號 → 這次重試的結果
    let remaining = 0;
    for (const r of first.list) {
      if (r && r.userId === userId && !r.synced && r.syncStatus === 'fail') {
        const st = await syncRecordToApp(userId, r, env); // 這一步比較慢，所以先全部做完、最後才（重新讀最新清單後）一次寫回，中間別的訊息存進來的紀錄才不會被蓋掉
        if (st === 'fail') remaining++;
        else updates[r.id] = { st, tries: (r.syncTries || 0) + 1 };
      }
    }
    if (Object.keys(updates).length) {
      const cur = await readLineLog(kv);
      let changed = false;
      cur.list.forEach((r) => {
        const u = r && !r.synced ? updates[r.id] : null;
        if (u) { r.syncStatus = u.st; r.syncTries = u.tries; if (u.st === 'ok') r.synced = true; changed = true; }
      });
      if (changed) await kv.put('line:log', JSON.stringify(cur.list));
    }
    if (!remaining) await kv.delete('line:retry:' + userId);
  } catch (e) {}
}

// ---------- 查詢條件解析（年份／月份／日期／關鍵字，可單獨或組合）----------
function parseConditions(rest) {
  let s = ' ' + String(rest || '') + ' ';
  const out = { year: null, month: null, day: null, keywords: [], version: null, page: 1, dateKey: '', all: false, ask: '' };
  VERSION_WORDS.forEach(([v, words]) => { words.forEach((w) => { if (!out.version && s.indexOf(w) >= 0) { out.version = v; s = s.replace(w, ' '); } }); });
  let m = s.match(/第\s*(\d+)\s*頁/);
  if (m) { out.page = Math.max(1, parseInt(m[1], 10)); s = s.replace(m[0], ' '); }
  Object.keys(WISH_DATE_KEYS).forEach((k) => { if (s.indexOf(WISH_DATE_KEYS[k]) >= 0) { out.dateKey = k; s = s.replace(WISH_DATE_KEYS[k], ' '); } });
  if (/\s全部\s/.test(s)) { out.all = true; s = s.replace(/\s全部\s/, ' '); }
  m = s.match(/(\d{4})\s*[-\/.]\s*(\d{1,2})(?:\s*[-\/.]\s*(\d{1,2}))?/);
  if (m) { out.year = +m[1]; out.month = +m[2]; if (m[3]) out.day = +m[3]; s = s.replace(m[0], ' '); }
  const yearRe = /(\d+)\s*年/g;
  let ym;
  while ((ym = yearRe.exec(s))) {
    if (ym[1].length !== 4) { out.ask = '「' + ym[0].trim() + '」看不出是哪一年，請用 4 位數的年份，例如「2026年」。'; return out; }
    out.year = +ym[1];
  }
  s = s.replace(/\d+\s*年/g, ' ');
  const monthRe = /(\d+)\s*月/g;
  let mm;
  while ((mm = monthRe.exec(s))) out.month = +mm[1];
  s = s.replace(/\d+\s*月/g, ' ');
  const dayRe = /(\d+)\s*[日號]/g;
  let dm;
  while ((dm = dayRe.exec(s))) out.day = +dm[1];
  s = s.replace(/\d+\s*[日號]/g, ' ');
  const slash = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (slash) { out.ask = '「' + slash[0] + '」可能是「' + slash[1] + '月' + slash[2] + '日」，也可能是「' + slash[2] + '月' + slash[1] + '日」，我不自己猜。請改成「' + slash[1] + '月' + slash[2] + '日」這種寫法。'; return out; }
  if (out.month !== null && (out.month < 1 || out.month > 12)) { out.ask = '月份要在 1～12 之間，你輸入的是「' + out.month + '月」。'; return out; }
  if (out.day !== null && (out.day < 1 || out.day > 31)) { out.ask = '日期要在 1～31 之間，你輸入的是「' + out.day + '日」。'; return out; }
  if (out.year !== null && (out.year < 1900 || out.year > 2100)) { out.ask = '年份「' + out.year + '」看起來不太對，請再確認。'; return out; }
  if (out.year && out.month && out.day) {
    const dt = new Date(out.year, out.month - 1, out.day);
    if (dt.getFullYear() !== out.year || dt.getMonth() !== out.month - 1 || dt.getDate() !== out.day) { out.ask = out.year + '年' + out.month + '月沒有' + out.day + '日，請再確認日期。'; return out; }
  } else if (out.month && out.day) {
    const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][out.month - 1];
    if (out.day > dim) { out.ask = out.month + '月沒有' + out.day + '日，請再確認日期。'; return out; }
  }
  out.keywords = s.split(/\s+/).map((x) => x.trim()).filter(Boolean);
  return out;
}
function condText(c) {
  const t = [];
  const date = (c.year ? c.year + '年' : '') + (c.month ? c.month + '月' : '') + (c.day ? c.day + '日' : '');
  if (date) t.push(date);
  if (c.dateKey) t.push('（依' + WISH_DATE_KEYS[c.dateKey] + '）');
  if (c.keywords.length) t.push('關鍵字「' + c.keywords.join(' ') + '」');
  return t.length ? t.join(' ') : '全部';
}
function condRest(c) { return condText(c) === '全部' ? '' : condText(c).replace(/（依.+?）\s?/, '').replace('關鍵字「', '').replace('」', ''); }
function hasConditions(c) { return !!(c.year || c.month || c.day || c.keywords.length || c.all); }

// ---------- 指令解析：主功能別名＋操作詞＋條件 ----------
function moduleAliases(cfg) {
  const list = [];
  const push = (alias, mod) => { if (alias && Array.from(String(alias)).length >= 2) list.push({ alias: String(alias), mod }); };
  Object.keys(MODULES).forEach((id) => {
    const m = MODULES[id];
    push(m.name, m); push(m.label, m);
    (cfg.keywords || []).forEach((k) => { if (k.enabled && k.fn === m.fn && k.type === 'exact') push(k.keyword, m); });
    (cfg.subMenus || []).forEach((s) => { if (s.enabled && s.functionId === m.fn) push(s.name, m); });
  });
  return list.sort((a, b) => b.alias.length - a.alias.length);
}
function opOf(word) {
  if (QUERY_OP_RE.test(word)) return 'query';
  if (RECORD_OP_RE.test(word)) return 'record';
  return null;
}
// 回傳 null（不是指令）或 { mod, op, rest }；op 為 null 代表只有主功能名稱（要先選紀錄／查詢）
function parseCommand(text, cfg) {
  const t = String(text || '').trim();
  if (!t) return null;
  const low = t.toLowerCase();
  for (const { alias, mod } of moduleAliases(cfg)) {
    const i = low.indexOf(alias.toLowerCase());
    if (i < 0) continue;
    const prefix = t.slice(0, i).trim();
    let rest = t.slice(i + alias.length).trim();
    let op = null;
    if (prefix) {
      op = opOf(prefix);
      if (!op) continue; // 前面還有別的字（例如「我想喝飲料」）：不是指令
    } else {
      const m = rest.match(/^(查詢|搜尋|搜索|查)\s*/); // 主功能名稱後面只接受「查詢」類操作詞；「飲料紀錄／飲料記錄」是主功能名稱本身，要先顯示紀錄／查詢
      if (m) { op = opOf(m[1]); rest = rest.slice(m[0].length).trim(); }
    }
    if (!op) return rest ? null : { mod, op: null, rest: '' };
    if (op === 'record') {
      const c = parseConditions(rest);
      if (c.ask || c.keywords.length || c.year || c.month || c.day || c.all || c.dateKey) return null; // 「紀錄＋其他內容」可能是在記帳，交給記帳流程
    }
    return { mod, op, rest };
  }
  return null;
}

// ---------- 選單（按鈕送出的文字 = 完整指令）----------
async function sendOpMenu(token, ev, mod) {
  await lineReplyCards(token, ev.replyToken, [{
    type: 'template', altText: mod.name + '：要做什麼？',
    template: {
      type: 'buttons', text: '「' + mod.name + '」要做什麼？',
      actions: [
        { type: 'message', label: '📝 紀錄', text: '紀錄' + mod.name },
        { type: 'message', label: '🔎 查詢', text: '查詢' + mod.name },
        { type: 'message', label: '↩️ 功能選單', text: '功能選單' },
      ],
    },
  }], '「' + mod.name + '」要做什麼？\n・紀錄：輸入「紀錄' + mod.name + '」\n・查詢：輸入「查詢' + mod.name + '」');
}
async function sendVersionMenu(token, ev, mod, op, restClean, cfg) {
  if (op !== 'query' && REC4_SCHEMAS[mod.fn]) { // V10.3：紀錄 → 四種版本（簡易／標準／進階／旗艦）
    await rec4Reply(token, ev.replyToken, [rec4VersionCardMsg(REC4_SCHEMAS[mod.fn].icon + ' ' + mod.name + '紀錄：選擇紀錄版本', '先選好版本，再開始輸入；文字、照片都可以。', (v) => '紀錄' + mod.name + ' ' + REC4_VERSIONS[v].name, { label: '↩️ 返回', text: mod.name }, REC4_SCHEMAS[mod.fn], cfg)]);
    return;
  }
  const word = op === 'query' ? '查詢' : '紀錄';
  const tail = restClean ? ' ' + restClean : '';
  const act = (v) => ({ type: 'message', label: VERSION_INFO[v], text: word + mod.name + tail + ' ' + VERSION_INFO[v] });
  await lineReplyCards(token, ev.replyToken, [{
    type: 'template', altText: mod.name + word + '：選擇版本',
    template: {
      type: 'buttons',
      text: (op === 'query' ? '🔎 ' : '📝 ') + mod.name + word + (restClean ? '（' + restClean + '）' : '') + '：要用哪個版本？',
      actions: [act('simple'), act('standard'), act('flagship'), { type: 'message', label: '↩️ 返回', text: mod.name }],
    },
  }], mod.name + word + '：請輸入「' + word + mod.name + ' 簡易版／標準版／旗艦版」');
}

// ---------- 紀錄：進入對應版本的表單（沿用既有的簡易版／標準版／旗艦版問答）----------
async function launchRecord(mod, version, ctx, ev, token, env) {
  if (!mod.wish && REC4_SCHEMAS[mod.fn]) return rec4StartModule(mod.fn, version, ctx, ev, token, env, await loadLineConfig(env)); // V10.3：飲料／美食／交通 → 四版本紀錄引擎（舊的問答流程只保留給已經在進行中的對話）
  if (mod.wish) return rec4StartModule('wish', version, ctx, ev, token, env, await loadLineConfig(env)); // V10.4：待去清單也有四種版本
  if (!mod.record[version]) {
    const avail = Object.keys(VERSION_INFO).filter((v) => mod.record[v]);
    const msg = '🚧 「' + mod.name + '」的' + VERSION_INFO[version] + '紀錄表單，規格還沒有確認，我不會自己猜欄位。\n目前可用：' + avail.map((v) => VERSION_INFO[v]).join('、') + '。要用完整表單，可以到 App 的「' + mod.label + '」。';
    const items = avail.map((v) => ({ label: VERSION_INFO[v], text: '紀錄' + mod.name + ' ' + VERSION_INFO[v] })).concat([{ label: '功能選單', text: '功能選單' }]);
    await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: msg, quickReply: quickReplyItems(items) }]).catch(() => {});
    return true;
  }
  if (mod.fn === 'travel') {
    await setFlagshipSession(ctx.userId, { flow: 'op', stage: 'pick_travel_type', version, module: 'travel' }, env);
    await lineReplyAsk(token, ev.replyToken, '🚗 交通紀錄（' + VERSION_INFO[version] + '）：要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS.concat([BACK_LABEL]));
    return true;
  }
  const flow = version === 'flagship' ? 'drink' : version;
  const s = { flow, module: mod.tier, mode: null, stage: 'core', stepIndex: 0, answers: {}, direct: true, version };
  await flagshipProceedAfterModule(s, ctx.userId, env, token, ev.replyToken);
  return true;
}

// ---------- 查詢 ----------
function recDateParts(rec, key) {
  const m = String(rec[key] || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}
function recSearchText(rec) {
  return Object.keys(rec).filter((k) => HIDDEN_FIELDS.indexOf(k) < 0).map((k) => rec[k]).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ').toLowerCase();
}
function recMatches(rec, c, dateKey) {
  if (c.year || c.month || c.day) {
    const d = recDateParts(rec, dateKey);
    if (!d) return false;
    if (c.year && d.y !== c.year) return false;
    if (c.month && d.mo !== c.month) return false;
    if (c.day && d.d !== c.day) return false;
  }
  if (c.keywords.length) { const t = recSearchText(rec); if (!c.keywords.every((k) => t.indexOf(k.toLowerCase()) >= 0)) return false; }
  return true;
}
function md(rec, key) { const d = recDateParts(rec, key); return d ? ('0' + d.mo).slice(-2) + '/' + ('0' + d.d).slice(-2) : '日期未記錄'; }
function amt(v) { return v !== undefined && v !== null && v !== '' ? '$' + v : ''; }
function fullFields(rec) {
  return Object.keys(rec).filter((k) => HIDDEN_FIELDS.indexOf(k) < 0 && rec[k] !== undefined && rec[k] !== null && String(rec[k]).trim() !== '')
    .map((k) => (FIELD_LABELS[k] || k) + '：' + (k === 'type' && TRAVEL_TYPE_LABELS[rec[k]] ? TRAVEL_TYPE_LABELS[rec[k]] : rec[k])).join('\n');
}
function recLine(mod, rec, version) {
  const tag = rec._pending ? '（LINE暫存）' : '';
  if (version === 'flagship') return '▪ ' + md(rec, mod.dateKey) + (rec.time ? ' ' + rec.time : '') + tag + '\n' + fullFields(rec);
  const join = (a) => a.filter(Boolean).join(' ');
  const std = version === 'standard';
  if (mod.fn === 'drink') return '▪ ' + join([md(rec, 'date'), rec.brand, rec.drink, std ? '（' + [rec.size, rec.sugar, rec.ice, rec.topping].filter(Boolean).join('/') + '）' : '', amt(rec.amount), std ? rec.payment : '']).replace('（）', '') + tag;
  if (mod.fn === 'food') return '▪ ' + join([md(rec, 'date'), rec.brand, rec.dish, std ? [rec.cuisine, rec.portion, rec.diningType].filter(Boolean).join('/') : '', amt(rec.amount), std ? rec.payment : '']) + tag;
  if (mod.fn === 'travel') return '▪ ' + join([md(rec, 'date'), TRAVEL_TYPE_LABELS[rec.type] || rec.type, [rec.depPort, rec.arrPort].filter(Boolean).join('→'), std ? rec.company : '', std ? rec.no : '', amt(rec.ticketPrice), std ? rec.payment : '']) + tag;
  return '▪ ' + join([rec.name, rec.city ? '（' + rec.city + '）' : '', '・' + (rec.status || '待去'), std ? [rec.country, rec.detailPlace, rec.proposer].filter(Boolean).join(' ') : '']);
}
async function loadQueryRecords(mod, ctx, appName, env) {
  const kv = env.SYNC_KV;
  const out = { records: [], bound: false, pending: 0, blobCount: 0 };
  let code = null;
  try { code = await kv.get('line:usersync:' + ctx.userId); } catch (e) {}
  out.bound = !!code;
  if (code) {
    try {
      const rec = JSON.parse((await kv.get(keyOf(code))) || 'null');
      const raw = rec && rec.data ? rec.data[mod.blobKey] : null;
      const parsed = raw ? JSON.parse(raw) : (mod.wish ? {} : []);
      if (mod.wish) out.records = (Array.isArray(parsed.wishItems) ? parsed.wishItems : []).filter(Boolean);
      else out.records = (Array.isArray(parsed) ? parsed : []).filter((r) => r && r.recorder === appName); // 只看自己的紀錄
      out.blobCount = out.records.length;
    } catch (e) { out.records = []; }
  }
  if (!mod.wish) { // 還沒同步到網頁、暫存在 LINE 的紀錄也要查得到
    try {
      const log = JSON.parse((await kv.get('line:log')) || '[]');
      log.forEach((r) => {
        if (r && r.userId === ctx.userId && r.category === mod.cat && !r.synced) {
          const shaped = shapeForAutoSync(r);
          if (shaped) { const e = Object.assign({}, shaped.entry, { _pending: true }); out.records.push(e); out.pending++; }
        }
      });
    } catch (e) {}
  }
  return out;
}
function sortRecords(a, b) { return String((b.date || '') + (b.time || '')).localeCompare(String((a.date || '') + (a.time || ''))); }
async function runQuery(mod, version, cond, ctx, ev, token, env, cfg, perm) {
  let userName = '';
  try { userName = (ctx.isGroup ? await lineGroupMemberProfile(token, ctx.groupId, ctx.userId) : await lineProfile(token, ctx.userId)) || ''; } catch (e) {}
  const appName = toAppUserName(userName);
  const data = await loadQueryRecords(mod, ctx, appName, env);
  const dateKey = cond.dateKey || mod.dateKey;
  let skipped = 0;
  const rows = data.records.filter((r) => {
    if ((cond.year || cond.month || cond.day) && !recDateParts(r, dateKey)) { skipped++; return false; }
    return recMatches(r, cond, dateKey);
  });
  if (!mod.wish) rows.sort(sortRecords);
  const size = QUERY_PAGE_SIZE[version];
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(cond.page, pages);
  const slice = rows.slice((page - 1) * size, page * size);
  const total = mod.amountKey ? rows.reduce((s, r) => s + (Number(r[mod.amountKey]) || 0), 0) : null;
  let head = '🔎 ' + mod.name + '查詢（' + VERSION_INFO[version] + '）\n條件：' + condText(cond);
  if (!data.bound) head += '\n⚠️ 你還沒綁定同步碼，只能查到暫存在 LINE 的紀錄（網頁上的紀錄需要先綁定同步碼）。';
  let body;
  if (!rows.length) {
    body = head + '\n\n找不到符合條件的紀錄。';
    if (data.bound && !data.blobCount && !data.pending) body += '\n（目前同步資料裡沒有屬於你的「' + mod.name + '」紀錄' + (mod.wish ? '' : '；紀錄是依「記錄者」分開的，LINE 名稱「' + userName + '」對應到 App 帳號「' + appName + '」') + '）';
  } else {
    body = head + '\n共 ' + rows.length + ' 筆' + (total !== null ? '・合計 $' + total : '') + (pages > 1 ? '・第 ' + page + '／' + pages + ' 頁' : '') + '\n\n' + slice.map((r) => recLine(mod, r, version)).join('\n\n');
    if (data.pending) body += '\n\n標示「LINE暫存」的是還沒同步到網頁的紀錄。';
  }
  if (skipped) body += '\n\n另有 ' + skipped + ' 筆沒有「' + (mod.wish ? WISH_DATE_KEYS[dateKey] : '日期') + '」，沒有納入日期條件。';
  if (body.length > 4800) body = body.slice(0, 4780) + '\n…（內容太長已截斷，請縮小條件）';
  const baseTail = condRest(cond) ? ' ' + condRest(cond) : '';
  const items = [];
  if (page < pages) items.push({ label: '下一頁', text: ('查詢' + mod.name + baseTail + ' ' + VERSION_INFO[version] + ' 第' + (page + 1) + '頁').slice(0, 280) });
  ['simple', 'standard', 'flagship'].filter((v) => v !== version).forEach((v) => items.push({ label: '改用' + VERSION_INFO[v], text: ('查詢' + mod.name + baseTail + ' ' + VERSION_INFO[v]).slice(0, 280) }));
  items.push({ label: '功能選單', text: '功能選單' });
  const messages = [{ type: 'text', text: body, quickReply: quickReplyItems(items) }];
  if (!ctx.isGroup || perm.groupReply === 'public') { await lineReplyCards(token, ev.replyToken, messages, body); return true; }
  const res = await linePush(token, ctx.userId, messages);
  if (res && res.ok) await lineReply(token, ev.replyToken, '🔎 查詢結果已私訊給你 ✉️');
  else await lineReply(token, ev.replyToken, PRIVATE_FAIL_TEXT);
  return true;
}

// ---------- 指令執行 ----------
async function runCommand(cmd, ctx, ev, token, env, cfg) {
  const mod = cmd.mod;
  if (ctx.isGroup && mod.wish && cmd.op === 'record') { // V10.7.0：待去清單的「紀錄」在群組只給看版本說明卡（不看群組授權）；功能停用、只限指定的人照樣擋
    const av0 = checkAvailability(mod.fn, ctx, cfg, { view: true });
    if (!av0.ok) { await lineReplyQuick(token, ev.replyToken, av0.message, ['功能選單']); return true; }
    return executeFunction('wish_add', ctx, ev, token, env, cfg);
  }
  const av = checkAvailability(mod.fn, ctx, cfg, { read: cmd.op !== 'record' });
  if (!av.ok) { await lineReplyQuick(token, ev.replyToken, av.message, ['功能選單']); return true; }
  if (!cmd.op) { await sendOpMenu(token, ev, mod); return true; }
  const cond = parseConditions(cmd.rest);
  if (cond.ask) { await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: '🤔 ' + cond.ask, quickReply: quickReplyItems(['功能選單']) }]).catch(() => {}); return true; }
  const restClean = condRest(cond);
  if (cmd.op === 'record') {
    if (mod.wish) return ctx.isGroup || !cond.version ? executeFunction('wish_add', ctx, ev, token, env, cfg) : rec4StartModule('wish', cond.version, ctx, ev, token, env, cfg); // V10.4：待去清單有四種版本（沒指定版本 → 版本卡片；群組是個人資料，維持原本的說明）。仍然是先建立草稿，到網頁確認後才寫入
    if (!cond.version) { await sendVersionMenu(token, ev, mod, 'record', '', cfg); return true; }
    return launchRecord(mod, cond.version, ctx, ev, token, env);
  }
  const version = (cond.version && cond.version !== 'advanced' ? cond.version : null) || (cfg.query && cfg.query.defaultVersion) || null; // 查詢只有簡易／標準／旗艦三種顯示詳細程度
  if (mod.wish && (cond.year || cond.month || cond.day) && !cond.dateKey) { // 待去清單有三種日期，不自己猜
    const items = Object.keys(WISH_DATE_KEYS).map((k) => ({ label: WISH_DATE_KEYS[k], text: ('查詢' + mod.name + ' ' + (restClean ? restClean + ' ' : '') + WISH_DATE_KEYS[k] + (version ? ' ' + VERSION_INFO[version] : '')).slice(0, 280) }));
    await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: '待去清單有三種日期，你要用哪一種來篩選？', quickReply: quickReplyItems(items.concat([{ label: '功能選單', text: '功能選單' }])) }]).catch(() => {});
    return true;
  }
  if (!version) { await sendVersionMenu(token, ev, mod, 'query', restClean + (cond.dateKey ? ' ' + WISH_DATE_KEYS[cond.dateKey] : ''), cfg); return true; }
  if (!hasConditions(cond)) {
    await setFlagshipSession(ctx.userId, { flow: 'op', stage: 'await_cond', module: mod.fn, version }, env);
    await lineReplyAsk(token, ev.replyToken, '🔎 ' + mod.name + '查詢（' + VERSION_INFO[version] + '）\n請輸入查詢條件：年份、月份、日期、關鍵字，可以單獨輸入，也可以組合，例如：\n・2026年\n・10月\n・2026年10月18日\n・2026年10月 咖啡\n・咖啡\n想看全部，輸入「全部」', [BACK_LABEL, '全部']);
    return true;
  }
  return runQuery(mod, version, cond, ctx, ev, token, env, cfg, av.perm);
}

// ---------- 進行中的對話：等待輸入查詢條件／選交通類型 ----------
async function handleOpMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const ctx = makeCtx(ev);
  if (!ctx.userId) return false;
  const session = await getFlagshipSession(ctx.userId, env);
  if (!session || session.flow !== 'op') return false;
  const mod = Object.keys(MODULES).map((k) => MODULES[k]).find((m) => m.fn === session.module);
  if (!mod) { await clearFlagshipSession(ctx.userId, env); return false; }
  if (QUICK_CANCEL_RE.test(text)) { await clearFlagshipSession(ctx.userId, env); await lineReplyQuick(token, ev.replyToken, '已取消。', ['功能選單']); return true; }
  if (BACK_RE.test(text)) { await clearFlagshipSession(ctx.userId, env); await sendOpMenu(token, ev, mod); return true; }
  const cfg = await loadLineConfig(env);
  const av = checkAvailability(mod.fn, ctx, cfg, { read: session.stage === 'await_cond' });
  if (!av.ok) { await clearFlagshipSession(ctx.userId, env); await lineReply(token, ev.replyToken, av.message); return true; }
  if (session.stage === 'pick_travel_type') {
    const tt = TRAVEL_TYPE_TRIGGERS[text];
    if (!tt) { await lineReplyAsk(token, ev.replyToken, '請從清單裡選一種交通：', TRAVEL_TYPE_OPTIONS.concat([BACK_LABEL])); return true; }
    const flow = session.version === 'flagship' ? 'drink' : session.version;
    const s = { flow, module: 'travel', travelType: tt, mode: null, stage: 'core', stepIndex: 0, answers: {}, direct: true, version: session.version };
    await flagshipProceedAfterModule(s, ctx.userId, env, token, ev.replyToken);
    return true;
  }
  if (session.stage === 'await_cond') {
    const cond = parseConditions(text);
    if (cond.ask) { await lineReplyAsk(token, ev.replyToken, '🤔 ' + cond.ask + '\n請再輸入一次查詢條件。', [BACK_LABEL, '全部']); return true; }
    if (!hasConditions(cond)) { await lineReplyAsk(token, ev.replyToken, '我沒有看到年份、月份、日期或關鍵字。請再輸入一次，或輸入「全部」。', [BACK_LABEL, '全部']); return true; }
    await clearFlagshipSession(ctx.userId, env);
    if (mod.wish && (cond.year || cond.month || cond.day) && !cond.dateKey) return runCommand({ mod, op: 'query', rest: text + ' ' + VERSION_INFO[session.version] }, ctx, ev, token, env, cfg);
    return runQuery(mod, session.version, cond, ctx, ev, token, env, cfg, av.perm);
  }
  await clearFlagshipSession(ctx.userId, env);
  return false;
}

// ---------- 版本與欄位規格（由程式裡真正的定義產生，不是手寫文件；沒有確認的標示「待確認」）----------
function buildSpecs() {
  const plain = (f) => f.label.replace('（選填）', '');
  const modules = Object.keys(MODULES).filter((id) => !MODULES[id].wish).map((id) => {
    const m = MODULES[id];
    const sch = REC4_SCHEMAS[id];
    const simpleFields = id === 'travel' ? ['交通類型（沒說就會問）', '出發地、到達地（句子裡有才記）', '票價'] : [rec4Label(id, sch.itemKey), rec4Label(id, sch.moneyKey)];
    return {
      id, name: m.name, label: m.label,
      record: {
        simple: { status: 'confirmed', fields: simpleFields, note: '輸入「品項＋金額」（文字或照片），系統歸類寫入對應欄位；沒提供的資料絕不猜測、不寫入錯誤欄位；無法辨識的必要資訊會適度提問確認。最後一定進「確認送出／返回修改／取消紀錄」' },
        standard: { status: 'confirmed', fields: DRAFT_SCOPE_FIELDS[id].map((k) => draftLabel(id, k)), note: '一句話描述（文字或照片），AI 拆成欄位；未提及的內容不臆測、不確定的欄位保持空白（看不清楚的標「待確認」）；辨識完成後提供紀錄摘要供核對確認；缺少必填才補問' },
        advanced: { status: 'confirmed', fields: sch.fields.filter((f) => f.adv || f.req).map(plain), note: '一次只問一個欄位；已從文字或照片辨識到的不重問（不太確定的會請你確認）；選填欄位可回答「無」「略過」「不知道」，必填欄位要回答才能繼續；全部回答完顯示完整摘要供確認送出' },
        flagship: sch.flagshipReady
          ? { status: 'confirmed', fields: sch.fields.map(plain), note: '依網頁「' + m.label + '」表單的全部欄位順序一次一問，不刪減、不合併（選填可略過，也可點「其餘略過」）；已辨識的資料自動帶入並請你確認，未提及的不編造；幣別沒寫明預設新臺幣 TWD（網頁顯示 NT$）；填完顯示完整紀錄供確認後存檔' }
          : { status: 'pending', fields: [], note: '網頁「' + m.label + '」表單還有欄位要逐欄核對（美食：飽足感、回訪意願、付款者…；交通：各交通類型的專屬欄位），規格確認前不開放，不自己猜欄位' },
      },
      query: {
        conditions: ['年份', '月份', '日期', '關鍵字（可單獨或組合）'],
        simple: { status: 'default', note: '摘要（筆數、合計）＋每頁 5 筆的簡短一行' },
        standard: { status: 'default', note: '摘要＋每頁 8 筆，含主要欄位' },
        flagship: { status: 'default', note: '摘要＋每頁 3 筆，顯示該筆儲存的全部欄位' },
      },
    };
  });
  // V10.4：分帳、集點卡、待去清單的四種版本（欄位＝網頁表單的欄位；群組與成員、孩子與行為、分類都對照使用者自己的資料）
  const LIST_RULE = '只在 1 對 1 聊天室記錄；要先綁定同步碼、App 同步過一次、管理頁「草稿模式」開著（不符合條件的人，維持原本的流程）。群組、多人聊天室只能看這張版本說明卡（卡片註明「要記錄請到 1 對 1」），不讀清單、不開始記錄。按「確認送出」＝建立網頁待確認草稿，到網頁按【確認新增】後才正式儲存、產生流水號。';
  const newMod = (id, name, label, sch, notes) => ({
    id, name, label,
    record: {
      simple: { status: 'confirmed', fields: sch.simpleFields.slice(), note: notes.simple + '　' + LIST_RULE },
      standard: { status: 'confirmed', fields: DRAFT_SCOPE_FIELDS[sch.kind].map((k) => draftLabel(sch.kind, k)), note: notes.standard + '　' + LIST_RULE },
      advanced: { status: 'confirmed', fields: sch.fields.filter((f) => f.adv || f.req === true).map(plain), note: notes.advanced + '　' + LIST_RULE },
      flagship: { status: 'confirmed', fields: sch.fields.map(plain), note: notes.flagship + '　' + LIST_RULE },
    },
    query: null,
  });
  const splitMod = newMod('split', '分帳', '分帳', REC4_SCHEMAS.split, {
    simple: '輸入「品項＋金額」（文字或照片）；只有一個分帳群組就直接用、有多個會問；誰先付錢一定會問（不替你決定）；分給誰沒說就是全部成員均分；日期、時間沒填暫用 LINE 傳送時間並標待確認',
    standard: '一句話描述（文字或照片），AI 對照你的分帳群組與成員拆成欄位；對不上成員的名字不硬收、標「待確認」；每個人金額不同、名字對得上且總和等於金額，會直接帶入自訂金額',
    advanced: '一次問一個欄位（群組、品項、金額、誰先付錢、分給誰）；已辨識的不重問，不太確定的請你確認；分給誰可點「全部成員」，或輸入多位成員（頓號隔開）',
    flagship: '依網頁分帳「新增支出」表單的全部欄位一次一問（類型、日期、時間、類別、幣別、付款方式、如何分…），不刪減、不合併；「如何分」選自訂金額會逐一問每位的金額（總和必須等於金額）；幣別沒寫明預設用該群組在 App 設定的幣別（沒設才用新臺幣 TWD）',
  });
  const stickerMod = newMod('sticker', '集點卡', '集點卡', REC4_SCHEMAS.sticker, {
    simple: '輸入「孩子＋行為」（文字或照片）；點數用該行為在 App 設定的點數（沒設定會問）；孩子與行為要對得上你的集點卡清單，對不上的不硬收',
    standard: '一句話描述（文字或照片），AI 對照你的孩子與行為清單拆成欄位；清單以外的行為標「待確認」；互助集點卡可以說「互助 洗碗 加2點」',
    advanced: '一次問一個欄位（集點卡種類、孩子、行為、點數）；互助集點卡沒有孩子與行為；點數加點填正數、扣點填負數，不能是 0',
    flagship: '依網頁集點卡「記一筆」的全部欄位一次一問（集點卡種類、孩子、行為、點數、日期、時間、紀錄者、原因／備註）；行為的預設點數會請你確認',
  });
  const wishlist = newMod('wishlist', '待去清單', '待去清單', REC4_SCHEMAS.wish, {
    simple: '只需輸入「地點名稱」（文字或照片）；提議者是網頁的必填欄位，所以會問一次（可點「我」）；其他欄位不問，提議日期用 LINE 傳送的日期、狀態預設待去',
    standard: '一句話描述（文字或照片），AI 拆成分類、國家、城市、詳細地點、推薦原因、來源、預計時間；沒提到的不編造',
    advanced: '一次問一個欄位（分類、項目名稱、國家、城市、詳細地點、推薦原因、提議者）；項目名稱必填',
    flagship: '依網頁待去清單「新增項目」的全部欄位一次一問（含備註、來源、推薦指數 3～5 顆星、提議日期、狀態、預計時間）；沒填的推薦指數網頁預設 5 顆星、提議日期用 LINE 傳送日期、狀態預設待去',
  });
  wishlist.query = { conditions: ['關鍵字', '年／月／日（需指定依「提議日期／預計時間／完成日期」哪一種）'], simple: { status: 'default', note: '摘要＋每頁 5 筆' }, standard: { status: 'default', note: '摘要＋每頁 8 筆' }, flagship: { status: 'default', note: '摘要＋每頁 3 筆，全部欄位' } };
  const pending = [
    '美食紀錄、交通紀錄「旗艦版」：網頁表單的全部欄位要逐欄核對後才開放（美食的飽足感、回訪意願、付款者；交通各類型的專屬欄位，例如機身／船舶編號、車牌）',
    '分帳、集點卡、待去清單的四種版本：記錄只在 1 對 1 聊天室，需要綁定同步碼並同步過一次、草稿模式開著；不符合條件的人維持原本的流程（要不要改成也能直接寫入 LINE 紀錄，等你決定）。群組、多人聊天室只能看版本說明卡（V10.7.0 起，卡片註明「要記錄請到 1 對 1」），不能用四種版本記錄。照片只有帶著清楚文字（收據、帳單、截圖、手寫便條）時才有用，一般生活照會回報「看不出來」',
    '分帳在群組裡原本就有「快速記錄」（輸入「分帳」→ 例如「晚餐 1200 AA」→ 建立待確認草稿），這次沒有動；要不要改成群組也只准在 1 對 1 記錄，等你決定。集點卡的原流程（群組已授權時，孩子的選項私訊給本人）同樣沒有動',
    '三個版本的「查詢」各自該呈現什麼（目前只用「顯示詳細程度」區分，欄位都不刪減；這是預設值，等你確認）',
    '旗艦版查詢的「進階條件」與「管理能力」（例如修改、刪除）',
    '記帳仍是原本的流程；分帳、集點卡在 LINE 還沒有「查詢」與「管理」（修改、刪除），要先確認怎麼查、查哪些欄位、每個版本各自呈現什麼',
    '透過 LINE 修改、刪除已儲存的紀錄：要選哪一筆、誰有權限、怎麼確認',
    '照片原檔要不要保存（要保存的話，需要先開 Cloudflare R2 儲存桶，再決定保存多久、誰看得到；目前一律不保存原檔，只保留你確認後的辨識結果）',
  ];
  const versions = REC4_ORDER.map((v) => ({ id: v, emoji: REC4_VERSIONS[v].emoji, name: REC4_VERSIONS[v].name, tag: REC4_VERSIONS[v].tag, lines: rec4VerLines(v, null) }));
  const tool = (id, note) => ({ id, name: FUNCTION_CATALOG[id].label, status: 'default', note });
  const tools = [
    tool('tool_compass', '奇遇羅盤（選地點）：點一下，從「你的待去清單」（狀態是待去／已安排的項目；只在 1 對 1，且要綁定同步碼）隨機抽一個，回一張店家圖卡（店名、營業狀態、地址、營業時間、Google 地圖按鈕）；也可以改從你的飲料紀錄地點、固定清單（東區／信義區／天母等地點，原「喝哪裡」）或你輸入的清單抽；每個選項機率相同'),
    tool('tool_surprise', '驚喜製造所（選店家）：點一下，從「你的待去清單」（狀態是待去／已安排的項目；只在 1 對 1，且要綁定同步碼）隨機抽一個，回一張店家圖卡；也可以改從你的飲料／美食紀錄店家、固定清單（珍珠奶茶／翡翠檸檬等飲品，原「喝什麼」）或你輸入的清單抽；每個選項機率相同'),
    tool('tool_wheel', '轉盤：點一下就用內建選項（誰買單、今晚吃大餐、回家洗洗睡…）轉出結果「轉盤轉動中... 停！最後指針落在：…」；也可以自己輸入至少 2 個選項（一行打完：轉盤 A B C）'),
    tool('tool_coin', '拋硬幣：「叮！硬幣落地了，結果是：正面／反面」，或自訂兩個面（拋硬幣 吃 不吃）'),
    tool('tool_bottle', '轉瓶子：點一下就用內建的人選（左手邊的人、最晚到的人…）；也可以輸入至少 2 個人名，瓶口隨機指向一個人'),
    tool('tool_box', '隨機盒子：「搖一搖... 打開盒子！」預設 8 種獎品（跟網頁的隨機盒子一樣），或自訂獎品（隨機盒子 A B C）'),
    tool('tool_dice', '骰子：「喀啦喀啦... 你擲出了：4 點！」，1～6 顆標準六面骰（骰子 3），多顆會列出每顆與合計'),
    tool('tool_rps', '剪刀石頭布（互動對決）：V10.9.0 起「工具」選單裡的 ✌️剪刀／✊石頭／✋布 3 格，點了直接出那一拳的結果，不用再選；打字「猜拳」或「剪刀石頭布」則維持先跳出 ✊ 石頭、✌️ 剪刀、✋ 布 三顆按鈕，選了之後小秘書才隨機出拳；回「你出了／小秘書出／結果（你獲勝、小秘書獲勝、平手）」，下面的三顆按鈕可以一直再玩'),
    tool('tool_rps_auto', '自動剪刀石頭布（一鍵自動對決）：「工具」選單的 🤖自動 格，點一下就直接出結果，不用再選——你的拳和小秘書的拳都由程式隨機出（各自獨立、每種拳機率相同），同樣回「你出了／小秘書出／結果」；下面有「再來一局」按鈕'),
    { id: 'device', name: FUNCTION_CATALOG.device.label, status: 'pending', note: '選單上有這個項目，但目前沒有對應的功能內容（待確認要做什麼），點進去只會說明「尚未開發」，不自己猜' },
  ];
  return { modules: modules.concat([splitMod, stickerMod, wishlist]), versions, formMode: FORM_MODE_REMINDER.split('\n'), formModeMore: FORM_MODE_MORE, tools, pending, drafts: buildDraftScope() };
}

// ---------- 執行功能 ----------
async function executeFunction(fn, ctx, ev, token, env, cfg) {
  if (!fnInfo(fn, cfg)) { await lineReply(token, ev.replyToken, '找不到這個功能，可能已經被管理員移除。'); return true; }
  if (fn === 'menu') { await sendMenuFor(token, ev, cfg, null); return true; }
  if (fn.indexOf('menu:') === 0) { await sendMenuFor(token, ev, cfg, fn.slice(5)); return true; }
  if (fn.indexOf('url:') === 0) { await lineReplyMessages(token, ev.replyToken, [{ type: 'template', altText: '🔗 開啟網址', template: { type: 'buttons', text: '點下面的按鈕，開啟網頁', actions: [{ type: 'uri', label: '🔗 開啟網址', uri: fn.slice(4) }] } }]).catch(() => {}); return true; } // V10.14：自訂網址——送出可以直接點開瀏覽器的按鈕，不是純文字連結；跟其他直接呼叫lineReplyMessages的地方一樣，網路失敗不丟例外
  const mainMod = Object.keys(MODULES).map((k) => MODULES[k]).find((m) => m.fn === fn);
  if (mainMod) return runCommand({ mod: mainMod, op: null, rest: '' }, ctx, ev, token, env, cfg); // 先選「紀錄／查詢」
  if (fn === 'wish_add' && ctx.isGroup) { await rec4ViewOnly(REC4_SCHEMAS.wish, ctx, ev, token, cfg); return true; } // V10.7.0：群組不新增待去地點（個人資料）；改回版本說明卡，卡片註明「要記錄請到 1 對 1」。不用先檢查群組授權（只是看說明）
  const av = checkAvailability(fn, ctx, cfg);
  if (!av.ok) { await lineReplyQuick(token, ev.replyToken, av.message, ['功能選單']); return true; }
  switch (fn) {
    case 'ledger': case 'split_add': {
      if (fn === 'split_add' && !ctx.isGroup) return rec4StartModule('split', '', ctx, ev, token, env, cfg); // V10.4：分帳＝四種版本（沒辦法建立網頁草稿的人，裡面會改走原本的快速記錄）
      const kind = Object.keys(QUICK_KINDS).find((q) => QUICK_KINDS[q].fn === fn);
      await startQuickRecord(kind, ctx.userId, env, token, ev.replyToken);
      return true;
    }
    case 'wish_add': // V10.4：待去清單＝四種版本（群組在上面已擋下）；沒辦法建立草稿的人，裡面會先說明原因，不讓他輸入完才被拒絕
      return rec4StartModule('wish', '', ctx, ev, token, env, cfg);
    case 'split': await sendSplitCard(token, ev); return true;
    case 'sticker':
      if (!ctx.isGroup) return rec4StartModule('sticker', '', ctx, ev, token, env, cfg); // V10.4：集點卡＝四種版本（沒辦法建立網頁草稿的人，裡面會改走原本的選孩子流程）
      await enterSticker(ctx, ev, token, env, av.perm);
      return true;
    case 'drafts': await sendDraftsList(ctx, ev, token, env, av.perm); return true;
    case 'device': return sendDeviceCenter(token, ev);
    case 'tool_compass': case 'tool_surprise': case 'tool_wheel': case 'tool_coin': case 'tool_bottle': case 'tool_box': case 'tool_dice': case 'tool_rps': case 'tool_rps_auto':
      return runLineTool(fn, ctx, ev, token, env, cfg, '');
    default:
      if (FAQ_REPLIES[fn]) { await lineReplyQuick(token, ev.replyToken, FAQ_REPLIES[fn], ['功能選單']); return true; } // 新增：FAQ常見問答，純文字回覆，不開始任何流程、不寫入任何資料
      return false;
  }
}

// ---------- 記下看過哪些使用者／群組（讓管理頁面可以挑選、授權）；只有第一次看到才寫入 ----------
// 群組名稱：有名稱的群組每天最多重新問 LINE 一次（群組改名後，管理頁才會跟著更新）；還沒問到名稱的，每 10 分鐘再試一次（避免每則訊息都寫一次 KV）
const GROUP_NAME_REFRESH_MS = 24 * 60 * 60 * 1000;
const GROUP_NAME_RETRY_MS = 10 * 60 * 1000;
async function touchRegistry(ev, token, env, ctx) {
  try {
    const kv = env.SYNC_KV;
    if (!kv) return;
    let reg = {};
    try { reg = JSON.parse((await kv.get(REGISTRY_KEY)) || '{}'); } catch (e) { reg = {}; }
    if (!reg || typeof reg !== 'object' || Array.isArray(reg)) reg = {};
    reg.users = reg.users || {};
    reg.groups = reg.groups || {};
    let changed = false;
    const now = Date.now();
    if (ctx.userId && !reg.users[ctx.userId]) {
      let name = '';
      try { name = (ctx.isGroup ? await lineGroupMemberProfile(token, ctx.groupId, ctx.userId) : await lineProfile(token, ctx.userId)) || ''; } catch (e) {}
      reg.users[ctx.userId] = { name, at: now };
      changed = true;
    }
    // 群組：即使傳訊息的人看不到身分（沒有 userId），群組本身也要登記，管理頁才找得到它
    if (ctx.isGroup && ctx.groupId) {
      const g = reg.groups[ctx.groupId];
      const canAskName = !!(ev.source && ev.source.type === 'group'); // 多人聊天室（room）沒有名稱可查
      const age = now - ((g && (g.checkedAt || g.at)) || 0);
      if (!g) {
        let gname = '';
        if (canAskName) { try { gname = (await lineGroupSummary(token, ctx.groupId)) || ''; } catch (e) {} }
        reg.groups[ctx.groupId] = { name: gname, at: now, checkedAt: now };
        changed = true;
      } else if (canAskName && age > (g.name ? GROUP_NAME_REFRESH_MS : GROUP_NAME_RETRY_MS)) {
        let gname = '';
        try { gname = (await lineGroupSummary(token, ctx.groupId)) || ''; } catch (e) {}
        if (gname) g.name = gname;
        g.checkedAt = now;
        changed = true;
      }
    }
    if (changed) await kv.put(REGISTRY_KEY, JSON.stringify(reg));
  } catch (e) {}
}

// ============================================================
// 🕒 營業狀態引擎（V10.5：LINE 店家圖卡用）
//   「BIZ-ENGINE-BEGIN ～ BIZ-ENGINE-END」和下面的 bizLegacyText、bizSource，是從 public/wishlist.html『原封不動』複製過來的
//   （網頁怎麼判斷營業中／休息中，LINE 圖卡就怎麼判斷）。改這一段時兩個檔案要一起改；
//   test/backend108.test.mjs 會逐字比對兩份一模一樣，test/biz110.test.mjs 用 SDA_BIZ_ENGINE 指向本檔也要全過。
// ============================================================
/* ===== BIZ-ENGINE-BEGIN（營業狀態判斷引擎；改這一段請同時跑 test/web110.test.mjs、test/biz_unit.mjs）===== */
// 依「營業時間」「休息日」和「現在的時間」算出：🟢營業中／🟡即將打烊／🟠即將營業／🔴休息中／⚪資訊未提供
// 原則：看得懂的才判斷，看不懂就老實說「資訊未提供」，不亂猜。
const BIZ_SOON_MIN = 60; // 「即將打烊」「即將營業」的緩衝分鐘數（含剛好 60 分鐘）
const BIZ_STATES = {
  open:    { text: '營業中',     emoji: '🟢', color: 'biz-open' },
  closing: { text: '即將打烊',   emoji: '🟡', color: 'biz-closing' },
  opening: { text: '即將營業',   emoji: '🟠', color: 'biz-opening' },
  closed:  { text: '休息中',     emoji: '🔴', color: 'biz-closed' },
  unknown: { text: '資訊未提供', emoji: '⚪', color: 'biz-unknown' }
};
const BIZ_WD_CHARS = '日一二三四五六'; // 位置 = JavaScript 的 getDay()（日 0、一 1 … 六 6）
function bizWdOf(ch) { return ch === '天' ? 0 : BIZ_WD_CHARS.indexOf(ch); }
function bizNumOf(ch) { const k = '一二三四五'.indexOf(ch); return k >= 0 ? k + 1 : parseInt(ch, 10); }

// ---- 1. 把文字整理成好讀的樣子：全形→半形、各種橫線→-、頓號→逗號、空白合併、英文轉小寫 ----
function bizNorm(v) {
  const s = String(v == null ? '' : v).slice(0, 600);
  let o = '';
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xFF01 && c <= 0xFF5E) c -= 0xFEE0; // 全形英數與符號 → 半形
    else if (c === 0x3000 || c === 0xA0 || c === 0x2009 || c === 0x202F || c === 10 || c === 13 || c === 9) c = 32; // 各種空白、換行
    else if (c === 0x200B || c === 0x200C || c === 0x200D || c === 0xFEFF) continue; // 看不見的字元
    else if ((c >= 0x2010 && c <= 0x2015) || c === 0x2212 || c === 0xFE58 || c === 0xFE63 || c === 0x301C) c = 45; // 各種橫線、波浪線 → -
    else if (c === 0x3001) c = 44; // 、 → ,
    else if (c === 0x3002) c = 59; // 。 → ;
    o += String.fromCharCode(c);
  }
  return o.toLowerCase().replace(/~/g, '-').replace(/ +/g, ' ').trim();
}

// ---- 2. 辨識「星期幾」：週一、週六日、週一至週五、星期二、禮拜三、平日、假日、每日、Mon-Fri ----
const BIZ_PFX = '(?:週|周|星期|禮拜|礼拜)';
const BIZ_W = '[一二三四五六日天]';
const BIZ_EN = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 0, sunday: 0 };
function bizCycle(a, b) { // 從 a 往後數到 b（含），週日接在週六後面：週五→週日 = 五、六、日
  const out = [];
  let x = a, n = 0;
  for (;;) { out.push(x); if (x === b || ++n > 7) break; x = (x + 1) % 7; }
  return out;
}
function bizUnion(list, items) {
  const set = {};
  items.forEach(it => bizCycle(it[0], it[1]).forEach(d => { set[d] = 1; }));
  (list || []).forEach(d => { set[d] = 1; });
  return Object.keys(set).map(Number).sort((x, y) => x - y);
}
function bizMatchDays(r, prev) {
  let m;
  if ((m = /^(?:每日|每天|天天|全週|整週|every ?day|daily|7 ?days)/.exec(r))) return { len: m[0].length, set: [0, 1, 2, 3, 4, 5, 6] };
  if ((m = /^(?:平日|週間|工作日|weekdays?)/.exec(r))) return { len: m[0].length, set: [1, 2, 3, 4, 5] };
  if ((m = /^(?:週末|例假日|假日|weekends?)/.exec(r))) return { len: m[0].length, set: [6, 0] };
  m = new RegExp('^' + BIZ_PFX + '(' + BIZ_W + ')').exec(r);
  if (m) {
    let len = m[0].length;
    const items = [[bizWdOf(m[1]), bizWdOf(m[1])]];
    for (;;) {
      const t = r.slice(len);
      let mm = new RegExp('^ ?(?:-|至|到) ?' + BIZ_PFX + '?(' + BIZ_W + ')').exec(t); // 範圍：週一至週五、週一~五
      if (mm) { items[items.length - 1][1] = bizWdOf(mm[1]); len += mm[0].length; continue; }
      mm = new RegExp('^(?: ?(?:,|/|和|及|與|&) ?' + BIZ_PFX + '?|' + BIZ_PFX + ')(' + BIZ_W + ')').exec(t); // 清單：週一、三、五
      if (!mm) mm = new RegExp('^(' + BIZ_W + ')').exec(t); // 連寫：週六日、週一二
      if (mm) { const d = bizWdOf(mm[1]); items.push([d, d]); len += mm[0].length; continue; }
      break;
    }
    return { len, set: bizUnion([], items) };
  }
  // 英文：Mon-Fri、Sat, Sun、Monday
  if (prev && /[a-z]/.test(prev)) return null; // 英文單字的中間不算
  m = /^([a-z]+)\.?/.exec(r);
  if (m && BIZ_EN[m[1]] !== undefined) {
    let len = m[0].length;
    const items = [[BIZ_EN[m[1]], BIZ_EN[m[1]]]];
    for (;;) {
      const t = r.slice(len);
      let mm = /^ ?(?:-|to|until|through|thru) ?([a-z]+)\.?/.exec(t);
      if (mm && BIZ_EN[mm[1]] !== undefined) { items[items.length - 1][1] = BIZ_EN[mm[1]]; len += mm[0].length; continue; }
      mm = /^ ?(?:,|\/|&|and) ?([a-z]+)\.?/.exec(t);
      if (mm && BIZ_EN[mm[1]] !== undefined) { items.push([BIZ_EN[mm[1]], BIZ_EN[mm[1]]]); len += mm[0].length; continue; }
      break;
    }
    return { len, set: bizUnion([], items) };
  }
  return null;
}

// ---- 3. 辨識「時間」：11:00、11點、11點半、下午9點、9pm、隔天2點；「時間範圍」：11:00-14:00、11:00至14:00 ----
const BIZ_TPFX = '(?:上午|早上|早晨|清晨|凌晨|中午|正午|下午|午後|傍晚|晚上|夜間|夜晚|深夜|半夜|翌日|隔天|隔日|次日|翌|明天|明日)';
const BIZ_T = '((?:' + BIZ_TPFX + ' ?){0,2})(\\d{1,2})(?:: ?(\\d{2})(?!\\d)| ?[點点時时] ?(?:(\\d{1,2}) ?分?|(半))?|(?= ?(?:am|pm|a\\.m\\.|p\\.m\\.)))(?: ?(am|pm|a\\.m\\.|p\\.m\\.))?';
const BIZ_RANGE_RE = new RegExp('^' + BIZ_T + ' ?(?:-|至|到|to|until|till) ?' + BIZ_T);
function bizTimeMin(g, inheritPM) { // g = [前綴, 時, 分, 點後的分, 半, am/pm]；傳回「從 00:00 起算的分鐘數」，看不懂傳回 null
  const word = (g[0] || '').replace(/ /g, '');
  let h = parseInt(g[1], 10);
  const m = g[2] ? parseInt(g[2], 10) : g[3] ? parseInt(g[3], 10) : g[4] ? 30 : 0;
  if (!(h >= 0 && h <= 29) || m > 59) return null;
  const ap = g[5] ? g[5].charAt(0) : '';
  const next = /翌|隔|次日|明/.test(word) ? 1440 : 0;
  if (ap === 'p') { if (h < 12) h += 12; }
  else if (ap === 'a') { if (h === 12) h = 0; }
  else if (/上午|早上|早晨|清晨|凌晨/.test(word)) { if (h === 12) h = 0; }
  else if (/中午|正午/.test(word)) { if (h >= 1 && h <= 6) h += 12; }
  else if (/下午|午後/.test(word)) { if (h < 12) h += 12; }
  else if (/傍晚|晚上|夜間|夜晚/.test(word)) { if (h < 12) h += 12; else if (h === 12) h = 24; }
  else if (/深夜|半夜/.test(word)) { if (h >= 6 && h < 12) h += 12; else if (h === 12) h = 24; }
  else if (inheritPM && h < 12) h += 12;
  return h * 60 + m + next;
}
function bizPM(g) { const w = (g[0] || '').replace(/ /g, ''); return g[5] === 'pm' || g[5] === 'p.m.' || /下午|午後|傍晚|晚上|夜間|夜晚/.test(w); }
function bizMatchRange(r) {
  const m = BIZ_RANGE_RE.exec(r);
  if (!m) return null;
  const a = m.slice(1, 7), b = m.slice(7, 13);
  const bHasMark = !!((b[0] || '').trim() || b[5]);
  const s = bizTimeMin(a, false);
  let e = bizTimeMin(b, !bHasMark && bizPM(a));
  if (s === null || e === null) return null;
  if (e <= s) { if (e === s && s !== 0) return null; e += 1440; } // 結束比開始早（或同為 00:00）= 跨夜／24 小時
  if (s === 0 && e === 1439) e = 1440; // 00:00-23:59 就是整天
  if (e === 23 * 60 + 59) e = 1440; // 23:59 打烊就當作到午夜
  if (e - s > 1440 || s >= 2 * 1440) return null;
  return { len: m[0].length, s, e };
}

// ---- 4. 把整段文字切成「記號」：時間範圍、星期、休息字眼、24 小時、第幾個週幾…；看不懂的字會被略過 ----
function bizTokAt(r, prev) {
  let m;
  if ((m = /^(?:全年無休|營業無休|無公休|沒有公休|不公休|不休息|天天營業|無休)/.exec(r))) return { t: 'norest', len: m[0].length };
  if ((m = /^(?:不定休|不定期|不固定|隨機公休|臨時公休|依公告|依官方公告|另行公告|請洽|請電洽|詳見官網|依官網|以官網為準|隔週[一二三四五六日天]?|隔周[一二三四五六日天]?)/.exec(r))) return { t: 'irreg', len: m[0].length };
  if ((m = /^(?:國定假日|國定|連假|過年|春節|農曆|除夕|元旦|端午|中秋|清明|特殊節日)/.exec(r))) return { t: 'holiday', len: m[0].length };
  m = new RegExp('^第 ?([1-5一二三四五](?: ?(?:,|和|及|與|&) ?第? ?[1-5一二三四五])*) ?(?:個|个)? ?' + BIZ_PFX + ' ?(' + BIZ_W + ')').exec(r);
  if (m) return { t: 'nth', len: m[0].length, ns: (m[1].match(/[1-5一二三四五]/g) || []).map(bizNumOf), last: false, wd: bizWdOf(m[2]) };
  m = new RegExp('^最後 ?(?:一 ?)?(?:個|个)? ?' + BIZ_PFX + ' ?(' + BIZ_W + ')').exec(r);
  if (m) return { t: 'nth', len: m[0].length, ns: [], last: true, wd: bizWdOf(m[1]) };
  if (!(prev && /\d/.test(prev)) && (m = /^(?:24 ?(?:小時|小时)|24 ?(?:hours?|hrs?|h)(?![a-z])|24\/7|全天候|全天營業|全日營業|整天營業|不打烊|通宵營業|通宵)/.exec(r))) return { t: 'h24', len: m[0].length };
  if ((m = /^(?:午休時間|午休|中休|中場休息|午間休息|休息時間|休憩時間|休憩|break)/.exec(r))) return { t: 'break', len: m[0].length, word: m[0] };
  if (!(prev && /[a-z]/.test(prev)) && (m = /^(?:休息日|休息中|休息|公休日|公休|店休日|店休|定休日|定休|休館日|休館|休業|休假日|休假|歇業|暫停營業|不營業|closed|day off|休)/.exec(r))) return { t: 'rest', len: m[0].length, word: m[0] };
  if (!(prev && /\d/.test(prev))) {
    const rg = bizMatchRange(r);
    if (rg) return { t: 'range', len: rg.len, s: rg.s, e: rg.e };
  }
  const d = bizMatchDays(r, prev);
  if (d) return { t: 'days', len: d.len, set: d.set };
  return null;
}
function bizTokenize(s) {
  const toks = [];
  let i = 0, pre = '';
  while (i < s.length) {
    const t = bizTokAt(s.slice(i), i > 0 ? s.charAt(i - 1) : '');
    if (t && t.len > 0) { t.pre = pre; toks.push(t); i += t.len; pre = ''; }
    else { pre += s.charAt(i); i++; }
  }
  return { toks, tail: pre };
}
function bizTight(pre) { // 兩個記號之間只隔著標點、空白、「每」「的」之類，就算「緊連著」
  return /^[\s:,;()\[\]\/&]*$/.test(String(pre || '').replace(/\b(?:on|every|each)\b/g, '').replace(/每個|每|的|是|為/g, ''));
}

// ---- 5. 休息日：每週固定（週一）、每月第幾個週幾（第1、3個週二／最後一個週三）、不定休、國定假日 ----
function bizNewRest() { return { weekly: [false, false, false, false, false, false, false], nth: [], none: false, irregular: false, holiday: false }; }
function bizAddRestDays(rest, set) { set.forEach(d => { rest.weekly[d] = true; }); }
function bizParseRestField(str, rest) {
  const s = bizNorm(str);
  if (!s) return rest;
  bizTokenize(s).toks.forEach(tk => {
    if (tk.t === 'days') bizAddRestDays(rest, tk.set);
    else if (tk.t === 'nth') rest.nth.push({ wd: tk.wd, ns: tk.ns, last: tk.last });
    else if (tk.t === 'holiday') rest.holiday = true;
    else if (tk.t === 'irreg') rest.irregular = true;
    else if (tk.t === 'norest') rest.none = true;
  });
  return rest;
}
function bizIsRest(rest, wd, dom, dim) {
  if (rest.weekly[wd]) return true;
  const nth = Math.ceil(dom / 7), isLast = dom + 7 > dim;
  return rest.nth.some(r => r.wd === wd && ((r.ns.indexOf(nth) >= 0) || (r.last && isLast)));
}

// ---- 6. 解讀營業時間文字 → { def: 每天都一樣的時段, byDay: 指定星期的時段, breaks: 午休, rest: 休息日, ok: 有沒有看懂 } ----
function bizParseSchedule(timesStr, restStr) {
  const p = { def: [], byDay: {}, breaks: [], rest: bizNewRest(), closedAll: false, ok: false, text: '' };
  const s = bizNorm(timesStr);
  p.text = s;
  if (s) {
    const tk = bizTokenize(s), toks = tk.toks, n = toks.length;
    const isRef = k => k >= 0 && k < n && (toks[k].t === 'days' || toks[k].t === 'nth' || toks[k].t === 'holiday');
    const isRng = k => k >= 0 && k < n && toks[k].t === 'range';
    // (a) 休息字眼綁到旁邊的星期：「週一公休」「公休：週一、週二」「除週一外」
    for (let k = 0; k < n; k++) {
      const x = toks[k];
      if ((x.t === 'days' || x.t === 'nth') && /除$/.test(String(x.pre).trim())) x.rest = true;
      if (x.t !== 'rest') continue;
      let any = false, j = k - 1, link = x;
      while (isRef(j) && bizTight(link.pre)) { toks[j].rest = true; any = true; link = toks[j]; j--; }
      if (!any) { j = k + 1; while (isRef(j) && bizTight(toks[j].pre)) { toks[j].rest = true; any = true; j++; } }
      x.bound = any;
    }
    // (b) 午休：「14:00-17:00 午休」「休息 14:00-17:00」→ 這一段不算營業時間
    for (let k = 0; k < n; k++) {
      const x = toks[k];
      const isBreakWord = x.t === 'break' || (x.t === 'rest' && !x.bound && /^(?:休息|休憩)/.test(x.word));
      if (!isBreakWord) continue;
      const pr = isRng(k - 1) && bizTight(x.pre) ? toks[k - 1] : null;
      const nx = isRng(k + 1) && bizTight(toks[k + 1].pre) ? toks[k + 1] : null;
      const inside = (a, b) => a.s <= b.s && b.e <= a.e;
      if (pr && nx) { if (inside(pr, nx)) nx.isBreak = true; else if (inside(nx, pr)) pr.isBreak = true; } // 兩邊都有時間：被包在裡面的那段才是午休，否則只是分隔字
      else if (pr) pr.isBreak = true;
      else if (nx) nx.isBreak = true;
      if (pr || nx) x.used = true;
    }
    // (c) 依序整理：星期 → 之後的時間算那幾天的；沒寫星期的時間 = 每天
    let ctx = null, lastDays = -2, standalone = false;
    toks.forEach((x, k) => {
      if (x.t === 'days') {
        if (x.rest) { bizAddRestDays(p.rest, x.set); }
        else { ctx = (lastDays === k - 1 && bizTight(x.pre) && ctx) ? bizUnion(ctx, x.set.map(d => [d, d])) : x.set.slice(); lastDays = k; }
      } else if (x.t === 'nth') { if (x.rest) p.rest.nth.push({ wd: x.wd, ns: x.ns, last: x.last }); }
      else if (x.t === 'holiday') { if (x.rest) p.rest.holiday = true; }
      else if (x.t === 'irreg') p.rest.irregular = true;
      else if (x.t === 'norest') p.rest.none = true;
      else if (x.t === 'rest') { if (!x.bound && !x.used && /^(?:公休|休息|休息中|休業|歇業|暫停營業|不營業|店休|休館|closed)$/.test(x.word)) standalone = true; }
      else if (x.t === 'range' || x.t === 'h24') {
        const iv = x.t === 'h24' ? [0, 1440] : [x.s, x.e];
        if (x.isBreak) p.breaks.push({ ctx: ctx ? ctx.slice() : null, s: iv[0], e: iv[1] });
        else if (ctx) ctx.forEach(d => { (p.byDay[d] = p.byDay[d] || []).push(iv); });
        else p.def.push(iv);
      }
    });
    p.ok = p.def.length > 0 || Object.keys(p.byDay).some(d => p.byDay[d].length > 0);
    // 整段只有「公休」「暫停營業」這類字（沒有任何時間）→ 一律休息
    if (!p.ok && standalone && s.replace(/[\s:,;()\[\]\/&]/g, '').length <= 8) p.closedAll = true;
  }
  bizParseRestField(restStr, p.rest);
  return p;
}
const BIZ_CACHE = {};
let bizCacheN = 0;
function bizParseCached(timesStr, restStr) {
  const key = String(timesStr == null ? '' : timesStr) + '\n' + String(restStr == null ? '' : restStr);
  if (!Object.prototype.hasOwnProperty.call(BIZ_CACHE, key)) {
    if (bizCacheN > 400) { Object.keys(BIZ_CACHE).forEach(k => { delete BIZ_CACHE[k]; }); bizCacheN = 0; }
    BIZ_CACHE[key] = bizParseSchedule(timesStr, restStr);
    bizCacheN++;
  }
  return BIZ_CACHE[key];
}

// ---- 7. 某個星期幾的營業時段（扣掉午休、合併重疊的）----
function bizMerge(list) {
  const a = list.map(x => [x[0], x[1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  a.forEach(iv => {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) { if (iv[1] > last[1]) last[1] = iv[1]; } // 接在一起（含剛好銜接）就合併，24 小時營業不會在午夜被誤判成打烊
    else out.push(iv);
  });
  return out;
}
function bizIntervalsFor(p, wd) {
  const base = (p.byDay[wd] && p.byDay[wd].length) ? p.byDay[wd] : p.def;
  let ivs = bizMerge(base);
  p.breaks.forEach(b => {
    if (b.ctx && b.ctx.indexOf(wd) < 0) return;
    let bs = b.s, be = b.e;
    if (be <= bs) be += 1440;
    const cuts = [[bs, be], [bs + 1440, be + 1440]];
    cuts.forEach(c => {
      const next = [];
      ivs.forEach(iv => {
        if (c[1] <= iv[0] || c[0] >= iv[1]) { next.push(iv); return; }
        if (iv[0] < c[0]) next.push([iv[0], c[0]]);
        if (c[1] < iv[1]) next.push([c[1], iv[1]]);
      });
      ivs = next;
    });
  });
  return ivs;
}

// ---- 8. 現在是什麼時間：用店家所在地的時區（沒指定就用裝置的時間）----
function bizParts(date, tz) {
  try {
    if (tz) {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
      const o = {};
      f.formatToParts(date).forEach(x => { o[x.type] = x.value; });
      let h = parseInt(o.hour, 10);
      if (h === 24) h = 0;
      const y = parseInt(o.year, 10), mo = parseInt(o.month, 10), d = parseInt(o.day, 10), mi = parseInt(o.minute, 10);
      if (y > 0 && mo > 0 && d > 0 && h >= 0 && mi >= 0) return { y, m: mo, d, min: h * 60 + mi, tz };
    }
  } catch (e) { /* 這個瀏覽器不支援該時區 → 改用裝置時間 */ }
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(), min: date.getHours() * 60 + date.getMinutes(), tz: '' };
}
const BIZ_TZ_COUNTRY = {
  '台灣': 'Asia/Taipei', '臺灣': 'Asia/Taipei', '中華民國': 'Asia/Taipei', 'taiwan': 'Asia/Taipei',
  '日本': 'Asia/Tokyo', 'japan': 'Asia/Tokyo', '韓國': 'Asia/Seoul', '南韓': 'Asia/Seoul', '大韓民國': 'Asia/Seoul', 'korea': 'Asia/Seoul', 'south korea': 'Asia/Seoul',
  '中國': 'Asia/Shanghai', '中國大陸': 'Asia/Shanghai', '大陸': 'Asia/Shanghai', 'china': 'Asia/Shanghai',
  '香港': 'Asia/Hong_Kong', 'hong kong': 'Asia/Hong_Kong', '澳門': 'Asia/Macau', 'macau': 'Asia/Macau', 'macao': 'Asia/Macau',
  '新加坡': 'Asia/Singapore', 'singapore': 'Asia/Singapore', '泰國': 'Asia/Bangkok', 'thailand': 'Asia/Bangkok', '越南': 'Asia/Ho_Chi_Minh', 'vietnam': 'Asia/Ho_Chi_Minh',
  '馬來西亞': 'Asia/Kuala_Lumpur', 'malaysia': 'Asia/Kuala_Lumpur', '菲律賓': 'Asia/Manila', 'philippines': 'Asia/Manila',
  '柬埔寨': 'Asia/Phnom_Penh', '寮國': 'Asia/Vientiane', '緬甸': 'Asia/Yangon', '印度': 'Asia/Kolkata', '尼泊爾': 'Asia/Kathmandu', '斯里蘭卡': 'Asia/Colombo',
  '阿聯': 'Asia/Dubai', '阿聯酋': 'Asia/Dubai', '杜拜': 'Asia/Dubai', '土耳其': 'Europe/Istanbul',
  '英國': 'Europe/London', 'uk': 'Europe/London', 'united kingdom': 'Europe/London', '法國': 'Europe/Paris', 'france': 'Europe/Paris', '德國': 'Europe/Berlin', 'germany': 'Europe/Berlin',
  '義大利': 'Europe/Rome', 'italy': 'Europe/Rome', '西班牙': 'Europe/Madrid', 'spain': 'Europe/Madrid', '荷蘭': 'Europe/Amsterdam', '瑞士': 'Europe/Zurich', '奧地利': 'Europe/Vienna',
  '捷克': 'Europe/Prague', '希臘': 'Europe/Athens', '冰島': 'Atlantic/Reykjavik', '比利時': 'Europe/Brussels', '葡萄牙': 'Europe/Lisbon', '丹麥': 'Europe/Copenhagen',
  '瑞典': 'Europe/Stockholm', '挪威': 'Europe/Oslo', '芬蘭': 'Europe/Helsinki', '波蘭': 'Europe/Warsaw', '匈牙利': 'Europe/Budapest', '紐西蘭': 'Pacific/Auckland', '埃及': 'Africa/Cairo'
};
const BIZ_TZ_CITY = { // 跨好幾個時區的國家：只認幾個大家常去的城市，其他一律用裝置時間
  '紐約': 'America/New_York', '華盛頓': 'America/New_York', '波士頓': 'America/New_York', '芝加哥': 'America/Chicago', '洛杉磯': 'America/Los_Angeles', '舊金山': 'America/Los_Angeles',
  '西雅圖': 'America/Los_Angeles', '拉斯維加斯': 'America/Los_Angeles', '夏威夷': 'Pacific/Honolulu', '檀香山': 'Pacific/Honolulu',
  '雪梨': 'Australia/Sydney', '墨爾本': 'Australia/Melbourne', '坎培拉': 'Australia/Sydney', '布里斯本': 'Australia/Brisbane', '伯斯': 'Australia/Perth',
  '溫哥華': 'America/Vancouver', '多倫多': 'America/Toronto', '蒙特婁': 'America/Toronto'
};
function bizTzFor(country, city) {
  const c = String(country == null ? '' : country).trim().toLowerCase().replace(/\s+/g, ' ');
  const y = String(city == null ? '' : city).trim();
  if (c && Object.prototype.hasOwnProperty.call(BIZ_TZ_COUNTRY, c)) return BIZ_TZ_COUNTRY[c];
  if (y && Object.prototype.hasOwnProperty.call(BIZ_TZ_CITY, y)) return BIZ_TZ_CITY[y];
  return '';
}

// ---- 9. 判斷：把「昨天～之後一週」每個營業日的時段攤開成一條時間軸，看現在落在哪 ----
function bizEvaluate(p, parts) {
  const base = Date.UTC(parts.y, parts.m - 1, parts.d);
  const all = [];
  let restToday = false;
  for (let k = -1; k <= 8; k++) { // -1：昨天營業到今天凌晨的跨夜時段也要算；+8：找下一次營業
    const dt = new Date(base + k * 86400000);
    const dom = dt.getUTCDate();
    const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    const rest = bizIsRest(p.rest, dt.getUTCDay(), dom, dim);
    if (k === 0) restToday = rest;
    if (rest || p.closedAll) continue; // 休息日整天沒有營業（前一晚跨夜到凌晨的時段屬於前一個營業日，不受影響）
    bizIntervalsFor(p, dt.getUTCDay()).forEach(iv => { all.push([k * 1440 + iv[0], k * 1440 + iv[1]]); });
  }
  const line = bizMerge(all);
  const now = parts.min;
  let cur = null, next = null;
  for (let i = 0; i < line.length; i++) {
    if (line[i][0] <= now && now < line[i][1]) { cur = line[i]; break; }
    if (line[i][0] > now) { next = line[i]; break; }
  }
  return { cur, next, restToday, wd0: new Date(base).getUTCDay() };
}
function bizHM(abs) { const m = ((abs % 1440) + 1440) % 1440; return (m < 600 ? '0' : '') + Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60); }
function bizDur(min) {
  if (min < 60) return min + ' 分鐘';
  const h = Math.floor(min / 60), m = min % 60;
  return h + ' 小時' + (m ? ' ' + m + ' 分鐘' : '');
}
function bizDayLabel(abs, wd0) { const k = Math.floor(abs / 1440); return k <= 0 ? '今天' : k === 1 ? '明天' : '週' + BIZ_WD_CHARS.charAt((wd0 + k) % 7); }

// ---- 10. 對外的主函式：checkBusinessStatus(營業時間文字, { rest: 休息日文字, now: Date, tz: 時區, soonMin: 緩衝分鐘數 }) ----
function checkBusinessStatus(scheduleStr, opts) {
  opts = opts || {};
  const soon = typeof opts.soonMin === 'number' ? opts.soonMin : BIZ_SOON_MIN;
  const mk = (key, detail, extra) => Object.assign({ key, text: BIZ_STATES[key].text, emoji: BIZ_STATES[key].emoji, color: BIZ_STATES[key].color, detail: detail || '', parsed: false, tz: '', until: null, nextAt: null }, extra || {});
  try {
    const p = bizParseCached(scheduleStr, opts.rest);
    const parts = bizParts(opts.now && typeof opts.now.getTime === 'function' && !isNaN(opts.now.getTime()) ? opts.now : new Date(), opts.tz); // 不用 instanceof Date：不同視窗（iframe）的 Date 也認得
    const ev = bizEvaluate(p, parts);
    const x = { parsed: p.ok || p.closedAll, tz: parts.tz, p };
    if (!p.ok && !p.closedAll) {
      if (ev.restToday) return mk('closed', '今日公休', x);
      return mk('unknown', String(scheduleStr == null ? '' : scheduleStr).trim() ? '營業時間的寫法看不懂（可以寫成 11:00-14:00, 17:00-21:00）' : '還沒有填營業時間', x);
    }
    if (p.closedAll) return mk('closed', '標示為休息／暫停營業', x);
    if (ev.cur) {
      const left = ev.cur[1] - parts.min;
      const tomorrow = ev.cur[1] >= 1440 ? '（隔天）' : '';
      x.until = ev.cur[1];
      if (left <= soon) return mk('closing', bizHM(ev.cur[1]) + tomorrow + ' 打烊，剩 ' + bizDur(left), x);
      if (left > 2 * 1440) return mk('open', '24 小時營業中', x); // 連續營業好幾天（24 小時營業）就不倒數
      return mk('open', '營業到 ' + bizHM(ev.cur[1]) + tomorrow + '，還有 ' + bizDur(left), x);
    }
    if (ev.next) {
      const wait = ev.next[0] - parts.min;
      x.nextAt = ev.next[0];
      const when = bizDayLabel(ev.next[0], ev.wd0) + ' ' + bizHM(ev.next[0]);
      if (wait <= soon) return mk('opening', when + ' 開始營業，還有 ' + bizDur(wait), x);
      return mk('closed', (ev.restToday ? '今日公休，' : '') + when + ' 開始營業', x);
    }
    return mk('closed', ev.restToday ? '今日公休' : '近期沒有營業時段', x);
  } catch (e) {
    return mk('unknown', '營業時間讀取失敗');
  }
}

// ---- 11. 把「系統怎麼讀你寫的營業時間」用白話寫出來（表單與詳情視窗會顯示，讓你確認有沒有讀錯）----
function bizDescribe(p) {
  if (!p) return '';
  if (p.closedAll) return '標示為休息／暫停營業';
  const parts = [];
  if (p.ok) {
    const order = [1, 2, 3, 4, 5, 6, 0];
    const fmt = ivs => ivs.map(iv => (iv[0] === 0 && iv[1] === 1440) ? '24 小時' : bizHM(iv[0]) + '–' + (iv[1] > 1440 ? '隔天' : '') + bizHM(iv[1])).join('、');
    const labels = order.map(wd => p.rest.weekly[wd] ? '休' : (fmt(bizIntervalsFor(p, wd)) || '休'));
    const groups = [];
    order.forEach((wd, i) => {
      const g = groups[groups.length - 1];
      if (g && g.label === labels[i]) g.days.push(wd); else groups.push({ label: labels[i], days: [wd] });
    });
    if (groups.length === 1 && groups[0].label !== '休') parts.push('每天 ' + groups[0].label);
    else groups.forEach(g => {
      const n = g.days.map(d => '週' + BIZ_WD_CHARS.charAt(d));
      const name = n.length === 1 ? n[0] : n.length === 2 ? n.join('、') : n[0] + '～' + n[n.length - 1];
      parts.push(g.label === '休' ? name + '休' : name + ' ' + g.label);
    });
  } else if (p.rest.weekly.some(Boolean)) {
    parts.push('還沒有營業時段');
  }
  p.rest.nth.forEach(r => { parts.push('每月' + (r.last ? '最後一個' : '第' + r.ns.join('、') + '個') + '週' + BIZ_WD_CHARS.charAt(r.wd) + '休'); });
  if (p.rest.irregular) parts.push('營業日或時間不固定（出發前請先確認）');
  if (p.rest.holiday) parts.push('另有國定假日／過年等特殊休息日（出發前請先確認）');
  return parts.join('；');
}
/* ===== BIZ-ENGINE-END ===== */
// ---- 顯示用的文字整理（原樣複製自 wishlist.html 的 BIZ-UI 區段）----
function bizLegacyText(openHours) {
  return String(openHours == null ? '' : openHours).replace(/^\s*(?:🟢|⚪|⚫|🔴|🟡|🟠)\s*(?:營業中|休息中|今日公休|即將打烊|即將營業)?\s*\|?\s*/, '').trim();
}
function bizSource(item) {
  const d = (item && item.hoursDetail) || {};
  const times = String(d.times == null ? '' : d.times).trim();
  const rest = String(d.restDays == null ? '' : d.restDays).trim();
  if (times || rest) return { times, rest, legacy: false };
  return { times: bizLegacyText(item && item.openHours), rest: '', legacy: true };
}
// LINE 版的「這個項目現在營業嗎」：和網頁的 bizItemStatus 一樣，只差一點——
//   網頁在沒寫國家／城市時，用「這台裝置的時間」；LINE 的伺服器沒有裝置、時區固定是 UTC，不能拿來用，所以沒寫國家的項目改用台北時間。
const BIZ_DEFAULT_TZ = 'Asia/Taipei';
function lineBizStatus(item, date) {
  const s = bizSource(item);
  return checkBusinessStatus(s.times, { rest: s.rest, now: date || new Date(), tz: bizTzFor(item && item.country, item && item.city) || BIZ_DEFAULT_TZ });
}

// ============================================================
// 🧰 LINE 工具（V10.4）：奇遇羅盤（選地點）、驚喜製造所（選店家）、轉盤、拋硬幣、轉瓶子、隨機盒子、骰子、剪刀石頭布（手動出拳＝互動對決）；V10.6.0 多一個「自動剪刀石頭布」（一鍵自動對決）；
//   V10.9.0：「工具」選單的剪刀石頭布從「剪刀石頭布（手動）」＋「自動剪刀石頭布」2 格，拆成剪刀／石頭／布／自動 4 格，每格一點就直接出結果（functionId 還是只有 tool_rps／tool_rps_auto 兩個，剪刀／石頭／布 3 格共用 tool_rps，差別只在送出的隱藏指令帶了要出哪一拳）
//   ・都是「公平亂數」（crypto.getRandomValues），每個選項機率相同；網頁版的「避免連續重複」加權在 LINE 不做（LINE 沒有螢幕上的歷史可看）。
//   ・結果直接回在同一個聊天室（群組裡大家都看得到）；唯一例外：「我的紀錄」當選項來源只在 1 對 1 聊天室（不在群組公開你的紀錄）。
//   ・需要選項的（轉盤、轉瓶子、羅盤、製造所）：可以一行打完（轉盤 牛肉麵 拉麵 火鍋），也可以先打名稱、再回選項。
// ============================================================
const TOOL_FNS = ['tool_compass', 'tool_surprise', 'tool_wheel', 'tool_coin', 'tool_bottle', 'tool_box', 'tool_dice', 'tool_rps', 'tool_rps_auto'];
const TOOL_NAME_FN = { 奇遇羅盤: 'tool_compass', 選地點: 'tool_compass', 驚喜製造所: 'tool_surprise', 選店家: 'tool_surprise', 轉盤: 'tool_wheel', 拋硬幣: 'tool_coin', 擲硬幣: 'tool_coin', 丟硬幣: 'tool_coin', 轉瓶子: 'tool_bottle', 隨機盒子: 'tool_box', 骰子: 'tool_dice', 擲骰子: 'tool_dice', 骰骰子: 'tool_dice', 剪刀石頭布: 'tool_rps', 猜拳: 'tool_rps', 自動剪刀石頭布: 'tool_rps_auto', 自動猜拳: 'tool_rps_auto' };
const TOOL_BOX_PRIZES = ['今天你請！🎉', '下次再說～😅', '免費一杯 🧋', '加倍奉還 💸', '隨機飲品！🎲', '神秘加料 ✨', '喝最貴那杯 💀', '大家一起請 🤝']; // 跟網頁「隨機盒子」預設的獎品一樣
const TOOL_MAX_OPTS = 30;
const TOOL_MAX_LEN = 30;
const TOOL_BACK_Q = []; // 畫面顯示規則：只顯示該工具自己的內容，不加「回工具／回功能選單」之類別的按鈕（要回去直接輸入「工具」或「功能選單」）
const TOOL_CANCEL_Q = hq('❌ 取消', '取消'); // V10.5：工具上的按鈕都是隱藏指令（按下去聊天室不會多一句使用者說的話）
const RPS_HANDS_LINE = [{ e: String.fromCharCode(0x270C, 0xFE0F), n: '剪刀' }, { e: String.fromCharCode(0x270A), n: '石頭' }, { e: String.fromCharCode(0x270B), n: '布' }]; // 0 剪刀、1 石頭、2 布
const RPS_QUICK = [1, 0, 2].map((i) => hq(RPS_HANDS_LINE[i].e + ' ' + RPS_HANDS_LINE[i].n, '出拳 ' + RPS_HANDS_LINE[i].n)); // V10.6.0：按鈕順序 ✊ 石頭、✌️ 剪刀、✋ 布（判斷勝負用的編號不變：0 剪刀、1 石頭、2 布）
const RPS_AUTO_AGAIN = hq('🤖 再來一局', '自動剪刀石頭布'); // 自動對決結果下面的按鈕（隱藏指令：按下去聊天室不多一句話）
// V10.5：轉盤、轉瓶子「點一下就出結果」用的預設選項（想用自己的，按「✍️ 自己輸入選項」）；每個選項機率相同
const TOOL_WHEEL_PRESET = ['誰買單 💳', '今晚吃大餐 🍖', '來杯手搖 🧋', '叫外送 🛵', '吃泡麵 🍜', '出去走走 🚶', '回家洗洗睡 😴', '看場電影 🎬', '今天我請客 💸', '早點下班 🏃'];
const TOOL_BOTTLE_PRESET = ['左手邊的人', '右手邊的人', '對面的人', '最晚到的人', '年紀最大的人', '年紀最小的人', '穿得最亮眼的人', '離你最近的人'];
const TOOL_COMPASS_PRESET = ['東區', '信義區', '天母', '大安區', '中山區']; // v26.11.x：奇遇羅盤新增「固定清單抽」，沿用網頁原「喝哪裡」的預設地點
const TOOL_SURPRISE_PRESET = ['珍珠奶茶', '翡翠檸檬', '波霸鮮奶茶', '四季春', '烏龍茶']; // 驚喜製造所新增「固定清單抽」，沿用網頁原「喝什麼」的預設飲品

// 公平亂數：0 ～ n-1 機率都一樣（拒絕取樣，沒有「取餘數」造成的偏差）；env.TOOL_RANDOM 只給自動測試用（正式環境的環境變數只會是文字）
function toolRnd(n, env) {
  n = Math.max(1, Math.floor(n) || 1);
  if (env && typeof env.TOOL_RANDOM === 'function') { const v = Math.floor(Number(env.TOOL_RANDOM(n))); if (v >= 0 && v < n) return v; }
  try {
    const a = new Uint32Array(1), lim = Math.floor(4294967296 / n) * n;
    let x;
    do { crypto.getRandomValues(a); x = a[0]; } while (x >= lim);
    return x % n;
  } catch (e) { return Math.floor(Math.random() * n); }
}
function toolPick(list, env) { return list[toolRnd(list.length, env)]; }
// 選項清單：用空白、逗號、頓號、分號、斜線、直線或換行分開
function parseToolOptions(text) {
  return String(text || '').split(/[\s,，、;；/／|｜]+/).map((s) => s.trim()).filter(Boolean);
}
function checkToolOptions(opts, min, what) {
  if (opts.length < min) return '至少要 ' + min + ' 個' + what + '（用空白、頓號或換行分開）。';
  if (opts.length > TOOL_MAX_OPTS) return what + '最多 ' + TOOL_MAX_OPTS + ' 個，你輸入了 ' + opts.length + ' 個。';
  const long = opts.find((o) => Array.from(o).length > TOOL_MAX_LEN);
  if (long) return '每個' + what + '最多 ' + TOOL_MAX_LEN + ' 個字：「' + long.slice(0, 12) + '…」太長了。';
  if (min >= 2 && new Set(opts).size < 2) return '至少要 2 個「不一樣」的' + what + '。';
  return '';
}
const TOOL_SPEC = {
  tool_compass: { icon: '🧭', name: '奇遇羅盤', title: '奇遇羅盤（選地點）', what: '地點', ex: '信義區 大安區 天母' },
  tool_surprise: { icon: '🎁', name: '驚喜製造所', title: '驚喜製造所（選店家）', what: '店家', ex: '50嵐 清心 鼎泰豐' },
  tool_wheel: { icon: '🎡', name: '轉盤', title: '轉盤', what: '選項', ex: '牛肉麵 拉麵 火鍋' },
  tool_bottle: { icon: '🍾', name: '轉瓶子', title: '轉瓶子', what: '人名', ex: '小明 小華 小美' },
};
function toolOwns(session, ctx) {
  return !!(session && session.flow === 'tool' && (session.chat || 'direct') === ctx.chat && (session.groupId || '') === (ctx.groupId || ''));
}
async function toolReply(token, ev, text, quick) { await rec4Reply(token, ev.replyToken, [rec4TextMsg(text, quick || TOOL_BACK_Q)]); return true; }
async function toolStartSession(ctx, env, patch) {
  await setFlagshipSession(ctx.userId, Object.assign({ flow: 'tool', chat: ctx.chat, groupId: ctx.groupId || '', ts: Date.now() }, patch), env);
}
// 勝負：0 剪刀、1 石頭、2 布；(me - cpu + 3) % 3 === 1 ＝ 你贏（剪刀贏布、石頭贏剪刀、布贏石頭）
function rpsOutcome(me, cpu) { return me === cpu ? 'tie' : (((me - cpu + 3) % 3 === 1) ? 'win' : 'lose'); }
// V10.6.0：兩種模式用同一種回覆格式（標題寫明是哪一種對決）：
//   ✌️ 剪刀石頭布（自動對決）　或　（互動對決）
//   你出了：✊ 石頭
//   小秘書出：✌️ 剪刀
//   結果：你獲勝！　或　小秘書獲勝！　或　平手！
function rpsResultText(modeName, me, cpu) {
  const hand = (i) => RPS_HANDS_LINE[i].e + ' ' + RPS_HANDS_LINE[i].n;
  const o = rpsOutcome(me, cpu);
  return RPS_HANDS_LINE[0].e + ' 剪刀石頭布（' + modeName + '）\n你出了：' + hand(me) + '\n小秘書出：' + hand(cpu) + '\n結果：' + (o === 'win' ? '你獲勝！' : o === 'lose' ? '小秘書獲勝！' : '平手！');
}
function rpsParseMove(s) {
  const t = String(s || '').replace(/[\s️]/g, '').replace(/^出拳/, '');
  const i = ['剪刀', '石頭', '布'].indexOf(t.replace(/^[✌✊✋]/, ''));
  return i;
}
function diceQuick(n) { return [hq('🎲 再擲一次', n > 1 ? '骰子 ' + n : '骰子'), hq('兩顆', '骰子 2'), hq('三顆', '骰子 3')].concat(TOOL_BACK_Q); }

// 我的紀錄當選項來源（只在 1 對 1 聊天室；只看自己的紀錄）：回傳不重複的值
async function toolRecordValues(fn, src, ctx, token, env) {
  let userName = '';
  try { userName = (await lineProfile(token, ctx.userId)) || ''; } catch (e) {}
  const appName = toAppUserName(userName);
  const take = async (mod, key) => {
    const data = await loadQueryRecords(mod, ctx, appName, env);
    const vals = [];
    data.records.forEach((r) => { const v = String((r && r[key]) || '').trim(); if (v && vals.indexOf(v) < 0) vals.push(v); });
    return { vals, bound: data.bound };
  };
  if (fn === 'tool_compass') { const r = await take(MODULES.drink, 'area'); return { vals: r.vals, bound: r.bound, from: '你的飲料紀錄裡的地點' }; }
  if (src === 'food') { const r = await take(MODULES.food, 'brand'); return { vals: r.vals, bound: r.bound, from: '你的美食紀錄裡的店家' }; }
  if (src === 'drink') { const r = await take(MODULES.drink, 'brand'); return { vals: r.vals, bound: r.bound, from: '你的飲料紀錄裡的店家' }; }
  const a = await take(MODULES.drink, 'brand'), b = await take(MODULES.food, 'brand');
  const vals = a.vals.slice();
  b.vals.forEach((v) => { if (vals.indexOf(v) < 0) vals.push(v); });
  return { vals, bound: a.bound, from: '你的飲料與美食紀錄裡的店家' };
}

async function toolDrawFromList(fn, opts, ctx, ev, token, env, from, rerun, preset) {
  const sp = TOOL_SPEC[fn];
  const pick = toolPick(opts, env);
  let text;
  if (fn === 'tool_wheel') text = '轉盤轉動中... 🎡\n停！最後指針落在：\n🎯 ' + pick;
  else if (fn === 'tool_bottle') text = '瓶子轉動中... 🍾\n停！瓶口指向：\n👉 ' + pick + '\n請客囉！';
  else if (fn === 'tool_compass') text = '🧭 奇遇羅盤・命運為你安排了……\n📍 ' + pick;
  else text = '🎁 驚喜製造所・命運為你準備的驚喜是……\n🏪 ' + pick;
  text += preset ? '\n（預設選項；想用自己的選項，點下面「✍️ 自己輸入選項」）' : '\n（從 ' + opts.length + ' 個' + sp.what + (from ? '：' + from : '') + '抽出）';
  const quick = [];
  const verb = fn === 'tool_compass' ? '再遇一次驚喜' : fn === 'tool_surprise' ? '再製造一次驚喜' : (fn === 'tool_wheel' || fn === 'tool_bottle') ? '再轉一次' : '再抽一次';
  if (preset) {
    quick.push(hq(sp.icon + ' ' + verb, rerun || sp.name), hq('✍️ 自己輸入選項', sp.name + ' 自訂'));
  } else {
    const again = rerun || (sp.name + ' ' + opts.join(' '));
    if (again.length <= 280) quick.push(hq(sp.icon + ' ' + verb, again));
  }
  return toolReply(token, ev, text, quick.concat(TOOL_BACK_Q));
}

// ---------- V10.5：從「待去清單」抽（奇遇羅盤、驚喜製造所）→ 店家圖卡 ----------
//   一鍵：1 對 1、已綁定同步碼、清單裡有「待去／已安排」的項目 → 隨機抽一筆，回一張圖卡（店名、營業狀態、地址、營業時間、Google 地圖按鈕）。
//   任何一項不成立（群組、沒綁定、沒有權限、沒有項目）→ 白話說明原因，改成「自己輸入清單」，不會讓使用者看到一個空的結果。
//   營業狀態用 lineBizStatus（和網頁同一套引擎，現在幾點就算幾點）；資料沒寫的欄位一律顯示「資訊未提供」，不亂猜。
const BIZ_COLORS = { open: '#16a34a', closing: '#d97706', opening: '#ea580c', closed: '#dc2626', unknown: '#8b8b8b' };
function toolNow(env) { try { if (env && typeof env.TOOL_NOW === 'function') { const d = new Date(env.TOOL_NOW()); if (!isNaN(d.getTime())) return d; } } catch (e) {} return new Date(); } // env.TOOL_NOW 只給自動測試用（正式環境的環境變數只會是文字）
// 地址文字：國家（台灣不寫）＋城市＋詳細地點，已經寫在詳細地點裡的就不重複
function wishPlaceParts(it) {
  const s = (x) => String(x == null ? '' : x).trim();
  const country = s(it.country), city = s(it.city), place = s(it.detailPlace);
  const parts = [];
  if (country && !/^(台灣|臺灣)$/.test(country) && place.indexOf(country) < 0) parts.push(country);
  if (city && place.indexOf(city) < 0) parts.push(city);
  return { region: parts.join(' '), place };
}
function wishAddress(it) {
  const p = wishPlaceParts(it);
  if (p.place) return (p.region ? p.region + ' ' : '') + p.place;
  return p.region ? p.region + '（沒填詳細地址）' : ''; // 只有國家／城市就照實說，不把它當成完整地址
}
function wishMapsUrl(it) {
  const p = wishPlaceParts(it);
  const text = [String(it.name || '').trim(), p.region, p.place].filter(Boolean).join(' ');
  const lat = parseFloat(it.lat), lng = parseFloat(it.lng);
  const hasCoord = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  let q = (!p.region && !p.place && hasCoord) ? lat + ',' + lng : text; // 有地址文字：用「店名＋地址」搜尋，Google 地圖會直接顯示店家資訊；只有座標：用座標
  while (encodeURIComponent(q).length > 800) q = q.slice(0, -5); // LINE 的網址上限 1000 字
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}
function wishCardMessage(it, st, header) {
  const name = String(it.name || '（未命名）').trim();
  const addr = wishAddress(it);
  const src = bizSource(it);
  const hours = src.legacy ? src.times : (src.times + (src.rest ? (src.times ? ' ' : '') + '(' + src.rest + '休)' : '')); // 和網頁 bizSummary 一樣的寫法
  const rating = Math.max(0, Math.min(5, Math.round(Number(it.rating) || 0))); // 推薦指數最多 5 顆星（資料裡寫 9 也只算 5）
  const row = (label, value) => {
    // label 開頭的 emoji 查到圖示時，這一欄排版從 baseline 改成 horizontal＋靠上對齊（圖示＋文字橫排才好看）；
    // 查無圖示時 layout 維持原來的 baseline，跟轉換前一模一樣。
    const cell = iconRow({ type: 'text', text: label, size: 'xs', color: '#8b8b8b', flex: 2 });
    const box = { type: 'box', layout: cell.type === 'box' ? 'horizontal' : 'baseline', spacing: 'sm', contents: [cell, { type: 'text', text: value, size: 'sm', color: '#5c4b37', wrap: true, flex: 5 }] };
    if (cell.type === 'box') box.alignItems = 'flex-start';
    return box;
  };
  const rows = [row('📍 地址', addr || '資訊未提供'), row('🕒 營業', hours || '資訊未提供')];
  const cat = String(it.category || '').trim();
  if (cat) rows.push(row('🏷️ 分類', cat));
  if (rating > 0) rows.push(row('⭐ 推薦', '★'.repeat(Math.min(5, rating)) + ' ' + rating + ' 星'));
  const reason = String(it.reason || '').trim();
  if (reason) rows.push(row('💬 原因', reason.length > 60 ? reason.slice(0, 60) + '…' : reason));
  const tt = String(it.targetTime || '').trim();
  if (tt && tt !== '未定') rows.push(row('🗓️ 預計', tt));
  rows.push(row('📌 狀態', String(it.status || '待去')));
  const stLine = st.emoji + ' ' + st.text;
  const detail = st.key === 'unknown' ? '' : st.detail; // 「資訊未提供」時，引擎的說明是給網頁編輯用的（教你怎麼填），LINE 不顯示
  const url = wishMapsUrl(it);
  const bubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      iconRow({ type: 'text', text: header, size: 'xs', color: '#8b7355', weight: 'bold', wrap: true }),
      { type: 'text', text: name, size: 'xl', weight: 'bold', color: '#5c4b37', wrap: true },
      { type: 'box', layout: 'vertical', spacing: 'xs', contents: [iconRow({ type: 'text', text: stLine, size: 'sm', weight: 'bold', color: BIZ_COLORS[st.key] || '#8b8b8b' })].concat(detail ? [{ type: 'text', text: detail, size: 'xs', color: '#8b8b8b', wrap: true }] : []) },
      { type: 'separator' },
      { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
    ] },
    footer: { type: 'box', layout: 'vertical', contents: [iconButton('🗺️ 在 Google 地圖開啟', null, 'primary', { action: { type: 'uri', uri: url }, color: '#8b7355' })] },
  };
  const fallback = [header, name, stLine + (detail ? '｜' + detail : ''), '📍 ' + (addr || '資訊未提供'), '🕒 ' + (hours || '資訊未提供'), '🗺️ ' + url].join('\n');
  return { message: { type: 'flex', altText: (name + '・' + stLine).slice(0, 400), contents: bubble }, fallback };
}
// 送圖卡；LINE 拒絕時（格式問題）改傳文字版，同樣帶快速回覆按鈕，使用者一定看得到結果
async function toolReplyCard(token, ev, card, quick) {
  const msg = Object.assign({}, card.message);
  if (quick && quick.length) msg.quickReply = quickReplyItems(quick);
  let res = null;
  try { res = await lineReplyMessages(token, ev.replyToken, [msg]); } catch (e) { res = null; }
  if (!res || !res.ok) {
    try { console.log('LINE reply failed', res ? res.status : 'no response', res ? await res.text() : ''); } catch (e) {}
    try { await lineReplyMessages(token, ev.replyToken, [rec4TextMsg(card.fallback, quick)]); } catch (e) {}
  }
  return true;
}
async function toolDrawWish(fn, ctx, ev, token, env, cfg, askTyped) {
  if (ctx.isGroup) return askTyped('🔒 「待去清單」是你的個人資料，不會在群組裡公開，所以群組裡請直接輸入清單。');
  const av = checkAvailability('wishlist', ctx, cfg, { read: true });
  if (!av.ok) return askTyped('🔒 ' + av.message + '（所以不能從待去清單抽）');
  const got = await loadQueryRecords(MODULES.wishlist, ctx, '', env);
  if (!got.bound) return askTyped('你還沒綁定同步碼，LINE 看不到你的待去清單（綁定：傳「同步碼 你的同步碼」）。');
  const open = got.records.filter((x) => x && typeof x === 'object' && String(x.name || '').trim() && (!x.status || x.status === '待去' || x.status === '已安排'));
  if (!open.length) return askTyped('你的待去清單裡目前沒有「待去」或「已安排」的項目可以抽（到網頁的待去清單新增，或在 LINE 傳「新增待去地點」）。');
  const it = toolPick(open, env);
  await clearFlagshipSession(ctx.userId, env);
  const st = lineBizStatus(it, toolNow(env));
  const header = (fn === 'tool_compass' ? '🧭 奇遇羅盤・命運為你安排了……' : '🎁 驚喜製造所・命運為你準備的驚喜是……') + '（從待去清單 ' + open.length + ' 項抽出）';
  const label = TOOL_SPEC[fn].name; // 「奇遇羅盤」「驚喜製造所」：按鈕送出的指令（再抽一次＝名稱本身；紀錄／自訂／固定＝名稱＋空白＋字）
  const againLabel = fn === 'tool_compass' ? '🔄 再遇一次驚喜' : '🔄 再製造一次驚喜';
  return toolReplyCard(token, ev, wishCardMessage(it, st, header), [hq(againLabel, label), hq('📒 改從我的紀錄抽', label + ' 紀錄'), hq('✍️ 自己輸入', label + ' 自訂'), hq('🎯 固定清單抽', label + ' 固定')]);
}

// 執行一個工具；arg＝名稱後面接的字（沒有就是空字串）
async function runLineTool(fn, ctx, ev, token, env, cfg, arg) {
  arg = String(arg || '').trim();
  const sp = TOOL_SPEC[fn];
  switch (fn) {
    case 'tool_dice': {
      let n = 1;
      if (arg) {
        const m = arg.match(/^(\d{1,2})\s*(顆|個|粒)?$/);
        if (!m) return toolReply(token, ev, '🎲 骰子要幾顆？請輸入 1～6，例如：骰子 2', diceQuick(1));
        n = Number(m[1]);
        if (n < 1 || n > 6) return toolReply(token, ev, '🎲 一次最少 1 顆、最多 6 顆，例如：骰子 2', diceQuick(1));
      }
      const vals = Array.from({ length: n }, () => toolRnd(6, env) + 1);
      const sum = vals.reduce((a, b) => a + b, 0);
      const text = n === 1
        ? '喀啦喀啦... 你擲出了：\n🎲 ' + vals[0] + ' 點！'
        : '喀啦喀啦... 你擲出了 ' + n + ' 顆骰子：\n' + vals.map((v) => '🎲 ' + v).join('　') + '\n合計：' + vals.join(' + ') + ' = ' + sum + ' 點！';
      return toolReply(token, ev, text, diceQuick(n));
    }
    case 'tool_coin': {
      let sides = ['正面', '反面'];
      if (arg) {
        const o = parseToolOptions(arg);
        const bad = o.length !== 2 ? '拋硬幣要剛好兩個面，例如：拋硬幣 吃 不吃（不加的話就是正面／反面）。' : checkToolOptions(o, 2, '面');
        if (bad) return toolReply(token, ev, '🪙 ' + bad, [hq('🪙 拋正反面', '拋硬幣')].concat(TOOL_BACK_Q));
        sides = o;
      }
      const res = toolPick(sides, env);
      return toolReply(token, ev, '叮！硬幣落地了，結果是：\n🪙 ' + res + (arg ? '\n（' + sides.join(' ／ ') + '）' : ''), [hq('🪙 再拋一次', arg ? '拋硬幣 ' + sides.join(' ') : '拋硬幣')].concat(TOOL_BACK_Q));
    }
    case 'tool_box': {
      let prizes = TOOL_BOX_PRIZES;
      if (arg) {
        prizes = parseToolOptions(arg);
        const bad = checkToolOptions(prizes, 2, '獎品');
        if (bad) return toolReply(token, ev, '📦 ' + bad, [hq('📦 用預設獎品', '隨機盒子')].concat(TOOL_BACK_Q));
      }
      const res = toolPick(prizes, env);
      const again = arg ? '隨機盒子 ' + prizes.join(' ') : '隨機盒子';
      return toolReply(token, ev, '搖一搖... 📦 打開盒子！\n🎁 ' + res, [hq('🎁 再開一個', again.length <= 280 ? again : '隨機盒子')].concat(TOOL_BACK_Q));
    }
    case 'tool_rps_auto': { // V10.6.0：一鍵自動對決。「你」和「小秘書」的拳都由程式隨機出（各自獨立、機率各 1/3，所以 9 種組合機率一樣），一次回覆就判完勝負，不用再按出拳按鈕
      const me = toolRnd(3, env);
      const cpu = toolRnd(3, env);
      return toolReply(token, ev, rpsResultText('自動對決', me, cpu), [RPS_AUTO_AGAIN].concat(TOOL_BACK_Q));
    }
    case 'tool_rps': { // 手動出拳（互動對決）：先出現 ✊ 石頭、✌️ 剪刀、✋ 布 三顆按鈕，你選了才判勝負
      if (!arg) {
        await toolStartSession(ctx, env, { tool: fn, stage: 'await_move' });
        return toolReply(token, ev, RPS_HANDS_LINE.map((h) => h.e).join('') + ' 剪刀石頭布！\n請出拳～（我是隨機出的，不會偷看你出什麼）', RPS_QUICK.concat([TOOL_CANCEL_Q]));
      }
      const me = rpsParseMove(arg);
      if (me < 0) return toolReply(token, ev, '請出剪刀、石頭或布，例如：出拳 剪刀', RPS_QUICK.concat(TOOL_BACK_Q));
      const cpu = toolRnd(3, env);
      await clearFlagshipSession(ctx.userId, env);
      return toolReply(token, ev, rpsResultText('互動對決', me, cpu), RPS_QUICK.concat(TOOL_BACK_Q));
    }
    case 'tool_wheel': case 'tool_bottle': {
      if (!arg) return toolDrawFromList(fn, fn === 'tool_wheel' ? TOOL_WHEEL_PRESET : TOOL_BOTTLE_PRESET, ctx, ev, token, env, '', sp.name, true); // V10.5：點一下就出結果（預設選項）
      const askOpts = async (lead) => {
        await toolStartSession(ctx, env, { tool: fn, stage: 'await_opts' });
        return toolReply(token, ev, sp.icon + ' ' + sp.title + '\n' + (lead ? lead + '\n' : '') + '請輸入' + (fn === 'tool_bottle' ? '要玩的人（瓶口指到誰，誰就請客）' : '轉盤上的選項') + '，至少 2 個，用空白、頓號或換行分開，例如：\n' + sp.ex, [TOOL_CANCEL_Q]);
      };
      if (/^(自訂|自己輸入)$/.test(arg)) return askOpts('');
      const opts = parseToolOptions(arg);
      const bad = checkToolOptions(opts, 2, sp.what);
      if (bad) return askOpts('⚠️ ' + bad + '\n請再輸入一次。');
      await clearFlagshipSession(ctx.userId, env);
      return toolDrawFromList(fn, opts, ctx, ev, token, env, '', '', false);
    }
    case 'tool_compass': case 'tool_surprise': {
      const askTyped = async (lead) => {
        await toolStartSession(ctx, env, { tool: fn, stage: 'await_opts' });
        return toolReply(token, ev, sp.icon + ' ' + sp.title + '\n' + (lead ? lead + '\n' : '') + '請輸入要抽的' + sp.what + '，至少 2 個，用空白、頓號或換行分開，例如：\n' + sp.ex, [TOOL_CANCEL_Q]);
      };
      const m = arg.match(/^(待去清單|待去|紀錄|記錄|我的紀錄|飲料|美食|自訂|自己輸入|固定清單|固定)$/);
      if (arg && !m) { // 一行打完：奇遇羅盤 信義區 大安區
        const opts = parseToolOptions(arg);
        const bad = checkToolOptions(opts, 2, sp.what);
        if (bad) return askTyped('⚠️ ' + bad);
        await clearFlagshipSession(ctx.userId, env);
        return toolDrawFromList(fn, opts, ctx, ev, token, env, '', '', false);
      }
      if (/^固定(清單)?$/.test(arg)) { // v26.11.x：固定清單抽——統一「奇遇羅盤／驚喜製造所」招牌下，原「喝哪裡／喝什麼」那種固定選項清單的抽法，一鍵就有結果
        await clearFlagshipSession(ctx.userId, env);
        return toolDrawFromList(fn, fn === 'tool_compass' ? TOOL_COMPASS_PRESET : TOOL_SURPRISE_PRESET, ctx, ev, token, env, '', sp.name + ' 固定', true);
      }
      if (!arg || /^待去(清單)?$/.test(arg)) return toolDrawWish(fn, ctx, ev, token, env, cfg, askTyped); // V10.5：一鍵從待去清單抽 → 店家圖卡
      if (/^(自訂|自己輸入)$/.test(arg)) return askTyped('');
      // 從我的紀錄抽
      if (ctx.isGroup) return askTyped('🔒 「我的紀錄」只能在跟我的 1 對 1 聊天室用（不會在群組公開你的紀錄）。');
      const src = /^飲料$/.test(arg) ? 'drink' : /^美食$/.test(arg) ? 'food' : 'all';
      const got = await toolRecordValues(fn, src, ctx, token, env);
      if (!got.bound) return askTyped('你還沒綁定同步碼，LINE 看不到你的網頁紀錄（綁定：傳「同步碼 你的同步碼」）。');
      if (got.vals.length < 2) return askTyped('⚠️ ' + got.from + '目前只有 ' + got.vals.length + ' 個，不夠抽。');
      await clearFlagshipSession(ctx.userId, env);
      const rerun = fn === 'tool_compass' ? '奇遇羅盤 紀錄' : '驚喜製造所 ' + (src === 'drink' ? '飲料' : src === 'food' ? '美食' : '紀錄');
      return toolDrawFromList(fn, got.vals.slice(0, 500), ctx, ev, token, env, got.from, rerun, false);
    }
    default: return false;
  }
}

// 路由用：處理「工具名稱後面接字」的指令，以及工具對話進行中的下一句。回傳 true＝已處理
async function handleToolText(text, ev, ctx, cfg, session, token, env) {
  const own = toolOwns(session, ctx);
  if (session && !own) return false; // 其他流程進行中、或是另一個聊天室開的工具對話：不搶
  const checkAv = async (fn) => {
    const av = checkAvailability(fn, ctx, cfg);
    if (!av.ok) { await clearFlagshipSession(ctx.userId, env); await lineReplyQuick(token, ev.replyToken, av.message, ['功能選單']); return false; }
    return true;
  };
  if (own && !(await checkAv(session.tool))) return true;
  if (own && QUICK_CANCEL_RE.test(text)) { await clearFlagshipSession(ctx.userId, env); return toolReply(token, ev, '已取消。', TOOL_BACK_Q); }
  // 1) 「工具名稱＋參數」一行打完（按鈕送出的也是這種完整指令）——工具對話進行中也認得，並且取代原本進行中的那個工具對話
  let cmd = null;
  let mm = text.match(/^(出拳)\s*(剪刀|石頭|布)$/) || text.match(/^(剪刀石頭布|猜拳)\s*(剪刀|石頭|布)$/);
  if (mm) cmd = ['tool_rps', mm[2]];
  if (!cmd && /^(自動剪刀石頭布|自動猜拳)$/.test(text)) cmd = ['tool_rps_auto', '']; // V10.6.0：一鍵自動對決（九宮格的格子、「再來一局」按鈕送出的也是這句）
  if (!cmd) {
    mm = text.match(/^(骰子|擲骰子|骰骰子)\s*(\d{1,2})\s*(顆|個|粒)?$/);
    if (mm) cmd = ['tool_dice', mm[2]];
    else { mm = text.match(/^擲?\s*(\d{1,2})\s*(顆|個|粒)\s*骰子$/); if (mm) cmd = ['tool_dice', mm[1]]; }
  }
  if (!cmd) {
    mm = text.match(/^(拋硬幣|擲硬幣|丟硬幣|轉盤|轉瓶子|隨機盒子|奇遇羅盤|選地點|驚喜製造所|選店家)\s+(\S[\s\S]*)$/);
    if (mm) cmd = [TOOL_NAME_FN[mm[1]], mm[2]];
  }
  if (cmd) {
    if (!(await checkAv(cmd[0]))) return true;
    if (own) await clearFlagshipSession(ctx.userId, env);
    return runLineTool(cmd[0], ctx, ev, token, env, cfg, cmd[1]);
  }
  if (!own) return false;
  // 2) 工具對話進行中的下一句
  const fn = session.tool;
  const m = matchKeyword(text, buildRules(cfg), ctx.chat, true, cfg.fuzzy);
  if (m.kind === 'hit' && m.rank === 0 && !(session.stage === 'await_move' && rpsParseMove(text) >= 0)) return false; // 是在叫別的功能 → 交給路由
  if (session.stage === 'await_move') {
    if (rpsParseMove(text) < 0) return toolReply(token, ev, '請出剪刀、石頭或布：', RPS_QUICK.concat([TOOL_CANCEL_Q]));
    return runLineTool('tool_rps', ctx, ev, token, env, cfg, text);
  }
  if (session.stage === 'await_opts') return runLineTool(fn, ctx, ev, token, env, cfg, text);
  if (session.stage === 'pick_src') return runLineTool(fn, ctx, ev, token, env, cfg, text); // 「自訂」「紀錄」…或是直接打了一串清單（當作清單）
  return false;
}

async function sendDeviceCenter(token, ev) {
  return toolReply(token, ev, '🛠️ 設備管理中心\n這個項目目前還沒有可以操作的內容（功能內容待確認，我不會自己猜）。\n如果你想放進來的是某個功能（例如管理綁定的裝置、同步碼之類），告訴我要做什麼，我再接上。', []);
}


// ---------- 路由：訊息 → 關鍵字比對 → 功能 ----------
// V10.4：這句話是不是「目前這一題的按鈕選項」（或修改欄位時的欄位名稱）？是的話，它是答案，不能被當成功能關鍵字
function rec4IsOfferedAnswer(S, text) {
  try {
    if (!S || !S.module || !REC4_SCHEMAS[S.module]) return false;
    const sch = REC4_SCHEMAS[S.module];
    const it = S.items && S.items[S.i];
    if (!it) return false;
    const t = rec4Clean(text);
    if (!t) return false;
    if (S.stage === 'ask' || S.stage === 'edit_value') {
      const f = rec4Field(sch, S.cur);
      if (!f) return false;
      return rec4Options(S, f, it).some((o) => rec4Clean(typeof o === 'string' ? o : (o.text || o.label)) === t);
    }
    if (S.stage === 'edit_pick') return sch.fields.some((f) => rec4Active(S, it, f) && (f.label.replace('（選填）', '') === t || f.label === t));
    return false;
  } catch (e) { return false; }
}
async function handleKeywordRouter(ev, token, env) {
  const text = (ev.message.text || '').trim();
  if (!text) return false;
  const ctx = makeCtx(ev);
  const cfg = await loadLineConfig(env);
  await touchRegistry(ev, token, env, ctx); // 先登記使用者／群組（群組裡看不到身分的人傳訊息時，群組本身也要登記，管理頁才找得到）
  if (!ctx.userId) {
    // 群組裡看不到對方的 LINE 身分（對方沒同意官方帳號的服務條款）：只有他明確要用功能時才說明，其餘不打擾
    if (!ctx.isGroup) return false;
    const m0 = matchKeyword(text, buildRules(cfg), ctx.chat, false, cfg.fuzzy);
    const info0 = m0.kind === 'hit' ? FUNCTION_CATALOG[m0.fn] : null;
    if (info0 && (info0.personal || info0.writes)) {
      await lineReply(token, ev.replyToken, '我在群組裡看不到你的 LINE 身分（可能還沒同意我的服務條款），所以沒辦法使用「' + info0.label + '」。請先加我為好友並同意條款，或直接私訊我使用。');
      return true;
    }
    return false;
  }
  await retryUnsynced(ctx.userId, env); // 之前同步失敗的紀錄，這時自動重試
  const session = await getFlagshipSession(ctx.userId, env);
  if (await handleToolText(text, ev, ctx, cfg, session, token, env)) return true; // V10.4：工具（骰子、猜拳、轉盤…）帶參數的指令，以及工具對話進行中的下一句
  // 舊版「選模組」按鈕（飲料／美食／交通／記帳）：正在選模組時，這些字是在回答問題，不是要開新功能
  if (session && session.flow !== 'quick' && session.flow !== 'stickerkid' && session.flow !== 'op' && session.flow !== 'rec4' && !session.module && MODULE_NAMES.indexOf(normalizeKeyword(text)) >= 0) return false;
  if (session && session.flow === 'rec4' && REC4_PICK_STAGES[session.stage] && rec4Owns(session, ctx)) return false; // V10.3：四版本紀錄正在選功能／版本，這時候點的按鈕文字是在回答問題，不是要開新功能
  if (session && session.flow === 'rec4' && rec4Owns(session, ctx) && rec4IsOfferedAnswer(session, text)) return false; // V10.4：點的是這一題的按鈕選項（例如分帳類別的「飲料」「交通」、待去清單狀態的「待去」），它是答案，不是要換功能
  const m = matchKeyword(text, buildRules(cfg), ctx.chat, !!session, cfg.fuzzy);
  if (session && session.flow === 'op' && m.kind === 'hit' && m.fn !== 'menu') return false; // 正在輸入查詢條件：條件裡剛好有別的功能名稱，不要打斷
  if (!session && !(m.kind === 'hit' && m.rank === 0)) { // 不是完全相同的關鍵字：試試看是不是「操作詞＋主功能＋條件」的完整指令
    const cmd = parseCommand(text, cfg);
    if (cmd) return runCommand(cmd, ctx, ev, token, env, cfg);
  }
  if (!session && !ctx.isGroup && !(m.kind === 'hit' && m.rank === 0)) { // V10.4：分帳／集點卡／待去清單有四種版本：「紀錄集點卡 旗艦版」「紀錄分帳」這類完整指令，不能被「集點卡」「分帳」這類關鍵字攔走
    const sw = rec4SwitchOf(text);
    if (sw && sw.kind === 'module' && REC4_SCHEMAS[sw.module].needLists) return rec4StartModule(sw.module, sw.version, ctx, ev, token, env, cfg);
  }
  if (m.kind === 'none') return false;
  if (m.kind === 'ambiguous' || m.kind === 'suggest') { await sendCandidates(token, ev, cfg, m.fns, m.kind === 'suggest'); return true; }
  if (m.confirm) {
    const label = fnLabel(m.fn, cfg);
    await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: '你是要開啟「' + label + '」嗎？點下面的按鈕開啟；不是的話，不用理這則訊息。', quickReply: quickReplyItems([{ label: '開啟' + label, text: label }]) }]).catch(() => {});
    return true;
  }
  if (!(ctx.isGroup && m.fn === 'wish_add')) await clearFlagshipSession(ctx.userId, env); // 切換功能 → 結束手上正在進行的流程（V10.7.0：群組裡「新增待去地點」只回版本說明卡、不開始任何紀錄，所以不去動你在別處——例如 1 對 1——記到一半的紀錄）
  return executeFunction(m.fn, ctx, ev, token, env, cfg);
}

// ---------- 管理 API：/api/line-config（App「設定」頁面使用；需要管理密碼）----------
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
// V10.8.0：LINE 管理密碼登入保護——同一個來源（IP）連續輸錯達門檻，先鎖一段時間（鎖定期間就算密碼對也先擋下），並記錄最近幾筆失敗嘗試給登入後的管理頁看
const ADMIN_FAIL_PREFIX = 'line:admin:fail:';
const ADMIN_FAILLOG_KEY = 'line:admin:faillog';
const ADMIN_FAIL_LIMIT = 5; // 連續輸錯達這個次數就鎖定
const ADMIN_LOCK_SECONDS = 600; // 鎖定 10 分鐘；期間沒有新的錯誤嘗試，記錄會自動過期、次數歸零
const ADMIN_FAILLOG_MAX = 20; // 只留最近這麼多筆失敗紀錄
function adminClientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown'; // Cloudflare 一定會自己加上 cf-connecting-ip，不是使用者能假造的
}
async function adminGuardState(env, ip) {
  let st = null;
  try { st = JSON.parse((await env.SYNC_KV.get(ADMIN_FAIL_PREFIX + ip)) || 'null'); } catch (e) { st = null; }
  if (!st || typeof st !== 'object' || Array.isArray(st)) st = { count: 0, lockedUntil: 0 };
  return st;
}
function adminGuardLock(st) {
  const until = (st && st.lockedUntil) || 0;
  const leftMs = until - Date.now();
  const left = leftMs > 0 ? Math.ceil(leftMs / 1000) : 0;
  return { locked: left > 0, secondsLeft: left, minutesLeft: Math.max(1, Math.ceil(left / 60)) };
}
async function adminFailLogAppend(env, ip, count, locked) {
  let log = [];
  try { log = JSON.parse((await env.SYNC_KV.get(ADMIN_FAILLOG_KEY)) || '[]'); } catch (e) { log = []; }
  if (!Array.isArray(log)) log = [];
  log.unshift({ at: Date.now(), ip, count, locked: !!locked });
  log = log.slice(0, ADMIN_FAILLOG_MAX);
  try { await env.SYNC_KV.put(ADMIN_FAILLOG_KEY, JSON.stringify(log)); } catch (e) {}
}
async function adminGuardFail(env, ip) {
  const st = await adminGuardState(env, ip);
  st.count = (st.count || 0) + 1;
  if (st.count >= ADMIN_FAIL_LIMIT) st.lockedUntil = Date.now() + ADMIN_LOCK_SECONDS * 1000;
  try { await env.SYNC_KV.put(ADMIN_FAIL_PREFIX + ip, JSON.stringify(st), { expirationTtl: ADMIN_LOCK_SECONDS }); } catch (e) {}
  await adminFailLogAppend(env, ip, st.count, st.count >= ADMIN_FAIL_LIMIT);
  return adminGuardLock(st);
}
async function adminGuardSuccess(env, ip) {
  try { await env.SYNC_KV.delete(ADMIN_FAIL_PREFIX + ip); } catch (e) {}
}
async function adminFailLog(env) {
  try { const log = JSON.parse((await env.SYNC_KV.get(ADMIN_FAILLOG_KEY)) || '[]'); return Array.isArray(log) ? log : []; } catch (e) { return []; }
}
async function knownGroupsAndUsers(env, cfg) {
  const out = { groups: [], users: [] };
  let reg = {};
  try { reg = JSON.parse((await env.SYNC_KV.get(REGISTRY_KEY)) || '{}'); } catch (e) { reg = {}; }
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) reg = {};
  const groups = {};
  Object.keys(reg.groups || {}).forEach((gid) => { const g = reg.groups[gid] || {}; groups[gid] = { groupId: gid, name: g.name || '', seenAt: g.at || 0 }; });
  try { // 過去記帳紀錄裡出現過的群組也列進來
    JSON.parse((await env.SYNC_KV.get('line:log')) || '[]').forEach((r) => { if (r && r.groupId && !groups[r.groupId]) groups[r.groupId] = { groupId: r.groupId, name: r.groupName || '', seenAt: r.ts || 0 }; });
  } catch (e) {}
  Object.keys(cfg.groups || {}).forEach((gid) => { if (!groups[gid]) groups[gid] = { groupId: gid, name: cfg.groups[gid].name || '', seenAt: 0 }; });
  // 名稱以「LINE 最近一次回報的」為準；管理頁按授權時存下的名稱只是備用（不然群組改名後，這裡會一直顯示舊名字）
  out.groups = Object.keys(groups).map((gid) => Object.assign(groups[gid], { name: groups[gid].name || (cfg.groups[gid] && cfg.groups[gid].name) || '', authorized: !!(cfg.groups[gid] && cfg.groups[gid].authorized) }));
  out.users = Object.keys(reg.users || {}).map((uid) => ({ userId: uid, name: (reg.users[uid] && reg.users[uid].name) || '' }));
  return out;
}
function menuRulesInfo(cfg) {
  const v = (cfg.menu && cfg.menu.rulesV) || 1;
  return { version: v, latest: MENU_RULES_V, pending: v < MENU_RULES_V };
}
async function handleLineConfigApi(request, env) {
  const adminKey = env.LINE_ADMIN_PASSWORD || '';
  if (!adminKey) return json({ error: 'not_configured', message: '還沒設定管理密碼。請到 Cloudflare → Workers → sda → 設定 → 變數和祕密，新增一個名稱為 LINE_ADMIN_PASSWORD 的變數（內容自己決定），儲存並部署後再回來。' }, 403);
  const adminIp = adminClientIp(request);
  const hasKv = !!env.SYNC_KV;
  let guardLock = { locked: false, secondsLeft: 0, minutesLeft: 0 };
  if (hasKv) { try { guardLock = adminGuardLock(await adminGuardState(env, adminIp)); } catch (e) {} }
  if (guardLock.locked) return json({ error: 'locked', message: '輸入錯誤太多次，請於 ' + guardLock.minutesLeft + ' 分鐘後再試一次。', retryAfterSeconds: guardLock.secondsLeft }, 429);
  if (!safeEqual(request.headers.get('x-admin-key'), adminKey)) {
    if (hasKv) {
      try {
        const after = await adminGuardFail(env, adminIp);
        if (after.locked) return json({ error: 'locked', message: '輸入錯誤太多次，請於 ' + after.minutesLeft + ' 分鐘後再試一次。', retryAfterSeconds: after.secondsLeft }, 429);
      } catch (e) {}
    }
    return json({ error: 'unauthorized', message: '管理密碼不正確。' }, 401);
  }
  if (hasKv) { try { await adminGuardSuccess(env, adminIp); } catch (e) {} }
  if (!env.SYNC_KV) return json({ error: 'KV not bound' }, 500);
  const path = new URL(request.url).pathname;
  const catalog = Object.keys(FUNCTION_CATALOG).map((id) => Object.assign({ id }, FUNCTION_CATALOG[id]));

  if (request.method === 'GET' && path === '/api/line-config') {
    const cfg = await loadLineConfig(env);
    const known = await knownGroupsAndUsers(env, cfg);
    const loginGuard = { failLimit: ADMIN_FAIL_LIMIT, lockMinutes: ADMIN_LOCK_SECONDS / 60, log: await adminFailLog(env) };
    return json({ config: cfg, functions: catalog, groups: known.groups, users: known.users, specs: buildSpecs(), menuRules: menuRulesInfo(cfg), loginGuard });
  }
  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    if (path === '/api/line-config-reset') { // 還原預設不需要帶資料
      await env.SYNC_KV.delete(CONFIG_KEY);
      const cfg = await loadLineConfig(env);
      const known = await knownGroupsAndUsers(env, cfg);
      return json({ ok: true, config: cfg, functions: catalog, groups: known.groups, users: known.users, menuRules: menuRulesInfo(cfg) });
    }
    if (!body || typeof body !== 'object') return json({ error: 'bad_request', message: '資料格式不正確' }, 400);
    if (path === '/api/line-config') {
      let incoming = body && body.config;
      if (incoming && typeof incoming === 'object' && !incoming.menu) { const cm = (await loadLineConfig(env)).menu || {}; incoming = Object.assign({}, incoming, { menu: { style: cm.style, rulesV: cm.rulesV } }); } // 只帶顯示規則；不帶 toolsV（舊頁面的選單裡不一定有「自動剪刀石頭布」，toolsV 要由載入時依實際內容補） // 還沒更新的舊後台頁面不會帶 menu 欄位：沿用目前的，不要把選單顯示規則存回舊樣子
      const res = sanitizeConfig(incoming);
      if (res.errors.length) return json({ error: 'invalid', message: res.errors[0], errors: res.errors }, 400);
      await env.SYNC_KV.put(CONFIG_KEY, JSON.stringify(res.config));
      const known = await knownGroupsAndUsers(env, res.config);
      return json({ ok: true, config: res.config, warnings: res.warnings, functions: catalog, groups: known.groups, users: known.users });
    }
    if (path === '/api/line-config-menu-rules') { // 「套用新版建議選單」或「保留我的設定」
      const cur = await loadLineConfig(env);
      let next;
      if (body.action === 'apply') {
        const nd = defaultLineConfig(); // 只換選單與關鍵字；權限、群組授權、模糊比對、查詢、草稿設定都保留
        next = sanitizeConfig(Object.assign({}, cur, { mainMenus: nd.mainMenus, subMenus: nd.subMenus, keywords: nd.keywords, menu: nd.menu })).config;
      } else if (body.action === 'keep') {
        next = sanitizeConfig(Object.assign({}, cur, { menu: Object.assign({}, cur.menu, { rulesV: MENU_RULES_V }) })).config;
      } else return json({ error: 'bad_request', message: '不認得的動作' }, 400);
      await env.SYNC_KV.put(CONFIG_KEY, JSON.stringify(next));
      const known = await knownGroupsAndUsers(env, next);
      return json({ ok: true, config: next, functions: catalog, groups: known.groups, users: known.users, menuRules: menuRulesInfo(next) });
    }
    if (path === '/api/line-config-test') { // 「這句話會觸發哪個功能？」不會真的執行任何功能
      const draft = body && body.config ? sanitizeConfig(body.config).config : await loadLineConfig(env);
      const chat = body && body.chat === 'group' ? 'group' : 'direct';
      const m = matchKeyword(String((body && body.text) || ''), buildRules(draft), chat, false, draft.fuzzy);
      const out = { kind: m.kind };
      if (m.kind === 'hit') {
        out.fn = m.fn; out.fnLabel = fnLabel(m.fn, draft); out.rank = m.rank; out.confirm = !!m.confirm;
        out.matched = m.rule ? m.rule.keyword + (m.rule.implicit ? '（系統自動：功能／選單名稱）' : '') : '';
        out.type = m.rule ? m.rule.type : '';
      } else if (m.fns) { out.candidates = m.fns.map((f) => fnLabel(f, draft)); }
      return json(out);
    }
  }
  return json({ error: 'not_found' }, 404);
}

async function handleFlagshipMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = isGroupSource(ev.source);
  const groupId = isGroup ? sourceGroupId(ev.source) : '';
  if (!userId) return false; // session用userId分辨，群組裡不同人各自有各自的流程，不會互相干擾

  let session = await getFlagshipSession(userId, env);
  if (session && (session.flow === 'stickerkid' || session.flow === 'quick' || session.flow === 'op' || session.flow === 'rec4' || session.flow === 'tool')) return false; // 集點卡／「紀錄」快速記錄流程的session，交給各自的handler處理
  if (session && session.module && MODULE_FN[session.module]) { // 舊版入口也要受權限設定管控
    const cfgG = await loadLineConfig(env);
    const avG = checkAvailability(MODULE_FN[session.module], makeCtx(ev), cfgG);
    if (!avG.ok) { await clearFlagshipSession(userId, env); await lineReply(token, ev.replyToken, avG.message); return true; }
  }
  if (session && session.stage === 'confirm' && session.pending) return finishPending(ev, token, env, session); // 已填完，等使用者按「確認儲存」

  if (!session) {
    const tier = TIER_TRIGGERS[text];
    if (!tier) return false;
    session = { flow: tier, module: null, mode: null, stage: 'core', stepIndex: 0, answers: {} };
    await setFlagshipSession(userId, session, env);
    await lineReplyButtons(token, ev.replyToken, '請選擇模組', '要記錄哪個模組呢？', [
      { label: '🧋 飲料', text: '飲料' },
      { label: '🍱 美食', text: '美食' },
      { label: '🚆 交通', text: '交通' },
      { label: '💰 記帳', text: '記帳' },
    ]);
    return true;
  }

  // 取消確認：分兩步，先問「確定嗎」，按「確認刪除」才真的清掉，避免不小心打到「取消」就整筆不見
  if (session.pendingCancel) {
    if (/^確認刪除$/.test(text)) {
      await clearFlagshipSession(userId, env);
      await lineReplyQuick(token, ev.replyToken, '已取消這次的記錄。', null);
      return true;
    }
    session.pendingCancel = false;
    await setFlagshipSession(userId, session, env);
    await flagshipReprompt(session, token, ev.replyToken);
    return true;
  }
  if (/^(取消|cancel|結束|結束此次對話|離開|退出|quit|exit)$/i.test(text)) {
    session.pendingCancel = true;
    await setFlagshipSession(userId, session, env);
    await lineReplyButtons(token, ev.replyToken, '確認取消', '確定要放棄這筆紀錄嗎？\n尚未儲存的內容將會遺失。', [
      { label: '取消', text: '取消' },
      { label: '確認刪除', text: '確認刪除' },
    ]);
    return true;
  }

  // ---- 選模組（所有版本共用，先選模組才能接著選模式、進對應問答）----
  if (!session.module) {
    const mod = MODULE_TRIGGERS[text];
    if (!mod) {
      await lineReplyButtons(token, ev.replyToken, '請選擇模組', '要記錄哪個模組呢？', [
        { label: '🧋 飲料', text: '飲料' },
        { label: '🍱 美食', text: '美食' },
        { label: '🚆 交通', text: '交通' },
        { label: '💰 記帳', text: '記帳' },
      ]);
      return true;
    }
    session.module = mod;
    if (mod === 'travel') {
      // 交通還要再選一次是哪一種交通工具，選完才繼續下一步
      await setFlagshipSession(userId, session, env);
      await lineReplyAsk(token, ev.replyToken, '要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS);
      return true;
    }
    await flagshipProceedAfterModule(session, userId, env, token, ev.replyToken);
    return true;
  }

  // ---- 選交通子類型（只有選了🚆交通才會進到這裡）----
  if (session.module === 'travel' && !session.travelType) {
    const tt = TRAVEL_TYPE_TRIGGERS[text];
    if (!tt) {
      await lineReplyAsk(token, ev.replyToken, '請從下面選一種交通方式：', TRAVEL_TYPE_OPTIONS);
      return true;
    }
    session.travelType = tt;
    session.answers.transportType = tt; // 先預存起來，標準版雙表單問答時會用到
    await flagshipProceedAfterModule(session, userId, env, token, ev.replyToken);
    return true;
  }

  const flow = FLAGSHIP_SCHEMAS[session.flow];

  // ---- 選模式 ----
  if (!session.mode) {
    if (/^↩️?\s*返回$/.test(text)) {
      if (session.direct) { // 從「紀錄」選單直接進來的：返回就回到選單，不要掉進舊的選模組畫面
        await clearFlagshipSession(userId, env);
        await sendRecordMenu(token, ev, env);
        return true;
      }
      session.module = null;
      session.travelType = null;
      await setFlagshipSession(userId, session, env);
      await lineReplyButtons(token, ev.replyToken, '請選擇模組', '要記錄哪個模組呢？', [
        { label: '🧋 飲料', text: '飲料' },
        { label: '🍱 美食', text: '美食' },
        { label: '🚆 交通', text: '交通' },
        { label: '💰 記帳', text: '記帳' },
      ]);
      return true;
    }
    if (/^單/.test(text)) session.mode = 'single';
    else if (/^雙/.test(text)) session.mode = 'dual';
    else {
      await askFormMode(token, ev.replyToken, '請選擇：單表單模式 或 雙表單模式', null, ['單表單模式', '雙表單模式']);
      return true;
    }

    // 簡易版/標準版選「單表單」＝現有一則訊息搞定的行為，給說明就結束，不用真的開對話
    if (session.mode === 'single' && session.flow !== 'drink') {
      await clearFlagshipSession(userId, env);
      const helpText = session.flow === 'simple'
        ? '🟢 簡易版：打「品項 金額」，例如：\n・珍奶 60\n・午餐 120\n・計程車 250'
        : '🟡 標準版：一句話講詳細一點，我會自動幫你抓細節，沒提到的不會亂猜，例如：\n・清心的四季春大杯少糖去冰現金60\n・鼎泰豐小籠包中份現金380';
      await lineReplyQuick(token, ev.replyToken, helpText, null);
      return true;
    }

    await setFlagshipSession(userId, session, env);
    if (flow.kind === 'freeform') {
      await lineReplyAsk(token, ev.replyToken, flow.core[0].prompt, null);
    } else {
      const field = flagshipCurrentField(session);
      await lineReplyAsk(token, ev.replyToken, field.q, field.quick);
    }
    return true;
  }

  // ---- freeform（標準版-雙表單）：每一輪都用Gemini解析整句話，而不是一題一題問固定欄位 ----
  if (flow.kind === 'freeform') {
    const parsed = await parseExpense(text, env);
    if (session.stage === 'core') {
      Object.assign(session.answers, parsed || {});
      session.stage = 'extended';
      await setFlagshipSession(userId, session, env);
      await lineReplyAsk(token, ev.replyToken, flow.extended[0].prompt, null);
      return true;
    }
    if (parsed) {
      if (parsed.amount != null) session.answers.amount = parsed.amount;
      if (parsed.payment) session.answers.payment = parsed.payment;
      if (!session.answers.item && parsed.item) session.answers.item = parsed.item;
      if (!session.answers.category && parsed.category) session.answers.category = parsed.category;
    }
    if (session.answers.amount == null || isNaN(Number(session.answers.amount))) {
      await setFlagshipSession(userId, session, env);
      await lineReplyAsk(token, ev.replyToken, '還是沒抓到金額耶，直接跟我說金額多少就好', null);
      return true;
    }
    let userName = '';
    let groupName = '';
    try {
      userName = (isGroup ? await lineGroupMemberProfile(token, groupId, userId) : await lineProfile(token, userId)) || '';
    } catch (e) {}
    if (isGroup) { try { groupName = (await lineGroupSummary(token, groupId)) || ''; } catch (e) {} }
    const record = buildRecordFromParsed(session.answers, text, userId, userName, groupId, groupName, 'standard', ev.message.id);
    if (session.direct) { // 從「紀錄」選單進來的：分類固定為選的主功能
      record.category = MODULE_CAT[session.module] || record.category;
      if (session.travelType) record.transportType = session.travelType;
    }
    await askConfirm(userId, session, record, ev.replyToken, token, env, ev);
    return true;
  }

  // ---- rigid（簡易版-雙表單 / 旗艦版-飲料）：一題一題問固定欄位 ----
  const field = flagshipCurrentField(session);
  if (field) {
    if (field.numeric) {
      const n = Number(String(text).replace(/[^0-9.]/g, ''));
      if (isNaN(n)) {
        await lineReplyAsk(token, ev.replyToken, '這題要填數字喔，' + field.q, null);
        return true;
      }
      session.answers[field.key] = n;
    } else {
      session.answers[field.key] = text;
    }
    session.stepIndex++;
  }

  const currentList = session.stage === 'core' ? flow.core : flow.extended;
  if (session.stepIndex >= currentList.length) {
    if (session.stage === 'core') {
      session.stage = 'extended';
      session.stepIndex = 0;
      const nextField = flagshipCurrentField(session);
      if (session.mode === 'dual' && session.flow === 'drink') {
        const a = session.answers;
        const summary = '📋 目前記到這裡：\n品牌：' + (a.brand || '未填') + '\n飲品：' + (a.drink || '未填')
          + '\nSIZE：' + (a.size || '未填') + '\n加料：' + (a.topping || '無') + '\n甜度：' + (a.sugar || '未填')
          + '\n冰塊：' + (a.ice || '未填') + '\n\n接著問付款相關資料 👇\n\n' + nextField.q;
        await setFlagshipSession(userId, session, env);
        await lineReplyAsk(token, ev.replyToken, summary, nextField.quick);
      } else {
        await setFlagshipSession(userId, session, env);
        await lineReplyAsk(token, ev.replyToken, nextField.q, nextField.quick);
      }
      return true;
    }
    // 全部問完 → 存檔
    let userName = '';
    let groupName = '';
    try {
      userName = (isGroup ? await lineGroupMemberProfile(token, groupId, userId) : await lineProfile(token, userId)) || '';
    } catch (e) {}
    if (isGroup) { try { groupName = (await lineGroupSummary(token, groupId)) || ''; } catch (e) {} }
    const record = session.flow === 'drink'
      ? flagshipBuildRecord(session, userId, userName, groupId, groupName, ev.message.id)
      : buildSimpleRecord(session, userId, userName, groupId, groupName, ev.message.id);
    await askConfirm(userId, session, record, ev.replyToken, token, env, ev);
    return true;
  }

  await setFlagshipSession(userId, session, env);
  const nextField = flagshipCurrentField(session);
  await lineReplyAsk(token, ev.replyToken, nextField.q, nextField.quick);
  return true;
}

// 處理一則記帳訊息（直接打一句話，沒有進到多輪問答的情況）：解析 → 存 KV → 回覆
// isGroup=true 時是「群組聊天室」，行為跟 1對1 稍有不同（見下方註解）
async function handleExpenseMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = isGroupSource(ev.source);
  const groupId = isGroup ? sourceGroupId(ev.source) : '';

  // 指令：查自己的 User ID（多人加入時，家人朋友傳「我的id」就能拿到自己的 ID）
  if (/^(我的id|我的ID|id|ID)$/.test(text)) {
    await lineReply(token, ev.replyToken, '你的 User ID：\n' + (userId || '（讀取不到）'));
    return;
  }
  // 指令：查群組 ID（之後要把這個 LINE 群組連結到 App 的分帳群組時會用到）
  if (/^(群組id|群組ID)$/i.test(text)) {
    await lineReply(token, ev.replyToken, isGroup
      ? ('這個群組的 ID：\n' + groupId)
      : '這不是群組聊天室，沒有群組 ID 喔。');
    return;
  }
  // 指令：機器人版本 —— 確認 Cloudflare 上跑的是不是新版程式（官方帳號看起來沒更新時，先用這個查）
  if (BOT_VERSION_CMD_RE.test(text)) {
    await lineReply(token, ev.replyToken, await botVersionText(env, userId));
    return;
  }
  // 指令：圖文選單點「日常小秘書」時送出的觸發文字 —— 回一張「按鈕卡片」讓你三選一
  if (/^日常小秘書$/.test(text)) {
    // V10.3：四種紀錄版本（簡易／標準／進階／旗艦），選完版本再選功能
    await rec4Reply(token, ev.replyToken, [rec4VersionCardMsg('日常小秘書', '事不宜遲！這次想用哪種方式記一筆呢？', (v) => REC4_VERSIONS[v].name, null)]);
    return;
  }

  // 指令：綁定同步碼 —— 綁定後，LINE記的帳會直接自動同步進App（不用再手動匯入）
  const syncCodeMatch = text.match(/^同步碼[:：]?\s*(.+)$/);
  if (syncCodeMatch) {
    const code = (syncCodeMatch[1] || '').trim().toUpperCase();
    if (!code) {
      await lineReply(token, ev.replyToken, '請在「同步碼」後面接你App裡設定的同步碼，例如：\n同步碼 ABCD-1234-EFGH');
      return;
    }
    const kv = env.SYNC_KV;
    if (!kv) {
      await lineReply(token, ev.replyToken, '伺服器目前沒有連接資料庫，請稍後再試。');
      return;
    }
    // 先確認這組碼底下實際有什麼，讓使用者能立刻核對是不是自己的帳號，避免打錯碼綁到空的地方都不知道
    let drinkCount = '未知', mealCount = '未知', travelCount = '未知';
    let codeExists = false;
    try {
      const raw = await kv.get(keyOf(code));
      if (raw) {
        codeExists = true;
        const rec = JSON.parse(raw);
        const data = (rec && rec.data) || {};
        try { drinkCount = String(JSON.parse(data.boba_recs || '[]').length); } catch (e) {}
        try { mealCount = String(JSON.parse(data.meal_recs || '[]').length); } catch (e) {}
        try { travelCount = String(JSON.parse(data.travel_recs || '[]').length); } catch (e) {}
      }
    } catch (e) {}
    await kv.put('line:usersync:' + userId, code);
    const summary = codeExists
      ? ('這組碼目前有：🧋飲料 ' + drinkCount + ' 筆・🍱美食 ' + mealCount + ' 筆・🚆交通 ' + travelCount + ' 筆\n如果數字跟你App裡看到的對不起來，代表可能打錯碼了，可以重新傳一次「同步碼 正確的碼」覆蓋。')
      : '⚠️ 這組碼目前雲端還查不到資料（可能是還沒同步過，或是打錯了）。如果是新帳號還沒同步過，這是正常的；如果你App裡明明有資料，麻煩再檢查一次同步碼有沒有打對。';
    await lineReply(token, ev.replyToken, '✅ 已綁定同步碼！之後LINE記的🧋飲料／🍱美食／🚆交通／🧾分帳／🌟集點卡／📍待去清單，會先變成「待確認草稿」，到網頁核對資料卡片、按【確認新增】後才正式儲存（💰一般記帳目前還是要手動處理）。\n\n' + summary);
    return;
  }

  // V9：已綁定同步碼的使用者 → 飲料／美食／交通先建立「待確認草稿」（不直接存檔，要到網頁確認後才儲存）。
  //   群組裡只有訊息含數字（可能有金額）才嘗試，避免一般聊天每句話都呼叫 AI
  const ctxD = makeCtx(ev);
  const eligD = ctxD.userId ? await draftEligibility(ctxD.userId, env) : null;
  if (eligD && (!isGroup || /[0-9０-９零一二三四五六七八九十百千萬兩]/.test(text) || localParseDraftItems(text, '').length)) {
    const whoD = await lineWho(token, ctxD);
    const stD = await tryDraftFromText(ev, token, env, ctxD, whoD.userName, whoD.groupName, text, eligD);
    if (stD !== 'skip') return;
  }
  const parsed = await parseExpense(text, env);
  if (!parsed || parsed.amount == null || isNaN(Number(parsed.amount))) {
    // 群組裡看不懂就安靜略過（大家可能在聊別的事，不要洗版）；1對1才提示格式
    if (!isGroup) {
      await lineReplyQuick(token, ev.replyToken,
        '看不懂這則訊息耶 😅\n\n・要記帳：請用「品項 金額」，例如：\n　珍奶 60／午餐 120／計程車 250\n・要用其他功能：輸入「功能選單」或「紀錄」看選單，或直接輸入功能名稱：\n　飲料紀錄／美食紀錄／交通紀錄／記帳／分帳管理／集點卡／待去清單',
        ['功能選單']);
    }
    return;
  }

  let userName = '';
  try {
    userName = (isGroup
      ? await lineGroupMemberProfile(token, groupId, userId)
      : await lineProfile(token, userId)) || '';
  } catch (e) {}

  let groupName = '';
  if (isGroup) {
    try { groupName = (await lineGroupSummary(token, groupId)) || ''; } catch (e) {}
  }

  const record = buildRecordFromParsed(parsed, text, userId, userName, groupId, groupName, undefined, ev.message.id);

  // V9：AI 嚴格擷取不能用時的備援 —— 舊流程組出來的飲料／美食／交通，同樣先建立草稿
  if (eligD && DRAFT_KIND_BY_CAT[record.category]) {
    if ((await tryDraftFromRecord(userId, record, ev.replyToken, token, env, ev, null)) === 'done') return;
  }

  { // 依這筆記錄的分類，檢查對應功能在這個聊天室能不能新增資料
    const cfgG = await loadLineConfig(env);
    const avG = checkAvailability(CATEGORY_FN[record.category] || 'ledger', makeCtx(ev), cfgG);
    if (!avG.ok) { await lineReply(token, ev.replyToken, avG.message); return; }
  }
  let synced = false;
  try {
    synced = await saveLineLogRecord(record, env);
  } catch (e) {
    await lineReply(token, ev.replyToken, '記錄時發生問題，請稍後再試 🙏');
    return;
  }

  const catLabel = { drink: '🧋 飲料', food: '🍱 美食', travel: '🚆 交通', other: '📝 其他' }[record.category] || '📝 其他';
  const who = userName ? '（' + userName + '）' : '';
  const head = record.synced ? '✅ 已記錄' + who + '（已同步到網頁）' : '📝 已暫存' + who;
  await lineReply(token, ev.replyToken, head + '\n' + catLabel + '：' + record.item + '　$' + record.amount + (record.synced ? '' : '\n' + syncWording(record)));
}

// =================================================================
// calnote 轉送（Phase 3：calnote 併入同一個LINE官方帳號）
// -----------------------------------------------------------------
// 使用者決定 calnote（行事曆／記事／待辦／倒數日／日期計算機）不要另外
// 申請一個LINE官方帳號，改成跟這支「日常小秘書」共用同一個帳號。做法是
// 「轉送式整合」：calnote 的程式碼／KV資料庫完全獨立部署在它自己的
// Cloudflare Worker，這支 _worker.js 只在自己原有的文字指令鏈最前面，
// 多加一關——這段文字像不像calnote的指令？像的話就用內部API問一下
// calnote，它有處理就把它的回覆原封不動轉給LINE；它說沒處理、連不上、
// 或者逾時，就完全不影響，直接往下走原來六種既有判斷。
//
// 安全性：CALNOTE_WORKER_URL／CALNOTE_INTERNAL_SECRET 這兩個環境變數只
// 要有一個沒設定，這整塊就是100%不動作（直接 return false）——不會因為
// 裝了這段程式碼就改變現有六個功能的任何行為。要啟用才需要：
//   1) 這支Worker的環境變數加 CALNOTE_WORKER_URL = calnote那支Worker的網址
//   2) 這支Worker的環境變數加 CALNOTE_INTERNAL_SECRET = 跟calnote那邊設定
//      的 CALNOTE_INTERNAL_SECRET 完全相同的一串密鑰（兩邊要一致）
//
// CALNOTE_TRIGGER_PATTERNS 是從 calnote_worker.js 原封不動複製過來的指令
// 格式清單（共48條regex，對照 calnote_worker.js 裡每一個 RE_ 開頭的常數）。
// 這裡只是「值不值得發一次內部API請求」的便宜本地判斷，省掉對每一句聊天
// 訊息都打一次內部API的成本；真正判斷是不是calnote指令、群組裡有沒有@到
// 機器人，一律由calnote那邊自己的 handleSingleEvent/extractCommandText
// 決定（轉送時會把 ev.source、ev.message.mention 原封不動一起送過去）。
// 如果以後calnote那邊新增/修改了指令格式，要記得回來同步這份清單——沒同
// 步也不會答錯，只是預篩會不準：漏判只會少轉送一次（那句calnote指令機器
// 人沒反應，但不會得到錯誤答案）；多轉送只是多一次內部API呼叫，calnote
// 會回handled:false，一樣正常往下走原來六種判斷，不影響正確性。
// =================================================================
const CALNOTE_TRIGGER_PATTERNS = [
  // 行程 Event
  /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/,
  /^查詢行事曆$/,
  /^本週行程$/,
  /^本月行程$/,
  /^查詢行事曆\s+(\d{4})-(\d{2})$/,
  /^行事曆\s*#(\d+)\s*改為\s*(.+)$/,
  /^完成行程\s*#(\d+)$/,
  /^修改行程\s*#(\d+)\s*時間改為\s*(\d{1,2}):(\d{2})$/,
  /^刪除行程\s*#(\d+)$/,
  /^行事曆\s*#(\d+)\s*地點設為\s*(.+)$/,
  /^行事曆\s*#(\d+)\s*備註\s*(.+)$/,
  /^將行程\s*#(\d+)\s*設為緊急$/,
  // 記事 Note
  /^記事\s+(.+)$/s,
  /^補充記事\s*#(\d+)[:：]\s*(.+)$/s,
  /^修改記事\s*#(\d+)\s*內容改為\s*(.+)$/s,
  /^刪除記事\s*#(\d+)$/,
  /^置頂記事\s*#(\d+)$/,
  /^輸出純文字記事\s*#(\d+)$/,
  // 待辦 Todo
  /^待辦\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/s,
  /^待辦\s+(\d{4})-(\d{2})-(\d{2})\s+(.+)$/s,
  /^待辦\s+(.+)$/s,
  /^查詢待辦$/,
  /^今天該做的待辦$/,
  /^已逾期待辦$/,
  /^(高|中|低)優先待辦$/,
  /^(.+)的待辦$/,
  /^完成待辦\s*#(\d+)$/,
  /^待辦\s*#(\d+)\s*改[為回]\s*(.+)$/,
  /^修改待辦\s*#(\d+)\s*期限改為\s*(\d{4})-(\d{2})-(\d{2})$/,
  /^刪除待辦\s*#(\d+)$/,
  /^把待辦\s*#(\d+)\s*轉成行事曆\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/,
  // 倒數日 Countdown
  /^(倒數日|紀念日)\s+(\d{4})-(\d{2})-(\d{2})\s+(.+)$/s,
  /^(查詢倒數日|我的倒數日清單)$/,
  /^倒數日\s*#(\d+)\s*設為每年重複$/,
  /^修改倒數日\s*#(\d+)\s*標題改為\s*(.+)$/s,
  /^刪除倒數日\s*#(\d+)$/,
  /^將倒數日\s*#(\d+)\s*關聯到(行事曆|記事)\s*#(\d+)$/,
  // 日期計算機 DateCalc
  /^計算\s+(\d{4})-(\d{2})-(\d{2})\s+到\s+(\d{4})-(\d{2})-(\d{2})\s+中間幾天$/,
  /^到\s+(\d{4})-(\d{2})-(\d{2})\s+還有幾天$/,
  /^(\d{4})-(\d{2})-(\d{2})\s+(加|減)\s*(\d+)\s*(天|週|個月|月|年)\s*是幾號$/,
  /^今天(加|減)\s*(\d+)\s*(天|週|個月|月|年)\s*是幾號$/,
  /^(\d{4})-(\d{2})-(\d{2})\s+星期幾$/,
  /^(\d{4})-(\d{2})-(\d{2})\s+出生[，,]?\s*現在幾歲$/,
  /^(\d{4})-(\d{2})-(\d{2})\s+到職[，,]?\s*現在年資幾年$/,
  /^下(\d+)個星期([一二三四五六日天])是幾號$/,
  /^下下週([一二三四五六日天])是幾號$/,
  /^下週([一二三四五六日天])是幾號$/,
  /^這個月最後一個星期([一二三四五六日天])是幾號$/,
];

/**
 * 便宜的本地預篩：這段文字「看起來像不像」calnote的指令格式。
 * 只決定要不要發內部API，不是最終判斷（見上方整段說明）。
 * 群組訊息會先模仿 calnote 自己 extractCommandText 的作法，把@到本機器人
 * 的mention文字片段去掉再比對；完全沒有@到本機器人的群組訊息，直接判定
 * 「不像」，因為calnote那邊的規則下群組一定會保持靜默，轉送也是白轉。
 */
function looksLikeCalnoteCommand(text, ev) {
  if (!text) return false;
  let t = text;
  const source = ev && ev.source;
  if (isGroupSource(source)) {
    const mention = ev.message && ev.message.mention;
    if (mention && Array.isArray(mention.mentionees)) {
      const selfMention = mention.mentionees.find((m) => m.isSelf === true);
      if (!selfMention) return false;
      t = (text.slice(0, selfMention.index) + text.slice(selfMention.index + selfMention.length)).trim();
    } else if (text.startsWith('@機器人')) {
      t = text.slice('@機器人'.length).trim();
    } else {
      return false;
    }
  }
  return CALNOTE_TRIGGER_PATTERNS.some((re) => re.test(t));
}

/**
 * 轉送到 calnote 的內部API。CALNOTE_WORKER_URL／CALNOTE_INTERNAL_SECRET
 * 兩個環境變數只要有一個沒設定，直接回false（完全不動作，原有六個功能
 * 不受任何影響）。calnote那邊有處理（handled:true）就把它的reply陣列
 * 原樣轉給LINE，回true；calnote說沒處理、逾時、或者連不上，都回false，
 * 讓後面原本的六種判斷繼續正常運作——calnote這邊不管發生什麼問題，都
 * 不會讓使用者收不到回覆或讓整個訊息處理卡住。
 */
async function handleCalnoteForward(ev, token, env) {
  const base = env.CALNOTE_WORKER_URL;
  const secret = env.CALNOTE_INTERNAL_SECRET;
  if (!base || !secret) return false;
  if (!ev.message || typeof ev.message.text !== 'string') return false;
  const text = ev.message.text;
  if (!looksLikeCalnoteCommand(text, ev)) return false;

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000); // calnote如果掛了或很慢，最多等4秒就放棄，不拖累使用者原本六個功能的回覆
    try {
      res = await fetch(base.replace(/\/+$/, '') + '/internal/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
        body: JSON.stringify({ text, source: ev.source, mention: ev.message.mention }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.log('calnote 轉送失敗（連不上或逾時），交回原本的指令判斷', e && e.message);
    return false;
  }
  if (!res || !res.ok) return false;

  let data;
  try { data = await res.json(); } catch (e) { return false; }
  if (!data || data.handled !== true || !Array.isArray(data.reply) || !data.reply.length) return false;

  await lineReplyMessages(token, ev.replyToken, data.reply); // 轉送成功後的回覆萬一失敗，交給外層既有的 catch 統一處理（跟其他既有handler一致，不另外吞掉）
  return true;
}

async function handleLine(request, env) {
  // LINE 的 webhook 只會用 POST。用瀏覽器直接開會是 GET，回個 OK 方便測試。
  if (request.method !== 'POST') return new Response('LINE webhook OK');

  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const secret = env.LINE_CHANNEL_SECRET;
  if (!token || !secret) {
    return new Response('LINE env not set (need LINE_CHANNEL_ACCESS_TOKEN & LINE_CHANNEL_SECRET)', { status: 500 });
  }

  const body = await request.text();

  // 簽章驗證：擋掉不是 LINE 送來的假請求
  const signature = request.headers.get('x-line-signature') || '';
  const valid = await verifyLineSignature(secret, body, signature);
  if (!valid) return new Response('bad signature', { status: 401 });

  let data;
  try { data = JSON.parse(body || '{}'); }
  catch (e) { return new Response('OK'); }

  const events = data.events || [];
  for (const rawEv of events) {
    let ev = rawEv;
    if (rawEv && rawEv.type === 'postback') { // V10.5：隱藏按鈕（九宮格、再玩一次…）→ 當成使用者打了那串字，往下走同一條路
      ev = postbackAsTextEvent(rawEv);
      if (!ev) continue;
    }
    if (ev.type === 'join' && ev.source && isGroupSource(ev.source)) {
      // 官方帳號被加進群組／聊天室：馬上登記，管理頁的「群組與權限」不用等到有人在裡面傳訊息就找得到（只登記，不回話、不打擾）
      try { await touchRegistry(ev, token, env, makeCtx(ev)); } catch (e) {}
      continue;
    }
    if (ev.type === 'message' && ev.message && ev.message.type === 'image' && ev.replyToken) {
      // V10.3：照片（拍照、相簿、上傳、貼上圖片）。只有「自己開了紀錄流程」或 1 對 1 直接傳的才處理，群組裡別人傳的照片一律不理
      try {
        ev.appOrigin = new URL(request.url).origin;
        await handleRec4Image(ev, token, env);
      } catch (e) {
        if (ev._rec4Engaged) { try { await lineReply(token, ev.replyToken, '照片處理時發生了一點問題 🙏 不影響文字紀錄，請直接用文字輸入，或稍後再傳一次照片'); } catch (e2) {} }
      }
      continue;
    }
    if (ev.type === 'message' && ev.message && ev.message.type === 'text' && ev.replyToken) {
      try {
        ev.appOrigin = new URL(request.url).origin; // 給「開啟App」按鈕組網址用
        const handled = (await handleCalnoteForward(ev, token, env)) || (await handleKeywordRouter(ev, token, env)) || (await handleRec4Message(ev, token, env)) || (await handleOpMessage(ev, token, env)) || (await handleQuickMessage(ev, token, env)) || (await handleFlagshipMessage(ev, token, env)) || (await handleStickerCardMessage(ev, token, env));
        if (!handled) await handleExpenseMessage(ev, token, env);
      } catch (e) {
        try { await lineReply(token, ev.replyToken, '發生了一點問題 🙏 請再試一次'); } catch (e2) {}
      }
    }
  }
  return new Response('OK');
}

// 讀取 LINE紀錄資料（給 App 讀、也方便測試時用瀏覽器查看）
async function handleLineLog(request, env) {
  if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
  const kv = env.SYNC_KV;
  const noStore = (res) => { res.headers.set('Cache-Control', 'no-store'); return res; }; // 讀到的一定要是最新的，不能被瀏覽器或中間節點留著舊的
  if (!kv) return noStore(withCORS(json({ error: 'kv_not_bound', message: '伺服器還沒綁定 KV（SYNC_KV），所以讀不到 LINE紀錄' }, 500)));
  let cur;
  try { cur = await readLineLog(kv); }
  catch (e) { return noStore(withCORS(json({ error: 'kv_read_failed', message: '伺服器讀取 LINE 暫存資料時發生問題：' + kvErrorMessage(e) }, 500))); }
  // 清單裡混進 null 或不是物件的東西 → 略過，不要讓網頁整頁讀不出來
  const list = cur.list.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  return noStore(withCORS(json({ count: list.length, skipped: cur.list.length - list.length, corrupt: cur.corrupt, records: list })));
}

// 匯入完成後，把已經搬進App模組的LINE記錄從 line:log 移除（避免兩邊都算、變兩倍）
async function handleLineLogRemove(request, env) {
  if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
  if (request.method !== 'POST') return withCORS(json({ error: 'method not allowed' }, 405));
  if (!checkToken(request, env)) return withCORS(json({ error: 'unauthorized' }, 401));
  const kv = env.SYNC_KV;
  if (!kv) return withCORS(json({ error: 'KV not bound' }, 500));

  let body;
  try { body = await request.json(); }
  catch (e) { return withCORS(json({ error: 'invalid JSON body' }, 400)); }
  const ids = body && Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return withCORS(json({ error: 'missing ids' }, 400));

  // LINE整合 V10.2.0：App 的「🗑 刪除」要靠這裡的回答告訴使用者「真的刪掉了」或「沒刪成功」，所以和「新增一筆」一樣——
  //   每一輪都重新讀最新的清單 → 拿掉指定的 → 寫回 → 讀回來確認指定的真的不在了（被同時進來的寫入蓋回去就再做一次）；
  //   KV 寫不進去（例如 429）時最多再試 3 次，還是不行就回 500 ＋ 白話原因（不再丟出沒人接的錯誤、也不假裝成功）。
  //   指定的編號本來就不在清單裡（例如已經被刪過）也算成功（removed:0），重複按不會出錯。
  const idSet = new Set(ids);
  let lastErr = null;
  let stage = 'read'; // 失敗時用來分辨是「讀不到」還是「寫不進去／寫了沒成功」
  for (let attempt = 0; attempt < LINE_LOG_WRITE_DELAYS.length; attempt++) {
    if (LINE_LOG_WRITE_DELAYS[attempt]) await sleepMs(LINE_LOG_WRITE_DELAYS[attempt] + Math.floor(Math.random() * 150));
    try {
      stage = 'read';
      const cur = await readLineLog(kv);
      if (cur.corrupt) return withCORS(json({ ok: true, removed: 0, remaining: 0, corrupt: true })); // 壞掉的清單沒有東西可以移除；之後 LINE 新紀錄進來時會自動修復
      const list = cur.list;
      const remaining = list.filter((r) => !(r && idSet.has(String(r.id))));
      if (remaining.length === list.length) return withCORS(json({ ok: true, removed: 0, remaining: remaining.length })); // 指定的都已經不在了
      stage = 'write';
      await kv.put('line:log', JSON.stringify(remaining));
      stage = 'verify';
      const back = await readLineLog(kv); // 讀回來確認：真的拿掉了，才算成功
      if (!back.corrupt && !back.list.some((r) => r && idSet.has(String(r.id)))) {
        return withCORS(json({ ok: true, removed: list.length - remaining.length, remaining: back.list.length }));
      }
      lastErr = null; // 讀得到、寫得進去，但指定的又出現了（被同時進來的寫入蓋回去）
    } catch (e) { lastErr = e; }
  }
  if (lastErr) return withCORS(json({ error: stage === 'read' ? 'kv_read_failed' : 'kv_write_failed', message: '伺服器沒能把這筆從 LINE 暫存清單移除：' + kvErrorMessage(lastErr) }, 500));
  return withCORS(json({ error: 'kv_write_failed', message: '伺服器沒能把這筆從 LINE 暫存清單移除：寫入後讀回確認，這筆還在（可能被同時進來的另一筆 LINE 紀錄蓋掉了），請再試一次' }, 500));
}

// ============================================================
// 📩 V9：LINE 輸入 → 網頁表單自動帶入（待確認草稿）
//   核心流程：訊息解析 → 表單自動帶入 → 人工審核 → 確認儲存 → 流水號生成
//   ・LINE 傳來的飲料／美食／交通，不直接變成正式紀錄，而是「每個品項各存成一張待確認草稿」（同步資料裡的 line_drafts）。
//   ・網頁端打開草稿時，用「既有的」飲料／美食／交通表單，把解析到的欄位自動填進去；
//     訊息沒提到的欄位維持空白或表單原本的預設值，辨識不確定的欄位標「待確認」。
//   ・使用者在網頁按原本的「儲存」才會正式建立紀錄，並由網頁表單原有的規則產生總流水號／個人流水號。
//   ・還沒綁定同步碼（或同步碼底下還沒有網頁資料）的人，維持原本流程（暫存在 LINE，到 App「LINE紀錄」匯入）。
//   ・管理員可以在 App「設定 → LINE 官方帳號…」關閉這個模式（設定裡的 draft.enabled），關閉後回到 V8 的 LINE 端確認流程。
// V10 補充（只有網頁端 index.html 有改流程；後端這裡只調整說明文字與管理頁的規格表，建立草稿的邏輯沒動）：
//   ・點 LINE 卡片的連結 → 網頁先跳「資料卡片」：【確認新增】才正式建立紀錄並產生流水號；【取消】放棄這張草稿、不留紀錄。
//   ・LINE 轉入的紀錄流水號改用 LINE- 開頭的新格式（飲料 LINE-DRK、美食 LINE-FD／LINE-MFD、交通 LINE-TRP／LINE-MTRP），
//     序號＝同一組現有最大號 + 1、年份依紀錄日期各自起算、編輯時鎖定不變號（實作在網頁端的「流水號引擎」）。
//   ・分帳 LINE-SPL／LINE-MSPL、集點卡 LINE-PTS／LINE-MPTS、待去清單 LINE-WSH／LINE-MWSH：V10 先登記前綴。
// V10.1 補充（分帳、集點卡、待去清單也走同一條流程）：
//   ・LINE 傳來的分帳（晚餐 1200 AA）、集點卡（小明 刷牙）、待去地點（想去 九份老街）一樣先變成「待確認草稿」，
//     到網頁資料卡片按【確認新增】才正式寫入各自的模組，並產生 LINE-SPL／LINE-PTS／LINE-WSH 流水號；【取消】不留任何紀錄。
//   ・欄位全部沿用這三個模組現有的表單（分帳＝新增支出表單、集點卡＝乖寶寶／互助的記一筆、待去清單＝新增項目表單），沒有自己另外造欄位。
//   ・分帳的群組與成員、集點卡的孩子與行為、待去清單的分類：解析時會對照使用者同步資料裡的清單 —— 對得上才帶入，對不上的標「待確認」，不亂猜。
//   ・集點卡與待去清單只在 1 對 1 聊天室做「自由文字」解析（孩子姓名、個人清單不在群組裡處理）；群組裡仍可走選單流程。
// ============================================================
const DRAFT_LS_KEY = 'line_drafts';
const DRAFT_KIND_BY_CAT = { drink: 'drink', food: 'food', travel: 'travel', split: 'split', sticker: 'sticker', wish: 'wish' };
const DRAFT_KIND_LABEL = { drink: '🧋 飲料', food: '🍱 美食', travel: '🚆 交通', split: '🧾 分帳', sticker: '🌟 集點卡', wish: '📍 待去清單' };
const DRAFT_KIND_FN = { drink: 'drink', food: 'food', travel: 'travel', split: 'split_add', sticker: 'sticker', wish: 'wish_add' }; // 建立哪種草稿，就用哪個「功能」的權限檢查
const WISH_NEED_DRAFT_TEXT = '要用 LINE 新增待去地點，需要先綁定同步碼（傳「同步碼 你的碼」，App 首頁的「雲端同步」可以看到），而且管理頁的「草稿模式」要開著。';
// 判斷這則訊息「可能」是哪一種：只用來決定要不要把該種類的說明與清單交給 AI（省額度、降低誤判），最後仍由程式逐欄檢查
const SPLIT_TRIGGER_RE = /(AA|分帳|均分|平分|分攤|拆帳|代墊|幫付|先付|各付|每人|算我)/i;
const WISH_TRIGGER_RE = /(想去|待去|想要去|想逛|口袋名單|收藏|下次(?:要)?去|有機會(?:要)?去|一定要去|必去|新增待去|加入待去)/;
const STICKER_TRIGGER_RE = /(集點|加點|扣點|互助|點數|乖寶寶|[加扣]\s*[0-9０-９]+\s*點)/;
const WISH_DEFAULT_CATS = ['食', '衣', '住', '行', '娛樂', '夜景', '最美的地方', '購物', '旅遊', '其他'];
const SPLIT_CAT_IDS = ['food', 'drink', 'transport', 'flight', 'ship', 'hotel', 'shopping', 'ticket', 'gift', 'grocery', 'fun', 'other'];
const SPLIT_CAT_NAMES = { 餐飲: 'food', 吃飯: 'food', 飲料: 'drink', 交通: 'transport', 機票: 'flight', 船票: 'ship', 住宿: 'hotel', 購物: 'shopping', 門票: 'ticket', 禮物: 'gift', 雜貨: 'grocery', 娛樂: 'fun', 其他: 'other' };
const SPLIT_CAT_LABEL = { food: '餐飲', drink: '飲料', transport: '交通', flight: '機票', ship: '船票', hotel: '住宿', shopping: '購物', ticket: '門票', gift: '禮物', grocery: '雜貨', fun: '娛樂', other: '其他' };
const DRAFT_KEEP_MS = 30 * 24 * 3600 * 1000; // 已儲存／已捨棄的草稿保留 30 天（用來擋重複），超過就清掉
const DRAFT_KEEP_MAX = 300;
const DRAFT_MAX_ITEMS = 8; // 一則訊息最多拆成幾張草稿
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 台灣時間 UTC+8（Cloudflare Worker 的時區固定是 UTC，不能直接用 getHours()）

// 網頁表單裡「下拉選單」真正有的選項（要跟 index.html 的表單一致；不在清單裡的值會當成「自訂」帶入）
const WEB_SELECT = {
  size: ['L', 'M', 'S', '瓶裝', '壺裝'],
  topping: ['無', '珍珠', '椰果', '布丁', '仙草', '蘆薈', '小芋圓', '波霸'],
  sugar: ['0', '0.5', '1', '2', '3', '5', '7', '10'],
  ice: ['normal', 'more', 'less', 'micro', 'no_ice', 'no_ice_c', 'warm', 'hot'],
  mealCategory: ['早餐', '午餐', '晚餐', '宵夜', '點心'],
  cuisine: ['中式', '日式', '韓式', '美式', '義式', '泰式', '港式', '素食'],
  portion: ['小份', '中份', '大份', '雙人餐'],
  spicy: ['不辣', '小辣', '中辣', '大辣', '變態辣'],
  diningType: ['內用', '外帶', '外送'],
  payment: ['現金', '信用卡', '簽帳金融卡', 'Apple Pay', 'Google Pay', 'Samsung Pay', 'LINE Pay', '街口支付', '全支付', '轉帳', '其他'],
  currency: ['NT$', 'RMB¥', 'JPY¥', 'KRW₩'],
  travelType: ['flight', 'ship', 'hsr', 'train', 'metro', 'taxi'],
};
const DRAFT_LABELS = {
  date: '日期', time: '時間', area: '地點', brand: '品牌', drink: '飲品', category: '類別', size: 'SIZE', topping: '加料', sugar: '甜度', ice: '冰塊',
  payment: '付款方式', currency: '幣別', amount: '金額', drinker: '飲用者', eater: '用餐者', recorder: '紀錄者', note: '備註', rating: '評分',
  dish: '餐點', cuisine: '菜系', portion: '份量', spicy: '辣度', diningType: '用餐方式', type: '交通類型', company: '公司', no: '班次／編號',
  depPort: '出發地', arrPort: '到達地', transitPort: '經停', depTime: '出發時間', arrTime: '到達時間', seat: '座位', vehicleType: '車種／機型', ticketPrice: '票價',
  // V10.1：分帳（新增支出表單）、集點卡（記一筆）、待去清單（新增項目表單）
  group: '分帳群組', entry: '類型', cat: '類別', desc: '品項', payer: '誰先付錢', participants: '分給誰', splitAll: '分給誰',
  card: '集點卡', kid: '孩子', behavior: '行為', points: '點數', dir: '加點／扣點',
  name: '項目名稱', country: '國家／地區', city: '城市／地區', detailPlace: '詳細地點／商家', reason: '推薦原因', notes: '備註', targetTime: '預計時間', suggestDate: '提議日期', suggestTime: '提議時間',
  customShares: '每人金額', splitType: '如何分', status: '狀態',
};
// 各種紀錄在網頁表單上實際使用的欄位名稱（和網頁表單一致，LINE 回覆、網頁提示、管理頁適用範圍都用這張表）
const DRAFT_LABELS_KIND = {
  drink: { brand: '品牌名稱', drink: '飲品名稱', category: '飲品類別', size: '規格（SIZE）', topping: '加料', payment: '支付方式', country: '國家', payer: '付款者' },
  food: { brand: '店家名稱', dish: '餐點名稱', category: '用餐類別', payment: '支付方式' },
  travel: { payment: '付款方式' },
  split: { payment: '付款方式' },
  sticker: { note: '原因／備註' },
  wish: { category: '分類', source: '來源', proposer: '提議者', rating: '推薦指數' },
};
function draftLabel(kind, k) { return (DRAFT_LABELS_KIND[kind] && DRAFT_LABELS_KIND[kind][k]) || DRAFT_LABELS[k] || k; }
const SUGAR_LABEL = { '0': '無糖', '0.5': '0.5分糖', '1': '一分糖', '2': '二分糖', '3': '微糖', '5': '半糖', '7': '少糖', '10': '全糖' };
const ICE_LABEL = { normal: '正常冰', more: '多冰', less: '少冰', micro: '微冰', no_ice: '去冰', no_ice_c: '完全去冰', warm: '溫', hot: '熱' };

function tpParts(ms) { // 毫秒 → 台灣時間的 日期／時間／星期
  const d = new Date(Number(ms || Date.now()) + TZ_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return { date: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()), time: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()), dow: d.getUTCDay() };
}

// ---------- 欄位整理（全部都是「純函式」：不信任 AI 回傳的格式，一律在這裡檢查、轉成網頁表單認得的值）----------
const EMPTY_WORD_RE = /^(null|undefined|n\/a|na|none|未提及|未知|不明|未填|無資料|－|—|-)$/i;
function dStr(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60);
  return EMPTY_WORD_RE.test(s) ? '' : s;
}
function dCleanChoice(v, max) { // 選項類：去掉括號說明（例如「微糖(30%)」→「微糖」）與空白
  return dStr(v, max || 20).replace(/[（(][^)）]*[)）]/g, '').replace(/\s+/g, '');
}
// 每個 normXxx 回傳 null（沒有值）或 { v: 值, known: 是否是表單下拉選單裡有的選項 }
function normChoice(v, list, table, max) {
  const s = dCleanChoice(v, max);
  if (!s) return null;
  if (list.indexOf(s) >= 0) return { v: s, known: true };
  for (let i = 0; i < table.length; i++) { if (table[i][0].indexOf(s) >= 0) return { v: table[i][1], known: true }; }
  return { v: dStr(v, max || 20), known: false };
}
const SUGAR_TABLE = [
  [['無糖', '無', '不加糖', '零糖', '0糖', '0分', '0分糖', '0%'], '0'],
  [['0.5分', '0.5分糖', '0.5糖'], '0.5'],
  [['一分糖', '一分', '1分糖', '1分', '10%'], '1'],
  [['二分糖', '二分', '兩分糖', '兩分', '2分糖', '2分', '20%'], '2'],
  [['三分糖', '三分', '3分糖', '3分', '微糖', '30%'], '3'],
  [['五分糖', '五分', '5分糖', '5分', '半糖', '50%'], '5'],
  [['七分糖', '七分', '7分糖', '7分', '少糖', '70%'], '7'],
  [['全糖', '正常糖', '正常', '十分糖', '十分', '10分糖', '10分', '100%'], '10'],
];
const ICE_TABLE = [
  [['完全去冰', '完全無冰', '去冰完全'], 'no_ice_c'],
  [['去冰', '無冰', '不加冰', '走冰'], 'no_ice'],
  [['正常冰', '全冰', '正常', '多冰正常'], 'normal'],
  [['多冰'], 'more'],
  [['少冰'], 'less'],
  [['微冰'], 'micro'],
  [['常溫', '溫', '溫飲', '溫的', '微溫'], 'warm'],
  [['熱', '熱飲', '熱的', '加熱'], 'hot'],
];
function normSugar(v) { return normChoice(v, WEB_SELECT.sugar, SUGAR_TABLE, 20); }
function normIce(v) { return normChoice(v, WEB_SELECT.ice, ICE_TABLE, 20); }
function normSize(v) {
  const s = dCleanChoice(v, 12);
  if (!s) return null;
  const up = s.toUpperCase();
  if (['L', '大', '大杯', 'LARGE'].indexOf(up) >= 0) return { v: 'L', known: true };
  if (['M', '中', '中杯', 'MEDIUM'].indexOf(up) >= 0) return { v: 'M', known: true };
  if (['S', '小', '小杯', 'SMALL'].indexOf(up) >= 0) return { v: 'S', known: true };
  if (WEB_SELECT.size.indexOf(s) >= 0) return { v: s, known: true };
  return { v: dStr(v, 12), known: false };
}
function normTopping(v) {
  const s = dStr(v, 30);
  if (!s) return null;
  if (/^(無|沒有|不加|不加料|無加料)$/.test(s)) return { v: '無', known: true };
  if (WEB_SELECT.topping.indexOf(s) >= 0) return { v: s, known: true };
  return { v: s, known: false };
}
function normPayment(v) {
  const s = dStr(v, 20);
  if (!s) return null;
  const t = s.toLowerCase().replace(/\s+/g, '');
  if (/^(現金|cash)$/.test(t)) return { v: '現金', known: true };
  if (/^(信用卡|刷卡|creditcard)$/.test(t)) return { v: '信用卡', known: true };
  if (/^(簽帳金融卡|簽帳卡|金融卡|debit|debitcard)$/.test(t)) return { v: '簽帳金融卡', known: true };
  if (/^applepay$/.test(t)) return { v: 'Apple Pay', known: true };
  if (/^(googlepay|gpay)$/.test(t)) return { v: 'Google Pay', known: true };
  if (/^samsungpay$/.test(t)) return { v: 'Samsung Pay', known: true };
  if (/^(linepay|line支付)$/.test(t)) return { v: 'LINE Pay', known: true };
  if (/^(街口|街口支付|jkopay)$/.test(t)) return { v: '街口支付', known: true };
  if (/^(全支付|pxpay)$/.test(t)) return { v: '全支付', known: true };
  if (/^(轉帳|匯款)$/.test(t)) return { v: '轉帳', known: true };
  if (t === '其他') return { v: '其他', known: true };
  return { v: s, known: false };
}
function normCurrency(v) {
  const s = dStr(v, 12);
  if (!s) return null;
  const t = s.toUpperCase().replace(/\s+/g, '');
  if (['NT$', 'NTD', 'TWD', 'NT', '台幣', '臺幣', '新台幣', '新臺幣'].indexOf(t) >= 0) return { v: 'NT$', known: true };
  if (['RMB¥', 'RMB', 'CNY', '人民幣'].indexOf(t) >= 0) return { v: 'RMB¥', known: true };
  if (['JPY¥', 'JPY', '日圓', '日幣', '円'].indexOf(t) >= 0) return { v: 'JPY¥', known: true };
  if (['KRW₩', 'KRW', '韓元', '韓幣', '₩'].indexOf(t) >= 0) return { v: 'KRW₩', known: true };
  if (['¥', '$', '元', '塊'].indexOf(t) >= 0) return null; // 單一符號可能是好幾種貨幣，不猜
  return { v: s, known: false };
}
function normAmount(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) && v >= 0 && v < 1e8 ? Math.round(v * 100) / 100 : null;
  const m = String(v).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return isFinite(n) && n < 1e8 ? Math.round(n * 100) / 100 : null;
}
function normDate(v) {
  const s = dStr(v, 12);
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return m[1] + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}
function normTime(v) {
  const s = dStr(v, 8);
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}
function normPerson(v, sender) {
  const s = dStr(v, 20);
  if (!s) return null;
  if (/^(我|自己|本人|me|i)$/i.test(s)) return sender ? { v: sender, known: true } : null;
  if (/^together$/i.test(s)) return { v: 'Together', known: true };
  if (/^xiaoge$/i.test(s)) return { v: 'XiaoGe', known: true };
  if (/^xiaoyan$/i.test(s)) return { v: 'XiaoYan', known: true };
  return { v: s, known: false };
}
function normTravelType(v) {
  const s = dStr(v, 12).toLowerCase();
  if (WEB_SELECT.travelType.indexOf(s) >= 0) return s;
  const map = { 航班: 'flight', 飛機: 'flight', 機票: 'flight', 船班: 'ship', 渡輪: 'ship', 船: 'ship', 高鐵: 'hsr', 火車: 'train', 台鐵: 'train', 地鐵: 'metro', 捷運: 'metro', 打車: 'taxi', 計程車: 'taxi', uber: 'taxi', taxi: 'taxi' };
  return map[s] || '';
}

// ---------- V10.1：分帳／集點卡／待去清單 的名稱比對小工具（純函式）----------
// 把訊息裡的名字對到使用者「自己的清單」：完全相同，或「只有一個」清單項目包含它（至少 2 個字）才算對得上；對不上就保留原文、請使用者確認，不亂猜
function matchListName(v, names) {
  const s = dStr(v, 30);
  if (!s) return null;
  const low = s.toLowerCase();
  const list = (names || []).map((n) => String(n === undefined || n === null ? '' : n)).filter(Boolean);
  const exact = list.filter((n) => n.toLowerCase() === low);
  if (exact.length === 1) return { v: exact[0], known: true };
  if (exact.length > 1) return { v: s, known: false };
  if (s.length >= 2) {
    const part = list.filter((n) => n.toLowerCase().indexOf(low) >= 0);
    if (part.length === 1) return { v: part[0], known: true };
  }
  return { v: s, known: false };
}
// 「我」對應到分帳成員：LINE 顯示名稱或 App 帳號名稱和成員完全相同才算「確定」；只是互相包含（例如「洪小格」和「小格」）也接受，但一定標待確認；都對不上就留著請使用者選
function resolveMeMember(members, meNames) {
  const list = (members || []).map((n) => String(n === undefined || n === null ? '' : n)).filter(Boolean);
  const names = (meNames || []).map((n) => dStr(n, 30)).filter(Boolean);
  for (let i = 0; i < names.length; i++) {
    const ex = list.filter((m) => m.toLowerCase() === names[i].toLowerCase());
    if (ex.length === 1) return { v: ex[0], viaName: false };
  }
  for (let i = 0; i < names.length; i++) {
    const low = names[i].toLowerCase();
    const part = list.filter((m) => m.length >= 2 && low.length >= 2 && (low.indexOf(m.toLowerCase()) >= 0 || m.toLowerCase().indexOf(low) >= 0));
    if (part.length === 1) return { v: part[0], viaName: true, by: names[i] };
  }
  return null;
}
const ME_RE = /^(我|自己|本人|me|i)$/i;
// 分帳表單的幣別選單（和網頁 SPLIT_CURRENCIES 一致）
const SPLIT_CUR_TABLE = [
  ['NT$', ['NT$', 'NTD', 'TWD', 'NT', '台幣', '臺幣', '新台幣', '新臺幣']],
  ['CN¥', ['CN¥', 'RMB¥', 'RMB', 'CNY', '人民幣']],
  ['US$', ['US$', 'USD', '美金', '美元']],
  ['₩', ['₩', 'KRW₩', 'KRW', '韓元', '韓幣']],
  ['¥', ['JPY¥', 'JPY', '日圓', '日幣', '円']],
  ['€', ['€', 'EUR', '歐元']],
  ['HK$', ['HK$', 'HKD', '港幣', '港元']],
  ['£', ['£', 'GBP', '英鎊']],
  ['฿', ['฿', 'THB', '泰銖']],
  ['A$', ['A$', 'AUD', '澳幣', '澳元']],
  ['S$', ['S$', 'SGD', '新加坡幣', '新幣']],
  ['RM', ['RM', 'MYR', '馬幣', '馬來幣', '令吉']],
];
function normSplitCurrency(v) {
  const s = dStr(v, 12);
  if (!s) return null;
  const t = s.toUpperCase().replace(/\s+/g, '');
  for (let i = 0; i < SPLIT_CUR_TABLE.length; i++) { if (SPLIT_CUR_TABLE[i][1].some((n) => n.toUpperCase() === t)) return { v: SPLIT_CUR_TABLE[i][0], known: true }; }
  if (['¥', '$', '元', '塊'].indexOf(t) >= 0) return null; // 單一符號可能是好幾種貨幣，不猜
  return { v: s, known: false };
}

// ---------- 把「AI（或本地解析）給的原始物件」整理成一張草稿的內容 ----------
// raw 的欄位名稱沿用網頁「貼上解析」的命名（drinkName、toppings…），這裡統一換成網頁紀錄的欄位名稱（drink、topping…）
// V10.1：ctx 另外可以帶 { userName, lists }，lists＝使用者自己的 { groups, kids, behaviors, wishCats }（分帳／集點卡／待去清單用來比對名稱）
// 回傳 { fields, uncertain, notes } 或 null（什麼都沒辨識到）。fields 只放「訊息裡真的有的」；沒有的欄位不放，網頁端就維持空白／表單預設。
function normalizeDraftItem(kind, raw, ctx) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const f = {};
  const unc = new Set(); // 辨識者（AI）自己說「不太確定」的欄位
  const forced = new Set(); // 我們判定一定要請使用者確認的欄位（例如：值對應不到表單選項）
  const notes = {};
  const unmapped = {}; // 訊息有提到、但這個網頁表單沒有對應欄位的資訊：只顯示給使用者看，不亂塞進別的欄位
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') f[k] = v; };
  const DROP_UNKNOWN = { sugar: 1, ice: 1 }; // 網頁表單的甜度、冰塊不支援自訂值：對應不到就不帶入，請使用者自己選
  const FLAG_UNKNOWN = { payment: 1, currency: 1 }; // 付款方式、幣別：不在選項內時以「自訂」帶入，並請使用者確認
  const putChoice = (k, n) => {
    if (!n) return;
    if (!n.known && DROP_UNKNOWN[k]) { forced.add(k); notes[k] = '訊息寫的是「' + n.v + '」，無法對應到表單的選項，請自己選'; return; }
    f[k] = n.v;
    if (!n.known && FLAG_UNKNOWN[k]) { forced.add(k); notes[k] = '「' + n.v + '」不在表單的選項內，已用自訂內容帶入，請確認'; }
  };
  const ALIAS = { drinkName: 'drink', toppings: 'topping', mealCategory: 'category', price: 'amount' };
  (Array.isArray(raw.uncertain) ? raw.uncertain : []).forEach((n) => { n = dStr(n, 20); if (n) unc.add(ALIAS[n] || n); });
  const sender = ctx && ctx.sender ? ctx.sender : '';

  const date = normDate(raw.date);
  const time = (kind === 'travel' || kind === 'wish') ? '' : normTime(raw.time);
  if (kind === 'drink') {
    put('brand', dStr(raw.brand, 40));
    put('drink', dStr(raw.drinkName !== undefined ? raw.drinkName : raw.drink, 40));
    put('category', dStr(raw.category, 20));
    putChoice('size', normSize(raw.size));
    putChoice('topping', normTopping(raw.toppings !== undefined ? raw.toppings : raw.topping));
    putChoice('sugar', normSugar(raw.sugar));
    putChoice('ice', normIce(raw.ice));
    const amount = normAmount(raw.amount);
    if (amount !== null) f.amount = amount;
    putChoice('currency', normCurrency(raw.currency));
    putChoice('payment', normPayment(raw.payment));
    put('area', dStr(raw.area, 40));
    if (dStr(raw.country, 30)) f.country = rec4ParseCountry(raw.country); // V10.3：網頁飲料表單的「國家」
    const dr = normPerson(raw.drinker, sender);
    if (dr) { f.drinker = dr.v; if (!dr.known) { unc.add('drinker'); notes.drinker = '訊息裡的稱呼「' + dr.v + '」不是已知帳號，請確認飲用者'; } }
    const py = normPerson(raw.payer, sender); // V10.3：網頁飲料表單的「付款者」
    if (py) { f.payer = py.v; if (!py.known) { unc.add('payer'); notes.payer = '訊息裡的稱呼「' + py.v + '」不是已知帳號，請確認付款者'; } }
    put('note', dStr(raw.note, 80));
    const rating = Math.round(Number(raw.rating) || 0);
    if (rating >= 1 && rating <= 5) f.rating = rating;
    if (date) f.date = date;
    if (time) f.time = time;
  } else if (kind === 'food') {
    put('brand', dStr(raw.brand, 40));
    put('dish', dStr(raw.dish !== undefined ? raw.dish : raw.drinkName, 40));
    const mc = dStr(raw.mealCategory !== undefined ? raw.mealCategory : raw.category, 12);
    if (mc) f.category = mc === '下午茶' ? '點心' : mc;
    putChoice('cuisine', normChoice(raw.cuisine, WEB_SELECT.cuisine, [], 12));
    putChoice('portion', normChoice(raw.portion, WEB_SELECT.portion, [[['小', '小份'], '小份'], [['中', '中份'], '中份'], [['大', '大份'], '大份']], 12));
    putChoice('spicy', normChoice(raw.spicy, WEB_SELECT.spicy, [], 12));
    putChoice('diningType', normChoice(raw.diningType, WEB_SELECT.diningType, [[['堂食', '在店內'], '內用'], [['帶走', '自取'], '外帶']], 12));
    const amount = normAmount(raw.amount);
    if (amount !== null) f.amount = amount;
    putChoice('currency', normCurrency(raw.currency));
    putChoice('payment', normPayment(raw.payment));
    if (dStr(raw.area, 40)) unmapped.area = dStr(raw.area, 40);
    const ea = normPerson(raw.eater, sender);
    if (ea) { f.eater = ea.v; if (!ea.known) { unc.add('eater'); notes.eater = '訊息裡的稱呼「' + ea.v + '」不是已知帳號，請確認用餐者'; } }
    put('note', dStr(raw.note, 80));
    const rating = Math.round(Number(raw.rating) || 0);
    if (rating >= 1 && rating <= 5) f.rating = rating;
    if (date) f.date = date;
    if (time) f.time = time;
  } else if (kind === 'travel') {
    const type = normTravelType(raw.type !== undefined ? raw.type : raw.transportType);
    if (type) f.type = type;
    put('company', dStr(raw.company, 40));
    put('no', dStr(raw.no, 30));
    put('depPort', dStr(raw.depPort, 40));
    put('arrPort', dStr(raw.arrPort, 40));
    put('transitPort', dStr(raw.transitPort, 40));
    const dt = normTime(raw.depTime);
    if (dt) f.depTime = dt;
    const at = normTime(raw.arrTime);
    if (at) f.arrTime = at;
    put('seat', dStr(raw.seat, 20));
    put('vehicleType', dStr(raw.vehicleType, 30));
    const price = normAmount(raw.ticketPrice !== undefined && raw.ticketPrice !== null ? raw.ticketPrice : raw.amount);
    if (price !== null) f.ticketPrice = price;
    putChoice('payment', normPayment(raw.payment));
    put('note', dStr(raw.note, 80));
    if (date) f.date = date;
  } else if (kind === 'split') {
    // 分帳＝網頁「新增支出」表單：類型、日期、時間、類別、品項、金額、幣別、誰先付錢、付款方式、如何分／分給誰、備註
    const L = (ctx && ctx.lists) || {};
    const groups = Array.isArray(L.groups) ? L.groups : [];
    const meNames = [sender, ctx && ctx.userName].filter(Boolean);
    let grp = null;
    const gIn = dStr(raw.group, 30);
    if (gIn) {
      const gm = matchListName(gIn, groups.map((g) => g.name));
      f.group = gm.v;
      if (gm.known) grp = groups.find((g) => g.name === gm.v) || null;
      else { forced.add('group'); notes.group = '你的分帳裡找不到叫「' + gIn + '」的群組，請在網頁選擇'; }
    } else if (groups.length === 1) {
      grp = groups[0]; f.group = grp.name;
      forced.add('group'); notes.group = '訊息沒指定群組，暫用你唯一的分帳群組「' + grp.name + '」，請確認';
    } else if (groups.length > 1) {
      forced.add('group'); notes.group = '訊息沒指定群組，請在網頁選擇要記在哪一個分帳群組';
    }
    const members = grp ? (grp.members || []) : null;
    put('desc', dStr(raw.desc !== undefined ? raw.desc : raw.item, 40));
    const amt = normAmount(raw.amount);
    if (amt) f.amount = amt; // 分帳金額必須大於 0
    const en = dStr(raw.entry, 12).toLowerCase();
    if (/^(income|收入|收款|入帳|退款)$/.test(en)) f.entry = 'income';
    else if (/^(expense|支出|花費)$/.test(en)) f.entry = 'expense';
    const catIn = dStr(raw.cat !== undefined ? raw.cat : raw.category, 12);
    if (catIn) { const cid = SPLIT_CAT_IDS.indexOf(catIn.toLowerCase()) >= 0 ? catIn.toLowerCase() : SPLIT_CAT_NAMES[catIn]; if (cid) f.cat = cid; }
    const cur = normSplitCurrency(raw.currency);
    if (cur) {
      if (cur.known) f.currency = cur.v;
      else { forced.add('currency'); notes.currency = '訊息寫的是「' + cur.v + '」，分帳表單的幣別選單沒有這個幣別，請自己選'; }
    }
    putChoice('payment', normPayment(raw.payment));
    // 誰先付錢
    const payIn = dStr(raw.payer, 20);
    if (payIn) {
      if (ME_RE.test(payIn)) {
        const me = members ? resolveMeMember(members, meNames) : null;
        if (me) { f.payer = me.v; if (me.viaName) { forced.add('payer'); notes.payer = '依你的名稱「' + me.by + '」對應到成員「' + me.v + '」，請確認'; } }
        else { f.payer = '我'; forced.add('payer'); notes.payer = members ? '訊息寫「我」，但群組成員裡沒有和你的名稱對得上的人，請選擇' : '訊息寫「我」，請選擇是哪一位成員'; }
      } else {
        const pm = members ? matchListName(payIn, members) : { v: payIn, known: true };
        f.payer = pm.v;
        if (!pm.known) { forced.add('payer'); notes.payer = '群組成員裡找不到「' + payIn + '」，請選擇'; }
      }
    } else { forced.add('payer'); notes.payer = '訊息沒提到誰先付錢，請選擇'; }
    // 分給誰
    const splitAll = raw.splitAll === true || /^(true|全部|所有人|大家|全員)$/i.test(String(raw.splitAll === undefined || raw.splitAll === null ? '' : raw.splitAll));
    let rawParts = [];
    if (Array.isArray(raw.participants)) rawParts = raw.participants;
    else if (typeof raw.participants === 'string' && raw.participants.trim()) rawParts = raw.participants.split(/[、,，\s]+/);
    rawParts = rawParts.map((x) => dStr(x, 20)).filter(Boolean).slice(0, 20);
    const partIssues = [];
    if (rawParts.length) {
      const names = [];
      rawParts.forEach((p) => {
        let name = p;
        if (ME_RE.test(p)) {
          const me = members ? resolveMeMember(members, meNames) : null;
          if (me) { name = me.v; if (me.viaName) partIssues.push('「' + me.by + '」對應到成員「' + me.v + '」'); }
          else { name = '我'; partIssues.push('找不到「我」是哪一位成員'); }
        } else if (members) {
          const pm = matchListName(p, members);
          name = pm.v;
          if (!pm.known) partIssues.push('群組成員裡找不到「' + p + '」');
        }
        if (names.indexOf(name) < 0) names.push(name);
      });
      f.participants = names;
    } else if (splitAll) {
      f.splitAll = true;
    } else {
      forced.add('participants'); notes.participants = '訊息沒提到分給誰，表單預設是全部成員均分，請確認';
    }
    let customApplied = false;
    if (raw.customShares && typeof raw.customShares === 'object' && !Array.isArray(raw.customShares)) {
      const cs = Object.keys(raw.customShares).slice(0, 20).map((k) => dStr(k, 20) + '＝' + dStr(raw.customShares[k], 12)).filter((x) => x.length > 1 && x.slice(-1) !== '＝');
      // V10.4：四種版本的問答（或使用者明確選了「自訂金額」）才會帶 splitType='custom'：名字都對得上成員、金額加起來剛好等於總金額，才當成自訂金額；任何一項不符就退回下面原本的「提醒＋均分」
      if (/^(custom|自訂|自訂金額)$/i.test(dStr(raw.splitType, 12)) && f.amount) {
        const mapN = {};
        let sum = 0;
        let bad = '';
        Object.keys(raw.customShares).slice(0, 20).forEach((k) => {
          if (bad) return;
          let nm = dStr(k, 20);
          const v = normAmount(raw.customShares[k]);
          if (!nm || v === null) { bad = '有一位的金額看不懂'; return; }
          if (ME_RE.test(nm)) {
            const me = members ? resolveMeMember(members, meNames) : null;
            if (!me) { bad = '找不到「我」是哪一位成員'; return; }
            nm = me.v;
          } else if (members) {
            const pm = matchListName(nm, members);
            if (!pm.known) { bad = '群組成員裡找不到「' + nm + '」'; return; }
            nm = pm.v;
          }
          if (mapN[nm] !== undefined) { bad = '「' + nm + '」出現了兩次'; return; }
          mapN[nm] = v; sum += v;
        });
        const total = Math.round(sum * 100) / 100;
        if (!bad && !Object.keys(mapN).length) bad = '沒有看到每個人的金額';
        if (!bad && Math.abs(total - f.amount) >= 0.005) bad = '每人金額加起來是 ' + total + '，和總金額 ' + f.amount + ' 不一樣';
        if (bad) partIssues.push(bad);
        else { f.splitType = 'custom'; f.customShares = mapN; f.participants = Object.keys(mapN); delete f.splitAll; forced.delete('participants'); delete notes.participants; customApplied = true; }
      }
      if (!customApplied && cs.length) { unmapped.customShares = cs.join('、'); partIssues.push('訊息提到每個人金額不同，這裡先用均分帶入，需要的話按【修改內容】改成「自訂金額」'); }
    }
    if (!customApplied && /^(equal|均分|平分)$/i.test(dStr(raw.splitType, 12))) f.splitType = 'equal';
    if (partIssues.length) { forced.add('participants'); notes.participants = partIssues.filter((x, i) => partIssues.indexOf(x) === i).join('；') + '，請確認'; } // 同一句原因只寫一次
    put('note', dStr(raw.note, 80));
    if (date) f.date = date;
    if (time) f.time = time;
  } else if (kind === 'sticker') {
    // 集點卡＝乖寶寶集點卡「記一筆」（孩子＋行為＋點數）或互助集點卡「記一筆」（加點／扣點＋點數＋原因）
    const L = (ctx && ctx.lists) || {};
    const kids = (Array.isArray(L.kids) ? L.kids : []).map((k) => (k && k.name ? String(k.name) : '')).filter(Boolean);
    const behs = (Array.isArray(L.behaviors) ? L.behaviors : []).filter((b) => b && b.name);
    const cardIn = String(raw.card === undefined || raw.card === null ? '' : raw.card);
    const isMutual = /^mutual$/i.test(cardIn) || /互助/.test(cardIn);
    f.card = isMutual ? 'mutual' : 'kid';
    let pts = null; // 有正負號的點數（加點為正、扣點為負）
    if (raw.points !== undefined && raw.points !== null && raw.points !== '') {
      const pn = Number(String(raw.points).replace(/[+＋]/g, '').replace(/[－−]/g, '-'));
      if (isFinite(pn) && pn !== 0 && Math.abs(pn) < 100000) pts = Math.round(pn * 100) / 100;
    }
    let beh = null;
    const kIn = isMutual ? '' : dStr(raw.kid, 20);
    const bIn = isMutual ? '' : dStr(raw.behavior, 30);
    if (!isMutual && !kIn && !bIn && pts === null) return null; // 訊息本身沒有孩子、行為、點數任何一項 → 不算一筆集點紀錄（不能只靠「唯一的孩子」這種預設值湊成一筆）
    if (!isMutual) {
      if (kIn) {
        const km = matchListName(kIn, kids);
        f.kid = km.v;
        if (!km.known) { forced.add('kid'); notes.kid = '集點卡裡找不到叫「' + kIn + '」的孩子，請在網頁選擇'; }
      } else if (kids.length === 1) {
        f.kid = kids[0]; forced.add('kid'); notes.kid = '訊息沒指定孩子，暫用你唯一的集點卡「' + kids[0] + '」，請確認';
      } else if (kids.length > 1) {
        forced.add('kid'); notes.kid = '訊息沒指定是哪個孩子，請在網頁選擇';
      }
      if (bIn) {
        const bm = matchListName(bIn, behs.map((b) => b.name));
        f.behavior = bm.v;
        if (bm.known) beh = behs.find((b) => b.name === bm.v) || null;
        else { forced.add('behavior'); notes.behavior = '行為清單裡沒有「' + bIn + '」，儲存時會當成自訂行為記錄'; }
      }
      if (pts === null && beh && Number(beh.points)) pts = Number(beh.points); // 訊息沒另外說幾點 → 用行為在 App 裡設定的點數（是清單裡的真實設定，不是猜的）
    }
    const dirIn = dStr(raw.dir, 10);
    if (pts !== null && /^(deduct|minus|-|扣|扣點|減)$/i.test(dirIn)) pts = -Math.abs(pts);
    else if (pts !== null && /^(add|plus|\+|加|加點)$/i.test(dirIn)) pts = Math.abs(pts);
    if (pts !== null) f.points = pts;
    else { forced.add('points'); notes.points = isMutual ? '訊息沒提到點數，請輸入' : '訊息沒提到點數，這個行為也沒有設定點數，請輸入'; }
    put('note', dStr(raw.note, 80));
    if (date) f.date = date;
    if (time) f.time = time;
  } else if (kind === 'wish') {
    // 待去清單＝網頁（待去清單頁）「新增項目」表單：分類、項目名稱、國家、城市、詳細地點、推薦原因、備註、來源、提議者、提議日期、預計時間
    const L = (ctx && ctx.lists) || {};
    const cats = Array.isArray(L.wishCats) && L.wishCats.length ? L.wishCats : WISH_DEFAULT_CATS;
    put('name', dStr(raw.name, 60));
    put('country', dStr(raw.country, 30));
    put('city', dStr(raw.city, 30));
    put('detailPlace', dStr(raw.detailPlace, 80));
    put('reason', dStr(raw.reason, 100));
    put('notes', dStr(raw.notes, 100));
    put('source', dStr(raw.source, 30));
    put('proposer', dStr(raw.proposer, 20));
    put('targetTime', dStr(raw.targetTime, 30));
    const sdW = normDate(raw.suggestDate); // V10.4：四種版本的問答可以指定提議日期、推薦指數、狀態（一句話解析不會填這三項）
    if (sdW) f.suggestDate = sdW;
    const rtgW = Number(raw.rating);
    if (isFinite(rtgW) && rtgW >= 3 && rtgW <= 5 && Math.round(rtgW) === rtgW) f.rating = rtgW; // 網頁「推薦指數」只有 3～5 顆星三個選項
    put('status', dStr(raw.status, 20));
    const cIn = dStr(raw.category, 20);
    const fallbackCat = cats.indexOf('其他') >= 0 ? '其他' : '';
    if (cIn) {
      const cm = matchListName(cIn, cats);
      if (cm.known) f.category = cm.v;
      else { if (fallbackCat) f.category = fallbackCat; forced.add('category'); notes.category = '分類「' + cIn + '」不在你的待去清單分類裡，' + (fallbackCat ? '暫放「' + fallbackCat + '」，' : '') + '請選擇'; }
    } else {
      if (fallbackCat) f.category = fallbackCat;
      forced.add('category'); notes.category = '訊息沒提到分類，' + (fallbackCat ? '暫放「' + fallbackCat + '」，' : '') + '請選擇';
    }
  } else {
    return null;
  }
  const MEANINGFUL = { drink: ['brand', 'drink', 'amount'], food: ['brand', 'dish', 'amount'], travel: ['type', 'company', 'no', 'depPort', 'arrPort', 'ticketPrice'], split: ['desc', 'amount'], sticker: ['kid', 'behavior', 'points'], wish: ['name'] };
  if (!MEANINGFUL[kind].some((k) => f[k] !== undefined)) return null; // 只剩日期之類的零碎資訊 → 不算一筆紀錄
  if (kind === 'sticker' && f.card === 'mutual' && f.points === undefined) return null; // 互助集點卡一定要有點數才算一筆
  if (ctx && ctx.trustRecorder) { const rc = dStr(raw.recorder, 20); if (rc) f.recorder = rc; } // V10.3：四版本流程裡使用者自己確認過的紀錄者
  else if (sender) f.recorder = sender; // 紀錄者 = 傳訊息的人（LINE 身分，不是猜的）
  const uncertain = Array.from(unc).filter((k) => f[k] !== undefined);
  forced.forEach((k) => { if (uncertain.indexOf(k) < 0) uncertain.push(k); });
  if (ctx && ctx.trustRecorder && raw && raw.lineNotes && typeof raw.lineNotes === 'object') { // V10.4：四版本流程的確認畫面說過「為什麼標待確認」，一起帶到網頁，核對時看得到原因
    uncertain.forEach((k) => { if (!notes[k] && raw.lineNotes[k]) notes[k] = dStr(raw.lineNotes[k], 200); });
  }
  Object.keys(notes).forEach((k) => { if (uncertain.indexOf(k) < 0) delete notes[k]; });
  return { fields: f, uncertain, notes, unmapped };
}

// 飲料／美食（V10.1 起也包含分帳、集點卡）沒提到日期或時間時：帶入「LINE 傳送訊息的時間」並標成待確認（不是猜測，是真實的傳送時間；交通的日期維持空白，因為票券日期常常不是傳訊息的那天）
//   opts.quiet＝這筆是使用者在 LINE 選單裡「現在」按出來的（例如集點卡選孩子→選行為），傳送時間就是記錄時間，直接帶入、不用標待確認
//   待去清單：提議日期＝LINE 傳送的日期、提議時間＝傳送的時間 —— 這是「提議」發生的時間本身，不是缺漏，所以也不標待確認
function applyMessageTimeFallback(kind, item, msgTs, opts) {
  const tp = tpParts(msgTs);
  if (kind === 'wish') {
    if (!item.fields.suggestDate) item.fields.suggestDate = tp.date;
    if (!item.fields.suggestTime && item.fields.suggestDate === tp.date) item.fields.suggestTime = tp.time;
    return;
  }
  if (kind !== 'drink' && kind !== 'food' && kind !== 'split' && kind !== 'sticker') return;
  const quiet = !!(opts && opts.quiet);
  if (!item.fields.date) { item.fields.date = tp.date; if (!quiet) { item.uncertain.push('date'); item.notes.date = '訊息沒提到日期，暫用 LINE 傳送時間（' + tp.date + '）'; } }
  if (!item.fields.time) { item.fields.time = tp.time; if (!quiet) { item.uncertain.push('time'); item.notes.time = '訊息沒提到時間，暫用 LINE 傳送時間（' + tp.time + '）'; } }
}

// ---------- 沒有 AI 也能用：「品牌：50嵐 飲品：珍奶 金額：65」這種欄位格式（跟網頁「貼上解析」的格式一樣）----------
const LOCAL_KEYS = {
  drink: { brand: ['品牌', '店家', '店名'], drinkName: ['飲品名稱', '飲品', '品名', '飲料', '名稱'], category: ['類別', '種類'], size: ['尺寸', '容量', '大小', 'size', 'SIZE'], toppings: ['加料', '配料', '料'], sugar: ['甜度', '糖度', '糖'], ice: ['冰塊', '冰量', '冰'], payment: ['支付方式', '支付', '付款方式', '付款'], amount: ['金額', '價格', '價錢', '售價', '價'], area: ['地點', '地區', '位置', '地址'], note: ['備註', '註記', '備注'], date: ['日期'], time: ['時間'] },
  food: { brand: ['店家', '品牌', '店名', '餐廳'], dish: ['餐點', '品名', '料理', '名稱'], mealCategory: ['類別', '餐別', '種類'], cuisine: ['菜系', '料理類型'], portion: ['份量', '分量'], spicy: ['辣度', '辣'], diningType: ['用餐方式', '取餐'], payment: ['支付方式', '支付', '付款方式', '付款'], amount: ['金額', '價格', '價錢', '售價', '價'], note: ['備註', '註記', '備注'], date: ['日期'], time: ['時間'] },
  travel: { company: ['航空公司', '航空', '船公司', '平台', '車行', '營運', '公司'], no: ['航班', '班機', '車次', '班次', '編號', '訂單', '路線'], depPort: ['出發地', '出發站', '上車站', '上車', '出發'], arrPort: ['到達地', '到達站', '下車站', '下車', '目的地', '到達'], depTime: ['出發時間', '去程時間'], arrTime: ['到達時間', '抵達時間'], seat: ['座位', '車廂'], ticketPrice: ['金額', '價格', '票價', '費用'], payment: ['支付方式', '支付', '付款方式', '付款'], note: ['備註', '註記', '備注'], date: ['日期'] },
};
function localParseDraftItems(text, hintKind) {
  const t = String(text || '');
  let kind = '';
  if (/(飲品名稱|飲品|飲料)\s*[：:]/.test(t)) kind = 'drink';
  else if (/(餐點|料理|菜系|餐廳)\s*[：:]/.test(t)) kind = 'food';
  else if (/(航班|班機|車次|班次|出發地|出發站|到達地|到達站|票價|航空公司)\s*[：:]/.test(t)) kind = 'travel';
  else if (hintKind && LOCAL_KEYS[hintKind]) kind = hintKind;
  if (!kind) return [];
  const map = LOCAL_KEYS[kind];
  const all = Array.from(new Set([].concat.apply([], Object.keys(map).map((k) => map[k])))).sort((a, b) => b.length - a.length);
  const KT = all.join('|');
  const grab = (keys) => {
    for (let i = 0; i < keys.length; i++) {
      const m = t.match(new RegExp(keys[i] + '\\s*[：:]\\s*(.+?)(?=\\s*(?:' + KT + ')\\s*[：:]|[，,；;、\\n]|$)'));
      if (m && m[1].trim()) return m[1].trim();
    }
    return null;
  };
  const raw = { kind };
  let hit = 0;
  Object.keys(map).forEach((k) => { const v = grab(map[k]); if (v !== null) { raw[k] = v; hit++; } });
  if (raw.amount === undefined && kind !== 'travel') {
    const m = t.match(/(?:NT\$|＄|\$|RMB|¥|￥)\s*([\d.]+)|([\d.]+)\s*元/);
    if (m) { raw.amount = m[1] || m[2]; hit++; }
  }
  return hit ? [raw] : [];
}

// ---------- V10.1：不靠 AI 的簡單解析（只處理「一看就懂」的短句；其他交給 AI。寧可不解析，也不要解析錯）----------
// 分帳：「晚餐 1200 AA」「唱歌 3000 我先付」—— 只認「品項＋一個金額＋AA／我先付」這種短句；有多個數字（看不出哪個是金額）就不處理
function localParseSplit(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return [];
  const tokens = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const after = t.charAt(m.index + m[0].length);
    const before = m.index > 0 ? t.charAt(m.index - 1) : '';
    if (/[人位個份杯點分%:：號月日年]/.test(after) || before === ':' || before === '：') continue; // 「4人」「3點」「12:30」這類不是金額
    tokens.push({ s: m[0], i: m.index });
  }
  if (tokens.length !== 1) return [];
  const amount = Number(tokens[0].s.replace(/,/g, ''));
  if (!(amount > 0)) return [];
  const all = /(AA|均分|平分|分攤|各付)/i.test(t);
  const meFirst = /(我先付|我付|我代墊|我先墊|我出)/.test(t);
  if (!all && !meFirst) return []; // 沒有任何分帳的線索 → 不處理（可能只是一般記帳）
  let desc = t.slice(0, tokens[0].i) + ' ' + t.slice(tokens[0].i + tokens[0].s.length);
  desc = desc.replace(/NT\$|＄|\$|元|塊/g, ' ').replace(/AA制?|均分|平分|分攤|各付|我先付|我付|我代墊|我先墊|我出|分帳/gi, ' ').replace(/[\s，,。.!！、]+/g, ' ').trim();
  // 剩下的字必須只是「一個簡短的品項」（例如「晚餐」「唱歌」）；還有別人的名字、群組、幣別、「某某先付」之類的說明 → 交給 AI 一起拆，不要在這裡硬湊
  if (!desc || desc.indexOf(' ') >= 0 || desc.length > 12 || /(先付|代墊|幫付|付了|付錢|出錢|買單|請客|結帳|刷卡|現金|日圓|日幣|美金|韓元|歐元|人民幣)/.test(desc)) return [];
  return [{ kind: 'split', desc, amount, splitAll: all ? true : null, payer: meFirst ? '我' : null }];
}
// 集點卡：「小明 刷牙」—— 訊息裡只有「一位孩子的名字＋一個行為的名字」、沒有其他字，才直接比對；有指定點數等其他內容就交給 AI
function localParseSticker(text, lists) {
  const t = String(text || '').trim();
  const kids = ((lists && lists.kids) || []).map((k) => (k && k.name ? String(k.name) : '')).filter(Boolean);
  const behs = ((lists && lists.behaviors) || []).filter((b) => b && b.name);
  if (!t || t.length > 30 || !kids.length || !behs.length) return [];
  const kidHit = kids.filter((k) => t.indexOf(k) >= 0);
  const behHit = behs.filter((b) => t.indexOf(b.name) >= 0);
  if (kidHit.length !== 1 || behHit.length !== 1) return [];
  const rest = t.split(kidHit[0]).join(' ').split(behHit[0].name).join(' ').replace(/[\s，,。.!！、:：+＋加點集點記錄]+/g, '');
  if (rest) return [];
  return [{ kind: 'sticker', card: 'kid', kid: kidHit[0], behavior: behHit[0].name }];
}
// 待去清單：「想去 九份老街」「新增待去地點 台南林百貨」—— 認得開頭的固定說法，後面整串當成項目名稱（使用者在資料卡片上還能改）
function localParseWish(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(?:新增待去(?:地點)?|加入待去(?:清單)?|想要去|想去|待去|想逛)\s*[：:，,、]?\s*(\S.{0,59})$/);
  return m ? [{ kind: 'wish', name: m[1].trim() }] : [];
}

// 使用者自己的清單：分帳群組（與成員）、集點卡的孩子與行為、待去清單的分類 —— 從「同步資料」讀出來，解析時用來比對名稱，也交給這個使用者自己的 AI 請求當選項
function draftListsFromBlob(rawBlob) {
  const out = { groups: [], kids: [], behaviors: [], wishCats: [] };
  let data = null;
  try { data = (JSON.parse(rawBlob) || {}).data || null; } catch (e) { data = null; }
  if (!data || typeof data !== 'object') return out;
  const arr = (k) => { try { const v = data[k] ? JSON.parse(data[k]) : []; return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  out.groups = arr('split_groups').filter((g) => g && g.name).slice(0, 20).map((g) => ({
    name: String(g.name).slice(0, 30), currency: g.currency ? String(g.currency).slice(0, 8) : '',
    members: (Array.isArray(g.members) ? g.members : []).filter((m) => m && m.name).slice(0, 30).map((m) => String(m.name).slice(0, 20)),
  }));
  out.kids = arr('sticker_kids').filter((k) => k && k.name).slice(0, 20).map((k) => ({ id: k.id, name: String(k.name).slice(0, 20) }));
  out.behaviors = arr('sticker_behaviors').filter((b) => b && b.name).slice(0, 60).map((b) => ({ id: b.id, name: String(b.name).slice(0, 20), points: Number(b.points) || 0 }));
  try {
    const w = data.wishlist_data_v2 ? JSON.parse(data.wishlist_data_v2) : null;
    if (w && Array.isArray(w.categories)) out.wishCats = w.categories.filter((c) => c && c.name).slice(0, 40).map((c) => String(c.name).slice(0, 20));
  } catch (e) {}
  // V10.4：待去清單「提議者」「來源」「狀態」的選項（頁面管理設定 + 已有項目用過的），四種版本的問答拿來當按鈕
  out.wishOpts = { proposer: [], source: [], status: ['待去', '已安排', '暫不去', '取消'] };
  const addOpt = (k, v) => { const n = typeof v === 'string' ? v.trim().slice(0, 20) : ''; if (n && n !== '已完成' && out.wishOpts[k].indexOf(n) < 0 && out.wishOpts[k].length < 30) out.wishOpts[k].push(n); };
  try {
    const mg = data.wishlist_mgmt_v2 ? JSON.parse(data.wishlist_mgmt_v2) : null;
    const o = (mg && mg.opts) || {};
    ['proposer', 'source', 'status'].forEach((k) => { (Array.isArray(o[k]) ? o[k] : []).forEach((x) => { if (x && x.name && x.on !== false) addOpt(k, String(x.name)); }); });
  } catch (e) {}
  try {
    const w2 = data.wishlist_data_v2 ? JSON.parse(data.wishlist_data_v2) : null;
    (w2 && Array.isArray(w2.wishItems) ? w2.wishItems : []).slice(0, 500).forEach((it) => { if (it) { addOpt('proposer', it.proposer); addOpt('source', it.source); } });
  } catch (e) {}
  return out;
}
// 這則訊息「可能」是哪幾種 V10.1 的紀錄？只用來決定要不要讀使用者的清單、要不要把該種類的說明交給 AI（省額度、降低誤判）；最後仍由程式逐欄檢查
//   集點卡、待去清單是個人資料（孩子姓名、個人清單），只在 1 對 1 聊天室做自由文字解析；分帳群組裡也可以
function draftMaybe(text, hint, direct) {
  const t = String(text || '');
  return {
    split: hint === 'split' || (!hint && SPLIT_TRIGGER_RE.test(t)),
    sticker: direct && (hint === 'sticker' || (!hint && (STICKER_TRIGGER_RE.test(t) || (t.length <= 30 && !/[0-9０-９]/.test(t))))),
    wish: direct && (hint === 'wish' || (!hint && WISH_TRIGGER_RE.test(t))),
  };
}
// 讀清單之後，真正要交給 AI 的種類：分帳至少要有一個群組（hint 指定時例外：使用者明確要記分帳）、集點卡要有孩子（或明講互助）
function draftWants(text, hint, lists, maybe) {
  const t = String(text || '');
  const L = lists || {};
  const stickerNameHit = (L.kids || []).some((k) => k && k.name && t.indexOf(k.name) >= 0) && (L.behaviors || []).some((b) => b && b.name && t.indexOf(b.name) >= 0);
  return {
    split: !!maybe.split && (hint === 'split' || (L.groups || []).length > 0),
    sticker: !!maybe.sticker && (hint === 'sticker' || ((L.kids || []).length > 0 && (STICKER_TRIGGER_RE.test(t) || stickerNameHit)) || /互助/.test(t)),
    wish: !!maybe.wish,
  };
}

// 一個品項的擷取格式（文字與照片辨識共用；欄位名稱沿用網頁「貼上解析」的命名）
const DRAFT_ITEM_SCHEMA_TEXT = {
  drink: '飲料：{"kind":"drink","brand":品牌或null,"drinkName":飲品名稱或null,"category":"純茶/奶茶/鮮奶茶/水果茶/芝士奶蓋/冰沙/咖啡/氣泡飲（訊息明確才填）或null","size":杯型或null,"sugar":甜度原文或null,"ice":冰塊原文或null,"toppings":加料或null,"amount":數字或null,"currency":幣別或null,"payment":付款方式或null,"area":地點或null,"drinker":"誰喝的（訊息裡的稱呼，例如我、小明）或null","note":備註或null,"date":"YYYY-MM-DD或null","time":"HH:MM或null","uncertain":[]}\n',
  food: '美食：{"kind":"food","brand":店家或null,"dish":餐點名稱或null,"area":地點或null,"mealCategory":"早餐/午餐/晚餐/宵夜/點心（訊息明確才填）或null","cuisine":菜系或null,"portion":份量或null,"spicy":辣度或null,"diningType":"內用/外帶/外送或null","amount":數字或null,"currency":幣別或null,"payment":付款方式或null,"eater":"誰吃的或null","note":備註或null,"date":"YYYY-MM-DD或null","time":"HH:MM或null","uncertain":[]}\n',
  travel: '交通：{"kind":"travel","type":"flight/ship/hsr/train/metro/taxi（無法判斷就 null）","company":公司或null,"no":航班車次班次或null,"depPort":出發地或null,"arrPort":到達地或null,"transitPort":經停或null,"depTime":"HH:MM或null","arrTime":"HH:MM或null","seat":座位或null,"vehicleType":車種機型或null,"ticketPrice":數字或null,"payment":付款方式或null,"note":備註或null,"date":"YYYY-MM-DD或null","uncertain":[]}\n',
  // V10.4：分帳、集點卡、待去清單的照片辨識（照片上看不到的欄位，例如分帳群組、誰先付錢、分給誰，一律不填）
  split: '分帳：{"kind":"split","desc":品項或null,"amount":總金額數字或null,"currency":幣別或null,"entry":"expense或income（照片明確是收款、退款才填 income）或null","cat":"food/drink/transport/flight/ship/hotel/shopping/ticket/gift/grocery/fun/other（品項明確屬於該類才填）或null","payment":付款方式或null,"note":備註或null,"date":"YYYY-MM-DD或null","time":"HH:MM或null","uncertain":[]}\n',
  sticker: '集點卡：{"kind":"sticker","card":"kid或mutual（照片明確寫出才填）或null","kid":孩子的名字或null,"behavior":行為或null,"points":數字（加點為正、扣點為負；沒寫就 null）,"note":原因或null,"date":"YYYY-MM-DD或null","time":"HH:MM或null","uncertain":[]}\n',
  wish: '待去清單：{"kind":"wish","name":地點或店家名稱或null,"country":國家或null,"city":城市或null,"detailPlace":地址或商家或null,"reason":推薦原因（貼文或截圖上明確寫出才填）或null,"notes":備註或null,"source":"資訊來源平台（照片或截圖上看得到，例如 Instagram、Threads、Google 地圖）或null","targetTime":"預計去的時間（明確寫出才填）或null","uncertain":[]}\n',
};
// ---------- 用 Gemini 嚴格擷取（寧可缺，不可假；一個品項一個物件）----------
// 回傳 { items: [raw…] }（items 可能是空陣列＝這則訊息不是消費／行程紀錄）；AI 不能用或回傳壞掉 → null
//   opts.want＝{ split, sticker, wish }：這次要不要多認分帳／集點卡／待去清單（沒要的種類，提示裡完全不出現，行為和 V10 一樣）；opts.lists＝使用者自己的清單
async function parseDraftItems(text, env, hintKind, nowMs, opts) {
  opts = opts || {};
  const apiKey = env.SmartDailyAssistant_GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const tp = tpParts(nowMs);
  const dow = ['日', '一', '二', '三', '四', '五', '六'][tp.dow];
  const want = opts.want || {};
  const lists = opts.lists || {};
  const extraKinds = [want.split ? '分帳' : '', want.sticker ? '集點卡' : '', want.wish ? '待去清單' : ''].filter(Boolean);
  const rule4 = extraKinds.length
    ? '4. 訊息如果不是「已經發生的消費或行程紀錄」，也不是下面的「' + extraKinds.join('／') + '」格式（閒聊、提問、' + (want.wish ? '其他計畫' : '計畫、願望') + '、收入／薪水／轉帳這類一般記帳' + (want.split ? '' : '，或 AA、分帳、代墊、幫付、每人多少這類分攤金錢的訊息') + '），回傳 {"items":[]}。\n'
    : '4. 訊息如果不是「已經發生的消費或行程紀錄」（閒聊、提問、計畫、願望、收入／薪水／轉帳這類一般記帳，或 AA、分帳、代墊、幫付、每人多少這類分攤金錢的訊息），回傳 {"items":[]}。\n';
  let extra = '';
  if (want.split) {
    extra += '分帳（AA、均分、代墊、幫付這類「錢要怎麼分」的訊息）：{"kind":"split","group":"分帳群組名稱（只能從下面的群組清單挑；訊息沒講或對不上就 null）","desc":品項或null,"amount":總金額數字或null,"currency":幣別或null,"entry":"expense或income（訊息明確是收款、收入才填 income）或null","cat":"food/drink/transport/flight/ship/hotel/shopping/ticket/gift/grocery/fun/other（品項明確屬於該類才填，例如計程車→transport、飯店→hotel；不確定就 null）","payer":"誰先付錢（用訊息裡的稱呼；說「我」就填「我」）或null","participants":["分攤的人（訊息裡的稱呼）"]或null,"splitAll":true或null,"customShares":{"名字":金額}或null,"payment":付款方式或null,"note":備註或null,"date":"YYYY-MM-DD或null","time":"HH:MM或null","uncertain":[]}\n' +
      '分帳規則：AA、均分、平分、分攤＝所有成員平均分攤（splitAll 填 true，participants 填 null）；只有特定幾位分攤才填 participants（代墊給某人＝只有那個人分攤）；每個人金額不同才填 customShares；沒講誰先付錢，payer 填 null，不要猜。\n' +
      '分帳群組與成員（group、payer、participants 只能用這裡的名稱）：\n' + ((lists.groups || []).length ? (lists.groups || []).map((g) => '・' + g.name + '：' + (g.members || []).join('、')).join('\n') : '（目前沒有任何分帳群組）') + '\n';
  }
  if (want.sticker) {
    extra += '集點卡：{"kind":"sticker","card":"kid（孩子的乖寶寶集點卡）或mutual（兩個人互相加扣點的互助集點卡，訊息有「互助」才用）","kid":孩子的名字或null,"behavior":行為名稱或null,"points":數字（加點為正、扣點為負；沒講點數就 null）,"note":原因或null,"date":"YYYY-MM-DD或null","time":"HH:MM或null","uncertain":[]}\n' +
      '集點卡規則：孩子與行為只能用下面清單裡的名稱，對不上就照訊息原文填；沒講點數 points 填 null（程式會用行為在 App 裡設定的點數），不要自己推算。\n' +
      '孩子：' + ((lists.kids || []).length ? (lists.kids || []).map((k) => k.name).join('、') : '（沒有）') + '\n' +
      '行為（名稱 點數）：' + ((lists.behaviors || []).length ? (lists.behaviors || []).map((b) => b.name + ' ' + (b.points > 0 ? '+' : '') + b.points).join('、') : '（沒有）') + '\n';
  }
  if (want.wish) {
    extra += '待去清單（還沒去、想去的地點，不是已經發生的消費）：{"kind":"wish","name":地點或店家名稱或null,"category":"分類（只能從下面的分類清單挑；沒講或對不上就 null）","country":國家或null,"city":城市或null,"detailPlace":地址或商家或null,"reason":想去的原因或null,"notes":備註或null,"source":"資訊來源（IG、Threads、朋友推薦…，訊息明確才填）或null","proposer":"誰提議的（訊息明確寫出才填）或null","targetTime":"預計去的時間，照訊息原文（例如 週末、11月、明年春天）或null","uncertain":[]}\n' +
      '待去清單規則：已經去過、已經買了吃了喝了的是消費紀錄，不是待去地點；一則訊息只有一個地點就一個物件。\n' +
      '分類：' + ((lists.wishCats || []).length ? lists.wishCats.join('、') : WISH_DEFAULT_CATS.join('、')) + '\n';
  }
  const prompt =
    '你是嚴格的生活紀錄擷取系統。核心原則：寧可缺，不可假。\n' +
    '現在是台灣時間 ' + tp.date + '（星期' + dow + '）' + tp.time + '。\n' +
    '任務：把使用者在 LINE 傳的「一則訊息」擷取成表單草稿。只回傳一個 JSON，不要 markdown，不要其他文字。\n\n' +
    '規則（非常重要）：\n' +
    '1. 只能填訊息裡「實際出現」的內容；沒出現的欄位一律填 null。禁止推測、補齊、填預設值（沒講甜度就不要填甜度，沒講品牌就不要填品牌）。\n' +
    '2. 一則訊息可能有多個品項：每杯飲料、每道餐點、每趟交通各自一個物件，不可合併，也不可混用不同品項的資料。數量大於 1（例如「兩杯珍奶」）就輸出對應數量的物件。\n' +
    '3. 如果只講了多杯／多份的「合計金額」，每個物件的 amount 填 null，並在 note 寫「合計XX元」。\n' +
    rule4 +
    '5. date 與 time 只在訊息明確提到時才填（可用上面的現在時間換算「今天、昨天、前天、週五、下午3點」），格式 YYYY-MM-DD 與 24 小時制 HH:MM。沒提到就填 null，絕對不要拿現在時間代替。\n' +
    '6. uncertain 是陣列：列出「你有填值、但訊息講得很含糊」的欄位名稱（例如「大概50」、「好像是少冰」）。完全沒把握就填 null，不要放進 uncertain。\n' +
    '7. 金額只填數字；幣別只有訊息明確寫出才填（NT$、RMB¥、JPY¥、KRW₩ 擇一，其他幣別寫原文）。\n' +
    '8. area（地點）只填訊息裡出現的地名／商圈／行政區，不要自己補縣市。\n' +
    '9. sugar 與 ice 請照訊息原文各自填寫（例如「半糖」「少冰」），不要合併成一個欄位。\n\n' +
    '每個物件的格式（kind 只能是 drink / food / travel' + (want.split ? ' / split' : '') + (want.sticker ? ' / sticker' : '') + (want.wish ? ' / wish' : '') + '）：\n' +
    DRAFT_ITEM_SCHEMA_TEXT.drink + DRAFT_ITEM_SCHEMA_TEXT.food + DRAFT_ITEM_SCHEMA_TEXT.travel +
    extra +
    '回傳格式：{"items":[…]}\n' +
    (hintKind ? '使用者已經指定這則訊息是「' + ({ drink: '飲料', food: '美食', travel: '交通', split: '分帳', sticker: '集點卡', wish: '待去清單' }[hintKind] || hintKind) + '」紀錄，所有 items 的 kind 都必須是 "' + hintKind + '"。\n' : '') +
    '使用者訊息：<<<' + String(text).slice(0, 1500) + '>>>';
  const geminiBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent';
  let up;
  try {
    up = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(geminiBody) });
  } catch (e) { return null; }
  const gdata = await up.json().catch(() => null);
  if (!up.ok || !gdata) return null;
  let out = '';
  const cand = gdata.candidates && gdata.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) out = cand.content.parts.map((p) => (p && p.text) ? p.text : '').join('');
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (e) { return null; }
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const allowed = { drink: 1, food: 1, travel: 1 }; // 沒要求的種類，就算 AI 自己回傳了也不收
  if (want.split) allowed.split = 1;
  if (want.sticker) allowed.sticker = 1;
  if (want.wish) allowed.wish = 1;
  const items = parsed.items.filter((it) => it && typeof it === 'object' && allowed[String(it.kind || '').toLowerCase()]).slice(0, DRAFT_MAX_ITEMS);
  items.forEach((it) => { it.kind = String(it.kind).toLowerCase(); });
  return { items };
}

// V8 流程（簡易版／標準版／旗艦版、一句話記帳）組好的紀錄 → 草稿的原始物件（欄位沿用網頁的命名）
function rawFromLegacyRecord(record) {
  const cat = record.category;
  const amount = Number(record.amount) > 0 ? Number(record.amount) : null; // V8 把「沒提到金額」存成 0，這裡不當成真的 0 元
  const rating = Number(record.rating) > 0 ? Number(record.rating) : null;
  const note = record.note ? String(record.note) : null;
  if (cat === 'drink') {
    return { kind: 'drink', brand: record.brand, drinkName: record.drink || record.item, size: record.size, sugar: record.sugar, ice: record.ice, toppings: record.topping, amount, payment: record.payment, rating, note };
  }
  if (cat === 'food') {
    const dt = String(record.diningType || '');
    const isMealTime = ['早餐', '午餐', '晚餐', '宵夜', '點心', '下午茶'].indexOf(dt) >= 0; // V8 的 diningType 其實是「用餐類別」，網頁的「用餐方式」是內用／外帶／外送
    return { kind: 'food', brand: record.brand, dish: record.item, mealCategory: isMealTime ? dt : null, diningType: isMealTime ? null : dt, cuisine: record.cuisine, portion: record.portion, amount, payment: record.payment, rating, note };
  }
  if (cat === 'travel') {
    const item = record.item ? String(record.item) : '';
    const itemUseful = item && !(record.depPort || record.arrPort) && !/^(計程車|打車|高鐵|火車|台鐵|捷運|地鐵|飛機|航班|船班|船|渡輪|uber)$/i.test(item.trim());
    return { kind: 'travel', type: record.transportType, depPort: record.depPort, arrPort: record.arrPort, ticketPrice: amount, payment: record.payment, note: [note, itemUseful ? item : ''].filter(Boolean).join(' · ') || null };
  }
  return null;
}

let _draftSeq = 0;
function newDraftId() { _draftSeq = (_draftSeq + 1) % 1296; return 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + _draftSeq.toString(36); }

// 把整理好的品項組成草稿物件（createdAt 在寫入時才填入）
function buildDrafts(items, meta) {
  return items.map((it, i) => ({
    id: newDraftId(),
    lineKey: (meta.msgId || meta.fallbackKey) + '#' + i,
    kind: it.kind, v: 1, status: 'pending',
    owner: meta.owner, lineUserId: meta.userId, userName: meta.userName, groupName: meta.groupName || '',
    rawText: String(meta.text || '').slice(0, 500),
    msgTs: meta.ts, itemIndex: i, itemCount: items.length,
    fields: it.fields, uncertain: it.uncertain, notes: it.notes, unmapped: it.unmapped || {}, via: meta.via, createdAt: 0,
  }));
}

// 把草稿寫進使用者「同步碼」底下的網頁資料（line_drafts）。回傳 { status, drafts }：
//   'ok' 已寫入（或同一則訊息的草稿早就在了）｜'unbound' 沒綁同步碼｜'nodata' 同步碼底下還沒有網頁資料｜'fail' 失敗
// 同一則 LINE 訊息（lineKey）只會建立一次；寫完會再讀回來確認，萬一被同時進來的寫入蓋掉就重做一次。
async function addDraftsToApp(userId, drafts, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return { status: 'fail', drafts: [] };
  let code;
  try { code = await kv.get('line:usersync:' + userId); } catch (e) { return { status: 'fail', drafts: [] }; }
  if (!code) return { status: 'unbound', drafts: [] };
  const keys = drafts.map((d) => d.lineKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await kv.get(keyOf(code));
      if (!raw) return { status: 'nodata', drafts: [] };
      const rec = JSON.parse(raw);
      const data = rec.data || {};
      let arr;
      try { arr = data[DRAFT_LS_KEY] ? JSON.parse(data[DRAFT_LS_KEY]) : []; } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      const have = new Map(arr.filter(Boolean).map((d) => [d.lineKey, d]));
      const fresh = drafts.filter((d) => !have.has(d.lineKey));
      if (!fresh.length) return { status: 'ok', drafts: keys.map((k) => have.get(k)).filter(Boolean) };
      const ver = nextVersion(rec.updated_at);
      fresh.forEach((d) => { d.createdAt = ver; }); // createdAt = 這次寫入的版本號：網頁「上次同步的版本」比它舊，就表示網頁還沒看過這張草稿
      const now = Date.now();
      let merged = fresh.concat(arr.filter(Boolean)).filter((d) => d.status === 'pending' || (now - Number(d.savedAt || d.discardedAt || d.createdAt || 0)) < DRAFT_KEEP_MS);
      if (merged.length > DRAFT_KEEP_MAX) merged = merged.filter((d) => d.status === 'pending').concat(merged.filter((d) => d.status !== 'pending')).slice(0, DRAFT_KEEP_MAX);
      data[DRAFT_LS_KEY] = JSON.stringify(merged);
      await kv.put(keyOf(code), JSON.stringify({ data, updated_at: ver }));
      const back = JSON.parse((await kv.get(keyOf(code))) || 'null');
      const backArr = back && back.data && back.data[DRAFT_LS_KEY] ? JSON.parse(back.data[DRAFT_LS_KEY]) : [];
      const backMap = new Map(backArr.filter(Boolean).map((d) => [d.lineKey, d]));
      if (keys.every((k) => backMap.has(k))) return { status: 'ok', drafts: keys.map((k) => backMap.get(k)) };
    } catch (e) { /* 再試一次 */ }
  }
  return { status: 'fail', drafts: [] };
}
// 讀出某個 LINE 使用者的草稿（給「待確認草稿」指令與查詢用）
async function loadDraftsFor(userId, env) {
  const out = { bound: false, drafts: [] };
  const kv = env.SYNC_KV;
  if (!kv || !userId) return out;
  try {
    const code = await kv.get('line:usersync:' + userId);
    if (!code) return out;
    out.bound = true;
    const rec = JSON.parse((await kv.get(keyOf(code))) || 'null');
    const arr = rec && rec.data && rec.data[DRAFT_LS_KEY] ? JSON.parse(rec.data[DRAFT_LS_KEY]) : [];
    out.drafts = (Array.isArray(arr) ? arr : []).filter((d) => d && d.lineUserId === userId);
  } catch (e) {}
  return out;
}

// ---------- LINE 端顯示（草稿摘要）----------
function draftBrief(d) {
  const f = d.fields || {};
  const unc = d.uncertain || [];
  const mark = (k, txt) => (txt ? txt + (unc.indexOf(k) >= 0 ? '⚠' : '') : '');
  const parts = [];
  if (d.kind === 'drink') {
    parts.push(mark('brand', f.brand), mark('drink', f.drink));
    parts.push(mark('size', f.size), mark('sugar', f.sugar !== undefined ? (SUGAR_LABEL[f.sugar] || f.sugar) : ''), mark('ice', f.ice !== undefined ? (ICE_LABEL[f.ice] || f.ice) : ''), mark('topping', f.topping && f.topping !== '無' ? '加' + f.topping : ''));
    parts.push(mark('amount', f.amount !== undefined ? '$' + f.amount : ''));
  } else if (d.kind === 'food') {
    parts.push(mark('brand', f.brand), mark('dish', f.dish), mark('category', f.category), mark('amount', f.amount !== undefined ? '$' + f.amount : ''));
  } else if (d.kind === 'split') {
    const how = f.participants && f.participants.length ? '分給' + f.participants.join('、') : (f.splitAll ? '均分' : '');
    parts.push(mark('group', f.group ? '【' + f.group + '】' : ''), mark('desc', f.desc), mark('amount', f.amount !== undefined ? '$' + f.amount : ''), mark('payer', f.payer ? f.payer + '先付' : ''), mark('participants', how));
  } else if (d.kind === 'sticker') {
    const pt = f.points !== undefined ? (f.points > 0 ? '+' : '') + f.points + '點' : '';
    if (f.card === 'mutual') parts.push('互助', mark('points', pt), mark('note', f.note));
    else parts.push(mark('kid', f.kid), mark('behavior', f.behavior), mark('points', pt));
  } else if (d.kind === 'wish') {
    parts.push(mark('name', f.name), mark('city', f.city), mark('category', f.category ? '〔' + f.category + '〕' : ''));
  } else {
    const route = f.depPort ? mark('depPort', f.depPort) + (f.arrPort ? '→' + mark('arrPort', f.arrPort) : '') : (f.arrPort ? '→' + mark('arrPort', f.arrPort) : '');
    parts.push(f.type ? (TRAVEL_TYPE_LABELS[f.type] || f.type) : '', route, mark('no', f.no), mark('ticketPrice', f.ticketPrice !== undefined ? '$' + f.ticketPrice : ''));
  }
  const line = parts.filter(Boolean).join(' ');
  return line || '（只辨識到部分欄位）';
}
function draftUncertainText(d) {
  const unc = (d.uncertain || []).map((k) => draftLabel(d.kind, k));
  return unc.length ? '待確認：' + unc.join('、') : '';
}
function draftAppUrl(origin, msgId) {
  return (origin || DEFAULT_APP_URL) + '/?open=drafts' + (msgId ? '&d=' + encodeURIComponent(msgId) : '') + '&openExternalBrowser=1';
}
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
// 建立草稿後的回覆：Flex 卡片（附「開啟網頁確認」按鈕）；LINE 拒絕卡片時用純文字備援
function buildDraftsReply(drafts, url, opts) {
  opts = opts || {};
  const title = opts.title || ('📝 已建立 ' + drafts.length + ' 張待確認草稿');
  const sub = opts.sub || '還沒有正式儲存 — 請到網頁核對資料卡片，按【確認新增】後才會建立紀錄並產生流水號；按【取消】則不會留下任何紀錄。';
  const rows = drafts.map((d, i) => {
    const numPrefix = drafts.length > 1 ? CIRCLED[i] + ' ' : ''; // ①②③ 這種圈號不是 emoji，不會被圖示比對命中，特別留著跟 kindLabel 分開放
    const kindLabel = DRAFT_KIND_LABEL[d.kind] || '';
    return { head: numPrefix + kindLabel, numPrefix, kindLabel, brief: draftBrief(d), unc: draftUncertainText(d) };
  });
  const body = [
    iconRow({ type: 'text', text: title, weight: 'bold', size: 'lg', color: '#5c4b37', wrap: true }),
    { type: 'text', text: sub, size: 'xs', color: '#8b8b8b', wrap: true, margin: 'sm' },
  ];
  rows.forEach((r) => {
    // kindLabel（例如「🧋 飲料」）單獨拆 emoji，不含前面的圈號——避免「①🧋」被誤判成抓不到開頭 emoji。
    const { icon, rest } = splitIcon(r.kindLabel);
    let box;
    if (icon) {
      const contents = [];
      if (r.numPrefix) contents.push({ type: 'text', text: r.numPrefix.trim(), size: 'sm', weight: 'bold', color: '#3f3f3f', flex: 0 });
      contents.push({ type: 'image', url: icon, flex: 0, size: 'xs', aspectRatio: '1:1', gravity: 'center' });
      contents.push({ type: 'text', text: rest + '　' + r.brief, size: 'sm', weight: 'bold', wrap: true, color: '#3f3f3f', flex: 1 });
      box = [{ type: 'box', layout: 'horizontal', spacing: 'xs', alignItems: 'center', contents }];
    } else {
      box = [{ type: 'text', text: r.head + '　' + r.brief, size: 'sm', weight: 'bold', wrap: true, color: '#3f3f3f' }];
    }
    if (r.unc) box.push(iconRow({ type: 'text', text: '⚠ ' + r.unc, size: 'xs', color: '#b45309', wrap: true, margin: 'xs' }));
    body.push({ type: 'box', layout: 'vertical', margin: 'md', contents: box });
  });
  const message = {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        iconButton('📝 開啟網頁確認', null, 'primary', { action: { type: 'uri', uri: url }, color: '#9a7d52' }),
        iconButton('📋 待確認草稿', '待確認草稿', 'secondary'),
      ] },
    },
  };
  const fallback = title + '\n' + rows.map((r) => r.head + ' ' + r.brief + (r.unc ? '\n　⚠ ' + r.unc : '')).join('\n') + '\n\n' + sub + '\n👉 ' + url;
  return { message, fallback };
}

// 這個使用者目前能不能用「草稿模式」？回傳 { cfg, code } 或 null（維持 V8 的 LINE 端確認流程）
//   條件：管理員沒有關閉草稿模式、使用者已綁定同步碼、而且這組同步碼底下已經有網頁資料（沒有地方可以放草稿的人，維持原本流程）
async function draftEligibility(userId, env, cfgIn) {
  try {
    if (!userId || !env.SYNC_KV) return null;
    const cfg = cfgIn || await loadLineConfig(env);
    if (cfg.draft && cfg.draft.enabled === false) return null;
    const code = await env.SYNC_KV.get('line:usersync:' + userId);
    if (!code) return null;
    const blob = await env.SYNC_KV.get(keyOf(code));
    if (!blob) return null;
    return { cfg, code, blob }; // blob＝同步資料的原始文字（V10.1：分帳群組、孩子與行為、待去分類要用；需要時才解析，不額外多讀一次）
  } catch (e) { return null; }
}
// 取得傳訊者的 LINE 顯示名稱與群組名稱（失敗就留空，不影響主流程）
async function lineWho(token, ctx) {
  let userName = '';
  let groupName = '';
  try { userName = (ctx.isGroup ? await lineGroupMemberProfile(token, ctx.groupId, ctx.userId) : await lineProfile(token, ctx.userId)) || ''; } catch (e) {}
  if (ctx.isGroup) { try { groupName = (await lineGroupSummary(token, ctx.groupId)) || ''; } catch (e) {} }
  return { userName, groupName };
}

// 核心：把解析好的品項 → 草稿 → 寫進網頁資料 → 回覆。回傳：
//   'created' 草稿已建立並已回覆｜'blocked' 這個聊天室不能使用該功能（已回覆原因）｜'failed' 寫入失敗（已回覆）
//   'empty' 沒有辨識到任何品項（沒有回覆）｜'skip' 沒綁同步碼或同步碼底下沒有網頁資料（沒有回覆，請走 V8 原本的流程）
//   V10.1：args.lists＝使用者自己的清單（分帳群組、孩子與行為、待去分類）；args.quiet＝使用者剛剛在 LINE 選單裡「現在」按出來的（時間直接帶入、不標待確認）
async function createDraftsAndReply(args) {
  const { ev, token, env, ctx, userName, groupName, text, rawItems, via, replyToken, cfg } = args;
  const sender = toAppUserName(userName);
  const ts = Number(args.ts) > 0 ? Number(args.ts) : Date.now();
  const kept = [];
  const blocked = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const kind = String((raw && raw.kind) || '').toLowerCase();
    if (!DRAFT_KIND_BY_CAT[kind]) continue;
    const av = checkAvailability(DRAFT_KIND_FN[kind], ctx, cfg);
    if (!av.ok) { if (blocked.indexOf(av.message) < 0) blocked.push(av.message); continue; }
    const norm = normalizeDraftItem(kind, raw, { sender, userName, lists: args.lists, trustRecorder: !!args.trustRecorder });
    if (!norm) continue;
    const item = { kind, fields: norm.fields, uncertain: norm.uncertain, notes: norm.notes, unmapped: norm.unmapped };
    applyMessageTimeFallback(kind, item, ts, { quiet: !!args.quiet });
    kept.push(item);
  }
  if (!kept.length) {
    if (blocked.length) { await lineReply(token, replyToken, blocked[0]); return 'blocked'; }
    return 'empty';
  }
  const msgId = (ev && ev.message && ev.message.id) || '';
  const meta = { msgId, fallbackKey: 'T' + ts, owner: sender, userId: ctx.userId, userName, groupName, text, ts, via };
  const drafts = buildDrafts(kept, meta);
  const res = await addDraftsToApp(ctx.userId, drafts, env);
  if (res.status === 'unbound' || res.status === 'nodata') return 'skip';
  if (res.status !== 'ok' || !res.drafts.length) {
    const retryHint = args.failQuick ? '請按「' + (args.retryWord || '✅ 確認儲存') + '」再試一次 🙏' : '請稍後再傳一次 🙏';
    await lineReplyMessages(token, replyToken, [{ type: 'text', text: '⚠️ 草稿暫時建立失敗，這筆還沒有儲存。' + retryHint, quickReply: quickReplyItems(args.failQuick || ['功能選單']) }]).catch(() => {});
    return 'failed';
  }
  const built = buildDraftsReply(res.drafts, draftAppUrl(ev && ev.appOrigin, msgId), args.replyOpts);
  const msgs = [built.message];
  const extra = blocked.length ? '另外有一部分沒有建立：' + blocked[0] : '';
  if (extra) msgs.push({ type: 'text', text: extra });
  if (args.quick && msgs.length) msgs[msgs.length - 1].quickReply = quickReplyItems(args.quick); // V10.3：附上「再記一筆」等快速按鈕
  await lineReplyCards(token, replyToken, msgs, built.fallback + (extra ? '\n\n' + extra : ''));
  return 'created';
}

// 入口一：V8 的問答流程（簡易版／標準版／旗艦版、快速記錄）組好一筆紀錄後 —— 取代原本的 LINE 端「確認儲存」
//   回傳 'done'（已處理，不要再走 V8 的確認）或 'skip'（請走 V8 原本的流程）
async function tryDraftFromRecord(userId, record, replyToken, token, env, ev, session) {
  const kind = DRAFT_KIND_BY_CAT[record && record.category];
  if (!kind) return 'skip';
  const raw = rawFromLegacyRecord(record); // V10.1：分帳等其他種類沒有舊流程的對應內容（回傳 null）→ 先判斷，不用多讀一次同步資料
  if (!raw) return 'skip';
  const elig = await draftEligibility(userId, env);
  if (!elig) return 'skip';
  const ev2 = Object.assign({}, ev || {}, { message: { id: record.msgId || (ev && ev.message && ev.message.id) || '' } });
  const ctx = { isGroup: !!record.groupId, chat: record.groupId ? 'group' : 'direct', groupId: record.groupId || '', userId };
  const st = await createDraftsAndReply({ ev: ev2, token, env, ctx, userName: record.userName || '', groupName: record.groupName || '', text: record.item || '', rawItems: [raw], via: 'flow', replyToken, cfg: elig.cfg, ts: record.ts, failQuick: ['✅ 確認儲存', '❌ 放棄'] });
  if (st === 'created' || st === 'blocked') { await clearFlagshipSession(userId, env); return 'done'; }
  if (st === 'failed') { // 寫入失敗：保留這筆內容，讓使用者按「✅ 確認儲存」重試（不用重新回答所有問題）
    const s = session || {};
    s.stage = 'confirm'; s.pending = record; s.draftRetry = true;
    await setFlagshipSession(userId, s, env);
    return 'done';
  }
  return 'skip';
}
// 入口二：一句話（沒有進到問答流程）或「快速記錄」的內容。先試「品牌：… 飲品：…」欄位格式（不用 AI），否則用 Gemini 嚴格擷取（可多品項）
//   opts.forceKind：使用者已經選好是哪一種紀錄（例如從選單點了「美食紀錄」）；opts.forceType：已經選好的交通類型
//   回傳 'created'／'blocked'／'failed'（都代表已經回覆使用者了）或 'skip'（不是飲料／美食／交通紀錄、AI 不能用、或不能用草稿模式 → 請走 V8 原本的流程）
async function tryDraftFromText(ev, token, env, ctx, userName, groupName, text, elig, opts) {
  opts = opts || {};
  const hint = opts.forceKind || '';
  // V10.1：看這則訊息「可能」是分帳／集點卡／待去清單 —— 是的話才讀使用者的清單（群組與成員、孩子與行為、待去分類）；一般的飲料／美食／交通訊息完全不多做事
  const direct = !ctx.isGroup;
  const blobText = (elig && elig.blob) || '';
  const maybe = draftMaybe(text, hint, direct);
  if (maybe.sticker && !hint && blobText.indexOf('sticker_kids') < 0) maybe.sticker = false; // 沒有任何孩子的集點卡資料，就不用讀了
  if (maybe.split && !hint && blobText.indexOf('split_groups') < 0) maybe.split = false;
  let lists = null;
  if (maybe.split || maybe.sticker || maybe.wish) lists = draftListsFromBlob(blobText);
  const want = lists ? draftWants(text, hint, lists, maybe) : { split: false, sticker: false, wish: false };
  let rawItems = localParseDraftItems(text, hint);
  let via = 'local';
  if (!rawItems.length && want.split && (!hint || hint === 'split')) rawItems = localParseSplit(text);
  if (!rawItems.length && want.sticker && (!hint || hint === 'sticker')) rawItems = localParseSticker(text, lists);
  if (!rawItems.length && want.wish && (!hint || hint === 'wish') && /^(新增待去|加入待去|想要去|想去|待去|想逛)\s*\S+$/.test(String(text || '').trim())) rawItems = localParseWish(text).filter((r) => String(r.name || '').indexOf(' ') < 0); // 「想去 九份老街」這種一個詞的說法不用問 AI；有空白（可能還帶城市、時間）交給 AI 拆
  if (!rawItems.length) {
    const ai = await parseDraftItems(text, env, hint, Date.now(), { want, lists: lists || {} });
    if (ai && ai.items.length) { rawItems = ai.items; via = 'ai'; }
    else if (want.wish && (!hint || hint === 'wish')) { rawItems = localParseWish(text); via = 'local'; } // AI 不能用／沒認出來：「想去 …」開頭的整串當成項目名稱（使用者在資料卡片上還能改）
    if (!rawItems.length && hint === 'wish' && want.wish && String(text || '').trim()) rawItems = [{ kind: 'wish', name: String(text).trim().slice(0, 60) }]; // 使用者已經明確選了「新增待去地點」：整句就是項目名稱
    if (!rawItems.length) return 'skip';
  }
  if (hint) rawItems.forEach((it) => { it.kind = hint; });
  if (opts.forceType) rawItems.forEach((it) => { if (it.kind === 'travel') it.type = opts.forceType; });
  const st = await createDraftsAndReply({ ev, token, env, ctx, userName, groupName, text, rawItems, via, replyToken: ev.replyToken, cfg: elig.cfg, ts: Number(ev.timestamp), lists: lists || undefined });
  return (st === 'created' || st === 'blocked' || st === 'failed') ? st : 'skip';
}

// ---------- LINE 指令：「待確認草稿」（also 待確認／草稿）：看目前有哪些草稿、已儲存的流水號 ----------
async function sendDraftsList(ctx, ev, token, env, perm) {
  const data = await loadDraftsFor(ctx.userId, env);
  let messages;
  let plain;
  if (!data.bound) {
    plain = '你還沒綁定同步碼，所以沒有網頁草稿。\n要綁定的話，傳「同步碼 你的同步碼」給我（App 的「雲端同步」裡看得到）。';
    messages = [{ type: 'text', text: plain, quickReply: quickReplyItems(['功能選單']) }];
  } else {
    const pending = data.drafts.filter((d) => d.status === 'pending').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const saved = data.drafts.filter((d) => d.status === 'saved').sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 5);
    const url = draftAppUrl(ev.appOrigin, '');
    if (!pending.length && !saved.length) {
      plain = '目前沒有待確認的草稿 👍\n在 LINE 傳「珍奶 60」這類飲料／美食／交通紀錄，我會建立草稿，讓你到網頁確認後再儲存。';
      messages = [{ type: 'text', text: plain, quickReply: quickReplyItems(['功能選單']) }];
    } else {
      const shown = pending.slice(0, 8);
      let built = null;
      if (shown.length) built = buildDraftsReply(shown, url, { title: '📋 待確認草稿 ' + pending.length + ' 張', sub: pending.length > shown.length ? '只列出最新的 ' + shown.length + ' 張，其餘請到網頁查看。' : '按「開啟網頁確認」逐張確認、儲存。' });
      const savedText = saved.length ? '✅ 最近已儲存：\n' + saved.map((d) => '・' + draftBrief(d) + (d.sn ? '　流水號 ' + d.sn + (d.snp ? ' / ' + d.snp : '') : '　（流水號未記錄）')).join('\n') : '';
      messages = [];
      if (built) messages.push(built.message);
      if (savedText) messages.push({ type: 'text', text: savedText, quickReply: quickReplyItems(['功能選單']) });
      plain = (built ? built.fallback : '目前沒有待確認的草稿。') + (savedText ? '\n\n' + savedText : '');
    }
  }
  if (!ctx.isGroup || perm.groupReply === 'public') { await lineReplyCards(token, ev.replyToken, messages, plain); return true; }
  const res = await linePush(token, ctx.userId, messages);
  if (res && res.ok) await lineReply(token, ev.replyToken, '📋 草稿清單已私訊給你 ✉️');
  else await lineReply(token, ev.replyToken, PRIVATE_FAIL_TEXT);
  return true;
}


// ---------- 「各紀錄類型適用範圍」（給管理頁面顯示；欄位清單由程式裡真正的定義產生，沒有確認的標示「待確認」）----------
const DRAFT_SCOPE_FIELDS = {
  drink: ['date', 'time', 'country', 'area', 'brand', 'drink', 'category', 'size', 'topping', 'sugar', 'ice', 'amount', 'currency', 'payment', 'drinker', 'payer', 'recorder', 'note', 'rating'],
  food: ['date', 'time', 'brand', 'dish', 'category', 'cuisine', 'portion', 'spicy', 'diningType', 'amount', 'currency', 'payment', 'eater', 'recorder', 'note', 'rating'],
  travel: ['type', 'date', 'company', 'no', 'depPort', 'arrPort', 'transitPort', 'depTime', 'arrTime', 'seat', 'vehicleType', 'ticketPrice', 'payment', 'recorder', 'note'],
  // V10.1：欄位全部沿用各自模組現有的表單（分帳＝新增支出、集點卡＝記一筆、待去清單＝新增項目），沒有另外造欄位
  split: ['group', 'entry', 'date', 'time', 'cat', 'desc', 'amount', 'currency', 'payer', 'payment', 'splitType', 'participants', 'customShares', 'recorder', 'note'],
  sticker: ['card', 'kid', 'behavior', 'points', 'date', 'time', 'recorder', 'note'],
  wish: ['category', 'name', 'country', 'city', 'detailPlace', 'reason', 'notes', 'source', 'rating', 'proposer', 'suggestDate', 'status', 'targetTime', 'recorder'],
};
function buildDraftScope() {
  const lab = draftLabel;
  const fieldsOf = (kind) => DRAFT_SCOPE_FIELDS[kind].map((k) => lab(kind, k));
  return {
    title: 'LINE 輸入 → 網頁表單自動帶入（待確認草稿）',
    flow: '訊息解析 → 網頁資料卡片（確認新增／修改內容／取消）→ 確認儲存 → 流水號生成（自動帶入不代表自動儲存）',
    rules: [
      '訊息沒提到、又無法可靠辨識的欄位一律留空；表單原本就有的預設值（例如甜度、冰塊、付款方式）維持不變，並標示「預設」（代表 LINE 沒提到、用的是表單原本的值）',
      '辨識不確定的欄位標示為「待確認」，儲存前會再提醒一次，不會當作正確資料',
      '一則訊息有多個品項時，每個品項各建立一張草稿、各開一張表單，資料不會混在一起',
      '同一則 LINE 訊息只會建立一次草稿（重送、重複點擊都不會重複）；網頁儲存後，LINE 與網頁看到的狀態一致',
      '已綁定同步碼的使用者才會建立草稿；還沒綁定的人維持原本流程（暫存在 LINE，到 App「LINE紀錄」匯入）',
      '只有一張草稿時，點開 LINE 的連結會先跳出資料卡片：【確認新增】才會正式建立紀錄並產生流水號；【取消】放棄這張草稿、不留任何紀錄；【修改內容】打開完整表單逐欄修改；右上角 ✕ 只是先關閉，草稿仍留著',
      '流水號格式：前綴＋區塊（1／2）＋年份（YYYY）＋四位序號（0001）。序號＝同一組現有紀錄的「最大號 + 1」（不是筆數 + 1），刪掉舊紀錄後再新增不會撞號',
      '年份以紀錄的日期為準，每個年份各自從 0001 起算（例如 2027 年的第一筆是 0001）；日期缺漏時才用儲存當天的年份',
      '編輯既有紀錄時，流水號與草稿標記鎖定、原樣保留，不會重新編號；舊資料裡已經重複的流水號不會被自動改號',
      '只有「LINE 轉入」的紀錄使用 LINE- 開頭的新格式；網頁手動新增的紀錄維持原本的格式（但同樣改用最大號 + 1、依紀錄日期的年份）',
      '分帳、集點卡、待去清單也走同一條流程（V10.1）：LINE 傳來的內容先變成待確認草稿，到網頁資料卡片按【確認新增】才正式寫入各自的模組並產生流水號；【取消】不留任何紀錄。欄位全部沿用各模組現有的表單，沒有另外造欄位',
      '群組與成員、孩子與行為、待去分類都對照你自己的資料，對得上才帶入、對不上標「待確認」；集點卡與待去清單屬於個人資料，只在 1 對 1 聊天室做自由文字解析',
    ],
    types: [
      {
        id: 'drink', name: '飲料紀錄', status: 'confirmed', fields: fieldsOf('drink'),
        serial: 'LINE 轉入：總流水號＝LINE-DRK-區塊（1／2）-年份-四位序號（例 LINE-DRK-1-2026-0001）；個人流水號＝LINE-DRK-飲用者代號-年份-四位序號（例 LINE-DRK-XG-2026-0001）。代號：XiaoGe＝XG、XiaoYan＝XY、Together＝TG，其他人取名字前兩個字母，沒填＝XX。網頁手動新增維持原格式（1-年份-序號、代號-年份-序號）。',
        note: '國家、付款者、評分這類 LINE 句子裡通常不會提到的欄位，只有「進階版／旗艦版」逐題問答（或「返回修改」時填寫）才會帶入；日期、時間沒提到時暫用 LINE 傳送時間並標示待確認',
      },
      {
        id: 'food', name: '美食紀錄', status: 'confirmed', fields: fieldsOf('food'),
        serial: 'LINE 轉入：總流水號＝LINE-FD-區塊（1／2）-年份-四位序號（例 LINE-FD-1-2026-0001）；個人流水號＝LINE-MFD-用餐者代號-年份-四位序號（例 LINE-MFD-XG-2026-0001）。網頁手動新增維持原格式（M1-年份-序號、M＋代號-年份-序號）。',
        note: '網頁美食表單沒有「地點」欄位：訊息提到的地點只會顯示在草稿上提醒，不會塞進其他欄位',
      },
      {
        id: 'travel', name: '交通紀錄', status: 'confirmed', fields: fieldsOf('travel'),
        serial: 'LINE 轉入：總流水號＝LINE-TRP-區塊（1／2）-年份-四位序號（例 LINE-TRP-1-2026-0001）；個人流水號＝LINE-MTRP-記錄者代號-年份-四位序號（例 LINE-MTRP-XG-2026-0001）。網頁手動新增的交通紀錄本來就沒有流水號，這次沒有改。',
        note: '日期沒提到就留空（不會拿傳訊息的日期代替）；交通類型無法判斷時留空並標示待確認',
      },
      {
        id: 'split', name: '分帳', status: 'confirmed', fields: fieldsOf('split'),
        serial: 'LINE 轉入：總流水號＝LINE-SPL-區塊（1／2）-年份-四位序號（例 LINE-SPL-1-2026-0001）；個人流水號＝LINE-MSPL-記錄者代號-年份-四位序號（例 LINE-MSPL-XG-2026-0001）。網頁手動新增的分帳支出本來就沒有流水號，這次沒有改。',
        note: '欄位＝網頁分帳「新增支出」表單。群組與成員會對照你自己的分帳資料：對得上才帶入，對不上標「待確認」；只有一個群組、訊息沒指定時暫用它並標待確認。誰先付錢、分給誰沒提到就標待確認（不替你決定）。一句話裡提到「每人金額不同」只會提醒、先用均分（不自動帶入）；四種版本的問答裡，旗艦版可以選「自訂金額」並逐一填入每個人的金額（名字要對得上成員、總和要等於金額）。日期、時間沒提到時暫用 LINE 傳送時間並標待確認。AA／均分＝所有成員均分。',
      },
      {
        id: 'sticker', name: '集點卡', status: 'confirmed', fields: fieldsOf('sticker'),
        serial: 'LINE 轉入：總流水號＝LINE-PTS-區塊（1／2）-年份-四位序號（例 LINE-PTS-1-2026-0001）；個人流水號＝LINE-MPTS-記錄者代號-年份-四位序號（例 LINE-MPTS-XG-2026-0001）。App 裡手動記的加扣點本來就沒有流水號，這次沒有改。',
        note: '欄位＝乖寶寶集點卡「記一筆」（孩子、行為、點數）或互助集點卡「記一筆」（加點／扣點、點數、原因）。孩子與行為會對照你自己的集點卡資料；沒另外說點數時，用行為在 App 裡設定的點數。在 LINE 選單裡選孩子、選行為，也一樣先變成草稿。自由文字解析只在 1 對 1 聊天室（孩子姓名屬於個人資料）。',
      },
      {
        id: 'wish', name: '待去清單', status: 'confirmed', fields: fieldsOf('wish'),
        serial: 'LINE 轉入：總流水號＝LINE-WSH-區塊（1／2）-年份-四位序號（例 LINE-WSH-1-2026-0001）；個人流水號＝LINE-MWSH-記錄者代號-年份-四位序號（例 LINE-MWSH-XG-2026-0001）。待去清單原本的「個別／國家／城市／總流水號」照舊產生，不受影響。',
        note: '欄位＝待去清單「新增項目」表單。分類會對照你自己的分類，沒提到或對不上暫放「其他」並標待確認；提議日期＝LINE 傳送的日期。提議者、推薦指數、狀態這類 LINE 句子裡通常不會提到的欄位不替你填（提議者要自己填，推薦指數預設 5 顆星、狀態預設「待去」）；四種版本的問答（進階、旗艦）才會逐項問。只在 1 對 1 聊天室新增。',
      },
      {
        id: 'others', name: '記帳', status: 'excluded', fields: [],
        serial: '', note: '不在這個流程內，維持原本的做法',
      },
    ],
  };
}

// ============================================================
// 🧭 LINE整合 V10.3／V10.4：四版本紀錄引擎（rec4）
//   🟢簡易版（輕享紀錄）／🟡標準版（智慧辨識紀錄）／🟠進階版（動態問答紀錄）／🔵旗艦版（完整資料紀錄）
//   ・文字、照片（拍照／相簿／貼上圖片）都能輸入。照片先經 Gemini 視覺辨識：只帶入「照片上看得到明確依據」的欄位，看不出來的留空或再問，不猜
//   ・欄位一律沿用網頁各模組的原始表單（和「待確認草稿」用同一套欄位名稱），沒有另外造欄位
//   ・所有版本最後都進同一個確認畫面：確認送出／返回修改／取消紀錄。按「確認送出」才會寫入；返回修改、取消紀錄都不會寫入任何資料，也不會留下流水號
//   ・確認送出之後：已綁定同步碼、草稿模式開著 → 建立網頁「待確認草稿」（到網頁按【確認新增】才正式儲存並產生流水號）；
//     否則直接寫入 LINE 紀錄並同步到網頁，同步失敗會保留這筆並自動重試
//   ・V10.3：🧋飲料四個版本完整；🍱美食、🚆交通先提供簡易／標準／進階（旗艦版要等逐欄核對網頁表單，現在會誠實說明，不亂猜欄位）
//   ・V10.4：🧾分帳、🌟集點卡、🗺️待去清單也走這個引擎，四個版本都完整；但只在「1 對 1、已綁定同步碼、草稿模式開著」的情況下使用
//     （資料在網頁裡，只能建立網頁待確認草稿）；群組、沒綁定、沒開草稿模式、讀不到網頁資料時，維持原本的流程並說明原因
// ============================================================
const REC4_ORDER = ['simple', 'standard', 'advanced', 'flagship'];
// 四種版本的說明文字：用語由使用者指定。V10.5.1 依 2026-11-12 的「問答提示詞更新」改寫：🟢簡易版改稱「輕享紀錄」、🟠進階版改稱「動態問答紀錄」，
//   操作方式與規則改成使用者提供的新文字；{F}＝依模組換成該模組自己的欄位舉例（見各模組 schema 的 vtext）
const REC4_INPUT_LINE = '支援輸入：直接輸入文字／拍照／上傳照片／貼上文字或圖片';
const REC4_VERSIONS = {
  simple: {
    emoji: '🟢', name: '簡易版', tag: '輕享紀錄',
    how: '輸入「品項＋金額」即可完成紀錄；系統自動辨識品項與金額，並依照所屬功能寫入對應欄位。',
    example: '「珍奶 60」、「午餐 120」、「計程車 250」',
    ruleLabel: '規則', rule: '以快速完成紀錄為優先；未提供的資料不得自行猜測或編造；不得因為使用簡易版而將資料寫入錯誤欄位；遇到無法辨識的必要資訊，應適度詢問使用者。',
  },
  standard: {
    emoji: '🟡', name: '標準版', tag: '智慧辨識紀錄',
    how: '使用者以一句話描述，AI 自動擷取相關資訊；會依照輸入內容自動辨識及拆解資料，例如：{F}。',
    fields: '品牌／店家名稱、品項名稱、客製化標籤、備註、支付方式、金額',
    example: '「清心的四季春大杯少糖去冰現金60」、「鼎泰豐小籠包中份現金380」',
    ruleLabel: '規則', rule: '自動辨識使用者已提供的資訊；未提及的內容不得自行推測；不確定的欄位保持空白，不得擅自填入；辨識完成後，應提供紀錄摘要供使用者確認。',
  },
  advanced: {
    emoji: '🟠', name: '進階版', tag: '動態問答紀錄',
    how: '由機器人逐項提問，使用者依序回答；系統依照使用者選擇的功能，讀取該功能的原始表單欄位，逐項進行提問。',
    how2: '透過照片辨識及一問一答，完成完整資料建檔。', // V10.13.1：進階版補上第二種操作方式（原本只講逐題問答，沒講清楚也支援照片辨識），獨立成第二行，不是接在第一句後面
    ruleLabel: '互動規則', rule: '一次只詢問一個欄位；使用者回答後，再接續詢問下一個欄位；已經從文字或照片辨識出的資訊，不必重複詢問；使用者可以回答「無」、「略過」或「不知道」，依欄位規則處理；必填欄位不得直接跳過；選填欄位可以略過；所有問題完成後，顯示完整紀錄摘要，供使用者確認及送出。',
  },
  flagship: {
    emoji: '🔵', name: '旗艦版', tag: '完整資料紀錄',
    how: '透過一問一答或照片辨識，完成完整資料建檔。',
    ruleLabel: '互動規則', rule: '依照完整表單順序一次一問，不擅自刪除、合併或縮減欄位；已辨識的資料會自動帶入並請您確認，未提及資料不自行編造；金額若未寫明幣別，預設為新臺幣 (TWD)；資料全部填寫完成後，顯示完整紀錄供您確認後存檔。',
  },
};
// 🟠進階版／🔵旗艦版「會問哪些欄位」那一行：直接由該功能的欄位表（順序＝網頁原始表單）產生，所以說明和實際問答不會對不上。
//   沒給 sch（首頁通用卡、後台規格）＝用 🧋飲料當例子；簡易／標準版不逐欄提問，沒有這一行。
//   有條件才問的欄位（askNote）會註明；進階版已經從文字或照片辨識到的欄位不會再問，所以寫「最多」
function rec4AskLine(v, sch) {
  if (v !== 'advanced' && v !== 'flagship') return '';
  const s = sch || REC4_SCHEMAS.drink;
  if (v === 'flagship' && s.flagshipReady === false) return s.icon + ' ' + s.name + '的旗艦版：網頁表單還有欄位要逐欄核對（不會自己猜欄位、也不會少問），目前尚未開放。';
  const fs = s.fields.filter((f) => v === 'flagship' || f.adv);
  const cond = fs.some((f) => f.when);
  const head = (sch ? s.icon + ' ' + s.name + '紀錄' : '以' + s.name + '紀錄為例') + (v === 'flagship' ? '，依照原始表單欄位完整詢問' : '，依序提問') + '（' + (v === 'advanced' || cond ? '最多 ' : '共 ') + fs.length + ' 題）：';
  return head + fs.map((f, i) => (i + 1) + '.' + f.label + (f.askNote || '')).join('　');
}
// 某個版本的說明行（sch＝某模組的 schema 時，範例與欄位舉例換成該模組自己的；沒給＝通用版，就是使用者指定的原文）
//   V10.12.1：段落之間插入空字串（沿用 rec4Intro 的 ['', 內容] 空一行寫法），讓 LINE 版本卡、首頁通用卡、後台規格頁在「操作方式」「範例」「規則」之間空一行，不要擠成一段
//   V10.13.1：①「支援輸入」跟「操作方式」之間原本沒空一行，這次補上，四個版本都適用②進階版「操作方式」拆成❶❷兩句（❶逐題問答、❷照片輔助建檔），❶❷之間只換行、不空一行③進階／旗艦版「操作方式」（進階版是❷）跟下面的提問欄位清單之間原本也沒空一行，這次補上（簡易／標準版的「操作方式／範例」之間本來就有空一行，不用再加）
function rec4VerLines(v, sch) {
  const x = REC4_VERSIONS[v];
  const t = (sch && sch.vtext && sch.vtext[v]) || {};
  const howLabel = v === 'advanced' ? '操作方式❶：' : '操作方式：'; // V10.13.1：進階版有兩種操作方式（逐題問答／照片辨識），標❶❷區分；其他版本維持單句、不標號
  const lines = [REC4_INPUT_LINE, '', howLabel + (t.how || x.how).replace('{F}', t.fields || x.fields || '')]; // V10.13.1：「支援輸入」跟「操作方式」之間也補一個空一行標記（原本只有「操作方式／範例」「範例／規則」之間有）；某個模組的簡易版輸入方式不一樣（集點卡＝孩子＋行為、待去清單＝地點名稱）時，用該模組自己的說明
  if (v === 'advanced') lines.push('操作方式❷：' + x.how2); // V10.13.1：補上「也支援照片辨識」這一種操作方式，自己獨立一行（換行，不是空一行、不是接在❶後面）
  const ask = rec4AskLine(v, sch);
  if (ask) lines.push('', ask); // V10.13.1：進階／旗艦版「操作方式」跟提問欄位清單之間也補一個空一行標記（簡易／標準版的「操作方式／範例」之間本來就有，見下面 ex 那段）
  const ex = t.example || x.example;
  if (ex) lines.push('', '範例：' + ex);
  lines.push('', x.ruleLabel + '：' + (t.rule || x.rule));
  return lines;
}
// V10.13.0：規則／互動規則文字預設隱藏（後台「規則顯示」開關，六模組各自控制，預設全部關閉）——只影響這兩個 LINE 使用者看得到的地方：
//   「選擇紀錄版本」卡（rec4VersionCardMsg）、選好版本後的起手訊息（rec4Intro）；後台「版本規格」頁一律照常完整顯示（buildSpecs 直接呼叫 rec4VerLines，不經過這支，不受影響）。
//   rec4VerLines 的規則行一定是陣列最後兩個元素（空字串空一行標記＋規則本文，就是上面這行 push 的），所以關閉時用 slice(0,-2) 去掉剛好這兩個；
//   沒給 sch（首頁通用「日常小秘書」卡，不屬於任何單一模組）＝一律隱藏，沒有對應的後台開關可以打開它。
//   用 sch.cat（跟 FORM_MODE_MODULE_KEYS、後台開關、S.module 同一套簡單模組代號：drink/food/travel/split/sticker/wish）比對，不是 sch.fn
//   （sch.fn 是草稿系統內部用的動作代號，分帳是 'split_add'、待去清單是 'wish_add'，跟後台開關的 key 對不起來）。
function rec4VerLinesFor(v, sch, cfg) {
  const lines = rec4VerLines(v, sch);
  return (sch && ruleVisibleEnabled(cfg, sch.cat)) ? lines : lines.slice(0, -2);
}
const REC4_TRIGGERS = {};
REC4_ORDER.forEach((v) => { const x = REC4_VERSIONS[v]; REC4_TRIGGERS[x.name] = v; REC4_TRIGGERS[x.emoji + ' ' + x.name] = v; REC4_TRIGGERS[x.emoji + x.name] = v; });
const REC4_MODULE_WORDS = { 飲料: 'drink', 飲料紀錄: 'drink', '🧋 飲料': 'drink', 美食: 'food', 美食紀錄: 'food', '🍱 美食': 'food', 交通: 'travel', 交通紀錄: 'travel', '🚆 交通': 'travel', 分帳: 'split', 分帳紀錄: 'split', 記一筆分帳: 'split', 集點卡: 'sticker', 集點: 'sticker', 集點卡紀錄: 'sticker', 待去清單: 'wish', 待去: 'wish', 待去地點: 'wish', 新增待去地點: 'wish', 待去清單紀錄: 'wish' }; // V10.4：分帳、集點卡、待去清單也有四種版本
const REC4_PICK_STAGES = { pick_module: 1, pick_version: 1, pick_mode: 1, pick_mate: 1 };
const REC4_VS16 = String.fromCharCode(0xFE0F);
function rec4Clean(t) { return String(t === undefined || t === null ? '' : t).split(REC4_VS16).join('').trim(); }
const REC4_SKIP_RE = /^(略過|跳過|無|沒有|沒|不知道|不確定|不清楚|skip|n\/a|na|-|－|—|無資料)$/i;
const REC4_REST_RE = /^(⏩\s*)?其餘(全部)?(略過|跳過)$/;
const REC4_YES_RE = /^(✅\s*)?(確認送出|確認|送出|儲存|好|是|ok)$/i;
const REC4_EDIT_RE = /^(📝\s*)?(返回修改|修改|要修改|更改)$/;
const REC4_NO_RE = /^(❌\s*)?(取消紀錄|取消|放棄|不要|否|結束|結束此次對話|離開|退出|cancel|quit|exit)$/i;
const REC4_CANCEL_ALL_RE = /^(❌\s*)?取消紀錄$/;
const REC4_PREV_RE = /^(🔙\s*)?(上一題|上一步)$/;
const REC4_KEEP_RE = /^(✅\s*)?沿用$/;
const REC4_CONFIRM_BTN_RE = /^(✅\s*|📝\s*)?(確認送出|返回修改)$/; // 最後確認畫面專用的按鈕：問答途中收到（例如點到舊訊息的按鈕），不能當成答案寫進欄位
const REC4_CONFIRM_BTN_MSG = '「確認送出」「返回修改」是最後確認畫面的按鈕，現在還在回答問題，這句話沒有被當成答案。請回答下面這題，或按「取消紀錄」放棄這一筆。';
const REC4_BACK_RE = /^(↩\s*)?(返回|不改了|回到確認|都不改)$/;
const REC4_MAX_IMAGE = 7 * 1024 * 1024; // 照片大小上限（LINE 一般照片遠小於這個數字）
const REC4_PAGE = 10; // 「返回修改」一頁列幾個欄位

// 各欄位在 LINE 裡顯示的名稱：和網頁原始表單一致（沒列在這裡的，沿用草稿的名稱）
const REC4_LABEL = {
  drink: { country: '國家', area: '行政區．地點', brand: '品牌名稱', drink: '品項名稱', category: '品項類別', size: 'SIZE／容量', topping: '加料選擇', sugar: '甜度', ice: '冰塊', payment: '支付方式', currency: '幣別', amount: '金額', drinker: '飲用者', payer: '付款者', recorder: '紀錄者', rating: '評分', note: '備註（選填）' },
  food: { brand: '店家名稱', dish: '餐點名稱', category: '用餐類別', cuisine: '菜系', portion: '份量', spicy: '辣度', diningType: '用餐方式', payment: '支付方式', currency: '幣別', amount: '金額', eater: '用餐者', recorder: '紀錄者', rating: '評分', note: '備註（選填）' },
  travel: { type: '交通類型', company: '公司', no: '班次／編號', depPort: '出發地', arrPort: '到達地', transitPort: '經停', depTime: '出發時間', arrTime: '到達時間', seat: '座位', vehicleType: '車種／機型', ticketPrice: '票價', payment: '付款方式', recorder: '紀錄者', note: '備註（選填）' },
  split: { group: '分帳群組', entry: '類型', date: '日期', time: '時間', cat: '類別', desc: '品項', amount: '金額', currency: '幣別', payer: '誰先付錢', payment: '付款方式', splitType: '如何分', participants: '分給誰', customShares: '各自金額', recorder: '紀錄者', note: '備註（選填）' },
  sticker: { card: '集點卡', kid: '孩子', behavior: '行為', points: '點數', date: '日期', time: '時間', recorder: '紀錄者', note: '原因／備註（選填）' },
  wish: { category: '分類', name: '項目名稱', country: '國家／地區', city: '城市／地區', detailPlace: '詳細地點／商家', reason: '推薦原因', notes: '備註（選填）', source: '來源', rating: '推薦指數', proposer: '提議者', suggestDate: '提議日期', status: '狀態', targetTime: '預計時間', recorder: '紀錄者' },
};
function rec4Label(kind, key) { return (REC4_LABEL[kind] && REC4_LABEL[kind][key]) || draftLabel(kind, key); }

// ---------- V10.4：分帳／集點卡／待去清單 —— 「個人清單型」欄位的輔助函式 ----------
//   這三個功能的選項不是固定的，而是使用者自己的資料：分帳群組與成員、集點卡的孩子與行為、待去清單的分類。
//   清單在開始紀錄時從「同步資料」讀一次、放進對話（S.lists），之後每一題都對照它；對不上的名字不會硬收（會請使用者重選）。
const REC4_ALL = '__ALL__'; // 「分給誰」選了「全部成員」
function rec4Lists(S) {
  const L = (S && S.lists) || {};
  return {
    groups: Array.isArray(L.groups) ? L.groups : [], kids: Array.isArray(L.kids) ? L.kids : [], behaviors: Array.isArray(L.behaviors) ? L.behaviors : [],
    wishCats: Array.isArray(L.wishCats) ? L.wishCats : [], wishOpts: (L.wishOpts && typeof L.wishOpts === 'object') ? L.wishOpts : { proposer: [], source: [], status: [] },
  };
}
function rec4Group(S, it) {
  const n = it && it.fields ? it.fields.group : '';
  return n ? (rec4Lists(S).groups.find((g) => g.name === n) || null) : null;
}
function rec4Members(S, it) { const g = rec4Group(S, it); return g && Array.isArray(g.members) ? g.members : []; }
// 這一筆「分給誰」實際包含的成員（沒指定＝網頁表單預設的「全部成員」）
function rec4SharePeople(S, it) {
  const f = it.fields;
  if (Array.isArray(f.participants) && f.participants.length) return f.participants.slice();
  return rec4Members(S, it).slice();
}
// 這一筆預設的幣別符號：群組在 App 裡設定的幣別（網頁表單也是這樣預設），群組沒設才用 NT$
function rec4SplitCur(S, it) {
  const g = rec4Group(S, it);
  const sym = g && g.currency ? String(g.currency) : '';
  return SPLIT_CUR_TABLE.some((r) => r[0] === sym) ? sym : 'NT$';
}
const REC4_SPLIT_CUR_NAMES = { 'NT$': '新臺幣', 'CN¥': '人民幣', 'US$': '美金', '₩': '韓元', '¥': '日圓', '€': '歐元', 'HK$': '港幣', '£': '英鎊', '฿': '泰銖', 'A$': '澳幣', 'S$': '新加坡幣', 'RM': '馬幣' };
const REC4_SPLIT_CAT_ORDER = ['餐飲', '飲料', '交通', '購物', '住宿', '娛樂', '其他', '門票', '雜貨', '禮物', '機票', '船票']; // 按鈕順序：常用的在前面（LINE 一次最多 13 顆）
// 固定選項的欄位（類型、如何分、類別、集點卡種類）：[顯示名稱, 存進去的值, [別名]]
function rec4Enum(pairs, order) {
  const labels = order || pairs.map((p) => p[0]);
  return {
    options: () => labels.slice(),
    parse: (S, it, text) => {
      const t = String(text).replace(/\s+/g, '').toLowerCase();
      const hit = pairs.find((p) => p[0].toLowerCase() === t || String(p[1]).toLowerCase() === t || (p[2] || []).some((a) => a.toLowerCase() === t));
      return hit ? { ok: true, value: hit[1] } : { ok: false, msg: '沒看懂這個選項，請點下面的選項（或輸入：' + labels.join('、') + '）。' };
    },
    show: (v) => { const p = pairs.find((x) => x[1] === v); return p ? p[0] : String(v); },
  };
}
// 把「我」「小明」這類稱呼對到群組成員；對不上就說明原因（不亂猜）
function rec4PickMember(S, mem, raw) {
  const p = dStr(raw, 20);
  if (ME_RE.test(p)) {
    const me = resolveMeMember(mem, [S.sender, S.userName]);
    if (!me) return { ok: false, msg: '成員裡找不到和你的名稱對得上的人，請直接點成員的名字。' };
    return me.viaName ? { ok: true, value: me.v, warn: '依你的名稱「' + me.by + '」對應到成員「' + me.v + '」' } : { ok: true, value: me.v };
  }
  const m = matchListName(p, mem);
  return m && m.known ? { ok: true, value: m.v } : { ok: false, msg: '成員裡沒有「' + p + '」。成員：' + mem.join('、') };
}
// 分帳：分給誰、金額、群組只要有一項變了，依賴它的欄位就重新檢查（不再屬於這個群組的付款人、分攤名單、對不上總金額的各自金額，都清掉重問）
function rec4SplitRevalidate(S, it) {
  const g = rec4Group(S, it);
  const mem = g ? g.members : null;
  const f = it.fields;
  if (mem && mem.length) {
    if (f.payer && mem.indexOf(f.payer) < 0) rec4ClearValue(it, 'payer');
    if (Array.isArray(f.participants)) {
      const keep = f.participants.filter((n) => mem.indexOf(n) >= 0);
      if (keep.length !== f.participants.length) { if (keep.length) f.participants = keep; else delete f.participants; }
    }
  }
  if (f.customShares && typeof f.customShares === 'object') {
    const people = rec4SharePeople(S, it);
    const keys = Object.keys(f.customShares);
    const sum = keys.reduce((s, k) => s + (Number(f.customShares[k]) || 0), 0);
    const ok = keys.length === people.length && keys.every((k) => people.indexOf(k) >= 0) && Math.abs(sum - (Number(f.amount) || 0)) < 0.005;
    if (!ok) rec4ClearValue(it, 'customShares');
  }
}
// 集點卡：選了清單裡的行為、點數還空著 → 帶入這個行為在 App 裡設定的點數（是清單裡的真實設定，不是猜的）
function rec4StickerDefaultPoints(S, it) {
  if (it.fields.card === 'mutual' || rec4Has(it, 'points')) return;
  const b = rec4Lists(S).behaviors.find((x) => x.name === it.fields.behavior);
  if (b && Number(b.points)) { it.fields.points = Number(b.points); it.src.points = 'default'; }
}
const REC4_HOOK = {
  group: {
    options: (S) => rec4Lists(S).groups.map((g) => g.name),
    parse: (S, it, text) => {
      const names = rec4Lists(S).groups.map((g) => g.name);
      const m = matchListName(text, names);
      return m && m.known ? { ok: true, value: m.v } : { ok: false, msg: '你的分帳裡沒有叫「' + dStr(text, 20) + '」的群組。' + (names.length ? '可以選：' + names.join('、') : '') };
    },
    after: (S, it) => rec4SplitRevalidate(S, it),
  },
  payer: {
    options: (S, it) => rec4Members(S, it),
    parse: (S, it, text) => {
      const mem = rec4Members(S, it);
      if (!mem.length) return { ok: false, msg: '還不知道要記在哪個分帳群組，請先選好群組。' };
      const r = rec4PickMember(S, mem, text);
      if (r.ok && r.warn) r.warn += '，請確認';
      return r;
    },
    invalid: (S, it) => { const mem = rec4Members(S, it); return !!(it.fields.payer && mem.length && mem.indexOf(it.fields.payer) < 0); }, // 例如訊息寫「我」卻對不上成員：不能當作有答案，要問
  },
  participants: {
    options: (S, it) => ['全部成員'].concat(rec4Members(S, it)),
    parse: (S, it, text) => {
      const mem = rec4Members(S, it);
      if (!mem.length) return { ok: false, msg: '還不知道要記在哪個分帳群組，請先選好群組。' };
      if (/^(全部成員|全部|所有人|大家|全員|均分|平分|AA制?)$/i.test(text.replace(/\s+/g, ''))) return { ok: true, value: REC4_ALL };
      const tryParts = (sep) => {
        const parts = text.split(sep).map((x) => x.trim()).filter(Boolean).slice(0, 20);
        const names = [];
        const warns = [];
        for (let i = 0; i < parts.length; i++) {
          const r = rec4PickMember(S, mem, parts[i]);
          if (!r.ok) return { ok: false, msg: r.msg };
          if (r.warn) warns.push(r.warn);
          if (names.indexOf(r.value) < 0) names.push(r.value);
        }
        return names.length ? { ok: true, value: names, warn: warns.length ? warns.join('；') + '，請確認' : '' } : { ok: false, msg: '沒看到名字，請點成員的名字，或輸入多位成員（用頓號隔開）。' };
      };
      const whole = rec4PickMember(S, mem, text);
      if (whole.ok) return { ok: true, value: [whole.value], warn: whole.warn ? whole.warn + '，請確認' : '' };
      const a = tryParts(/[、,，;；+＋&\s]+/);
      if (a.ok) return a;
      const b = tryParts(/[、,，;；+＋&\s和跟與]+/);
      return b.ok ? b : a;
    },
    show: (v, it) => (it.fields.splitAll === true && !(Array.isArray(v) && v.length) ? '全部成員（均分）' : (Array.isArray(v) ? v.join('、') : String(v))),
    after: (S, it) => rec4SplitRevalidate(S, it),
  },
  splitType: {
    after: (S, it) => { if (it.fields.splitType !== 'custom') rec4ClearValue(it, 'customShares'); },
  },
  customShares: {
    parse: (S, it, text) => {
      const people = rec4SharePeople(S, it);
      const amt = Number(it.fields.amount) || 0;
      const t = text.replace(/(\d),(\d{3})/g, '$1$2');
      const re = /([^\d\s,，、;；=＝:：+＋]+)\s*[=＝:：]?\s*(\d+(?:\.\d+)?)/g;
      const pairs = [];
      let m;
      while ((m = re.exec(t))) pairs.push([m[1], Number(m[2])]);
      if (!pairs.length) return { ok: false, msg: '請用「名字 金額」的格式，多位用頓號隔開，例如：' + (people.slice(0, 2).map((n, i) => n + ' ' + (i ? 700 : 300)).join('、') || '小明 300、小華 700') };
      const map = {};
      let sum = 0;
      for (let i = 0; i < pairs.length; i++) {
        const r = rec4PickMember(S, people, pairs[i][0]);
        if (!r.ok) return { ok: false, msg: '「' + dStr(pairs[i][0], 20) + '」不在這一筆分攤的名單裡。分攤的人：' + people.join('、') };
        if (map[r.value] !== undefined) return { ok: false, msg: '「' + r.value + '」出現了兩次。' };
        map[r.value] = pairs[i][1]; sum += pairs[i][1];
      }
      const missing = people.filter((n) => map[n] === undefined);
      if (missing.length) return { ok: false, msg: '還缺少 ' + missing.join('、') + ' 的金額（分攤的每一位都要填；不用付的人，請用「返回修改」把「分給誰」改掉）。' };
      const total = Math.round(sum * 100) / 100;
      if (Math.abs(total - amt) >= 0.005) return { ok: false, msg: '每個人的金額加起來是 ' + total + '，要等於總金額 ' + amt + '（差 ' + Math.round((amt - total) * 100) / 100 + '）。請再輸入一次。' };
      return { ok: true, value: map };
    },
    show: (v) => Object.keys(v || {}).map((n) => n + '＝' + v[n]).join('、'),
  },
  splitCurrency: {
    options: (S, it) => { const g = rec4SplitCur(S, it); return [g].concat(['NT$', '¥', 'US$', '₩', '€', 'HK$', 'CN¥'].filter((x) => x !== g)).map((sym) => ({ label: sym + ' ' + REC4_SPLIT_CUR_NAMES[sym], text: sym === '¥' ? 'JPY' : sym })); }, // 單獨一個「¥」可能是日圓也可能是人民幣，所以按鈕送出的是代碼 JPY（分帳表單的「¥」＝日圓）
    parse: (S, it, text) => { const n = normSplitCurrency(text); return n && n.known ? { ok: true, value: n.v } : { ok: false, msg: '分帳的幣別選單沒有這個幣別，請點下面的選項（或輸入 TWD、JPY、USD 這類代碼）。' }; },
    show: (v) => (REC4_SPLIT_CUR_NAMES[v] ? v + '（' + REC4_SPLIT_CUR_NAMES[v] + '）' : String(v)),
  },
  kid: {
    options: (S) => rec4Lists(S).kids.map((k) => k.name),
    parse: (S, it, text) => {
      const names = rec4Lists(S).kids.map((k) => k.name);
      const m = matchListName(text, names);
      return m && m.known ? { ok: true, value: m.v } : { ok: false, msg: '你的集點卡裡沒有叫「' + dStr(text, 20) + '」的孩子。' + (names.length ? '可以選：' + names.join('、') : '') };
    },
  },
  behavior: {
    options: (S) => rec4Lists(S).behaviors.map((b) => ({ label: (b.name + (Number(b.points) ? ' ' + (b.points > 0 ? '+' : '') + b.points : '')).slice(0, 20), text: b.name })),
    parse: (S, it, text) => {
      const m = matchListName(text, rec4Lists(S).behaviors.map((b) => b.name));
      if (m && m.known) return { ok: true, value: m.v };
      const v = dStr(text, 30);
      return v ? { ok: true, value: v, warn: '行為清單裡沒有「' + v + '」，儲存時會當成自訂行為記錄，請確認' } : { ok: false, msg: '沒看懂這個行為，請點選或再輸入一次。' };
    },
    after: (S, it) => rec4StickerDefaultPoints(S, it),
  },
  points: {
    options: (S, it) => {
      const b = rec4Lists(S).behaviors.find((x) => x.name === it.fields.behavior);
      const first = b && Number(b.points) ? [(b.points > 0 ? '+' : '') + b.points] : [];
      return first.concat(['+1', '+2', '+3', '-1', '-2'].filter((x) => first.indexOf(x) < 0));
    },
    parse: (S, it, text) => {
      const n = Number(String(text).replace(/[+＋]/g, '').replace(/[－−]/g, '-').replace(/點/g, '').trim());
      if (!isFinite(n) || n === 0 || Math.abs(n) >= 100000) return { ok: false, msg: '點數請輸入不是 0 的數字（加點填正數、扣點填負數，例如 2 或 -1）。' };
      return { ok: true, value: Math.round(n * 100) / 100 };
    },
    show: (v) => (Number(v) > 0 ? '+' : '') + v + ' 點',
  },
  wishCat: {
    options: (S) => { const c = rec4Lists(S).wishCats; return c.length ? c : WISH_DEFAULT_CATS; },
    parse: (S, it, text) => {
      const c = rec4Lists(S).wishCats;
      const names = c.length ? c : WISH_DEFAULT_CATS;
      const m = matchListName(text, names);
      return m && m.known ? { ok: true, value: m.v } : { ok: false, msg: '你的待去清單沒有「' + dStr(text, 20) + '」這個分類。可以選：' + names.join('、') };
    },
  },
  wishStatus: {
    options: (S) => rec4Lists(S).wishOpts.status || [],
    parse: (S, it, text) => {
      const names = rec4Lists(S).wishOpts.status || [];
      const m = matchListName(text, names);
      if (m && m.known) return { ok: true, value: m.v };
      const v = dStr(text, 20);
      return v ? { ok: true, value: v, warn: '狀態「' + v + '」不在你的待去清單狀態選項裡，網頁會請你自己選' } : { ok: false, msg: '沒看懂這個狀態，請點選或再輸入一次。' };
    },
  },
  wishRating: {
    options: () => [{ label: '⭐⭐⭐⭐⭐ 5', text: '5' }, { label: '⭐⭐⭐⭐ 4', text: '4' }, { label: '⭐⭐⭐ 3', text: '3' }],
    parse: (S, it, text) => { const n = Number(String(text).replace(/[顆星分★⭐\s]/g, '')); return n >= 3 && n <= 5 && Math.round(n) === n ? { ok: true, value: n } : { ok: false, msg: '網頁的推薦指數只有 3、4、5 顆星，請點下面的選項。' }; },
    show: (v) => '★'.repeat(Math.max(1, Math.min(5, Math.round(Number(v) || 0)))) + ' ' + v,
  },
  wishProposer: {
    options: (S) => ['我', 'XiaoGe', 'XiaoYan'].concat((rec4Lists(S).wishOpts.proposer || []).filter((x) => x !== 'XiaoGe' && x !== 'XiaoYan')),
  },
  wishSource: {
    options: (S) => rec4Lists(S).wishOpts.source || [],
  },
};
// 欄位是否必填／要不要出現：有些欄位會看這一筆的其他答案或使用者的清單（例如只有一個分帳群組就不用問群組；互助集點卡沒有孩子與行為）
function rec4IsReq(S, it, f) { return typeof f.req === 'function' ? !!f.req(S, it) : !!f.req; }
function rec4Active(S, it, f) { return !f.when || !!f.when(it, S); }
function rec4Q(S, it, f) { return typeof f.q === 'function' ? f.q(S, it) : f.q; }

// 各模組的欄位表：順序＝網頁原始表單的順序。
//   req＝必填（所有版本都一定要有，不能略過）；adv＝🟠進階版會問的欄位（其餘欄位只有🔵旗艦版才逐項問）；confirmDefault＝旗艦版即使已有預設值，也要請使用者確認
const REC4_SCHEMAS = {};
(function () {
  const F = (kind, key, type, extra) => Object.assign({ key, type, label: rec4Label(kind, key) }, extra || {});
  const DATE_Q = '日期？（點「今天」，或輸入 2026-11-05、11月5日）';
  const TIME_Q = '時間？（點「現在」，或輸入 14:30、下午3點）';
  REC4_SCHEMAS.drink = {
    kind: 'drink', fn: 'drink', icon: '🧋', name: '飲料', cat: 'drink', itemKey: 'drink', moneyKey: 'amount', flagshipReady: true,
    examples: ['珍奶 60', '四季春 55'], sentence: '清心的四季春大杯少糖去冰現金60',
    vtext: { // 四種版本說明裡的舉例：簡易版／標準版的範例、標準版可拆出的欄位。🟠進階版／🔵旗艦版會問哪些欄位不手寫，直接由下面的 fields 產生（見 rec4AskLine）
      simple: { example: '「珍奶 60」' },
      standard: { example: '「清心的四季春大杯少糖去冰現金60」', fields: '品牌／店家名稱、品項名稱、客製化標籤（容量、加料、甜度、冰塊）、備註、支付方式、金額' },
    },
    fields: [
      F('drink', 'date', 'date', { q: DATE_Q }),
      F('drink', 'time', 'time', { q: TIME_Q }),
      F('drink', 'country', 'country', { q: '國家／地區？（網頁表單的選項是臺灣、中國，也可以直接輸入其他國家）' }),
      F('drink', 'area', 'text', { max: 40, q: '行政區．地點？（例如：信義區 市府店；網頁表單的「行政區．地點」是同一欄）' }),
      F('drink', 'brand', 'text', { max: 40, adv: true, q: '品牌／店家名稱？（例如：50嵐）' }),
      F('drink', 'drink', 'text', { max: 40, adv: true, req: true, q: '品項名稱？（例如：四季春茶）' }),
      F('drink', 'category', 'text', { max: 20, q: '品項類別？（可點選，也可以自己輸入）', opts: ['純茶', '奶茶', '鮮奶茶', '水果茶', '芝士奶蓋', '冰沙', '咖啡', '氣泡飲'] }),
      F('drink', 'size', 'size', { adv: true, q: 'SIZE／容量？' }),
      F('drink', 'topping', 'topping', { adv: true, q: '加料選擇？（沒有加料請點「無」）' }),
      F('drink', 'sugar', 'sugar', { adv: true, q: '甜度？' }),
      F('drink', 'ice', 'ice', { adv: true, q: '冰塊？' }),
      F('drink', 'payment', 'payment', { adv: true, q: '支付方式？' }),
      F('drink', 'currency', 'currency', { askNote: '（未填寫時，預設新臺幣 TWD）', q: '幣別？（沒填的話，預設 NT$ 新臺幣 TWD）' }),
      F('drink', 'amount', 'amount', { adv: true, req: true, q: '金額多少？（請輸入數字）' }),
      F('drink', 'drinker', 'person', { q: '飲用者是誰？' }),
      F('drink', 'payer', 'person', { q: '付款者是誰？' }),
      F('drink', 'recorder', 'person', { confirmDefault: true, q: '紀錄者是誰？' }),
      F('drink', 'rating', 'rating', { q: '評分幾顆星？（1～5）' }),
      F('drink', 'note', 'text', { max: 80, q: '備註？（選填）' }),
    ],
  };
  REC4_SCHEMAS.food = {
    kind: 'food', fn: 'food', icon: '🍱', name: '美食', cat: 'food', itemKey: 'dish', moneyKey: 'amount', flagshipReady: false,
    examples: ['午餐 120', '拉麵 180'], sentence: '鼎泰豐小籠包中份現金380',
    vtext: {
      simple: { example: '「午餐 120」' },
      standard: { example: '「九八餐廳桌菜現金980」、「鼎泰豐小籠包中份現金380」', fields: '店家、餐點、用餐類別、菜系、客製化標籤（份量、辣度）、備註、支付方式、金額' },
    },
    fields: [
      F('food', 'date', 'date', { q: DATE_Q }),
      F('food', 'time', 'time', { q: TIME_Q }),
      F('food', 'brand', 'text', { max: 40, adv: true, q: '店家名稱？' }),
      F('food', 'dish', 'text', { max: 40, adv: true, req: true, q: '餐點名稱？' }),
      F('food', 'category', 'choice', { adv: true, list: WEB_SELECT.mealCategory, table: [[['下午茶'], '點心']], opts: WEB_SELECT.mealCategory, q: '用餐類別？（早餐／午餐／晚餐／宵夜／點心）' }),
      F('food', 'cuisine', 'choice', { adv: true, list: WEB_SELECT.cuisine, table: [], opts: WEB_SELECT.cuisine, q: '菜系？' }),
      F('food', 'portion', 'choice', { adv: true, list: WEB_SELECT.portion, table: [[['小', '小份'], '小份'], [['中', '中份'], '中份'], [['大', '大份'], '大份']], opts: WEB_SELECT.portion, q: '份量？' }),
      F('food', 'spicy', 'choice', { list: WEB_SELECT.spicy, table: [], opts: WEB_SELECT.spicy, q: '辣度？' }),
      F('food', 'diningType', 'choice', { adv: true, list: WEB_SELECT.diningType, table: [[['堂食', '在店內'], '內用'], [['帶走', '自取'], '外帶']], opts: WEB_SELECT.diningType, q: '用餐方式？（內用／外帶／外送）' }),
      F('food', 'payment', 'payment', { adv: true, q: '支付方式？' }),
      F('food', 'currency', 'currency', { askNote: '（未填寫時，預設新臺幣 TWD）', q: '幣別？（沒填的話，預設 NT$ 新臺幣 TWD）' }),
      F('food', 'amount', 'amount', { adv: true, req: true, q: '金額多少？（請輸入數字）' }),
      F('food', 'eater', 'person', { q: '用餐者是誰？' }),
      F('food', 'recorder', 'person', { confirmDefault: true, q: '紀錄者是誰？' }),
      F('food', 'rating', 'rating', { q: '評分幾顆星？（1～5）' }),
      F('food', 'note', 'text', { max: 80, q: '備註？（選填）' }),
    ],
  };
  REC4_SCHEMAS.travel = {
    kind: 'travel', fn: 'travel', icon: '🚆', name: '交通', cat: 'travel', itemKey: '', moneyKey: 'ticketPrice', flagshipReady: false,
    examples: ['計程車 250', '台北到台中 1490'], sentence: '高鐵台北到台中 1490 信用卡',
    vtext: {
      simple: { example: '「計程車 250」' },
      standard: { example: '「高鐵台北到台中 1490 信用卡」', fields: '交通類型、公司、出發地、到達地、票價、備註、付款方式' },
    },
    fields: [
      F('travel', 'type', 'travelType', { adv: true, req: true, q: '要記錄哪一種交通？' }),
      F('travel', 'date', 'date', { adv: true, q: DATE_Q }),
      F('travel', 'company', 'text', { max: 40, q: '公司（航空公司／船公司／平台）？' }),
      F('travel', 'no', 'text', { max: 30, q: '班次／車次／編號？' }),
      F('travel', 'depPort', 'text', { max: 40, adv: true, q: '出發地？' }),
      F('travel', 'arrPort', 'text', { max: 40, adv: true, q: '到達地？' }),
      F('travel', 'transitPort', 'text', { max: 40, q: '經停？' }),
      F('travel', 'depTime', 'time', { opts: [], q: '出發時間？（例如 14:30）' }),
      F('travel', 'arrTime', 'time', { opts: [], q: '到達時間？（例如 16:45）' }),
      F('travel', 'seat', 'text', { max: 20, q: '座位／艙位？' }),
      F('travel', 'vehicleType', 'text', { max: 30, q: '車種／機型／船型？' }),
      F('travel', 'ticketPrice', 'amount', { adv: true, req: true, q: '票價（金額）多少？（請輸入數字）' }),
      F('travel', 'payment', 'payment', { adv: true, q: '付款方式？' }),
      F('travel', 'recorder', 'person', { confirmDefault: true, q: '紀錄者是誰？' }),
      F('travel', 'note', 'text', { max: 80, q: '備註？（選填）' }),
    ],
  };
  // ---------- V10.4：分帳（網頁「新增支出」表單）、集點卡（「記一筆」）、待去清單（「新增項目」）----------
  //   欄位順序＝網頁表單的順序；群組與成員、孩子與行為、分類都對照使用者自己的資料。
  //   這三個功能只有「建立網頁待確認草稿」這一條路（資料都在網頁裡）：按「確認送出」→ 草稿 → 到網頁按【確認新增】才正式儲存。
  const SPLIT_CAT_PAIRS = SPLIT_CAT_IDS.map((id) => [SPLIT_CAT_LABEL[id], id, id === 'food' ? ['吃飯'] : []]);
  REC4_SCHEMAS.split = {
    kind: 'split', fn: 'split_add', icon: '🧾', name: '分帳', cat: 'split', itemKey: 'desc', moneyKey: 'amount', flagshipReady: true,
    needLists: true, listWord: '分帳群組與成員', timeFallback: 'message', backText: '紀錄',
    examples: ['晚餐 1200', '唱歌 3000'], sentence: '日本旅行 火鍋2400 小燕先付 我跟小明分',
    simpleFields: ['品項', '金額'],
    vtext: {
      simple: { example: '「晚餐 1200」、「唱歌 3000」' },
      standard: { example: '「日本旅行 火鍋2400 小燕先付 我跟小明分」、「晚餐 1200 AA」', fields: '分帳群組、品項、金額、幣別、誰先付錢、分給誰、付款方式、備註' },
      flagship: {
        rule: '依照完整表單順序一次一問，不擅自刪除、合併或縮減欄位；已辨識的資料會自動帶入並請您確認，未提及資料不自行編造；金額若未寫明幣別，預設為該分帳群組的幣別（群組沒設定幣別時為新臺幣 TWD）；資料全部填寫完成後，顯示完整紀錄供您確認後存檔。' }, // 分帳的幣別以群組為準（和網頁表單一致），所以這一句和其他功能不同
    },
    fields: [
      F('split', 'group', 'group', Object.assign({ adv: true, req: true, confirmDefault: true, q: '要記在哪個分帳群組？' }, REC4_HOOK.group)),
      F('split', 'entry', 'entry', Object.assign({ q: '這一筆是支出還是收入？（收入＝收款，例如退款、代收）' }, rec4Enum([['支出', 'expense', ['花費']], ['收入', 'income', ['收款', '入帳', '退款']]]))),
      F('split', 'date', 'date', { q: DATE_Q }),
      F('split', 'time', 'time', { q: TIME_Q }),
      F('split', 'cat', 'splitCat', Object.assign({ q: '類別？（' + SPLIT_CAT_IDS.map((id) => SPLIT_CAT_LABEL[id]).join('、') + '）' }, rec4Enum(SPLIT_CAT_PAIRS, REC4_SPLIT_CAT_ORDER))),
      F('split', 'desc', 'text', { max: 40, adv: true, q: '品項？（例如：晚餐、住宿、計程車）' }),
      F('split', 'amount', 'amount', { adv: true, req: true, positive: true, after: (S, it) => rec4SplitRevalidate(S, it), q: '金額多少？（這一筆的總金額，請輸入大於 0 的數字）' }), // 改了總金額 → 原本的各自金額加起來不一樣了，要清掉重問
      F('split', 'currency', 'splitCurrency', Object.assign({ askNote: '（未填寫時，預設該分帳群組的幣別）', q: (S, it) => '幣別？（沒指定的話，用這個群組的幣別 ' + rec4SplitCur(S, it) + '）' }, REC4_HOOK.splitCurrency)),
      F('split', 'payer', 'payer', Object.assign({ adv: true, req: true, q: (S, it) => (it.fields.entry === 'income' ? '誰收款？' : '誰先付錢？') }, REC4_HOOK.payer)),
      F('split', 'payment', 'payment', { q: '付款方式？' }),
      F('split', 'splitType', 'splitType', Object.assign({ q: '如何分？（均分＝大家平均分攤；自訂金額＝每個人金額不同）' }, rec4Enum([['均分', 'equal', ['平分', 'aa']], ['自訂金額', 'custom', ['自訂']]]), REC4_HOOK.splitType)),
      F('split', 'participants', 'members', Object.assign({ adv: true, q: '分給誰？（點「全部成員」＝大家均分；只有一位直接點名字；多位請輸入名字、用頓號隔開，例如：小明、小華）' }, REC4_HOOK.participants)),
      F('split', 'customShares', 'shares', Object.assign({ askNote: '（如何分選「自訂金額」才問）', req: true, when: (it) => it.fields.splitType === 'custom', q: (S, it) => '每個人各自的金額？（總和要等於 ' + (it.fields.amount !== undefined ? it.fields.amount : '總金額') + '）\n分攤的人：' + rec4SharePeople(S, it).join('、') + '\n格式：名字 金額，用頓號隔開，例如：' + (rec4SharePeople(S, it).slice(0, 2).map((n, i) => n + ' ' + (i ? 700 : 300)).join('、') || '小明 300、小華 700') }, REC4_HOOK.customShares)),
      F('split', 'recorder', 'person', { confirmDefault: true, q: '紀錄者是誰？' }),
      F('split', 'note', 'text', { max: 80, q: '備註？（選填）' }),
    ],
  };
  REC4_SCHEMAS.sticker = {
    kind: 'sticker', fn: 'sticker', icon: '🌟', name: '集點卡', cat: 'sticker', itemKey: 'behavior', moneyKey: 'points', flagshipReady: true,
    needLists: true, listWord: '孩子與行為清單', timeFallback: 'message', backText: '功能選單',
    examples: ['小明 刷牙'], sentence: '小明今天自己刷牙，加2點',
    simpleFields: ['孩子', '行為（點數用行為在 App 設定的點數）'],
    goText: { simple: '👉 現在請輸入「孩子＋行為」（也可以直接傳照片）' },
    vtext: {
      simple: { how: '輸入「孩子＋行為」即可完成紀錄；系統自動辨識孩子與行為，並依照所屬功能寫入對應欄位（點數用該行為在 App 裡設定的點數）。', example: '「小明 刷牙」' },
      standard: { example: '「小明今天自己刷牙，加2點」、「互助 洗碗 加2點」', fields: '集點卡種類（乖寶寶／互助）、孩子、行為、點數、原因、日期時間' },
      flagship: { rule: '依照完整表單順序一次一問，不擅自刪除、合併或縮減欄位；已辨識的資料會自動帶入並請您確認，未提及資料不自行編造；資料全部填寫完成後，顯示完整紀錄供您確認後存檔。' }, // 集點卡沒有金額，所以沒有「幣別」那一句
    },
    fields: [
      F('sticker', 'card', 'card', Object.assign({ adv: true, q: '要記哪一種集點卡？（乖寶寶集點卡：孩子的行為加點；互助集點卡：兩個人互相加點、扣點）' }, rec4Enum([['乖寶寶集點卡', 'kid', ['乖寶寶', '孩子']], ['互助集點卡', 'mutual', ['互助']]]))),
      F('sticker', 'kid', 'kid', Object.assign({ askNote: '（乖寶寶集點卡才問）', adv: true, req: true, when: (it) => it.fields.card !== 'mutual', q: '要幫哪個孩子集點？' }, REC4_HOOK.kid)),
      F('sticker', 'behavior', 'behavior', Object.assign({ askNote: '（乖寶寶集點卡才問）', adv: true, req: true, when: (it) => it.fields.card !== 'mutual', q: '是哪個行為？（可以點選，也可以輸入清單以外的自訂行為）' }, REC4_HOOK.behavior)),
      F('sticker', 'points', 'points', Object.assign({ adv: true, req: true, confirmDefault: true, q: '點數？（加點填正數、扣點填負數，不能是 0；例如 2 或 -1）' }, REC4_HOOK.points)),
      F('sticker', 'date', 'date', { q: DATE_Q }),
      F('sticker', 'time', 'time', { q: TIME_Q }),
      F('sticker', 'recorder', 'person', { confirmDefault: true, q: '紀錄者是誰？' }),
      F('sticker', 'note', 'text', { max: 80, q: '原因／備註？（選填）' }),
    ],
  };
  REC4_SCHEMAS.wish = {
    kind: 'wish', fn: 'wish_add', icon: '📍', name: '待去清單', cat: 'wish', itemKey: 'name', moneyKey: '', flagshipReady: true,
    needLists: true, listWord: '待去清單', timeFallback: 'suggest', backText: '待去清單',
    examples: ['九份老街', '台南林百貨'], sentence: '週末想去台南林百貨，朋友推薦的',
    simpleFields: ['項目名稱', '提議者（網頁必填，會問一次）'],
    goText: { simple: '👉 現在請輸入「地點名稱」（也可以直接傳照片）' },
    vtext: {
      simple: { how: '輸入「地點名稱」即可完成紀錄；系統自動辨識地點名稱，並依照所屬功能寫入對應欄位。', example: '「九份老街」、「台南林百貨」' },
      standard: { example: '「週末想去台南林百貨，朋友推薦的」、「想去日本京都 賞楓 11月」', fields: '項目名稱、分類、國家、城市、詳細地點、推薦原因、來源、預計時間、備註' },
      flagship: { rule: '依照完整表單順序一次一問，不擅自刪除、合併或縮減欄位；已辨識的資料會自動帶入並請您確認，未提及資料不自行編造；資料全部填寫完成後，顯示完整紀錄供您確認後存檔。' }, // 待去清單沒有金額，所以沒有「幣別」那一句
    },
    fields: [
      F('wish', 'category', 'wishCat', Object.assign({ adv: true, q: '分類？' }, REC4_HOOK.wishCat)),
      F('wish', 'name', 'text', { max: 60, adv: true, req: true, q: '項目名稱？（店家、景點名稱）' }),
      F('wish', 'country', 'text', { max: 30, adv: true, q: '國家／地區？' }),
      F('wish', 'city', 'text', { max: 30, adv: true, q: '城市／地區？' }),
      F('wish', 'detailPlace', 'text', { max: 80, adv: true, q: '詳細地點／商家？（地址或商家名稱）' }),
      F('wish', 'reason', 'text', { max: 100, adv: true, q: '推薦原因？（為什麼想去）' }),
      F('wish', 'notes', 'text', { max: 100, q: '備註？（選填）' }),
      F('wish', 'source', 'text', Object.assign({ max: 30, q: '來源？（資訊是從哪裡看到的，例如 Instagram、朋友推薦）' }, REC4_HOOK.wishSource)),
      F('wish', 'rating', 'wishRating', Object.assign({ defNote: '沒填的話，網頁預設 5 顆星', q: '推薦指數？（3～5 顆星）' }, REC4_HOOK.wishRating)),
      F('wish', 'proposer', 'person', Object.assign({ adv: true, req: true, q: '提議者是誰？（網頁待去清單的必填欄位）' }, REC4_HOOK.wishProposer)),
      F('wish', 'suggestDate', 'date', { defNote: '沒填的話，用 LINE 傳送的日期', q: '提議日期？（點「今天」，或輸入 2026-11-05、11月5日）' }),
      F('wish', 'status', 'wishStatus', Object.assign({ defNote: '沒填的話，狀態預設「待去」', q: '狀態？' }, REC4_HOOK.wishStatus)),
      F('wish', 'targetTime', 'text', { max: 30, q: '預計時間？（例如 2027年3月、週末、未定）' }),
      F('wish', 'recorder', 'person', { confirmDefault: true, q: '紀錄者是誰？' }),
    ],
  };
})();
function rec4Field(sch, key) { return sch.fields.find((f) => f.key === key) || null; }

// ---------- 把使用者輸入的答案，整理成網頁表單認得的值（全部是純函式）----------
function rec4ParseDate(text, ts) {
  const t = String(text || '').replace(/\s+/g, '');
  const today = tpParts(ts).date;
  const addDays = (n) => new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
  if (/^(今天|今日)$/.test(t)) return today;
  if (/^昨(天|日)$/.test(t)) return addDays(-1);
  if (/^前(天|日)$/.test(t)) return addDays(-2);
  if (/^大前(天|日)$/.test(t)) return addDays(-3);
  let m = t.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})[日號]?$/);
  if (m) return normDate(m[1] + '-' + m[2] + '-' + m[3]);
  m = t.match(/^(\d{1,2})月(\d{1,2})[日號]?$/);
  if (m) return normDate(today.slice(0, 4) + '-' + m[1] + '-' + m[2]);
  return ''; // 「11/5」可能是 11月5日，也可能是 5月11日：不猜
}
function rec4ParseTime(text, ts) {
  const t = String(text || '').replace(/\s+/g, '').replace(/：/g, ':');
  if (/^(現在|剛剛|剛才|此刻)$/.test(t)) return tpParts(ts).time;
  let m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return normTime(m[1] + ':' + m[2]);
  m = t.match(/^(凌晨|上午|早上|中午|下午|晚上|傍晚)?(\d{1,2})[點時](半|(\d{1,2})分?)?$/);
  if (!m) return '';
  let h = +m[2];
  const mi = m[3] === '半' ? 30 : (m[4] ? +m[4] : 0);
  const per = m[1] || '';
  if ((per === '下午' || per === '晚上' || per === '傍晚') && h < 12) h += 12;
  else if (per === '中午' && h < 6) h += 12;
  else if (per === '凌晨' && h === 12) h = 0;
  return normTime(h + ':' + ('0' + mi).slice(-2));
}
function rec4ParseCountry(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (/^(台灣|臺灣|台湾|taiwan|tw)$/i.test(t)) return '臺灣';
  if (/^(中國|大陸|中国|china|cn)$/i.test(t)) return '中國';
  return dStr(text, 30);
}
const REC4_TRANSPORT_WORD_RE = /^(航班|飛機|船班|渡輪|高鐵|火車|台鐵|地鐵|捷運|打車|計程車|uber|taxi)\s+(.+)$/i;
// 簡易版的「品項＋金額」拆法：只處理一看就懂的短句（一個金額）；有多個數字就不硬拆，交給 AI
function rec4SimpleParse(kind, text, lists) {
  const t0 = String(text || '').replace(/(\d),(\d{3})/g, '$1$2').trim();
  if (!t0 || t0.length > 60) return null;
  // V10.4：集點卡的簡易版＝「孩子＋行為」（結尾可以多一個點數）；待去清單的簡易版＝「地點名稱」
  if (kind === 'sticker') {
    let r = localParseSticker(t0, lists);
    if (r.length) return r[0];
    const pm = t0.match(/^(.+?)\s*([+＋\-－]?\s*\d+(?:\.\d+)?)\s*點?$/);
    if (pm) {
      r = localParseSticker(pm[1], lists);
      const pn = Number(pm[2].replace(/\s+/g, '').replace(/[+＋]/g, '').replace(/[－−]/g, '-'));
      if (r.length && isFinite(pn) && pn !== 0) return Object.assign({}, r[0], { points: pn });
    }
    return null;
  }
  if (kind === 'wish') {
    const wm = t0.match(/^(?:新增待去(?:地點)?|加入待去(?:清單)?|想要去|想去|待去|想逛)\s*[：:，,、]?\s*(\S.*)$/);
    const name = (wm ? wm[1] : t0).trim();
    return name && name.length <= 60 ? { kind: 'wish', name } : null;
  }
  const t = t0;
  const nums = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const after = t.charAt(m.index + m[0].length);
    const before = m.index > 0 ? t.charAt(m.index - 1) : '';
    if (/[杯份個人位張件瓶碗盤顆片串%點:號月日年時分秒]/.test(after) || before === ':' || before === '：') continue; // 「3杯」「12:30」不是金額
    nums.push({ s: m[0], i: m.index });
  }
  if (nums.length > 1) return null;
  const amount = nums.length ? Number(nums[0].s) : null;
  let item = nums.length ? (t.slice(0, nums[0].i) + ' ' + t.slice(nums[0].i + nums[0].s.length)) : t;
  item = item.replace(/NT\$|NTD|TWD|＄|\$|元|塊|圓/gi, ' ').replace(/[\s，,。.!！、]+/g, ' ').trim();
  if (!item && amount === null) return null;
  const raw = { kind };
  if (kind === 'split') { // 分帳：「晚餐 1200」「晚餐 1200 AA」「唱歌 3000 我先付」—— AA／均分、我先付 是看得懂的線索，其他一概不猜
    const all = /(AA制?|均分|平分|分攤|各付)/i.test(item);
    const meFirst = /(我先付|我付|我代墊|我先墊|我出)/.test(item);
    item = item.replace(/AA制?|均分|平分|分攤|各付|我先付|我付|我代墊|我先墊|我出|分帳/gi, ' ').replace(/[\s，,。.!！、]+/g, ' ').trim();
    if (!item && amount === null) return null;
    if (item) raw.desc = item;
    if (amount !== null) raw.amount = amount;
    if (all) raw.splitAll = true;
    if (meFirst) raw.payer = '我';
    return raw;
  }
  if (amount !== null) raw.amount = amount;
  if (kind === 'drink') { if (item) raw.drinkName = item; }
  else if (kind === 'food') { if (item) raw.dish = item; }
  else {
    if (amount !== null) { raw.ticketPrice = amount; delete raw.amount; }
    let rest = item;
    const tw = rest.match(REC4_TRANSPORT_WORD_RE);
    if (tw) { raw.type = normTravelType(tw[1]); rest = tw[2].trim(); }
    else if (normTravelType(rest)) { raw.type = normTravelType(rest); rest = ''; }
    const rm = rest.match(/^(.{1,20}?)\s*(?:到|→|->|至)\s*(.{1,20})$/);
    if (rm) { raw.depPort = rm[1].trim(); raw.arrPort = rm[2].trim(); }
    else if (rest) raw.note = rest;
  }
  return raw;
}

// AI 不能用的時候，標準版只收「一看就是『品項 金額』」的短句：句子裡還混著大小、甜度、冰塊、付款方式這些詞，代表是一整句描述，
// 沒有 AI 就拆不開，硬收會把整句話塞進品名欄（寫錯欄位）。這種情況改請使用者用「品項 金額」或進階版。
const REC4_ATTR_WORD_RE = /(大杯|中杯|小杯|少糖|微糖|半糖|無糖|全糖|去冰|少冰|微冰|正常冰|現金|信用卡|悠遊卡|一卡通|街口|轉帳|刷卡|linepay|applepay|googlepay)/i;
function rec4FallbackOk(kind, raw) {
  if (kind === 'sticker') return !!(raw.kid && raw.behavior); // 只有「孩子＋行為」都完全對上清單才收
  if (kind === 'wish') return !!raw.name;
  const amt = kind === 'travel' ? raw.ticketPrice : raw.amount;
  if (amt === undefined || amt === null) return false; // 沒有金額 → 不是「品項 金額」，也可能只是閒聊
  if (kind === 'travel') return true;
  const name = String((kind === 'drink' ? raw.drinkName : (kind === 'split' ? raw.desc : raw.dish)) || '');
  if (!name) return true;
  return name.length <= 12 && !REC4_ATTR_WORD_RE.test(name.replace(/\s+/g, ''));
}

// 回答 → { ok:true, value } ｜ { ok:true, skip:true } ｜ { ok:false, msg }（ok:true 時可能多一個 warn：值收下了，但要標「待確認」）
function rec4Parse(S, f, rawText) {
  const text = rec4Clean(rawText);
  const it = (S.items && S.items[S.i]) || { fields: {}, uncertain: [], notes: {}, src: {}, skip: {} };
  if (!text) return { ok: false, msg: '沒有收到內容，請再回答一次。' };
  if (REC4_SKIP_RE.test(text) && !(f.type === 'topping' && /^(無|沒有|沒)$/.test(text))) {
    if (rec4IsReq(S, it, f)) return { ok: false, msg: '「' + f.label + '」是必填的，不能略過。' + (/不知道|不確定|不清楚/.test(text) ? '真的不確定的話，請先給一個大概的內容，之後可以在網頁再修改。' : '') };
    return { ok: true, skip: true };
  }
  const bad = (msg) => ({ ok: false, msg });
  if (f.parse) return f.parse(S, it, text); // V10.4：分帳／集點卡／待去清單的欄位（要對照使用者自己的清單）自己有一套解析
  switch (f.type) {
    case 'text': { const v = dStr(text, f.max || 40); return v ? { ok: true, value: v } : bad('沒看懂這個內容，請再輸入一次。'); }
    case 'amount': { const n = normAmount(text); if (n === null) return bad('金額請輸入數字，例如：60'); if (f.positive && !(n > 0)) return bad('金額要大於 0，請再輸入一次。'); return { ok: true, value: n }; }
    case 'date': { const d = rec4ParseDate(text, S.ts); return d ? { ok: true, value: d } : bad('看不懂這個日期。請點「今天」「昨天」，或輸入 2026-11-05、11月5日（「11/5」可能是 11月5日也可能是 5月11日，我不猜）。'); }
    case 'time': { const t = rec4ParseTime(text, S.ts); return t ? { ok: true, value: t } : bad('看不懂這個時間。請輸入 14:30、下午3點，或點「現在」。'); }
    case 'country': { const v = rec4ParseCountry(text); return v ? { ok: true, value: v } : bad('沒看懂這個國家，請再輸入一次。'); }
    case 'size': { const n = normSize(text); return n ? { ok: true, value: n.v } : bad('沒看懂 SIZE，請點選或再輸入一次。'); }
    case 'topping': { const n = normTopping(text); return n ? { ok: true, value: n.v } : bad('沒看懂加料，請點選或再輸入一次（沒有加料請點「無」）。'); }
    case 'sugar': { const n = normSugar(text); return n && n.known ? { ok: true, value: n.v } : bad('網頁表單的甜度沒有這個選項，請點下面的選項（或輸入：無糖、微糖、半糖、少糖、全糖、三分糖…）。'); }
    case 'ice': { const n = normIce(text); return n && n.known ? { ok: true, value: n.v } : bad('網頁表單的冰塊沒有這個選項，請點下面的選項。'); }
    case 'payment': { const n = normPayment(text); return n ? { ok: true, value: n.v } : bad('沒看懂支付方式，請點選或再輸入一次。'); }
    case 'currency': { const n = normCurrency(text); return n ? { ok: true, value: n.v } : bad('請選擇幣別（NT$、RMB¥、JPY¥、KRW₩），或輸入 TWD、JPY 這類代碼。'); }
    case 'person': {
      if (ME_RE.test(text) && !S.sender) return bad('我在 LINE 裡看不到你的名稱，請直接輸入名字（例如 XiaoGe）。');
      const n = normPerson(text, S.sender);
      return n ? { ok: true, value: n.v } : bad('沒看懂這個名字，請再輸入一次。');
    }
    case 'rating': {
      const n = Number(text.replace(/[顆星分★\s]/g, ''));
      if (n === 0) return { ok: true, skip: true };
      return n >= 1 && n <= 5 ? { ok: true, value: Math.round(n) } : bad('評分請輸入 1～5。');
    }
    case 'choice': { const n = normChoice(text, f.list || [], f.table || [], 12); return n ? { ok: true, value: n.v } : bad('沒看懂這個內容，請點選或再輸入一次。'); }
    case 'travelType': {
      const tt = TRAVEL_TYPE_TRIGGERS[text] || normTravelType(text.replace(/^\S+\s+/, '')) || normTravelType(text);
      return tt ? { ok: true, value: tt } : bad('請從下面選一種交通：航班、船班、高鐵、火車、地鐵、打車。');
    }
    default: return bad('這一題暫時無法處理。');
  }
}
function rec4Options(S, f, it) {
  if (f.options) return f.options(S, it || (S.items && S.items[S.i]) || { fields: {} }); // V10.4：依使用者清單／前面的答案決定的按鈕
  if (f.opts) return f.opts.slice();
  switch (f.type) {
    case 'date': return ['今天', '昨天', '前天'];
    case 'time': return ['現在'];
    case 'country': return ['臺灣', '中國'];
    case 'size': return ['S', 'M', 'L', '瓶裝', '壺裝'];
    case 'topping': return ['無', '珍珠', '椰果', '布丁', '仙草', '蘆薈', '小芋圓', '波霸'];
    case 'sugar': return ['無糖', '一分糖', '二分糖', '微糖', '半糖', '少糖', '全糖'];
    case 'ice': return ['正常冰', '多冰', '少冰', '微冰', '去冰', '完全去冰', '溫', '熱'];
    case 'payment': return ['現金', '信用卡', '簽帳金融卡', 'Apple Pay', 'Google Pay', 'LINE Pay', '街口支付', '轉帳'];
    case 'currency': return [{ label: 'NT$ 新臺幣', text: 'NT$' }, 'RMB¥', 'JPY¥', 'KRW₩'];
    case 'person': return ['我', 'XiaoGe', 'XiaoYan'].concat(f.key === 'drinker' || f.key === 'eater' ? ['Together'] : []);
    case 'rating': return ['1', '2', '3', '4', '5'];
    case 'travelType': return Object.keys(TRAVEL_TYPE_TRIGGERS).map((lab) => ({ label: lab, text: lab.replace(/^\S+\s+/, '') }));
    default: return [];
  }
}
function rec4Show(sch, f, item, S) {
  const v = item.fields[f.key];
  if (f.show) return f.show(v, item, S);
  switch (f.key) {
    case 'sugar': return SUGAR_LABEL[v] || String(v);
    case 'ice': return ICE_LABEL[v] || String(v);
    case 'type': return TRAVEL_TYPE_LABELS[v] || String(v);
    case 'amount': case 'ticketPrice': return (item.fields.currency || (S && sch.kind === 'split' ? rec4SplitCur(S, item) : 'NT$')) + ' ' + v;
    case 'currency': return v === 'NT$' ? 'NT$（新臺幣 TWD）' : String(v);
    case 'rating': return '★'.repeat(Math.max(1, Math.min(5, Math.round(Number(v) || 0)))) + ' ' + v;
    default: return String(v);
  }
}

// ---------- 一筆紀錄（網頁表單的欄位名稱）----------
function rec4Has(it, key) {
  if (key === 'participants') { const p = it.fields.participants; return (Array.isArray(p) && p.length > 0) || it.fields.splitAll === true; } // 分帳「分給誰」：指定了名單，或選了「全部成員」
  const v = it.fields[key];
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (key === 'rating') return Number(v) > 0;
  return true;
}
function rec4NewItem(S) {
  const it = { fields: {}, uncertain: [], notes: {}, unmapped: {}, skip: {}, src: {} };
  if (S.sender) { it.fields.recorder = S.sender; it.src.recorder = 'default'; } // 紀錄者＝傳訊息的人（LINE 身分，不是猜的）
  if (S.module === 'sticker' && !rec4Lists(S).kids.length) { it.fields.card = 'mutual'; it.src.card = 'default'; } // 集點卡裡沒有任何孩子：只能記互助集點卡
  if (S.module === 'split' && rec4Lists(S).groups.length === 1) { it.fields.group = rec4Lists(S).groups[0].name; it.src.group = 'default'; } // 只有一個分帳群組：預設選它（畫面上標「預設」，旗艦版會請你確認）
  return it;
}
function rec4ItemFromNorm(norm, src) {
  const it = { fields: Object.assign({}, norm.fields), uncertain: (norm.uncertain || []).slice(), notes: Object.assign({}, norm.notes || {}), unmapped: Object.assign({}, norm.unmapped || {}), skip: {}, src: {} };
  Object.keys(it.fields).forEach((k) => { it.src[k] = (k === 'recorder' || (norm.defaults || []).indexOf(k) >= 0) ? 'default' : src; });
  return it;
}
// 只有一個分帳群組、使用者沒指定：草稿整理時會「暫用並標待確認」；四種版本的畫面上，使用者看得到這個預設（標「預設」），所以改成預設值，不再標待確認
function rec4GroupDefault(S, raw, norm) {
  if (!norm || !norm.fields) return;
  if (S.module === 'sticker') { // 沒講點數：整理草稿時帶入的是這個行為在 App 裡設定的點數（清單裡的真實設定，不是猜的）→ 當成預設值，畫面上標「預設」
    if ((!raw || raw.points === undefined || raw.points === null || raw.points === '') && norm.fields.points !== undefined) norm.defaults = (norm.defaults || []).concat(['points']);
    return;
  }
  if (S.module !== 'split') return;
  const gs = rec4Lists(S).groups;
  if (gs.length !== 1 || (raw && raw.group) || norm.fields.group !== gs[0].name) return;
  norm.uncertain = (norm.uncertain || []).filter((k) => k !== 'group');
  if (norm.notes) delete norm.notes.group;
  norm.defaults = (norm.defaults || []).concat(['group']);
}
// 把辨識到的欄位補進「還是空的」欄位；已經有的（使用者自己回答過的）一律不覆蓋
function rec4MergeInto(it, norm, src) {
  const filled = [];
  Object.keys(norm.fields).forEach((k) => {
    if (k === 'recorder' || rec4Has(it, k)) return;
    if ((k === 'splitAll' && rec4Has(it, 'participants')) || (k === 'participants' && it.fields.splitAll === true)) return; // 「分給誰」已經有答案
    it.fields[k] = norm.fields[k]; it.src[k] = src; delete it.skip[k]; filled.push(k);
    if ((norm.uncertain || []).indexOf(k) >= 0 && it.uncertain.indexOf(k) < 0) it.uncertain.push(k);
    if (norm.notes && norm.notes[k]) it.notes[k] = norm.notes[k];
  });
  Object.keys(norm.unmapped || {}).forEach((k) => { if (it.unmapped[k] === undefined) it.unmapped[k] = norm.unmapped[k]; });
  return filled;
}
function rec4SetValue(it, key, value, S) {
  if (key === 'participants') {
    if (value === REC4_ALL) { it.fields.splitAll = true; delete it.fields.participants; } // 全部成員＝網頁表單預設的均分
    else { it.fields.participants = value; delete it.fields.splitAll; }
    delete it.src.splitAll;
  } else it.fields[key] = value;
  it.src[key] = 'ask'; delete it.skip[key]; delete it.notes[key];
  it.uncertain = it.uncertain.filter((k) => k !== key);
  const f = S && REC4_SCHEMAS[S.module] ? rec4Field(REC4_SCHEMAS[S.module], key) : null;
  if (f && f.after) f.after(S, it); // 例如：換了分帳群組，不屬於新群組的付款人、分攤名單要清掉重問
}
function rec4ClearValue(it, key) {
  delete it.fields[key]; delete it.src[key]; delete it.notes[key];
  if (key === 'participants') { delete it.fields.splitAll; delete it.src.splitAll; }
  it.uncertain = it.uncertain.filter((k) => k !== key);
}
// 這一筆還要問哪些欄位（依版本）：必填一定要有；進階版問 adv 欄位；旗艦版問全部欄位。已辨識／已回答的不重問；不太確定的（⚠）會請使用者確認
//   V10.4：有些欄位只在特定情況才出現（when：例如「各自金額」只有「如何分＝自訂金額」才問），必填也可以看情況（req 是函式）；
//   已經有值、但對不上使用者清單的（invalid：例如付款人不是群組成員）不算有答案，一定重問
function rec4Queue(S, it) {
  const sch = REC4_SCHEMAS[S.module];
  const out = [];
  sch.fields.forEach((f) => {
    if (!rec4Active(S, it, f)) return;
    const req = rec4IsReq(S, it, f);
    const has = rec4Has(it, f.key) && !(f.invalid && f.invalid(S, it));
    const unc = it.uncertain.indexOf(f.key) >= 0 && it.src[f.key] !== 'ask'; // 使用者自己回答過的（即使因為「依名稱對應」等原因仍標待確認），不再重複問；確認畫面和草稿上照樣標示
    if (it.skip[f.key] && !req) return; // 使用者已經明說略過
    let ask = false;
    if (req) ask = !has || (unc && (S.version === 'advanced' || S.version === 'flagship')) || (S.version === 'flagship' && it.src[f.key] === 'default' && !!f.confirmDefault);
    else if (S.version === 'advanced') ask = !!f.adv && (!has || unc);
    else if (S.version === 'flagship') ask = !S.restSkip && (!has || unc || (it.src[f.key] === 'default' && !!f.confirmDefault));
    if (ask) out.push(f.key);
  });
  return out;
}

// ---------- 照片：LINE 下載 → Gemini 視覺辨識（失敗一律退回文字流程，不中斷）----------
function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
async function lineImageContent(token, message) {
  try {
    if (!message || !message.id) return { ok: false, reason: 'noid' };
    if (message.contentProvider && message.contentProvider.type === 'external') return { ok: false, reason: 'external' };
    const res = await fetch('https://api-data.line.me/v2/bot/message/' + encodeURIComponent(message.id) + '/content', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return { ok: false, reason: 'http' + res.status };
    if (Number(res.headers.get('content-length') || 0) > REC4_MAX_IMAGE) return { ok: false, reason: 'toolarge' };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return { ok: false, reason: 'empty' };
    if (bytes.length > REC4_MAX_IMAGE) return { ok: false, reason: 'toolarge' };
    const mime = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    return { ok: true, bytes, mime: /^image\//.test(mime) ? mime : 'image/jpeg' };
  } catch (e) { return { ok: false, reason: 'error' }; }
}
function rec4PhotoPrompt(kind, nowMs) {
  const tp = tpParts(nowMs);
  const dow = ['日', '一', '二', '三', '四', '五', '六'][tp.dow];
  const name = { drink: '飲料', food: '美食', travel: '交通', split: '分帳', sticker: '集點卡', wish: '待去清單' }[kind] || kind;
  const hint = {
    drink: '飲料照片（杯身貼紙或 LOGO、收據、訂單截圖、菜單）：可以看品牌、品名、杯型（SIZE）、價格、日期時間。甜度、冰塊通常看不出來，除非杯貼或收據清楚印出才填；價格要有收據、杯貼或訂單上的明確數字。',
    food: '美食照片（餐點、菜單、收據、訂單截圖）：可以看店家、餐點名稱、價格、日期時間。菜系、份量、辣度、用餐方式只有菜單或收據明確寫出才填，不要從菜色外觀推測；價格要有菜單或收據上的明確數字。',
    travel: '交通照片（車票、機票、登機證、收據、行程截圖）：可以看交通類型、公司、班次或車次、出發地與到達地、出發與到達時間、座位、票價、日期。',
    split: '分帳照片（收據、帳單、訂單截圖、行程費用截圖）：可以看品項、總金額、幣別、日期時間、付款方式。分帳群組、誰先付錢、分給誰這些照片上看不出來的，一律填 null（不要自己推測）。',
    sticker: '集點卡照片（手寫便條、聊天截圖、獎勵表）：只有照片上清楚寫出孩子的名字、做了什麼行為、幾點的，才填對應欄位；看起來只是一般生活照、沒有任何文字說明，就回傳 {"items":[],"quality":"irrelevant"}。',
    wish: '待去清單照片（Google 地圖截圖、Instagram／Threads 貼文截圖、店家招牌、傳單、菜單）：可以看店家或景點名稱、地址、城市、國家、資訊來源平台。推薦原因、預計時間只有截圖上明確寫出才填；不要自己編推薦原因、不要補地址。',
  }[kind] || '';
  return '你是嚴格的【照片辨識】系統（生活紀錄）。核心原則：寧可缺，不可假。\n' +
    '現在是台灣時間 ' + tp.date + '（星期' + dow + '）' + tp.time + '。\n' +
    '任務：看使用者傳來的這張照片，把「照片上看得到明確依據」的內容擷取成「' + name + '」紀錄表單的欄位。只回傳一個 JSON，不要 markdown，不要其他文字。\n\n' +
    hint + '\n\n' +
    '規則（非常重要）：\n' +
    '1. 只能填照片上「看得到明確依據」的內容（印出來的文字、標籤、收據、菜單、票券）。看不清楚、被遮住、反光，或只能靠外觀猜的欄位一律填 null。禁止推測品牌、價格、地點、日期。\n' +
    '2. 一張照片有多個品項（例如收據有好幾行、一次點好幾杯）就輸出多個物件，每個品項各一個，不可合併，也不可混用不同品項的資料。最多 8 個。\n' +
    '3. 價格必須能對應到那個品項才填；只看到合計、對不上品項時，amount 填 null，並在 note 寫「合計XX元」。\n' +
    '4. date 與 time 只有照片上明確印出才填（YYYY-MM-DD、24 小時制 HH:MM），絕對不要拿現在時間代替。\n' +
    '5. uncertain 是陣列：列出「你有填值、但照片上字跡不太清楚或不太確定」的欄位名稱。\n' +
    '6. 如果照片和' + name + '紀錄無關（風景、人像、文件…），回傳 {"items":[],"quality":"irrelevant"}。\n' +
    '7. quality 填：ok（清楚）／blurry（模糊）／glare（反光）／blocked（被遮住）／partial（資訊不完整）／irrelevant（無關）。note 用一句話說明哪裡看不清楚，沒有就 null。\n\n' +
    '每個物件的格式：\n' + (DRAFT_ITEM_SCHEMA_TEXT[kind] || '') +
    '回傳格式：{"items":[…],"quality":"ok","note":null}\n';
}
const REC4_QUALITY = { blurry: '照片有點模糊', glare: '照片有反光', blocked: '照片有被遮住的地方', partial: '照片拍到的資訊不完整', irrelevant: '照片看起來和這個功能無關' };
async function rec4Recognize(bytes, mime, env, kind, nowMs) {
  const apiKey = env.SmartDailyAssistant_GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: '還沒設定 AI 金鑰' };
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const body = {
    contents: [{ role: 'user', parts: [{ text: rec4PhotoPrompt(kind, nowMs) }, { inline_data: { mime_type: mime, data: bytesToBase64(bytes) } }] }],
    generationConfig: { maxOutputTokens: 2500, thinkingConfig: { thinkingBudget: 0 } },
  };
  let up;
  try { up = await fetch(GEMINI_BASE + encodeURIComponent(model) + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, reason: '連不上 AI 服務' }; }
  const g = await up.json().catch(() => null);
  if (!up.ok || !g) return { ok: false, reason: up.status === 429 ? 'AI 額度用完了' : 'AI 服務暫時沒回應（' + up.status + '）' };
  let out = '';
  const cand = g.candidates && g.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) out = cand.content.parts.map((p) => (p && p.text) ? p.text : '').join('');
  const m = out.match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch (e) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.items)) return { ok: false, reason: 'AI 回傳的內容看不懂' };
  const items = parsed.items.filter((it) => it && typeof it === 'object').slice(0, DRAFT_MAX_ITEMS);
  const q = String(parsed.quality || '').toLowerCase();
  return { ok: true, items, quality: q, note: dStr(parsed.note, 80) };
}
function rec4PhotoWhy(reason) {
  if (/^http4(04|10)$/.test(reason)) return '照片已經過期或找不到了';
  if (reason === 'toolarge') return '照片檔案太大';
  if (reason === 'external') return '這種來源的圖片讀不到';
  return '暫時讀不到這張照片';
}

// ---------- 訊息組裝 ----------
function rec4TextMsg(text, quick) {
  const m = { type: 'text', text: String(text).length > 4900 ? String(text).slice(0, 4900) + '…' : String(text) };
  if (quick && quick.length) m.quickReply = quickReplyItems(quick);
  return m;
}
async function rec4Reply(token, replyToken, msgs) {
  const messages = (msgs || []).slice(0, 5).map((m) => (typeof m === 'string' ? rec4TextMsg(m) : m));
  const plain = messages.map((m) => (m.type === 'text' ? m.text : (m.altText || ''))).filter(Boolean).join('\n\n');
  await lineReplyCards(token, replyToken, messages, plain);
}
const REC4_CANCEL_Q = { label: '❌ 取消紀錄', text: '取消紀錄' };
function rec4VersionFallback(title, textFor, note) {
  // textFor 有值：每一行教使用者輸入哪句話；textFor 為 null（只看說明的卡片）：只列版本名稱，並把「為什麼不能在這裡記錄」放在標題後面（altText 很短，不能被截掉）
  const lines = REC4_ORDER.map((v) => REC4_VERSIONS[v].emoji + ' ' + REC4_VERSIONS[v].name + '｜' + REC4_VERSIONS[v].tag + (textFor ? '：輸入「' + textFor(v) + '」' : ''));
  return title + '\n' + (!textFor && note ? note + '\n' : '') + lines.join('\n');
}
function rec4VersionCardMsg(title, sub, textFor, back, sch, cfg) {
  const viewOnly = !textFor; // V10.7.0：只看說明的版本卡（群組裡的分帳／集點卡／待去清單）：沒有「選這個版本」的按鈕，所以不可能在群組裡按下去開始記錄
  const bubbles = REC4_ORDER.map((v) => {
    const x = REC4_VERSIONS[v];
    // V10.?：使用者反應這裡的版本圓點圖示比原本 emoji 視覺上大很多、太搶眼，整張「選擇版本」卡片
    //   （標題模組圖示／版本圓點／下面返回鍵箭頭）都改回原本純文字＋emoji，不走 iconRow／iconButton；
    //   只有這個函式（rec4VersionCardMsg）不套用圖示，其餘選單、卡片不受影響。
    const body = [{ type: 'text', text: title, size: 'xs', color: '#8b8b8b', wrap: true }];
    if (sub) body.push(viewOnly ? { type: 'text', text: sub, size: 'xs', weight: 'bold', color: '#a04a00', wrap: true, margin: 'sm' } : { type: 'text', text: sub, size: 'xs', color: '#8b8b8b', wrap: true });
    body.push({ type: 'text', text: x.emoji + ' ' + x.name + '｜' + x.tag, weight: 'bold', size: 'lg', color: '#5c4b37', wrap: true, margin: 'md' });
    { // V10.12.1：rec4VerLines 裡的空字串是「空一行」的標記，不能直接送給 LINE 的 Flex Message（text 不能是空字串，送空字串整張卡會被 LINE 拒收）；改成讓下一行的 margin 變大，用間距做出空一行的視覺效果
      // V10.13.0：「範例：」那一行、進階／旗艦版的提問清單那一行（ask），改成粗體＋跟網頁 --br 一致的顏色（#8b7355），方便使用者一眼找到重點；其他行維持原樣。
      //   規則／互動規則那一行是否出現，由 rec4VerLinesFor 依後台「規則顯示」開關決定（這裡改用 rec4VerLinesFor，不是 rec4VerLines）。
      const ask = rec4AskLine(v, sch);
      let big = false, realIdx = 0;
      rec4VerLinesFor(v, sch, cfg).forEach((ln) => {
        if (ln === '') { big = true; return; }
        const emph = ln === ask || ln.indexOf('範例：') === 0;
        // V10.13.2：第一行（支援輸入）跟上面的版本名稱之間也要空一行——這一行本身不在 rec4VerLines 的陣列裡（版本名稱是 rec4VersionCardMsg 自己組的，不經過那個陣列），
        //   所以 big 這個標記（陣列內部的空字串）管不到它，這裡用 realIdx===0 直接強制第一行一定是 'xl'，不管 big 是不是 true
        body.push({ type: 'text', text: ln, size: 'xs', color: emph ? '#8b7355' : (realIdx === 0 ? '#8b8b8b' : '#3f3f3f'), weight: emph ? 'bold' : 'regular', wrap: true, margin: (realIdx === 0 || big) ? 'xl' : 'sm' });
        big = false; realIdx++;
      });
    }
    // 同上：「選這個版本」「返回」這兩顆按鈕也都改回原本純文字＋emoji 的按鈕樣式（不是圖示＋色塊的 box）。
    const foot = viewOnly ? [] : [{ type: 'button', style: 'primary', height: 'sm', color: '#8b7355', action: { type: 'message', label: (x.emoji + ' ' + x.name).slice(0, 40), text: textFor(v) } }];
    if (back) foot.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'message', label: String(back.label).slice(0, 40), text: String(back.text) } });
    const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: body } };
    if (foot.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'xs', contents: foot };
    return bubble;
  });
  return { type: 'flex', altText: rec4VersionFallback(title, textFor, sub).slice(0, 390), contents: { type: 'carousel', contents: bubbles } };
}
// V10.7.0：群組／多人聊天室裡，分帳、集點卡、待去清單只給看「版本說明卡」——不讀任何人的清單、不開始紀錄；要記錄請到 1 對 1。
//   說明卡的內容只跟「功能」有關（rec4VerLines(版本, 功能)），沒有任何個人資料，所以可以放心回在群組裡（所有人都看得到）。
function rec4ViewNote(sch) {
  return '🔒 群組、多人聊天室只能看說明。要記錄請到 1 對 1 聊天室（私訊我）。\n「' + sch.name + '」會用到你自己的' + sch.listWord + '，為了保護個人資料，記錄只在 1 對 1 進行。';
}
function rec4ViewCardMsg(sch, cfg) {
  return rec4VersionCardMsg(sch.icon + ' ' + sch.name + '紀錄：版本說明', rec4ViewNote(sch), null, { label: '↩️ 功能選單', text: '功能選單' }, sch, cfg);
}
// 回覆說明卡。功能被停用、或管理員限定了可以用的人時，照樣說明原因（不裝作能用）；群組有沒有被授權、這個功能是不是「只限 1 對 1」都不影響看說明
async function rec4ViewOnly(sch, ctx, ev, token, cfg) {
  const av = checkAvailability(sch.fn, ctx, cfg, { view: true });
  await rec4Reply(token, ev.replyToken, [av.ok ? rec4ViewCardMsg(sch, cfg) : rec4TextMsg(av.message, ['功能選單'])]);
  return av.ok;
}
function rec4ModulePrompt(lead) {
  const quick = [{ label: '🧋 飲料', text: '飲料' }, { label: '🍱 美食', text: '美食' }, { label: '🚆 交通', text: '交通' },
    { label: '🧾 分帳', text: '分帳' }, { label: '🌟 集點卡', text: '集點卡' }, { label: '📍 待去清單', text: '待去清單' }, { label: '💰 記帳', text: '記帳' }, REC4_CANCEL_Q];
  return rec4TextMsg((lead ? lead + '\n' : '') + '要記錄哪個功能？', quick);
}
// 開始紀錄時順便列出使用者自己的清單（只在 1 對 1 聊天室）：讓他知道有哪些名字可以輸入
function rec4ListHint(S) {
  const L = rec4Lists(S);
  const cut = (arr, n) => arr.slice(0, n).join('、') + (arr.length > n ? '…等 ' + arr.length + ' 個' : '');
  if (S.module === 'split') return L.groups.length ? '你的分帳群組：' + cut(L.groups.map((g) => g.name), 8) : '';
  if (S.module === 'sticker') return [L.kids.length ? '你的孩子：' + cut(L.kids.map((k) => k.name), 8) : '你的集點卡裡還沒有孩子，所以只能記互助集點卡', L.behaviors.length ? '行為：' + cut(L.behaviors.map((b) => b.name), 10) : ''].filter(Boolean).join('\n');
  if (S.module === 'wish') return S.version === 'simple' ? '' : '分類：' + cut(L.wishCats.length ? L.wishCats : WISH_DEFAULT_CATS, 10); // 簡易版不問分類，不用列
  return '';
}
function rec4Intro(S, cfg) {
  const sch = REC4_SCHEMAS[S.module], ver = REC4_VERSIONS[S.version];
  const head = ver.emoji + ' ' + ver.name + '｜' + ver.tag + '・' + sch.icon + ' ' + sch.name + '紀錄';
  // V10.13.2：進階／旗艦版原本問完版本卡直接送第一題，使用者說要跟簡易／標準版一樣先有一句引導語再開始問；
  //   逐題問答（不是像標準版自由輸入一句話），所以文字改寫成符合這個流程的說法，不是沿用標準版「請用一句話描述」那句
  const goDef = { simple: '👉 現在請輸入「品項＋金額」（也可以直接傳照片）', standard: '👉 現在請用一句話描述（也可以直接傳照片）', advanced: '👉 準備好了嗎？接下來將依序為您提問', flagship: '👉 準備好了嗎？接下來將依序為您提問' };
  const go = (sch.goText && sch.goText[S.version]) || goDef[S.version];
  const hint = sch.needLists ? rec4ListHint(S) : '';
  // V10.13.2：標題（版本名稱・模組名稱紀錄）跟下面「支援輸入」之間也補一個空一行標記，四個版本都適用，跟 Flex 版本卡的同一處改動一致
  return [head, ''].concat(rec4VerLinesFor(S.version, sch, cfg), hint ? ['', hint] : [], go ? ['', go] : []).join('\n');
}
function rec4QuickList(lead, options, controls) {
  const room = Math.max(0, 13 - lead.length - controls.length);
  return lead.concat(options.slice(0, room), controls);
}
function rec4QuestionMsg(S, it, queue, errMsg) {
  const sch = REC4_SCHEMAS[S.module], ver = REC4_VERSIONS[S.version];
  const f = rec4Field(sch, S.cur);
  const N = S.items.length;
  const editing = S.stage === 'edit_value';
  const askedMode = S.version === 'advanced' || S.version === 'flagship';
  const progress = editing ? '　（修改這一欄）' : (askedMode ? '　第 ' + (S.asked + 1) + '／' + (S.asked + queue.length) + ' 題' : '　（補問必要資訊）');
  let body = (errMsg ? '⚠️ ' + errMsg + '\n\n' : '') + ver.emoji + ' ' + ver.name + '・' + sch.icon + sch.name + (N > 1 ? '（第 ' + (S.i + 1) + '／' + N + ' 筆）' : '') + progress + '\n' + rec4Q(S, it, f);
  const has = rec4Has(it, f.key);
  const lead = [];
  if (has) {
    const unc = it.uncertain.indexOf(f.key) >= 0;
    const tag = { default: '目前預設：', photo: '📷 照片辨識到：', ask: '你之前填的：' }[it.src[f.key]] || '辨識到：';
    body += '\n' + tag + rec4Show(sch, f, it, S) + (unc ? '（⚠ 不太確定）' : '') + '\n正確請點「沿用」，或直接輸入新的內容。';
    if (unc && it.notes[f.key]) body += '\n（' + it.notes[f.key] + '）';
    lead.push({ label: '✅ 沿用', text: '沿用' });
  }
  const controls = [];
  const req = rec4IsReq(S, it, f);
  if (!req) controls.push({ label: '略過', text: '略過' });
  if (!editing && S.version === 'flagship' && !req && !S.restSkip) controls.push({ label: '⏩ 其餘略過', text: '其餘略過' });
  if (editing) controls.push({ label: '↩ 返回確認', text: '返回確認' });
  else if (S.hist.length) controls.push({ label: '🔙 上一題', text: '上一題' });
  controls.push(REC4_CANCEL_Q);
  const opts = rec4Options(S, f, it);
  if (opts.length > Math.max(0, 13 - lead.length - controls.length)) body += '\n（選項比較多，按鈕只列出一部分；也可以直接輸入）';
  return rec4TextMsg(body, rec4QuickList(lead, opts, controls));
}

// 旗艦版：幣別沒填的話，預設新臺幣 TWD（網頁的 NT$）
function rec4ApplyDefaults(S) {
  if (S.version !== 'flagship') return;
  const sch = REC4_SCHEMAS[S.module];
  if (!rec4Field(sch, 'currency')) return;
  S.items.forEach((it) => {
    if (rec4Has(it, 'currency')) return;
    it.fields.currency = sch.kind === 'split' ? rec4SplitCur(S, it) : 'NT$'; // 分帳：用群組在 App 裡設定的幣別（網頁表單也這樣預設），群組沒設才用新臺幣 TWD
    it.src.currency = 'default';
  });
}
// 這個使用者按「確認送出」之後會發生什麼事（要老實告訴他）：draft＝先建立網頁待確認草稿；direct＝直接寫入並同步；unbound＝只暫存在 LINE
async function rec4Mode(userId, env, cfg) {
  try {
    if (await draftEligibility(userId, env, cfg)) return 'draft';
    const code = env.SYNC_KV ? await env.SYNC_KV.get('line:usersync:' + userId) : null;
    return code ? 'direct' : 'unbound';
  } catch (e) { return 'direct'; }
}
function rec4SummaryText(S, mode, note) {
  const sch = REC4_SCHEMAS[S.module], ver = REC4_VERSIONS[S.version];
  const N = S.items.length;
  const parts = [(note ? note + '\n\n' : '') + '📋 請確認' + (N > 1 ? ' ' + N + ' 筆' : '這筆') + '「' + sch.icon + ' ' + sch.name + '」紀錄（' + ver.emoji + ' ' + ver.name + '）'];
  const tp = tpParts(S.startTs);
  S.items.forEach((it, idx) => {
    const lines = rec4ItemLines(S, it, true);
    const scope = (S.version === 'flagship' ? sch.fields : sch.fields.filter((f) => f.adv || rec4IsReq(S, it, f))).filter((f) => rec4Active(S, it, f));
    const miss = scope.filter((f) => !rec4Has(it, f.key)).map((f) => f.label.replace('（選填）', '') + (f.defNote ? '（' + f.defNote + '）' : ''));
    if (it.unmapped && it.unmapped.area) lines.push('（提到地點「' + it.unmapped.area + '」，但網頁美食表單沒有地點欄位，只會在草稿上提醒）');
    if (it.unmapped && it.unmapped.customShares) lines.push('（提到每個人金額不同：' + it.unmapped.customShares + '。目前先用均分；要照這個金額，請按「返回修改」，把「如何分」改成自訂金額）');
    let tail = '';
    if (sch.timeFallback === 'suggest') { // 待去清單：提議日期＝LINE 傳送的日期（這是「提議」發生的日子，不是缺漏）
      if (!rec4Has(it, 'suggestDate')) tail = '\n（提議日期沒填：會用 LINE 傳送的日期 ' + tp.date + '）';
    } else {
      const noDate = !rec4Has(it, 'date') && rec4Field(sch, 'date') && sch.kind !== 'travel';
      const noTime = !rec4Has(it, 'time') && rec4Field(sch, 'time');
      if (noDate || noTime) tail = '\n（' + [noDate ? '日期' : '', noTime ? '時間' : ''].filter(Boolean).join('、') + '沒填：會暫用開始記錄的時間 ' + tp.date + ' ' + tp.time + '，並標示待確認）';
    }
    parts.push((N > 1 ? CIRCLED[idx] + ' ' : '') + (lines.join('\n') || '（還沒有任何資料）') + (miss.length ? '\n（未填：' + miss.join('、') + '）' : '') + tail);
  });
  const where = sch.needLists && mode !== 'draft'
    ? '⚠️ 目前沒辦法建立網頁草稿（同步資料不見了，或管理員關閉了草稿模式），按「確認送出」會失敗；請先確認已綁定同步碼、App 已同步過一次。'
    : (mode === 'draft'
      ? '⚠️ 你已綁定網頁：按「確認送出」會先送到網頁的「待確認草稿」，到網頁按【確認新增】後才正式儲存、產生流水號。'
      : (mode === 'unbound'
        ? '按「確認送出」會先暫存在 LINE（你還沒綁定同步碼，網頁看不到；綁定後，或到 App「📱LINE紀錄」匯入）。'
        : '按「確認送出」才會寫入，並自動同步到網頁（同步失敗會保留並自動重試）。'));
  parts.push(where + '\n「返回修改」可以改任何一欄；「取消紀錄」不會寫入任何資料。');
  return parts.join('\n\n');
}
async function rec4SummaryMsg(S, ctx, env, note) {
  const cfg = await loadLineConfig(env);
  const mode = await rec4Mode(ctx.userId, env, cfg);
  return rec4TextMsg(rec4SummaryText(S, mode, note), [{ label: '✅ 確認送出', text: '確認送出' }, { label: '📝 返回修改', text: '返回修改' }, REC4_CANCEL_Q]);
}
// 往下一個要問的欄位走；都問完了就顯示確認畫面。回傳要回覆的訊息陣列（前面可以先接 pre）
async function rec4Advance(S, pre, ctx, env, note) {
  const msgs = (pre || []).slice();
  for (let guard = 0; guard < 30; guard++) {
    const it = S.items[S.i];
    const q = rec4Queue(S, it);
    if (q.length) { S.stage = 'ask'; S.cur = q[0]; msgs.push(rec4QuestionMsg(S, it, q)); return msgs; }
    if (S.i + 1 < S.items.length) { S.i++; S.asked = 0; S.hist = []; continue; }
    break;
  }
  S.i = 0; S.stage = 'confirm'; S.cur = '';
  rec4ApplyDefaults(S);
  msgs.push(await rec4SummaryMsg(S, ctx, env, note));
  return msgs;
}

// ---------- 輸入內容 → 欄位 ----------
async function rec4Extract(S, text, env) {
  const sch = REC4_SCHEMAS[S.module];
  const kind = sch.kind;
  const lists = sch.needLists ? rec4Lists(S) : null;
  let raws = sch.needLists ? [] : localParseDraftItems(text, kind); // 「品牌：50嵐 飲品：珍奶」這種欄位格式，不用 AI（分帳、集點卡、待去清單沒有這種格式）
  let via = 'local';
  let aiDown = false;
  if (S.version === 'simple' && !raws.length) { const s = rec4SimpleParse(kind, text, lists); if (s) { raws = [s]; via = 'simple'; } }
  if (!raws.length) {
    const ai = await parseDraftItems(text, env, kind, S.ts, sch.needLists ? { want: { [kind]: true }, lists } : {});
    if (ai === null) aiDown = true;
    else if (ai.items.length) { raws = ai.items; via = 'ai'; }
  }
  // AI 不能用的時候，才退回「品項 金額」的簡單拆法；AI 有回應但說「沒有可記錄的內容」就照實告訴使用者，不把閒聊硬當成品項
  if (!raws.length && aiDown) { const s = rec4SimpleParse(kind, text, lists); if (s && rec4FallbackOk(kind, s)) { raws = [s]; via = 'simple'; } }
  // 待去清單：使用者已經明確選了「待去清單」，AI 沒認出來時，整句當成項目名稱（和 LINE 一句話新增待去地點一樣；最後還有確認畫面可以改）
  if (!raws.length && kind === 'wish') { const s = rec4SimpleParse(kind, text, lists); if (s) { raws = [s]; via = 'simple'; } }
  if (kind === 'split') raws.forEach((r) => { if (r && r.customShares && typeof r.customShares === 'object' && !r.splitType) r.splitType = 'custom'; }); // 句子裡每個人的金額不同：名字對得上成員、總和等於金額才帶入（對不上就退回「提醒＋均分」）
  const items = raws.map((r) => { const n = normalizeDraftItem(kind, Object.assign({}, r, { kind }), { sender: S.sender, userName: S.userName, lists: lists || undefined }); rec4GroupDefault(S, r, n); return n; }).filter(Boolean).slice(0, DRAFT_MAX_ITEMS).map((n) => rec4ItemFromNorm(n, 'text'));
  return { items, via, aiDown };
}
function rec4RecognizedText(S, items, rec, merged) {
  const sch = REC4_SCHEMAS[S.module];
  const lines = ['📷 照片辨識結果（只列出照片上有明確依據的欄位）：'];
  items.forEach((it, idx) => {
    const parts = [];
    sch.fields.forEach((f) => { if (rec4Has(it, f.key) && it.src[f.key] === 'photo') parts.push(f.label.replace('（選填）', '') + '＝' + rec4Show(sch, f, it, S) + (it.uncertain.indexOf(f.key) >= 0 ? '⚠' : '')); });
    lines.push((items.length > 1 ? CIRCLED[idx] + ' ' : '') + (parts.join('、') || '（沒有可用的欄位）'));
  });
  const qt = REC4_QUALITY[rec.quality];
  if (qt && rec.quality !== 'ok') lines.push('⚠️ ' + qt + '，辨識可能不完整，建議補拍清楚一點的，或直接輸入文字。');
  if (rec.note) lines.push('AI 備註：' + rec.note);
  lines.push(merged ? '已把照片上看得到、而且原本還空著的欄位補進去（你已經回答過的不會被蓋掉）。' : '照片看不出來的欄位我先留空，不會亂猜；辨識結果最後會再請你確認。');
  return lines.join('\n');
}
// 處理一張照片：下載 → 辨識 → 併進 S.items。回傳 { msgs: [純文字], ok }
async function rec4PhotoStep(S, message, token, env) {
  const sch = REC4_SCHEMAS[S.module];
  const img = await lineImageContent(token, message);
  if (!img.ok) return { ok: false, msgs: ['⚠️ ' + rec4PhotoWhy(img.reason) + '，沒辦法辨識。不影響文字紀錄，直接用文字輸入就可以了。'] };
  const rec = await rec4Recognize(img.bytes, img.mime, env, sch.kind, S.ts);
  if (!rec.ok) return { ok: false, msgs: ['⚠️ AI 暫時沒辦法辨識這張照片（' + rec.reason + '）。不影響文字紀錄，請直接用文字輸入。'] };
  const norms = rec.items.map((r) => { const n = normalizeDraftItem(sch.kind, Object.assign({}, r, { kind: sch.kind }), { sender: S.sender, userName: S.userName, lists: sch.needLists ? rec4Lists(S) : undefined }); rec4GroupDefault(S, r, n); return n; }).filter(Boolean).slice(0, DRAFT_MAX_ITEMS);
  if (!norms.length) {
    const why = rec.quality === 'irrelevant' ? '這張照片看起來和「' + sch.name + '」紀錄無關。' : '這張照片我沒有辨識到可以用的資訊' + (REC4_QUALITY[rec.quality] ? '（' + REC4_QUALITY[rec.quality] + '）' : '') + '。';
    return { ok: false, msgs: ['📷 ' + why + '請補拍清楚一點的，或直接用文字輸入。'] };
  }
  const fresh = S.items.every((it) => !Object.keys(it.src).some((k) => it.src[k] !== 'default'));
  if (fresh) {
    S.items = norms.map((n) => rec4ItemFromNorm(n, 'photo')); S.i = 0; S.asked = 0; S.hist = [];
    return { ok: true, msgs: [rec4RecognizedText(S, S.items, rec, false)] };
  }
  if (S.items.length === 1) {
    const before = Object.assign({}, S.items[0].fields);
    const filled = rec4MergeInto(S.items[0], norms[0], 'photo');
    const probe = { fields: {}, uncertain: S.items[0].uncertain, notes: {}, src: {} };
    filled.forEach((k) => { probe.fields[k] = S.items[0].fields[k]; probe.src[k] = 'photo'; });
    const extra = norms.length > 1 ? '\n（照片裡還有其他品項，這次只補進目前這一筆；要記多筆的話，請另外開一筆。）' : '';
    return { ok: true, msgs: [rec4RecognizedText(S, [probe], rec, true) + (filled.length ? '' : '\n（這張照片沒有帶來新的資訊。）') + extra], unchanged: !filled.length && Object.keys(before).length >= 0 };
  }
  return { ok: false, msgs: ['⚠️ 目前已經有多筆紀錄，這張照片沒有併入。請先送出或取消這一批，再傳照片。'] };
}

// ---------- 流程控制：開始、取消、各階段的處理 ----------
const REC4_ABORT_RE = /^(❌\s*)?(取消紀錄|取消|放棄|結束|結束此次對話|離開|退出|cancel|quit|exit)$/i;
const REC4_GIVEUP_RE = /^(確定放棄|確認放棄)$/;
const REC4_CONTINUE_RE = /^(繼續填寫|繼續|不取消)$/;
const REC4_BACKC_RE = /^(↩\s*)?(返回確認|返回|不改了|回到確認|都不改)$/;
const REC4_CAMERA_Q = { label: '📷 拍照', lineAction: 'camera' };
const REC4_ROLL_Q = { label: '🖼️ 相簿', lineAction: 'cameraRoll' };
const REC4_CONFIRM_QUICK = [{ label: '✅ 確認送出', text: '確認送出' }, { label: '📝 返回修改', text: '返回修改' }, REC4_CANCEL_Q];
const REC4_NONLETTER_LEAD_RE = /^[^一-鿿A-Za-z0-9]+/;

function rec4Owns(S, ctx) {
  return !!(S && S.flow === 'rec4' && (S.chat || 'direct') === ctx.chat && (S.groupId || '') === (ctx.groupId || ''));
}
async function rec4Save(S, ctx, env) { S.updatedAt = Date.now(); await setFlagshipSession(ctx.userId, S, env); }
function rec4Bare(text) { return rec4Clean(text).replace(REC4_NONLETTER_LEAD_RE, '').trim(); }
function rec4VersionOf(text) {
  const t = rec4Bare(text);
  if (REC4_TRIGGERS[t]) return REC4_TRIGGERS[t];
  if (/^(簡易|標準|進階|旗艦)$/.test(t) && REC4_TRIGGERS[t + '版']) return REC4_TRIGGERS[t + '版'];
  return '';
}
function rec4ModuleOf(text) {
  const t = rec4Bare(text);
  return REC4_MODULE_WORDS[t] || '';
}
function rec4HasData(S) {
  return (S.items || []).some((it) => Object.keys(it.src || {}).some((k) => it.src[k] !== 'default') || Object.keys(it.skip || {}).length > 0);
}
function rec4Brief(S, it) {
  const sch = REC4_SCHEMAS[S.module];
  const f = it.fields;
  let name;
  if (sch.kind === 'drink') name = [f.brand, f.drink].filter(Boolean).join(' ');
  else if (sch.kind === 'food') name = [f.brand, f.dish].filter(Boolean).join(' ');
  else if (sch.kind === 'split') name = [f.group ? '【' + f.group + '】' : '', f.desc].filter(Boolean).join('');
  else if (sch.kind === 'sticker') name = f.card === 'mutual' ? '互助集點卡' : [f.kid, f.behavior].filter(Boolean).join(' ');
  else if (sch.kind === 'wish') name = [f.name, f.city].filter(Boolean).join(' ');
  else name = [f.type ? (TRAVEL_TYPE_LABELS[f.type] || f.type) : '', f.depPort && f.arrPort ? f.depPort + '→' + f.arrPort : (f.depPort || f.arrPort || '')].filter(Boolean).join(' ');
  let money = '';
  if (sch.kind === 'sticker') money = f.points !== undefined ? (Number(f.points) > 0 ? '+' : '') + f.points + '點' : '';
  else if (sch.moneyKey && f[sch.moneyKey] !== undefined) money = '$' + f[sch.moneyKey];
  return [name, money].filter(Boolean).join(' ') || '（還沒有內容）';
}
function rec4CollectQuick(S) {
  return (S.chat === 'direct' ? [REC4_CAMERA_Q, REC4_ROLL_Q] : []).concat([REC4_CANCEL_Q]);
}
async function rec4NewSession(ctx, ev, token, patch) {
  const who = await lineWho(token, ctx);
  const ts = Number(ev && ev.timestamp) || Date.now();
  return Object.assign({
    flow: 'rec4', stage: 'pick_module', module: '', version: '', chat: ctx.chat, groupId: ctx.groupId || '',
    userName: who.userName || '', groupName: who.groupName || '', sender: toAppUserName(who.userName || ''),
    startTs: ts, ts, recId: 'R4' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    items: [], i: 0, cur: '', asked: 0, hist: [], restSkip: false, photos: [], raw: [], seen: [],
  }, patch || {});
}

// 目前這個階段要送出的訊息（所有階段共用；呼叫前先把 S 的狀態改好）
async function rec4Render(S, ctx, env, pre, err) {
  const msgs = (pre || []).slice();
  const sch = S.module ? REC4_SCHEMAS[S.module] : null;
  switch (S.stage) {
    case 'pick_module':
      msgs.push(rec4ModulePrompt(err || (S.version ? '已選擇 ' + REC4_VERSIONS[S.version].emoji + ' ' + REC4_VERSIONS[S.version].name + '。' : '')));
      break;
    case 'pick_version': {
      // V10.13.0：rec4Render 呼叫端很多，沒有全部線上 cfg 參數；這裡當場讀一次後台設定，只為了「規則顯示」開關判斷要不要列出規則文字
      const cfg = await loadLineConfig(env);
      msgs.push(rec4VersionCardMsg(sch.icon + ' ' + sch.name + '紀錄：選擇紀錄版本', err || '先選好版本，再開始輸入；文字、照片都可以。', (v) => REC4_VERSIONS[v].name, { label: '↩️ 返回選功能', text: '返回' }, sch, cfg));
      break;
    }
    case 'collect': {
      const cfg = await loadLineConfig(env);
      msgs.push(rec4TextMsg((err ? '⚠️ ' + err + '\n\n' : '') + rec4Intro(S, cfg), rec4CollectQuick(S)));
      break;
    }
    case 'ask': {
      const it = S.items[S.i];
      let q = rec4Queue(S, it);
      if (S.cur && q.indexOf(S.cur) < 0) q = [S.cur].concat(q);
      if (!q.length) { S.stage = 'confirm'; return rec4Render(S, ctx, env, msgs, err); }
      S.cur = S.cur && q.indexOf(S.cur) >= 0 ? S.cur : q[0];
      msgs.push(rec4QuestionMsg(S, it, q, err));
      break;
    }
    case 'confirm':
      msgs.push(await rec4SummaryMsg(S, ctx, env, err || ''));
      break;
    case 'edit_item':
      msgs.push(rec4TextMsg((err ? '⚠️ ' + err + '\n\n' : '') + '要修改哪一筆？\n' + S.items.map((it, idx) => CIRCLED[idx] + ' ' + rec4Brief(S, it)).join('\n'),
        S.items.map((it, idx) => ({ label: CIRCLED[idx] + ' ' + rec4Brief(S, it), text: String(idx + 1) })).slice(0, 12).concat([{ label: '↩ 返回確認', text: '返回確認' }])));
      break;
    case 'edit_pick': {
      const it = S.items[S.i];
      const fl = sch.fields.filter((f) => rec4Active(S, it, f)); // 例如「各自金額」只有「如何分＝自訂金額」才列出
      const total = fl.length;
      const pages = Math.max(1, Math.ceil(total / REC4_PAGE));
      const page = Math.max(0, Math.min(pages - 1, S.editPage || 0));
      S.editPage = page;
      const slice = fl.slice(page * REC4_PAGE, (page + 1) * REC4_PAGE);
      const lines = slice.map((f, k) => (page * REC4_PAGE + k + 1) + '. ' + f.label.replace('（選填）', '') + '：' + (rec4Has(it, f.key) ? rec4Show(sch, f, it, S) : '（未填）') + (rec4IsReq(S, it, f) ? '　【必填】' : ''));
      const quick = slice.map((f) => ({ label: f.label.replace('（選填）', ''), text: f.label.replace('（選填）', '') }));
      if (page > 0) quick.push({ label: '⬅ 上一頁', text: '上一頁' });
      if (page < pages - 1) quick.push({ label: '下一頁 ➡', text: '下一頁' });
      quick.push({ label: '↩ 返回確認', text: '返回確認' });
      msgs.push(rec4TextMsg((err ? '⚠️ ' + err + '\n\n' : '') + '📝 要修改哪一欄？' + (S.items.length > 1 ? '（第 ' + (S.i + 1) + ' 筆）' : '') + '（第 ' + (page + 1) + '／' + pages + ' 頁）\n' + lines.join('\n') + '\n\n點下面的欄位名稱，或輸入前面的編號。', quick));
      break;
    }
    case 'edit_value': {
      const it = S.items[S.i];
      msgs.push(rec4QuestionMsg(S, it, [S.cur], err));
      break;
    }
    default:
      msgs.push(rec4TextMsg('這個流程已經結束，請輸入「日常小秘書」重新開始。', ['日常小秘書', '功能選單']));
  }
  return msgs;
}
async function rec4Done(rt, msgs) {
  await rec4Save(rt.S, rt.ctx, rt.env);
  await rec4Reply(rt.token, rt.ev.replyToken, msgs);
  return true;
}
async function rec4Cancel(rt, lead) {
  await clearFlagshipSession(rt.ctx.userId, rt.env);
  await rec4Reply(rt.token, rt.ev.replyToken, [rec4TextMsg((lead || '') + '❌ 已取消這次紀錄，沒有寫入任何資料，也不會留下流水號。', [{ label: '再記一筆', text: '日常小秘書' }, '功能選單'])]);
  return true;
}
// 在「選功能／選版本」的階段，使用者輸入了別的功能名稱或完整指令：切換過去（等同沒有進行中的流程時的行為）
async function rec4SwitchOut(rt) {
  const { ctx, ev, token, env, cfg, text } = rt;
  const swm = rec4SwitchOf(text); // V10.4：版本卡片按鈕送出的「紀錄分帳 簡易版」「紀錄集點卡」這類完整指令（分帳、集點卡不在 parseCommand 的主功能清單裡，要先在這裡認出來，不然會被關鍵字攔走）
  if (swm && swm.kind === 'module' && REC4_SCHEMAS[swm.module].needLists) return rec4RunSwitch(rt, swm);
  const m = matchKeyword(text, buildRules(cfg), ctx.chat, true, cfg.fuzzy);
  if (m.kind === 'hit' && !m.confirm) { await clearFlagshipSession(ctx.userId, env); await executeFunction(m.fn, ctx, ev, token, env, cfg); return true; }
  const cmd = parseCommand(text, cfg);
  if (cmd) { await clearFlagshipSession(ctx.userId, env); await runCommand(cmd, ctx, ev, token, env, cfg); return true; }
  return false;
}

// 功能與版本都選好了：開始紀錄
// 分帳／集點卡／待去清單：讀使用者自己的清單（分帳群組與成員、孩子與行為、待去分類）。這三個功能只有「建立網頁待確認草稿」這條路，
//   所以要有同步碼與網頁資料才能用四種版本；沒辦法的人維持原本的流程，不受影響。V10.7.0：群組／多人聊天室不讀任何清單，只回「版本說明卡」（見 rec4ViewOnly）。
function rec4ListsProblem(modId, lists) {
  if (modId === 'split') {
    lists.groups = lists.groups.filter((g) => g && Array.isArray(g.members) && g.members.length > 0); // 網頁表單要求群組至少要有一位成員
    if (!lists.groups.length) return '你的分帳裡還沒有可以記帳的群組（群組要有成員）。請先到 App「🧾分帳」新增群組與成員，再用 LINE 記分帳。';
  }
  return '';
}
const REC4_STICKER_FALLBACK_LEAD = '📝 要用簡易／標準／進階／旗艦四種版本記集點卡，需要先綁定同步碼、App 同步過一次，而且管理頁的「草稿模式」要開著；目前先用原本的「選孩子 → 選行為」。\n\n';
const REC4_SPLIT_FALLBACK_LEAD = '📝 要用簡易／標準／進階／旗艦四種版本記分帳，需要先綁定同步碼（傳「同步碼 你的碼」）、App 同步過一次，而且管理頁的「草稿模式」要開著；目前先用「快速記錄」。\n\n';
async function rec4LegacyEntry(modId, rt, av) {
  const { ctx, ev, token, env } = rt;
  if (modId === 'split') { await startQuickRecord('split', ctx.userId, env, token, ev.replyToken, REC4_SPLIT_FALLBACK_LEAD); return; }
  if (modId === 'sticker') { await enterSticker(ctx, ev, token, env, (av && av.perm) || {}, REC4_STICKER_FALLBACK_LEAD); return; }
  await lineReplyQuick(token, ev.replyToken, WISH_NEED_DRAFT_TEXT, ['功能選單']);
}
async function rec4PrepLists(rt, preLists) {
  const { S, ctx, ev, token, env, cfg } = rt;
  const sch = REC4_SCHEMAS[S.module];
  if (!sch.needLists) return true;
  if (ctx.isGroup) { await clearFlagshipSession(ctx.userId, env); await rec4ViewOnly(sch, ctx, ev, token, cfg); return false; } // V10.7.0：群組／多人聊天室只給看說明卡（不讀清單、不開始紀錄；這一輪「選功能／選版本」到此結束）
  const av = checkAvailability(sch.fn, ctx, cfg);
  if (!av.ok) { await clearFlagshipSession(ctx.userId, env); await rec4Reply(token, ev.replyToken, [rec4TextMsg(av.message, ['功能選單'])]); return false; }
  if (!S.lists) {
    let lists = preLists || null;
    if (!lists) {
      const elig = await draftEligibility(ctx.userId, env, cfg);
      if (!elig) { await clearFlagshipSession(ctx.userId, env); await rec4LegacyEntry(S.module, rt, av); return false; }
      lists = draftListsFromBlob(elig.blob);
    }
    S.lists = lists;
  }
  const problem = rec4ListsProblem(S.module, S.lists);
  if (problem) { await clearFlagshipSession(ctx.userId, env); await rec4Reply(token, ev.replyToken, [rec4TextMsg(problem, ['功能選單'])]); return false; }
  return true;
}
async function rec4Begin(rt, pre) {
  const { S, ctx, ev, token, env, cfg } = rt;
  const sch = REC4_SCHEMAS[S.module];
  if (!S.mode) { // V10.10：表單模式——這個模組有開、不是分帳／集點卡／待去清單（這 3 個只能建草稿，草稿系統沒有分開歸戶的能力，所以不管後台設定怎麼改都不問）、而且現在是「直接寫入」（不是草稿模式）才會問；其他情況直接當單表單，不卡原本的流程
    // V10.12：拿掉「講話的人必須是後台綁定的用戶A/B之一」這個條件——現在只要模組開關開著就會問，「對方是誰」改成選了雙表單之後當場問（見 rec4OnPickMode／rec4OnPickMate）。
    if (formModeEnabled(cfg, S.module) && !sch.needLists && (await rec4Mode(ctx.userId, env, cfg)) !== 'draft') {
      S.stage = 'pick_mode';
      return rec4Done(rt, (pre || []).concat([rec4FormModeMsg(sch)]));
    }
    S.mode = 'single';
  }
  const av = checkAvailability(sch.fn, ctx, cfg);
  if (!av.ok) { await clearFlagshipSession(ctx.userId, env); await rec4Reply(token, ev.replyToken, [rec4TextMsg(av.message, ['功能選單'])]); return true; }
  if (sch.needLists && !(await rec4PrepLists(rt))) return true;
  if (S.module === 'sticker' && S.version === 'simple' && !rec4Lists(S).kids.length) { // 簡易版只收「孩子＋行為」；集點卡裡沒有孩子時沒有東西可以對照，誠實說明並引導改用能記互助集點卡的版本
    await clearFlagshipSession(ctx.userId, env);
    await rec4Reply(token, ev.replyToken, [rec4TextMsg('你的集點卡裡還沒有孩子，簡易版的「孩子＋行為」沒有東西可以對照。\n要記互助集點卡（兩個人互相加點、扣點），請改用 🟡標準版（例如：互助 洗碗 加2點）、🟠進階版或 🔵旗艦版；要記孩子的行為，請先到 App「🌟集點卡」新增孩子與行為。', [{ label: '🟡 標準版', text: '紀錄集點卡 標準版' }, { label: '🟠 進階版', text: '紀錄集點卡 進階版' }, { label: '🔵 旗艦版', text: '紀錄集點卡 旗艦版' }, '功能選單'])]);
    return true;
  }
  if (S.version === 'flagship' && !sch.flagshipReady) {
    S.stage = 'pick_version'; S.version = '';
    return rec4Done(rt, (pre || []).concat([rec4TextMsg('🔵 旗艦版（完整資料紀錄）目前只有 🧋飲料 開放。\n' + sch.icon + ' ' + sch.name + '的網頁表單還有欄位要逐欄核對（我不會自己猜欄位、也不會少問），所以旗艦版先不開放，下一階段補上。\n現在可以選：🟢簡易版、🟡標準版、🟠進階版。', REC4_ORDER.filter((v) => v !== 'flagship').map((v) => ({ label: REC4_VERSIONS[v].emoji + ' ' + REC4_VERSIONS[v].name, text: REC4_VERSIONS[v].name })).concat([REC4_CANCEL_Q]))]));
  }
  S.items = [rec4NewItem(S)]; S.i = 0; S.asked = 0; S.hist = []; S.restSkip = false; S.cur = ''; S.raw = []; S.pendingCancel = false;
  const photoTexts = [];
  let gotAny = false;
  const photos = (S.photos || []).slice(0, 3);
  S.photos = [];
  for (let k = 0; k < photos.length; k++) {
    const r = await rec4PhotoStep(S, photos[k], token, env);
    photoTexts.push(r.msgs.join('\n'));
    if (r.ok) { gotAny = true; S.raw.push('📷 照片'); }
  }
  const msgs = (pre || []).slice();
  if (S.version === 'simple' || S.version === 'standard') {
    msgs.push(rec4TextMsg(rec4Intro(S, cfg), rec4CollectQuick(S)));
    if (photoTexts.length) msgs.push(rec4TextMsg(photoTexts.join('\n\n')));
    if (!gotAny) { S.stage = 'collect'; return rec4Done(rt, msgs); }
    const out = await rec4Advance(S, msgs, ctx, env);
    return rec4Done(rt, out);
  }
  msgs.push(rec4TextMsg(rec4Intro(S, cfg)));
  if (photoTexts.length) msgs.push(rec4TextMsg(photoTexts.join('\n\n')));
  return rec4Done(rt, await rec4Advance(S, msgs, ctx, env));
}
// 入口：已經知道是哪個功能（launchRecord 呼叫）。version 為空 → 先出版本卡片
async function rec4StartModule(modFn, version, ctx, ev, token, env, cfg, preLists) {
  const sch = REC4_SCHEMAS[modFn];
  if (sch.needLists && ctx.isGroup) { await rec4ViewOnly(sch, ctx, ev, token, cfg); return true; } // V10.7.0：群組／多人聊天室只給看版本說明卡（不建立任何進行中的紀錄、不讀清單；要記錄請到 1 對 1）
  const S = await rec4NewSession(ctx, ev, token, { module: modFn, version: version || '', stage: version ? 'collect' : 'pick_version' });
  const rt = { S, ctx, ev, token, env, cfg, text: '' };
  if (sch.needLists && !(await rec4PrepLists(rt, preLists))) return true; // V10.4：分帳／集點卡／待去清單先讀使用者的清單；沒辦法用四種版本的人，這裡會改走原本的流程
  if (!version) {
    return rec4Done(rt, [rec4VersionCardMsg(sch.icon + ' ' + sch.name + '紀錄：選擇紀錄版本', '先選好版本，再開始輸入；文字、照片都可以。', (v) => '紀錄' + sch.name + ' ' + REC4_VERSIONS[v].name, { label: '↩️ 返回', text: sch.backText || sch.name }, sch, cfg)]);
  }
  return rec4Begin(rt, []);
}
// 入口：先選版本（「日常小秘書」卡片、直接輸入「簡易版」…）
async function rec4StartVersion(version, ctx, ev, token, env, cfg, photos) {
  const S = await rec4NewSession(ctx, ev, token, { version, stage: 'pick_module', photos: photos || [] });
  return rec4Done({ S, ctx, ev, token, env, cfg, text: '' }, await rec4Render(S, ctx, env, [], ''));
}

// ---------- 各階段 ----------
async function rec4OnPickModule(rt) {
  const { S, text } = rt;
  const mod = rec4ModuleOf(text);
  if (mod) {
    S.module = mod;
    if (!(await rec4PrepLists(rt))) return true;
    if (S.version) return rec4Begin(rt, []);
    S.stage = 'pick_version';
    return rec4Done(rt, await rec4Render(S, rt.ctx, rt.env, [], ''));
  }
  const v = rec4VersionOf(text);
  if (v) { S.version = v; return rec4Done(rt, await rec4Render(S, rt.ctx, rt.env, [], '')); }
  if (/^日常小秘書$/.test(rec4Bare(text))) { await clearFlagshipSession(rt.ctx.userId, rt.env); return rec4Reply(rt.token, rt.ev.replyToken, [rec4VersionCardMsg('日常小秘書', '事不宜遲！這次想用哪種方式記一筆呢？', (x) => REC4_VERSIONS[x].name, null)]).then(() => true); }
  if (await rec4SwitchOut(rt)) return true;
  return rec4Done(rt, await rec4Render(S, rt.ctx, rt.env, [], '請點下面的按鈕，選擇要記錄的功能。'));
}
async function rec4OnPickVersion(rt) {
  const { S, text } = rt;
  const v = rec4VersionOf(text);
  if (v) { S.version = v; return rec4Begin(rt, []); }
  const mod = rec4ModuleOf(text);
  if (mod && mod !== S.module) { S.module = mod; if (!(await rec4PrepLists(rt))) return true; return rec4Done(rt, await rec4Render(S, rt.ctx, rt.env, [], '')); }
  if (REC4_BACKC_RE.test(rec4Clean(text))) { S.stage = 'pick_module'; S.module = ''; return rec4Done(rt, await rec4Render(S, rt.ctx, rt.env, [], '')); }
  if (/^日常小秘書$/.test(rec4Bare(text))) { await clearFlagshipSession(rt.ctx.userId, rt.env); return rec4Reply(rt.token, rt.ev.replyToken, [rec4VersionCardMsg('日常小秘書', '事不宜遲！這次想用哪種方式記一筆呢？', (x) => REC4_VERSIONS[x].name, null)]).then(() => true); }
  if (await rec4SwitchOut(rt)) return true;
  return rec4Done(rt, await rec4Render(S, rt.ctx, rt.env, [], '請點上面的卡片按鈕，選擇紀錄版本。'));
}
// 入口：已經選好模組＋版本，正在問「要用哪種表單模式」（V10.10；只有該模組開了開關才會進到這裡；V10.12 起不再要求講話的人要事先在後台綁定）
async function rec4OnPickMode(rt) {
  const { S, text, env, ctx } = rt;
  if (/^單/.test(text)) { S.mode = 'single'; return rec4Begin(rt, []); }
  if (/^雙/.test(text)) {
    const mates = await rec4MateCandidates(env, ctx.userId);
    if (!mates.length) { S.mode = 'single'; return rec4Begin(rt, [rec4TextMsg('⚠️ 目前還沒有其他已知的使用者可以當雙表單的另一位（請先讓對方也傳一句話給機器人，才會出現在名單裡），先用單表單繼續。')]); }
    S.mateCandidates = mates; S.stage = 'pick_mate';
    return rec4Done(rt, [rec4PickMateMsg(REC4_SCHEMAS[S.module], mates)]);
  }
  if (REC4_NO_RE.test(text)) return rec4Cancel(rt, ''); // 畫面上就有「結束」這顆快速回覆按鈕，按下去要真的結束，不能被當成聽不懂又重問一次同一題
  if (await rec4SwitchOut(rt)) return true;
  return rec4Done(rt, [rec4FormModeMsg(REC4_SCHEMAS[S.module])]);
}
// 入口：雙表單選完，正在問「這次的另一位是誰」（V10.12 新增：從已知使用者名單當場選，取代舊的後台先綁定用戶A／B）
async function rec4OnPickMate(rt) {
  const { S, text, env, ctx } = rt;
  if (REC4_NO_RE.test(text)) return rec4Cancel(rt, ''); // 畫面上有「結束」按鈕，按下去要真的結束
  const mates = S.mateCandidates || [];
  const cleaned = rec4Clean(text);
  const picked = mates.find((m) => m.name === cleaned);
  if (picked) {
    const users = await rec4KnownUsers(env);
    const selfName = (users[ctx.userId] && users[ctx.userId].name) || '';
    S.mode = 'dual';
    S.dualMate = { selfId: ctx.userId, mateId: picked.userId, selfName, mateName: picked.name };
    S.mateCandidates = null;
    return rec4Begin(rt, []);
  }
  if (await rec4SwitchOut(rt)) return true;
  return rec4Done(rt, [rec4PickMateMsg(REC4_SCHEMAS[S.module], mates)]); // 打的字不是名單裡的任何一個名字：不猜，重新顯示同一題的按鈕
}
function rec4GotText(S) {
  const sch = REC4_SCHEMAS[S.module];
  const parts = S.items.map((it, idx) => {
    const got = sch.fields.filter((f) => rec4Has(it, f.key) && it.src[f.key] !== 'default').map((f) => f.label.replace('（選填）', '') + '＝' + rec4Show(sch, f, it, S) + (it.uncertain.indexOf(f.key) >= 0 ? '⚠' : ''));
    return (S.items.length > 1 ? CIRCLED[idx] + ' ' : '') + (got.join('、') || '（沒有辨識到欄位）');
  });
  return '👌 已從你輸入的內容辨識到（沒提到的我不猜）：\n' + parts.join('\n');
}
async function rec4OnCollect(rt) {
  const { S, ctx, env, text } = rt;
  const ex = await rec4Extract(S, text, env);
  if (!ex.items.length) {
    const sch = REC4_SCHEMAS[S.module];
    let msg;
    const ex0 = sch.kind === 'sticker' ? ((rec4Lists(S).kids[0] && rec4Lists(S).behaviors[0]) ? rec4Lists(S).kids[0].name + ' ' + rec4Lists(S).behaviors[0].name : sch.examples[0]) : sch.examples[0];
    const fmt = sch.kind === 'sticker' ? '孩子 行為' : (sch.kind === 'wish' ? '地點名稱' : '品項 金額');
    if (S.version === 'simple' && sch.kind === 'sticker') msg = '沒看出「孩子＋行為」。請照你的集點卡裡的名字輸入（結尾可以加點數），例如：\n・' + ex0;
    else if (S.version === 'simple' && sch.kind === 'wish') msg = '沒看出地點名稱，請再輸入一次，例如：\n・' + sch.examples.join('\n・');
    else if (S.version === 'simple') msg = '沒看出「品項＋金額」。請照這樣輸入（金額用數字）：\n・' + sch.examples.join('\n・');
    else if (ex.aiDown) msg = 'AI 暫時沒辦法使用（可能是額度或連線），這句話我拆不出來。請改用「' + fmt + '」的格式，例如：' + ex0 + '；或改選 🟠進階版，一題一題回答。';
    else msg = '我沒有在這句話裡看到可以記錄的' + sch.name + '資訊。請再說一次（例如：' + sch.sentence + '），或改選 🟠進階版，一題一題回答。';
    return rec4Done(rt, await rec4Render(S, ctx, env, [], msg));
  }
  S.raw.push(String(text).slice(0, 200));
  S.items = ex.items; S.i = 0; S.asked = 0; S.hist = []; S.restSkip = false;
  const msgs = await rec4Advance(S, [], ctx, env);
  if (S.stage === 'ask') msgs.unshift(rec4TextMsg(rec4GotText(S)));
  return rec4Done(rt, msgs);
}
async function rec4OnAsk(rt) {
  const { S, ctx, env, text } = rt;
  const sch = REC4_SCHEMAS[S.module];
  const it = S.items[S.i];
  const f = rec4Field(sch, S.cur);
  if (!f) { return rec4Done(rt, await rec4Advance(S, [], ctx, env)); }
  if (REC4_PREV_RE.test(text)) {
    if (!S.hist.length) return rec4Done(rt, await rec4Render(S, ctx, env, [], '這已經是第一題了。'));
    S.cur = S.hist.pop(); S.asked = Math.max(0, S.asked - 1);
    return rec4Done(rt, await rec4Render(S, ctx, env, [], ''));
  }
  if (REC4_REST_RE.test(text)) {
    if (S.version !== 'flagship') return rec4Done(rt, await rec4Render(S, ctx, env, [], '這個版本沒有「其餘略過」；選填的題目可以個別回答「略過」。'));
    if (rec4IsReq(S, it, f) && !rec4Has(it, f.key)) return rec4Done(rt, await rec4Render(S, ctx, env, [], '「' + f.label + '」是必填的，要先回答。'));
    S.restSkip = true;
    return rec4Done(rt, await rec4Advance(S, [], ctx, env));
  }
  if (REC4_KEEP_RE.test(text)) {
    if (!rec4Has(it, f.key)) return rec4Done(rt, await rec4Render(S, ctx, env, [], '這一題目前還沒有內容可以沿用，請直接回答。'));
    it.uncertain = it.uncertain.filter((k) => k !== f.key); delete it.notes[f.key]; it.src[f.key] = 'ask';
    S.hist.push(f.key); S.asked++;
    return rec4Done(rt, await rec4Advance(S, [], ctx, env));
  }
  if (REC4_CONFIRM_BTN_RE.test(text)) return rec4Done(rt, await rec4Render(S, ctx, env, [], REC4_CONFIRM_BTN_MSG));
  const r = rec4Parse(S, f, text);
  if (!r.ok) return rec4Done(rt, await rec4Render(S, ctx, env, [], r.msg));
  if (r.skip) {
    if (f.key === 'recorder') { it.uncertain = it.uncertain.filter((k) => k !== f.key); it.src[f.key] = 'ask'; } // 紀錄者不能空白（個人資料靠它分開）：維持目前的值
    else { rec4ClearValue(it, f.key); it.skip[f.key] = true; }
  } else {
    rec4SetValue(it, f.key, r.value, S);
    if (r.warn) { it.uncertain.push(f.key); it.notes[f.key] = r.warn; } // 值收下了，但標「待確認」（例如自訂行為、依名稱對應到成員）
  }
  S.hist.push(f.key); if (S.hist.length > 40) S.hist.shift(); S.asked++;
  return rec4Done(rt, await rec4Advance(S, [], ctx, env));
}
async function rec4OnConfirm(rt) {
  const { S, ctx, env, text } = rt;
  if (REC4_YES_RE.test(text)) return (S.mode === 'dual' && S.dualRound !== 'b') ? rec4DualAdvanceToB(rt) : rec4Finalize(rt); // V10.10：雙表單——用戶A按「確認送出」時先不存，轉去問一輪用戶B；用戶B按了才是真的存
  if (REC4_EDIT_RE.test(text)) {
    S.i = 0; S.editPage = 0; S.cur = '';
    S.stage = S.items.length > 1 ? 'edit_item' : 'edit_pick';
    return rec4Done(rt, await rec4Render(S, ctx, env, [], ''));
  }
  if (REC4_NO_RE.test(text)) return rec4Cancel(rt, '');
  return rec4Done(rt, await rec4Render(S, ctx, env, [], '請點下面的按鈕：確認送出、返回修改，或取消紀錄。'));
}
async function rec4OnEdit(rt) {
  const { S, ctx, env, text } = rt;
  const sch = REC4_SCHEMAS[S.module];
  if (REC4_BACKC_RE.test(text)) { S.stage = 'confirm'; S.cur = ''; return rec4Done(rt, await rec4Render(S, ctx, env, [], '')); }
  if (S.stage === 'edit_item') {
    const n = Number(text.replace(/[^0-9]/g, ''));
    const cm = CIRCLED.indexOf(text.charAt(0));
    const idx = cm >= 0 ? cm : n - 1;
    if (!(idx >= 0 && idx < S.items.length)) return rec4Done(rt, await rec4Render(S, ctx, env, [], '請點要修改的那一筆。'));
    S.i = idx; S.stage = 'edit_pick'; S.editPage = 0;
    return rec4Done(rt, await rec4Render(S, ctx, env, [], ''));
  }
  if (S.stage === 'edit_pick') {
    if (/^(⬅\s*)?上一頁$/.test(text)) { S.editPage = Math.max(0, (S.editPage || 0) - 1); return rec4Done(rt, await rec4Render(S, ctx, env, [], '')); }
    if (/^下一頁(\s*➡)?$/.test(text)) { S.editPage = (S.editPage || 0) + 1; return rec4Done(rt, await rec4Render(S, ctx, env, [], '')); }
    let f = null;
    const num = text.match(/^(\d{1,2})[.、\s]*$/);
    const flE = sch.fields.filter((x) => rec4Active(S, S.items[S.i], x));
    if (num) f = flE[Number(num[1]) - 1] || null;
    if (!f) f = flE.find((x) => x.label.replace('（選填）', '') === text || x.label === text || x.key === text) || null;
    if (!f) return rec4Done(rt, await rec4Render(S, ctx, env, [], '沒有這個欄位，請點下面的欄位名稱，或輸入編號。'));
    S.cur = f.key; S.stage = 'edit_value';
    return rec4Done(rt, await rec4Render(S, ctx, env, [], ''));
  }
  // edit_value：回答新的內容
  const it = S.items[S.i];
  const f = rec4Field(sch, S.cur);
  if (!f) { S.stage = 'edit_pick'; return rec4Done(rt, await rec4Render(S, ctx, env, [], '')); }
  const hadBefore = {}; sch.fields.forEach((x) => { hadBefore[x.key] = rec4Has(it, x.key); }); // 改了這一欄之後，別的欄位可能跟著不符合而被清掉（例如改了群組 → 付款人不在新群組裡）
  if (REC4_KEEP_RE.test(text)) {
    if (!rec4Has(it, f.key)) return rec4Done(rt, await rec4Render(S, ctx, env, [], '這一欄目前還沒有內容，請直接輸入。'));
    it.uncertain = it.uncertain.filter((k) => k !== f.key); delete it.notes[f.key]; it.src[f.key] = 'ask';
  } else {
    if (REC4_CONFIRM_BTN_RE.test(text)) return rec4Done(rt, await rec4Render(S, ctx, env, [], REC4_CONFIRM_BTN_MSG));
    const r = rec4Parse(S, f, text);
    if (!r.ok) return rec4Done(rt, await rec4Render(S, ctx, env, [], r.msg));
    if (r.skip) {
      if (f.key === 'recorder') return rec4Done(rt, await rec4Render(S, ctx, env, [], '「紀錄者」不能留空，請輸入名字，或點「沿用」。'));
      rec4ClearValue(it, f.key); it.skip[f.key] = true;
    } else {
      rec4SetValue(it, f.key, r.value, S);
      if (r.warn) { it.uncertain.push(f.key); it.notes[f.key] = r.warn; }
    }
  }
  S.stage = 'confirm'; S.cur = '';
  const lost = sch.fields.filter((x) => x.key !== f.key && hadBefore[x.key] && !rec4Has(it, x.key)).map((x) => x.label.replace('（選填）', ''));
  return rec4Done(rt, await rec4Render(S, ctx, env, [], '已更新「' + f.label.replace('（選填）', '') + '」。' + (lost.length ? '\n⚠️ 因為這個修改，下面這些欄位已經不符合，先清除了：' + lost.join('、') + '。確認送出前會請你重新填。' : '')));
}
// 哪一筆、缺哪些必填欄位（沒有缺 → null）；rec4Finalize 跟雙表單用戶A那輪(rec4DualAdvanceToB)共用這個檢查
function rec4FirstMissing(S, sch) {
  for (let i = 0; i < S.items.length; i++) {
    const miss = sch.fields.filter((f) => rec4Active(S, S.items[i], f) && rec4IsReq(S, S.items[i], f) && (!rec4Has(S.items[i], f.key) || !!(f.invalid && f.invalid(S, S.items[i]))));
    if (miss.length) return { i, miss };
  }
  return null;
}
// V10.10：雙表單模式——用戶A按「確認送出」時不是真的存檔，是先把A的結果保留起來（S.dualA），重新走一次 rec4Begin 問用戶B同一套問題；
// 用戶B按「確認送出」時 S.dualRound 已經是 'b'，rec4OnConfirm 會改呼叫 rec4Finalize，兩邊的結果才真正合併寫入。
async function rec4DualAdvanceToB(rt) {
  const { S, ctx, env } = rt;
  const sch = REC4_SCHEMAS[S.module];
  const missing = rec4FirstMissing(S, sch);
  if (missing) { S.i = missing.i; S.cur = ''; S.stage = 'ask'; return rec4Done(rt, await rec4Advance(S, [rec4TextMsg('還缺少必填的「' + missing.miss.map((f) => f.label).join('、') + '」，補完才能送出。')], ctx, env)); }
  S.dualA = { items: S.items };
  S.dualRound = 'b';
  const mateName = (S.dualMate && S.dualMate.mateName) || '另一位';
  return rec4Begin(rt, [rec4TextMsg('✅ 用戶A的部分已經記好，接著問用戶B（' + mateName + '）的——欄位一樣，請重新回答一次 👇')]);
}

// ---------- 確認送出：寫入 ----------
function rec4RawItems(S) {
  const sch = REC4_SCHEMAS[S.module];
  return S.items.map((it) => {
    const raw = Object.assign({ kind: sch.kind }, it.fields, { uncertain: it.uncertain.slice() });
    if (sch.needLists) raw.lineNotes = Object.assign({}, it.notes); // 分帳／集點卡／待去清單：LINE 畫面上「待確認」的原因一起帶到網頁
    if (sch.kind === 'split' && raw.currency === '¥') raw.currency = 'JPY'; // 分帳表單的「¥」＝日圓；單獨的「¥」符號在草稿整理時不猜，所以改用代碼（整理後仍是表單的「¥」）
    if (sch.kind === 'food' && it.unmapped && it.unmapped.area) raw.area = it.unmapped.area;
    return raw;
  });
}
function rec4RawText(S) {
  const v = REC4_VERSIONS[S.version];
  return ('【' + v.name + '】' + (S.raw.length ? S.raw.join(' ｜ ') : '逐題問答')).slice(0, 480);
}
function rec4BuildRecord(S, it, idx, ctx) {
  const sch = REC4_SCHEMAS[S.module];
  const f = it.fields;
  const owner = it._dualOwner; // V10.10：雙表單模式——這一筆改歸戶用戶A或用戶B，不一定是講話的這個人
  const rec = {
    id: 'L' + S.startTs + (it._dualTag ? '-' + it._dualTag : ''), item: '', amount: Number(f[sch.moneyKey]) || 0, category: sch.cat,
    userId: (owner && owner.id) || ctx.userId, userName: (owner && owner.name) || S.userName || '', groupId: ctx.groupId || '', groupName: S.groupName || '',
    ts: S.startTs, msgId: S.recId + '#' + idx, detailed: true, tier: S.version,
  };
  if (it._pairId) rec.pairId = it._pairId; // 跟網頁 fmPairUp 的 pairId 是同一個欄位、同一個格式，雙表單兩筆共用同一個值
  if (sch.kind === 'drink') {
    rec.item = f.drink || '';
    rec.brand = f.brand || ''; rec.size = f.size || ''; rec.topping = f.topping && f.topping !== '無' ? f.topping : '';
    rec.sugar = f.sugar !== undefined ? (SUGAR_LABEL[f.sugar] || f.sugar) : ''; rec.ice = f.ice !== undefined ? (ICE_LABEL[f.ice] || f.ice) : '';
    rec.payment = f.payment || '';
  } else if (sch.kind === 'food') {
    rec.item = f.dish || '';
    rec.brand = f.brand || ''; rec.cuisine = f.cuisine || ''; rec.portion = f.portion || ''; rec.diningType = f.diningType || ''; rec.payment = f.payment || '';
  } else {
    rec.item = [f.type ? (TRAVEL_TYPE_LABELS[f.type] || f.type) : '', f.depPort && f.arrPort ? f.depPort + '→' + f.arrPort : ''].filter(Boolean).join(' ');
    rec.transportType = f.type || ''; rec.depPort = f.depPort || ''; rec.arrPort = f.arrPort || ''; rec.payment = f.payment || '';
  }
  if (Number(f.rating) > 0) rec.rating = Number(f.rating);
  if (f.note) rec.note = f.note;
  rec.webFields = Object.assign({}, f);
  return rec;
}
function rec4ItemLines(S, it, withFlags) {
  const sch = REC4_SCHEMAS[S.module];
  const lines = [];
  sch.fields.forEach((f) => {
    if (!rec4Has(it, f.key) || !rec4Active(S, it, f)) return;
    const flags = [];
    if (withFlags) {
      if (it.uncertain.indexOf(f.key) >= 0) flags.push('⚠待確認');
      if (it.src[f.key] === 'photo') flags.push('📷');
      else if (it.src[f.key] === 'default') flags.push('預設');
    }
    lines.push(f.label.replace('（選填）', '') + '：' + rec4Show(sch, f, it, S) + (flags.length ? '　' + flags.join(' ') : ''));
    if (withFlags && it.uncertain.indexOf(f.key) >= 0 && it.notes[f.key]) lines.push('　↳ ' + it.notes[f.key]);
  });
  return lines;
}
async function rec4Finalize(rt) {
  const { S, ctx, ev, token, env, cfg } = rt;
  const sch = REC4_SCHEMAS[S.module];
  const ver = REC4_VERSIONS[S.version];
  const missing = rec4FirstMissing(S, sch);
  if (missing) { S.i = missing.i; S.cur = ''; S.stage = 'ask'; return rec4Done(rt, await rec4Advance(S, [rec4TextMsg('還缺少必填的「' + missing.miss.map((f) => f.label).join('、') + '」，補完才能送出。')], ctx, env)); }
  const again = { label: '再記一筆', text: '紀錄' + sch.name + ' ' + ver.name };
  const mode = await rec4Mode(ctx.userId, env, cfg);
  const NO_DRAFT_TEXT = '⚠️ 現在沒辦法建立網頁草稿（同步資料不見了，或管理員關閉了草稿模式）。這一筆先保留在這裡，沒有寫入任何資料。請先確認已綁定同步碼、App 已同步過一次，再按「確認送出」重試。';
  // V10.10：雙表單——用戶A、用戶B都問完了，這裡才合併成同一次要存的清單並標記配對編號。安全網：needLists 這支已經在 rec4Begin 就不會問表單模式了，
  // draft 這支是防「問表單模式之後、確認送出之前，草稿模式才被改開」這種中途變卦；萬一真的走到這裡，寧可只存用戶A、說明清楚，也不要把兩人的資料存錯歸屬。
  // 這兩個先看 S 有沒有存過（重試時要讀回上一次合併好的結果，不能重算）：let 是因為下面兩個分支都只有「第一次」會真的賦值
  let dualNote = S.dualNote || '';
  let pairInfo = S.dualPairInfo || null;
  if (S.mode === 'dual' && S.dualA && !S.dualMerged) { // !S.dualMerged：只能合併一次。存檔中途失敗、使用者照指示再按一次「確認送出」時 S.items 已經是「A＋B合併後」的陣列，
    // 如果沒有這個檔，會把合併後的陣列當成「B那一輪」再合併一次：兩個陣列共用同一批物件參照，等於把A的那筆也改標成B，還會多出一個新配對編號——不是沒效果，是會把資料改錯。
    if (mode === 'draft' || sch.needLists) {
      dualNote = '\n⚠️ 雙表單目前只支援直接寫入，現在沒辦法把兩人分開歸戶，所以這筆先只存用戶A（你）的部分；用戶B的部分請他自己再記一次。';
      S.items = S.dualA.items;
    } else {
      const pairId = rec4NewPairId();
      const aName = S.dualMate.selfName || S.userName || '用戶A';
      const bName = S.dualMate.mateName || '用戶B';
      S.dualA.items.forEach((it, i) => { it._dualOwner = { id: S.dualMate.selfId, name: aName }; it._dualTag = 'a' + i; it._pairId = pairId; });
      S.items.forEach((it, i) => { it._dualOwner = { id: S.dualMate.mateId, name: bName }; it._dualTag = 'b' + i; it._pairId = pairId; });
      pairInfo = { pairId, aName, bName, aCount: S.dualA.items.length, bCount: S.items.length };
      S.items = S.dualA.items.concat(S.items);
    }
    S.dualMerged = true; S.dualNote = dualNote; S.dualPairInfo = pairInfo;
  }
  if (sch.needLists && mode !== 'draft') { // 分帳／集點卡／待去清單沒有「直接寫入 LINE 紀錄」這條路：只能建立網頁草稿
    await rec4Save(S, ctx, env);
    await rec4Reply(token, ev.replyToken, [rec4TextMsg(NO_DRAFT_TEXT, REC4_CONFIRM_QUICK)]);
    return true;
  }
  if (mode === 'draft') {
    const ev2 = Object.assign({}, ev, { message: { id: S.recId } }); // 同一筆紀錄固定用同一個編號：重複按「確認送出」不會產生兩張草稿
    const n = S.items.length;
    const st = await createDraftsAndReply({
      ev: ev2, token, env, ctx, userName: S.userName, groupName: S.groupName, text: rec4RawText(S), rawItems: rec4RawItems(S), via: 'rec4:' + S.version,
      replyToken: ev.replyToken, cfg, ts: S.startTs, trustRecorder: true, lists: sch.needLists ? rec4Lists(S) : undefined, failQuick: REC4_CONFIRM_QUICK, retryWord: '確認送出',
      replyOpts: { title: '✅ 已送出 ' + n + ' 張到網頁待確認（' + ver.emoji + ver.name + '）', sub: '還沒有正式儲存 — 請到網頁核對資料卡片，按【確認新增】後才會建立紀錄並產生流水號；按【取消】則不會留下任何紀錄。' },
      quick: [again, '功能選單'],
    });
    if (st === 'created' || st === 'blocked') { await clearFlagshipSession(ctx.userId, env); return true; }
    if (st === 'failed') { await rec4Save(S, ctx, env); return true; } // 已回覆失敗原因：保留在確認畫面，可以再按一次「確認送出」
    if (st === 'empty') { return rec4Done(rt, await rec4Render(S, ctx, env, [], '這筆沒有足夠的內容可以儲存，請用「返回修改」補上品項或金額。')); }
    // 'skip'：剛好沒辦法建立草稿（同步資料不見了…）→ 往下走，直接寫入 LINE 紀錄（分帳／集點卡／待去清單沒有這條路：保留在確認畫面）
    if (sch.needLists) { await rec4Save(S, ctx, env); await rec4Reply(token, ev.replyToken, [rec4TextMsg(NO_DRAFT_TEXT, REC4_CONFIRM_QUICK)]); return true; }
  }
  const records = S.items.map((it, idx) => rec4BuildRecord(S, it, idx, ctx));
  try {
    for (let k = 0; k < records.length; k++) await saveLineLogRecord(records[k], env);
  } catch (e) {
    await rec4Save(S, ctx, env);
    await rec4Reply(token, ev.replyToken, [rec4TextMsg('⚠️ 儲存時發生問題，這筆還沒有存進去。請再按一次「確認送出」重試 🙏（同一筆不會重複新增）', REC4_CONFIRM_QUICK)]);
    return true;
  }
  await clearFlagshipSession(ctx.userId, env);
  const allSynced = records.every((r) => r.synced);
  const who = S.userName ? '（' + S.userName + '）' : '';
  const head = (allSynced ? '✅ ' : '📝 ') + sch.icon + sch.name + (allSynced ? '紀錄完成' : '紀錄已暫存') + '（' + ver.emoji + ver.name + '）' + who;
  const body = S.items.map((it, idx) => (S.items.length > 1 ? CIRCLED[idx] + ' ' : '') + rec4ItemLines(S, it, false).join('\n')).join('\n\n');
  const bad = records.find((r) => !r.synced);
  const pairTxt = pairInfo ? ('\n👥 雙表單：➊ ' + pairInfo.aName + '（' + pairInfo.aCount + ' 筆）、➋ ' + pairInfo.bName + '（' + pairInfo.bCount + ' 筆），配對編號 ' + pairInfo.pairId) : '';
  const doneText = head + '\n' + body + '\n' + syncWording(bad || records[0]) + pairTxt + dualNote;
  await rec4Reply(token, ev.replyToken, [rec4TextMsg(doneText, [again, '功能選單'])]);
  return true;
}

// ---------- 文字訊息入口 ----------
// 流程進行到一半，使用者點到聊天室上方「舊的」版本按鈕、或重新輸入完整指令：這不是在回答問題，而是要改記別的 → 切換（有填過東西先確認一次）
const REC4_SWITCH_CMD_RE = /^(?:紀錄|記錄|新增)\s*(.+?)\s*(簡易版|標準版|進階版|旗艦版)$/;
function rec4SwitchOf(text) {
  const t = rec4Bare(text);
  if (/^日常小秘書$/.test(t)) return { kind: 'home' };
  const v = rec4VersionOf(text);
  if (v) return { kind: 'version', version: v };
  const m = t.match(REC4_SWITCH_CMD_RE);
  if (m) { const mod = rec4ModuleOf(m[1]); const ver = REC4_TRIGGERS[m[2]]; if (mod && ver) return { kind: 'module', module: mod, version: ver }; }
  const m2 = t.match(/^(?:紀錄|記錄|新增)\s*(.+)$/); // V10.4：「紀錄分帳」「紀錄集點卡」「新增待去地點」（沒指定版本）→ 先出版本卡片
  if (m2) { const mod2 = rec4ModuleOf(m2[1]); if (mod2 && REC4_SCHEMAS[mod2].needLists) return { kind: 'module', module: mod2, version: '' }; }
  return null;
}
function rec4SwitchLabel(sw) {
  if (sw.kind === 'home') return '重新選擇紀錄版本';
  if (sw.kind === 'version') return REC4_VERSIONS[sw.version].name;
  return REC4_SCHEMAS[sw.module].name + (sw.version ? ' ' + REC4_VERSIONS[sw.version].name : '');
}
async function rec4RunSwitch(rt, sw) {
  const { ctx, ev, token, env, cfg } = rt;
  await clearFlagshipSession(ctx.userId, env);
  if (sw.kind === 'home') { await rec4Reply(token, ev.replyToken, [rec4VersionCardMsg('日常小秘書', '事不宜遲！這次想用哪種方式記一筆呢？', (x) => REC4_VERSIONS[x].name, null)]); return true; }
  if (sw.kind === 'version') { await rec4StartVersion(sw.version, ctx, ev, token, env, cfg, []); return true; }
  await rec4StartModule(sw.module, sw.version, ctx, ev, token, env, cfg);
  return true;
}
async function handleRec4Message(ev, token, env) {
  const text = rec4Clean(ev.message.text || '');
  const ctx = makeCtx(ev);
  if (!ctx.userId || !text) return false;
  if (BOT_VERSION_CMD_RE.test(text)) return false; // 診斷指令「機器人版本」：任何時候都可以問，不會被當成答案，也不會動到進行中的紀錄
  let S = await getFlagshipSession(ctx.userId, env);
  if (S && S.flow !== 'rec4') return false; // 別的流程（記帳、集點卡、查詢…）的對話
  if (S && !rec4Owns(S, ctx)) S = null; // 這是在別的聊天室開始的紀錄：這個聊天室當成沒有進行中的紀錄
  const cfg = await loadLineConfig(env);
  if (!S) {
    const v = rec4VersionOf(text);
    if (!v) {
      const sw0 = rec4SwitchOf(text); // V10.4：「紀錄分帳 旗艦版」這類完整指令
      if (sw0 && sw0.kind === 'module') { await rec4StartModule(sw0.module, sw0.version, ctx, ev, token, env, cfg); return true; }
      return false;
    }
    await rec4StartVersion(v, ctx, ev, token, env, cfg, []);
    return true;
  }
  S.ts = Number(ev.timestamp) || Date.now();
  const rt = { S, ctx, ev, token, env, cfg, text };
  if (S.module) { // 每一步都重新檢查權限（管理員可能在流程中途改了設定）
    const av = checkAvailability(REC4_SCHEMAS[S.module].fn, ctx, cfg);
    if (!av.ok) { await clearFlagshipSession(ctx.userId, env); await rec4Reply(token, ev.replyToken, [rec4TextMsg(av.message, ['功能選單'])]); return true; }
  }
  if (S.pendingCancel) { // 「取消」（或「改記別的」）的第二步確認
    if (REC4_GIVEUP_RE.test(text)) {
      const sw0 = S.pendingSwitch ? rec4SwitchOf(S.pendingSwitch) : null;
      if (sw0) return rec4RunSwitch(rt, sw0);
      return rec4Cancel(rt, '');
    }
    S.pendingCancel = false; S.pendingSwitch = '';
    if (REC4_CONTINUE_RE.test(text) || REC4_ABORT_RE.test(text)) return rec4Done(rt, await rec4Render(S, ctx, env, [], ''));
    // 其他輸入：當成正常的回答，往下處理
  }
  const abort = REC4_ABORT_RE.test(text) || (S.stage === 'confirm' && REC4_NO_RE.test(text));
  if (abort) {
    const needAsk = S.stage !== 'confirm' && S.stage !== 'pick_module' && S.stage !== 'pick_version' && rec4HasData(S);
    if (!needAsk) return rec4Cancel(rt, '');
    S.pendingCancel = true;
    return rec4Done(rt, [rec4TextMsg('確定要放棄這筆紀錄嗎？已經填的內容會遺失（不會寫入任何資料）。', [{ label: '確定放棄', text: '確定放棄' }, { label: '繼續填寫', text: '繼續填寫' }])]);
  }
  const sw = REC4_PICK_STAGES[S.stage] ? null : rec4SwitchOf(text); // 選功能／選版本的階段自己會處理這些字
  if (sw) {
    if (!rec4HasData(S)) return rec4RunSwitch(rt, sw);
    S.pendingCancel = true; S.pendingSwitch = text;
    return rec4Done(rt, [rec4TextMsg('你正在記錄一筆。要放棄這一筆、改成「' + rec4SwitchLabel(sw) + '」嗎？已經填的內容會遺失（不會寫入任何資料）。', [{ label: '確定放棄', text: '確定放棄' }, { label: '繼續填寫', text: '繼續填寫' }])]);
  }
  switch (S.stage) {
    case 'pick_module': return rec4OnPickModule(rt);
    case 'pick_version': return rec4OnPickVersion(rt);
    case 'pick_mode': return rec4OnPickMode(rt);
    case 'pick_mate': return rec4OnPickMate(rt);
    case 'collect': return rec4OnCollect(rt);
    case 'ask': return rec4OnAsk(rt);
    case 'confirm': return rec4OnConfirm(rt);
    case 'edit_item': case 'edit_pick': case 'edit_value': return rec4OnEdit(rt);
    default: await clearFlagshipSession(ctx.userId, env); return false;
  }
}

// ---------- 照片訊息入口（拍照、相簿、上傳、貼上圖片，LINE 都是 image 訊息）----------
async function handleRec4Image(ev, token, env) {
  const ctx = makeCtx(ev);
  if (!ctx.userId || !ev.message || !ev.message.id) return false;
  const msg = { id: String(ev.message.id), contentProvider: ev.message.contentProvider || null };
  let S = await getFlagshipSession(ctx.userId, env);
  if (S && S.flow === 'rec4' && !rec4Owns(S, ctx)) S = null;
  const cfg = await loadLineConfig(env);
  if (S && S.flow !== 'rec4') { // 正在進行別的流程（記帳、分帳、集點卡、查詢…）
    if (ctx.isGroup) return false;
    ev._rec4Engaged = true;
    await rec4Reply(token, ev.replyToken, [rec4TextMsg('📷 收到照片了，不過你正在進行另一個流程，這個流程不支援照片辨識。\n可以先用文字輸入；或輸入「取消」結束後，再輸入「日常小秘書」選擇紀錄版本，那邊的照片可以辨識。', ['日常小秘書', '功能選單'])]);
    return true;
  }
  if (!S) {
    if (ctx.isGroup) return false; // 群組裡大家傳的照片不是都要處理：只有自己開了紀錄流程才接
    ev._rec4Engaged = true;
    return rec4StartVersionPhoto(ctx, ev, token, env, cfg, msg);
  }
  ev._rec4Engaged = true;
  if ((S.seen || []).indexOf(msg.id) >= 0) return true; // LINE 重送同一張照片
  S.seen = (S.seen || []).concat([msg.id]).slice(-12);
  S.ts = Number(ev.timestamp) || Date.now();
  const rt = { S, ctx, ev, token, env, cfg, text: '' };
  if (S.module) {
    const av = checkAvailability(REC4_SCHEMAS[S.module].fn, ctx, cfg);
    if (!av.ok) { await clearFlagshipSession(ctx.userId, env); await rec4Reply(token, ev.replyToken, [rec4TextMsg(av.message, ['功能選單'])]); return true; }
  }
  if (S.stage === 'pick_module' || S.stage === 'pick_version' || S.stage === 'pick_mode' || S.stage === 'pick_mate') {
    S.photos = (S.photos || []).concat([msg]).slice(0, 3);
    return rec4Done(rt, await rec4Render(S, ctx, env, [rec4TextMsg('📷 收到照片了（已先收下 ' + S.photos.length + ' 張），選好功能與版本後，我會幫你辨識。')], ''));
  }
  const r = await rec4PhotoStep(S, msg, token, env);
  const note = r.msgs.join('\n');
  if (!r.ok) return rec4Done(rt, await rec4Render(S, ctx, env, [rec4TextMsg(note)], ''));
  S.raw.push('📷 照片');
  if (S.stage === 'confirm' || S.stage === 'edit_item' || S.stage === 'edit_pick' || S.stage === 'edit_value') {
    S.stage = 'confirm'; S.cur = '';
    return rec4Done(rt, await rec4Render(S, ctx, env, [rec4TextMsg(note)], ''));
  }
  if (S.stage === 'collect') { S.cur = ''; }
  return rec4Done(rt, await rec4Advance(S, [rec4TextMsg(note)], ctx, env));
}
// 沒有進行中的紀錄、在 1 對 1 聊天室直接傳了照片：先收下，問要記成哪個功能與版本
async function rec4StartVersionPhoto(ctx, ev, token, env, cfg, msg) {
  const S = await rec4NewSession(ctx, ev, token, { stage: 'pick_module', photos: [msg], seen: [msg.id] });
  return rec4Done({ S, ctx, ev, token, env, cfg, text: '' }, await rec4Render(S, ctx, env, [], '📷 收到照片了！'));
}

// ============================================================
// 診斷：「機器人版本」—— 確認 Cloudflare 上跑的是不是新版程式
// （官方帳號看起來沒更新時，先用這個查：傳「機器人版本」給官方帳號，或打開 /api/health 看 worker 欄位）
// 只回報版本，以及各項「有沒有設定」（是／否）；不會顯示任何金鑰、密碼或同步碼本身。
// ============================================================
const BOT_LINE_VERSION = '10.13.2'; // 要跟網頁 index.html 的 LINE_VERSION、BUILD_ID 一致（backend105 測試會逐一比對）
const BOT_BUILD = '2026-11-19d';
const BOT_VERSION_CMD_RE = /^(機器人版本|機器人版號|bot版本)$/i;
async function botVersionText(env, userId) {
  const lines = [
    '🤖 日常小秘書 機器人',
    'LINE整合 V' + BOT_LINE_VERSION + '（Build ' + BOT_BUILD + '）',
    '看到這則訊息，代表 Cloudflare 上跑的就是這一版 ✅',
    '',
    '紀錄版本：' + REC4_ORDER.map((v) => REC4_VERSIONS[v].emoji + REC4_VERSIONS[v].name).join('、'),
    env.SmartDailyAssistant_GEMINI_API_KEY
      ? 'AI 辨識（一句話／照片）：已設定金鑰'
      : 'AI 辨識（一句話／照片）：⚠️ 還沒設定金鑰 — 標準版的一句話辨識與照片辨識暫時用不了；簡易版、進階版、旗艦版仍可使用',
  ];
  if (userId) {
    let mode = '';
    try { mode = await rec4Mode(userId, env, await loadLineConfig(env)); } catch (e) { mode = ''; }
    lines.push('你按「確認送出」之後：' + (
      mode === 'draft' ? '先放進網頁的「待確認」草稿，到網頁按【確認新增】才正式儲存'
        : mode === 'direct' ? '直接寫入，並同步到網頁'
          : mode === 'unbound' ? '你還沒綁定同步碼，只會暫存在 LINE（綁定方式：傳「同步碼 你的同步碼」）'
            : '（暫時查不到）'));
  }
  return lines.join('\n');
}

// ---------- 圖示（Icon）檔案：/icons/<檔名>.png ----------
//   V10.?（改版）：原本設計走 R2（見這裡之前的版本與交付報告第四節），但 R2 需要先在 Cloudflare 帳號
//   加付款方式才能開通，使用者選擇改用現有的靜態資源空間（跟 index.html 同一套 env.ASSETS）——
//   52 張圖示放在 public/icons/ 下，不用另外設定 binding，不用碰 R2／付款，交給最下面「其餘交給
//   靜態資源」那一行處理即可，所以這裡不再攔截 /icons/、不再需要 handleIconAsset／ICONS_BUCKET。
// ---------- 主路由 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/gemini') return handleGemini(request, env);
    if (url.pathname === '/api/sync') return handleSync(request, env);
    if (url.pathname === '/api/health') return handleHealth(request, env);
    if (url.pathname === '/api/line') return handleLine(request, env);
    if (url.pathname.indexOf('/api/line-config') === 0) return handleLineConfigApi(request, env);
    if (url.pathname === '/api/line-log') return handleLineLog(request, env);
    if (url.pathname === '/api/line-log-remove') return handleLineLogRemove(request, env);
    // 其餘交給靜態資源（你的 index.html、/icons/ 下的 52 張圖示都在這裡）
    return env.ASSETS.fetch(request);
  },
};

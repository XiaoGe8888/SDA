// ============================================================
// _worker.js  —  Cloudflare Pages「進階模式」單一 Worker
// 用「拖拉上傳」即可部署（不需要 functions 資料夾、不需要命令列 Wrangler）。
//
// 路由：
//   POST /api/gemini  → 轉接 Google Gemini（免費版），收/回 Anthropic 格式
//   GET/POST /api/sync → 用同步碼在 KV 存取資料（跨裝置同步）
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

async function handleSync(request, env) {
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
    const updated_at = nextVersion(prev && prev.updated_at);
    await kv.put(keyOf(code), JSON.stringify({ data: incoming, updated_at }));
    return withCORS(json({ ok: true, updated_at, preserved }));
  }

  return withCORS(json({ error: 'method not allowed' }, 405));
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
function buildRecordFromParsed(parsed, fallbackText, userId, userName, groupId, groupName, tierOverride, msgId) {
  const now = new Date();
  const hasDetail = DETAIL_KEYS.some((k) => parsed[k] != null && String(parsed[k]).trim() !== '');
  const record = {
    id: 'L' + now.getTime(),
    item: parsed.item || fallbackText,
    amount: Math.round(Number(parsed.amount) || 0),
    category: parsed.category || 'other',
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
    item: a.item || '', amount: Math.round(Number(a.amount) || 0), category: catMap[session.module] || 'other',
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
  const now = new Date(record.ts || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  const date = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
  const time = p2(now.getHours()) + ':' + p2(now.getMinutes());
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const tierTag = record.detailed ? '（' + (record.tier === 'flagship' ? '旗艦版' : '標準版') + '）' : '';

  if (record.category === 'drink') {
    return { lsKey: 'boba_recs', entry: {
      id: genId(), panel: '1', sn: '', snp: '',
      date, time, country: '', area: '',
      brand: record.brand || '', drink: record.item || '', category: '', size: record.size || '', topping: record.topping || '',
      sugar: record.sugar || '', ice: record.ice || '', payment: record.payment || '', currency: 'NT$', amount: Number(record.amount) || 0,
      drinker: toAppUserName(record.userName), payer: toAppUserName(record.userName), recorder: toAppUserName(record.userName),
      note: (record.note ? record.note + ' · ' : '') + '📱 LINE自動同步' + tierTag, ainote: '', rating: Number(record.rating) || 0,
      source: 'LINE',
    } };
  }
  if (record.category === 'food') {
    return { lsKey: 'meal_recs', entry: {
      id: genId(), panel: '1', sn: '', snp: '',
      date, time, category: '',
      brand: record.brand || '', dish: record.item || '', cuisine: record.cuisine || '', portion: record.portion || '中份', spicy: '', diningType: record.diningType || '',
      satiety: '', revisit: '', rating: Number(record.rating) || 0, payment: record.payment || '', currency: 'NT$', amount: Number(record.amount) || 0,
      eater: toAppUserName(record.userName), payer: toAppUserName(record.userName), recorder: toAppUserName(record.userName),
      note: (record.note ? record.note + ' · ' : '') + '📱 LINE自動同步' + tierTag, ainote: '',
      source: 'LINE',
    } };
  }
  if (record.category === 'travel') {
    return { lsKey: 'travel_recs', entry: {
      id: genId(), panel: 'a', type: record.transportType || 'taxi',
      date, no: '', company: '',
      depPort: record.depPort || '', arrPort: record.arrPort || '', transitPort: '',
      depTime: time, arrTime: '', duration: '', ticketPrice: Number(record.amount) || 0,
      vehicleType: '', regNo: '', seat: '', plateNo: '',
      note: (record.note ? record.note + ' · ' : '') + '📱 LINE自動同步' + tierTag + (record.item ? ' · ' + record.item : ''),
      recorder: toAppUserName(record.userName), payment: record.payment || '',
      source: 'LINE',
    } };
  }
  return null; // 記帳/分帳目前不支援自動同步（要選群組+對成員，無法全自動）
}

// 嘗試把記錄直接寫進使用者已綁定的同步資料裡；沒綁同步碼、或分類不支援，就回傳false（照舊只存line:log等手動匯入）
// 把一筆 LINE 紀錄寫進使用者「同步碼」底下的網頁資料。回傳：
//   'ok' 已寫入（或同一筆早就在了）｜'unbound' 還沒綁定同步碼｜'nodata' 同步碼底下還沒有網頁資料｜'skip' 這類紀錄沒有對應的網頁模組｜'fail' 失敗（會自動重試）
// 同一則 LINE 訊息（lineMsgId）只會寫入一次，重送／重試都不會重複；寫完會再讀一次確認，萬一被同時進來的寫入蓋掉就重做。
function nextVersion(prev) { return Math.max(Date.now(), Number(prev || 0) + 1); }
async function syncRecordToApp(userId, record, env) {
  const kv = env.SYNC_KV;
  if (!kv || !userId) return 'fail';
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
    let userName = '';
    try { userName = (await lineProfile(token, userId)) || ''; } catch (e) {}
    const now = new Date();
    const p2b = (n) => String(n).padStart(2, '0');
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      kidId: session.kidId, behaviorId: behavior.id, behaviorName: behavior.name, points: Number(behavior.points) || 0,
      date: now.getFullYear() + '-' + p2b(now.getMonth() + 1) + '-' + p2b(now.getDate()),
      time: p2b(now.getHours()) + ':' + p2b(now.getMinutes()),
      recorder: toAppUserName(userName), note: '📱 LINE記錄',
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

async function saveLineLogRecord(record, env) {
  const kv = env.SYNC_KV;
  if (!kv) throw new Error('no kv');
  const raw = await kv.get('line:log');
  const list = raw ? JSON.parse(raw) : [];
  // 同一則 LINE 訊息只會存一筆（LINE 重送、連按兩次「確認儲存」都不會重複新增）
  if (record.msgId) {
    const dup = list.find((r) => r && r.msgId === record.msgId && r.userId === record.userId && r.category === record.category);
    if (dup) { record.synced = !!dup.synced; record.syncStatus = dup.syncStatus; record.id = dup.id; return !!dup.synced; }
  }
  const status = await syncRecordToApp(record.userId, record, env);
  record.syncStatus = status;
  record.synced = status === 'ok';
  if (status === 'fail') { record.syncTries = 1; try { await kv.put('line:retry:' + record.userId, '1'); } catch (e) {} }
  list.push(record);
  await kv.put('line:log', JSON.stringify(list));
  return record.synced;
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
    await lineReplyAsk(
      token, replyToken,
      '（接續剛剛的紀錄）\n' + flow.label + '：要用哪種模式？\n單表單：一次問完（或一句話講完）\n雙表單：分兩段問，中間會停一下\n\n要用哪一種？',
      ['單表單模式', '雙表單模式']
    );
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
  await lineReplyAsk(
    token, replyToken,
    flow.label + '：要用哪種模式？\n單表單：一次問完（或一句話講完）\n雙表單：分兩段問，中間會停一下\n\n要用哪一種？',
    ['單表單模式', '雙表單模式', '↩️ 返回']
  );
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
};
const QUICK_KINDS = {
  food: { fn: 'food', label: '🍽️ 美食紀錄', category: 'food', examples: ['拉麵 180', '鼎泰豐小籠包中份現金380'] },
  travel: { fn: 'travel', label: '🚗 交通紀錄', category: 'travel', examples: ['台北到台中 1490', '計程車 250'] },
  other: { fn: 'ledger', label: '🧾 記帳', category: 'other', examples: ['薪水 30000', '房租 12000'] },
  split: { fn: 'split_add', label: '💰 分帳', category: 'split', examples: ['晚餐 1200 AA', '唱歌 3000 我先付'] },
};
const CATEGORY_FN = { drink: 'drink', food: 'food', travel: 'travel', split: 'split_add', other: 'ledger' };
const MODULE_FN = { drink: 'drink', food: 'food', travel: 'travel', split: 'ledger' };

function isGroupSource(src) { return !!(src && (src.type === 'group' || src.type === 'room')); }
function sourceGroupId(src) { return src ? (src.groupId || src.roomId || '') : ''; }
function makeCtx(ev) {
  const isGroup = isGroupSource(ev.source);
  return { isGroup, chat: isGroup ? 'group' : 'direct', groupId: sourceGroupId(ev.source), userId: (ev.source && ev.source.userId) || '' };
}

// ---------- 預設設定 ----------
function defaultLineConfig() {
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
    ],
    permissions: {
      drink: perm(), food: perm(), travel: perm(), ledger: perm(), split: perm(), split_add: perm(),
      sticker: perm({ requireGroupAuth: true, groupReply: 'private' }),
      wishlist: perm({ requireGroupAuth: true, groupReply: 'private' }),
    },
    groups: {},
    fuzzy: { suggest: 0.6, auto: 0.9 },
    query: { defaultVersion: '' },
  };
}

// ---------- 驗證／整理設定（存檔時嚴格檢查，讀取時寬鬆處理）----------
function normalizeScopeOverlap(a, b) { return a === 'both' || b === 'both' || a === b; }
function isValidFn(fn, mainIds) {
  if (FUNCTION_CATALOG[fn]) return true;
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
    const name = str(m.name, 20);
    if (!name) { errors.push('第 ' + (i + 1) + ' 個主選單沒有名稱'); return; }
    const id = str(m.id, 40) || ('m_' + Date.now().toString(36) + i);
    if (mainIds.has(id)) { errors.push('主選單 ID 重複：' + id); return; }
    mainIds.add(id);
    mains.push({ id, name, emoji: str(m.emoji, 8), order: num(m.order, i + 1), enabled: bool(m.enabled, true), scope: pick(m.scope, SCOPE_LIST, 'both'), functionId: m.functionId ? str(m.functionId, 60) : null });
  });
  mains.forEach((m) => {
    if (m.functionId && m.functionId === 'menu:' + m.id) { errors.push('主選單「' + m.name + '」不能指向自己'); m.functionId = null; }
    else if (m.functionId && !isValidFn(m.functionId, mainIds)) { errors.push('主選單「' + m.name + '」對應的功能不存在：' + m.functionId); m.functionId = null; }
  });

  const subs = [];
  const subIds = new Set();
  (Array.isArray(inp.subMenus) ? inp.subMenus : d.subMenus).slice(0, 100).forEach((s, i) => {
    s = s || {};
    const name = str(s.name, 20);
    if (!name) { errors.push('第 ' + (i + 1) + ' 個子選單沒有名稱'); return; }
    const id = str(s.id, 40) || ('s_' + Date.now().toString(36) + i);
    if (subIds.has(id)) { errors.push('子選單 ID 重複：' + id); return; }
    if (!mainIds.has(str(s.mainId, 40))) { errors.push('子選單「' + name + '」所屬的主選單不存在'); return; }
    const functionId = str(s.functionId, 60);
    if (!isValidFn(functionId, mainIds)) { errors.push('子選單「' + name + '」沒有對應到有效的功能'); return; }
    subIds.add(id);
    subs.push({ id, mainId: str(s.mainId, 40), name, emoji: str(s.emoji, 8), order: num(s.order, i + 1), enabled: bool(s.enabled, true), functionId });
  });

  const kws = [];
  const kwIds = new Set();
  (Array.isArray(inp.keywords) ? inp.keywords : d.keywords).slice(0, 300).forEach((k, i) => {
    k = k || {};
    const keyword = str(k.keyword, 30);
    if (!keyword) { errors.push('第 ' + (i + 1) + ' 筆關鍵字是空的'); return; }
    const fn = str(k.fn, 60);
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
  const cfg = { v: 1, mainMenus: mains, subMenus: subs, keywords: kws, permissions: perms, groups, fuzzy, query };

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
  if (typeof fn === 'string' && fn.indexOf('menu:') === 0) {
    const m = ((cfg && cfg.mainMenus) || []).find((x) => x.id === fn.slice(5));
    return m ? { label: m.name, writes: false, personal: false } : null;
  }
  return null;
}
async function loadLineConfig(env) {
  let stored = null;
  try { const raw = env.SYNC_KV ? await env.SYNC_KV.get(CONFIG_KEY) : null; if (raw) stored = JSON.parse(raw); } catch (e) { stored = null; }
  return sanitizeConfig(stored || {}).config;
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
  const info = fnInfo(fn, cfg);
  if (!info) return { ok: false, message: '找不到這個功能，可能已經被管理員移除。' };
  if (fn === 'menu' || fn.indexOf('menu:') === 0) return { ok: true, info, perm: permOf(cfg, fn) };
  const p = permOf(cfg, fn);
  const name = '「' + info.label + '」';
  if (!p.enabled) return { ok: false, message: name + '目前已停用。' };
  if (ctx.isGroup && p.chat === 'direct') return { ok: false, message: name + '目前只開放在跟我的 1 對 1 聊天室使用，請私訊我輸入' + name + '。' };
  if (!ctx.isGroup && p.chat === 'group') return { ok: false, message: name + '目前只開放在 LINE 群組使用。' };
  if (ctx.isGroup && p.requireGroupAuth) {
    const g = (cfg.groups || {})[ctx.groupId];
    if (!g || !g.authorized) return { ok: false, message: '這個群組還沒有被授權使用' + name + '。請管理員到 App「設定 → LINE官方帳號 × 智慧關鍵字辨識 × LINE群組使用權限」，把這個群組設為已授權。' };
  }
  if (p.allowedUsers.length && p.allowedUsers.indexOf(ctx.userId) < 0) return { ok: false, message: '你沒有使用' + name + '的權限。' };
  if (ctx.isGroup && info.writes && !readOnly && !p.groupWrite) return { ok: false, message: '群組裡目前不開放' + name + '新增資料，請改在跟我的 1 對 1 聊天室使用。' };
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
function quickReplyItems(list) {
  return {
    items: list.slice(0, 13).map((x) => {
      const label = typeof x === 'string' ? x : x.label;
      const text = typeof x === 'string' ? x : x.text;
      return { type: 'action', action: { type: 'message', label: String(label).slice(0, 20), text: String(text) } };
    }),
  };
}

// ---------- 功能選單（依設定產生）----------
function buildMenuMessage(cfg, ctx, onlyMainId) {
  const btn = (label, text) => ({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: String(label).slice(0, 40), text } });
  const withEmoji = (e, n) => (e ? e + ' ' + n : n);
  const sections = [];
  const mains = (cfg.mainMenus || []).filter((m) => m.enabled && (m.scope === 'both' || m.scope === ctx.chat) && (!onlyMainId || m.id === onlyMainId)).sort((a, b) => a.order - b.order);
  mains.forEach((m) => {
    const subs = (cfg.subMenus || []).filter((s) => s.mainId === m.id && s.enabled).sort((a, b) => a.order - b.order);
    const buttons = [];
    const names = [];
    subs.forEach((s) => { if (checkAvailability(s.functionId, ctx, cfg).ok) { buttons.push(btn(withEmoji(s.emoji, s.name), s.name)); names.push(s.name); } });
    if (!buttons.length && m.functionId && checkAvailability(m.functionId, ctx, cfg).ok) { buttons.push(btn(withEmoji(m.emoji, m.name), m.name)); names.push(m.name); }
    if (buttons.length) sections.push({ title: withEmoji(m.emoji, m.name), buttons, names });
  });
  const lines = sections.map((s) => '・' + s.names.join('／'));
  const fallback = sections.length ? '📋 功能選單\n請直接輸入想用的功能名稱：\n' + lines.join('\n') : '目前沒有可用的功能。';
  if (!sections.length) return { message: { type: 'text', text: fallback }, fallback };
  const body = [
    { type: 'text', text: '📋 功能選單', weight: 'bold', size: 'xl', color: '#5c4b37' },
    { type: 'text', text: '請選擇要使用的功能，也可以直接輸入功能名稱', size: 'xs', color: '#8b8b8b', wrap: true, margin: 'sm' },
  ];
  sections.forEach((s) => body.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: [{ type: 'text', text: s.title, weight: 'bold', size: 'sm', color: '#8b7355' }].concat(s.buttons) }));
  if (onlyMainId) body.push({ type: 'box', layout: 'vertical', margin: 'lg', contents: [btn('↩️ 功能選單', '功能選單')] });
  return {
    message: { type: 'flex', altText: '功能選單：' + sections.map((s) => s.names.join('／')).join('／').slice(0, 300), contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: body } } },
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
  const head = kind === 'travel' && travelType ? TRAVEL_TYPE_LABELS[travelType] + ' 交通紀錄' : k.label;
  return head + '：請輸入內容與金額，例如：\n・' + k.examples.join('\n・');
}
async function startQuickRecord(kind, userId, env, token, replyToken) {
  if (kind === 'travel') {
    await setFlagshipSession(userId, { flow: 'quick', kind, stage: 'pickType', travelType: null }, env);
    await lineReplyAsk(token, replyToken, '🚗 交通紀錄：要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS.concat([BACK_LABEL]));
    return;
  }
  await setFlagshipSession(userId, { flow: 'quick', kind, stage: 'await' }, env);
  await lineReplyAsk(token, replyToken, quickPromptText(kind, null), [BACK_LABEL]);
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
  await askConfirm(userId, session, record, ev.replyToken, token, env);
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
    summary = '📍 待去清單\n你還沒綁定同步碼，所以這裡看不到清單摘要。傳「同步碼 你的碼」綁定後就會顯示（App「設定→雲端同步」可以看到同步碼）。\n\n完整的待去清單（表格／看板／地圖）在App裡，按下面的按鈕開啟。';
  } else {
    let obj = null;
    try { obj = await fetchSyncedObject(userId, 'wishlist_data_v2', env); } catch (e) {}
    summary = wishlistSummaryText(obj);
  }
  return {
    messages: [
      { type: 'text', text: summary },
      { type: 'template', altText: '待去清單', template: { type: 'buttons', text: '要開啟完整的待去清單嗎？', actions: [{ type: 'uri', label: '📱 開啟待去清單', uri: url }, { type: 'message', label: '↩️ 功能選單', text: '功能選單' }] } },
    ],
    fallback: summary + '\n\n開啟待去清單：' + url,
  };
}

// ---------- 集點卡：開始流程（進行中的對話由 handleStickerCardMessage 處理）----------
async function startStickerFlow(userId, env, priv) {
  const kids = await fetchSyncedArray(userId, 'sticker_kids', env);
  if (kids === null) return { ok: false, text: '你還沒綁定同步碼喔，先傳「同步碼 你的碼」綁定（App設定→雲端同步可以看到），才能用LINE記集點卡。' };
  if (!kids.length) return { ok: false, text: '你的集點卡裡還沒有任何孩子，先到App「🌟集點卡→👶乖寶寶集點卡」新增一位孩子吧。' };
  await setFlagshipSession(userId, { flow: 'stickerkid', stage: 'pickKid', kids, kidId: null, private: !!priv }, env);
  return { ok: true, text: '🌟 要幫哪個孩子集點？', options: kids.map((k) => k.name) };
}
const PRIVATE_FAIL_TEXT = '我沒辦法私訊你（需要先把我加為好友），為了保護個人資料，群組裡不會顯示內容。請先加我為好友後再試一次，或直接私訊我。';
async function enterSticker(ctx, ev, token, env, perm) {
  const priv = ctx.isGroup && perm.groupReply !== 'public';
  const r = await startStickerFlow(ctx.userId, env, priv);
  if (!r.ok) { await lineReply(token, ev.replyToken, r.text); return; }
  if (!priv) { await lineReplyAsk(token, ev.replyToken, r.text, r.options); return; }
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
//   ・規格沒有確認的地方（例如美食／交通的旗艦版表單、待去清單的 LINE 新增表單）不自己猜，直接說明「待確認」。
// ============================================================
const MODULES = {
  drink: { fn: 'drink', name: '飲料', label: '飲料紀錄', tier: 'drink', blobKey: 'boba_recs', cat: 'drink', dateKey: 'date', amountKey: 'amount', record: { simple: true, standard: true, flagship: true } },
  food: { fn: 'food', name: '美食', label: '美食紀錄', tier: 'food', blobKey: 'meal_recs', cat: 'food', dateKey: 'date', amountKey: 'amount', record: { simple: true, standard: true, flagship: false } },
  travel: { fn: 'travel', name: '交通', label: '交通紀錄', tier: 'travel', blobKey: 'travel_recs', cat: 'travel', dateKey: 'date', amountKey: 'ticketPrice', record: { simple: true, standard: true, flagship: false } },
  wishlist: { fn: 'wishlist', name: '待去清單', label: '待去清單', blobKey: 'wishlist_data_v2', wish: true, dateKey: 'suggestDate', record: { simple: false, standard: false, flagship: false } },
};
const WISH_DATE_KEYS = { suggestDate: '提議日期', targetTime: '預計時間', completedDate: '完成日期' };
const VERSION_INFO = { simple: '簡易版', standard: '標準版', flagship: '旗艦版' };
const VERSION_WORDS = [['simple', ['簡易版', '簡易']], ['standard', ['標準版', '標準']], ['flagship', ['旗艦版', '旗艦']]];
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
  targetTime: '預計時間', completedDate: '完成日期', category: '分類', openHours: '營業時間',
};
const HIDDEN_FIELDS = ['id', 'panel', 'snp', 'importedAt', 'lineMsgId', 'ainote', '_pending', 'ts'];

// ---------- 讓使用者知道「有沒有同步到網頁」：沒同步成功前，不說「已完成」----------
function syncWording(record) {
  if (record.synced) return '✅ 已同步到網頁';
  if (record.syncStatus === 'fail') return '⚠️ 已暫存在 LINE，但同步到網頁失敗，稍後會自動重試（也可以到 App「📱LINE記帳」手動匯入）';
  if (record.syncStatus === 'nodata') return '📝 已暫存在 LINE（這組同步碼底下還沒有網頁資料，請先在 App 按一次雲端同步上傳）';
  if (record.syncStatus === 'unbound') return '📝 已暫存在 LINE（還沒綁定同步碼，網頁看不到；綁定同步碼後，或到 App「📱LINE記帳」匯入）';
  return '📝 已暫存在 LINE，請到 App「📱LINE記帳」匯入'; // 記帳／分帳：App 還沒有對應的模組，不會自動同步
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
async function askConfirm(userId, session, record, replyToken, token, env) {
  session.stage = 'confirm';
  session.pending = record;
  await setFlagshipSession(userId, session, env);
  await lineReplyMessages(token, replyToken, [{
    type: 'text',
    text: '📋 請確認這筆「' + (CATEGORY_NAME[record.category] || '') + '」紀錄：\n' + recordSummaryText(record) + '\n\n按「確認儲存」才會寫入；不要的話按「放棄」。',
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
    const list = JSON.parse((await kv.get('line:log')) || '[]');
    let changed = false;
    let remaining = 0;
    for (const r of list) {
      if (r && r.userId === userId && !r.synced && r.syncStatus === 'fail') {
        const st = await syncRecordToApp(userId, r, env);
        r.syncStatus = st;
        r.syncTries = (r.syncTries || 0) + 1;
        if (st === 'ok') { r.synced = true; changed = true; } else if (st === 'fail') remaining++;
        else changed = true;
      }
    }
    if (changed) await kv.put('line:log', JSON.stringify(list));
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
async function sendVersionMenu(token, ev, mod, op, restClean) {
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
  if (mod.wish || !mod.record[version]) {
    const avail = Object.keys(VERSION_INFO).filter((v) => mod.record[v]);
    const msg = mod.wish
      ? '🚧 「待去清單」在 LINE 新增地點的表單（簡易版／標準版／旗艦版）還沒有確認欄位規格，我不會自己猜。\n目前請到 App 新增。'
      : '🚧 「' + mod.name + '」的' + VERSION_INFO[version] + '紀錄表單，規格還沒有確認，我不會自己猜欄位。\n目前可用：' + avail.map((v) => VERSION_INFO[v]).join('、') + '。要用完整表單，可以到 App 的「' + mod.label + '」。';
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
  const av = checkAvailability(mod.fn, ctx, cfg, { read: cmd.op !== 'record' });
  if (!av.ok) { await lineReplyQuick(token, ev.replyToken, av.message, ['功能選單']); return true; }
  if (!cmd.op) { await sendOpMenu(token, ev, mod); return true; }
  const cond = parseConditions(cmd.rest);
  if (cond.ask) { await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: '🤔 ' + cond.ask, quickReply: quickReplyItems(['功能選單']) }]).catch(() => {}); return true; }
  const restClean = condRest(cond);
  if (cmd.op === 'record') {
    if (!cond.version) { await sendVersionMenu(token, ev, mod, 'record', ''); return true; }
    return launchRecord(mod, cond.version, ctx, ev, token, env);
  }
  const version = cond.version || (cfg.query && cfg.query.defaultVersion) || null;
  if (mod.wish && (cond.year || cond.month || cond.day) && !cond.dateKey) { // 待去清單有三種日期，不自己猜
    const items = Object.keys(WISH_DATE_KEYS).map((k) => ({ label: WISH_DATE_KEYS[k], text: ('查詢' + mod.name + ' ' + (restClean ? restClean + ' ' : '') + WISH_DATE_KEYS[k] + (version ? ' ' + VERSION_INFO[version] : '')).slice(0, 280) }));
    await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: '待去清單有三種日期，你要用哪一種來篩選？', quickReply: quickReplyItems(items.concat([{ label: '功能選單', text: '功能選單' }])) }]).catch(() => {});
    return true;
  }
  if (!version) { await sendVersionMenu(token, ev, mod, 'query', restClean + (cond.dateKey ? ' ' + WISH_DATE_KEYS[cond.dateKey] : '')); return true; }
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
  const drinkFields = FLAGSHIP_SCHEMAS.drink.core.concat(FLAGSHIP_SCHEMAS.drink.extended).map((f) => FIELD_LABELS[f.key] || f.key);
  const std = { drink: ['brand', 'size', 'topping', 'sugar', 'ice', 'payment'], food: ['cuisine', 'portion', 'diningType', 'payment'], travel: ['transportType', 'depPort', 'arrPort', 'payment'] };
  const modules = Object.keys(MODULES).filter((id) => !MODULES[id].wish).map((id) => {
    const m = MODULES[id];
    return {
      id, name: m.name, label: m.label,
      record: {
        simple: { status: 'confirmed', fields: ['品項', '金額'].concat(id === 'travel' ? ['交通類型（先選）'] : []), note: '一題一題問；可選單表單／雙表單' },
        standard: { status: 'confirmed', fields: ['品項', '金額'].concat(std[id].map((k) => FIELD_LABELS[k] || k)), note: '一句話描述，AI 自動拆出欄位（沒提到的不會亂猜）' },
        flagship: id === 'drink' ? { status: 'confirmed', fields: drinkFields, note: '逐題問答，可選單表單／雙表單' } : { status: 'pending', fields: [], note: '旗艦版表單的欄位與順序尚未確認' },
      },
      query: {
        conditions: ['年份', '月份', '日期', '關鍵字（可單獨或組合）'],
        simple: { status: 'default', note: '摘要（筆數、合計）＋每頁 5 筆的簡短一行' },
        standard: { status: 'default', note: '摘要＋每頁 8 筆，含主要欄位' },
        flagship: { status: 'default', note: '摘要＋每頁 3 筆，顯示該筆儲存的全部欄位' },
      },
    };
  });
  const wishlist = {
    id: 'wishlist', name: '待去清單', label: '待去清單',
    record: { simple: { status: 'pending', fields: [], note: '' }, standard: { status: 'pending', fields: [], note: '' }, flagship: { status: 'pending', fields: [], note: '' } },
    query: { conditions: ['關鍵字', '年／月／日（需指定依「提議日期／預計時間／完成日期」哪一種）'], simple: { status: 'default', note: '摘要＋每頁 5 筆' }, standard: { status: 'default', note: '摘要＋每頁 8 筆' }, flagship: { status: 'default', note: '摘要＋每頁 3 筆，全部欄位' } },
  };
  const pending = [
    '美食紀錄、交通紀錄「旗艦版」的表單：欄位、順序、哪些必填（目前沒有已確認的規格）',
    '待去清單在 LINE「新增」的簡易版／標準版／旗艦版：各版本要問哪些欄位、哪些必填（網頁表單有完整欄位，但 LINE 的版本拆法還沒定）',
    '三個版本的「查詢」各自該呈現什麼（目前只用「顯示詳細程度」區分，欄位都不刪減；這是預設值，等你確認）',
    '旗艦版查詢的「進階條件」與「管理能力」（例如修改、刪除）',
    '記帳、分帳管理、集點卡納入「紀錄／查詢＋三版本」的方式',
    '透過 LINE 修改、刪除已儲存的紀錄：要選哪一筆、誰有權限、怎麼確認',
  ];
  return { modules: modules.concat([wishlist]), pending };
}

// ---------- 執行功能 ----------
async function executeFunction(fn, ctx, ev, token, env, cfg) {
  if (!fnInfo(fn, cfg)) { await lineReply(token, ev.replyToken, '找不到這個功能，可能已經被管理員移除。'); return true; }
  if (fn === 'menu') { await sendMenuFor(token, ev, cfg, null); return true; }
  if (fn.indexOf('menu:') === 0) { await sendMenuFor(token, ev, cfg, fn.slice(5)); return true; }
  const mainMod = Object.keys(MODULES).map((k) => MODULES[k]).find((m) => m.fn === fn);
  if (mainMod) return runCommand({ mod: mainMod, op: null, rest: '' }, ctx, ev, token, env, cfg); // 先選「紀錄／查詢」
  const av = checkAvailability(fn, ctx, cfg);
  if (!av.ok) { await lineReplyQuick(token, ev.replyToken, av.message, ['功能選單']); return true; }
  switch (fn) {
    case 'ledger': case 'split_add': {
      const kind = Object.keys(QUICK_KINDS).find((q) => QUICK_KINDS[q].fn === fn);
      await startQuickRecord(kind, ctx.userId, env, token, ev.replyToken);
      return true;
    }
    case 'split': await sendSplitCard(token, ev); return true;
    case 'sticker': await enterSticker(ctx, ev, token, env, av.perm); return true;
    default: return false;
  }
}

// ---------- 記下看過哪些使用者／群組（讓管理頁面可以挑選、授權）；只有第一次看到才寫入 ----------
async function touchRegistry(ev, token, env, ctx) {
  try {
    const kv = env.SYNC_KV;
    if (!kv) return;
    let reg = {};
    try { reg = JSON.parse((await kv.get(REGISTRY_KEY)) || '{}'); } catch (e) { reg = {}; }
    reg.users = reg.users || {};
    reg.groups = reg.groups || {};
    let changed = false;
    if (ctx.userId && !reg.users[ctx.userId]) {
      let name = '';
      try { name = (ctx.isGroup ? await lineGroupMemberProfile(token, ctx.groupId, ctx.userId) : await lineProfile(token, ctx.userId)) || ''; } catch (e) {}
      reg.users[ctx.userId] = { name, at: Date.now() };
      changed = true;
    }
    if (ctx.isGroup && ctx.groupId && !reg.groups[ctx.groupId]) {
      let gname = '';
      try { gname = (await lineGroupSummary(token, ctx.groupId)) || ''; } catch (e) {}
      reg.groups[ctx.groupId] = { name: gname, at: Date.now() };
      changed = true;
    }
    if (changed) await kv.put(REGISTRY_KEY, JSON.stringify(reg));
  } catch (e) {}
}

// ---------- 路由：訊息 → 關鍵字比對 → 功能 ----------
async function handleKeywordRouter(ev, token, env) {
  const text = (ev.message.text || '').trim();
  if (!text) return false;
  const ctx = makeCtx(ev);
  const cfg = await loadLineConfig(env);
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
  await touchRegistry(ev, token, env, ctx);
  await retryUnsynced(ctx.userId, env); // 之前同步失敗的紀錄，這時自動重試
  const session = await getFlagshipSession(ctx.userId, env);
  // 舊版「選模組」按鈕（飲料／美食／交通／記帳）：正在選模組時，這些字是在回答問題，不是要開新功能
  if (session && session.flow !== 'quick' && session.flow !== 'stickerkid' && session.flow !== 'op' && !session.module && MODULE_NAMES.indexOf(normalizeKeyword(text)) >= 0) return false;
  const m = matchKeyword(text, buildRules(cfg), ctx.chat, !!session, cfg.fuzzy);
  if (session && session.flow === 'op' && m.kind === 'hit' && m.fn !== 'menu') return false; // 正在輸入查詢條件：條件裡剛好有別的功能名稱，不要打斷
  if (!session && !(m.kind === 'hit' && m.rank === 0)) { // 不是完全相同的關鍵字：試試看是不是「操作詞＋主功能＋條件」的完整指令
    const cmd = parseCommand(text, cfg);
    if (cmd) return runCommand(cmd, ctx, ev, token, env, cfg);
  }
  if (m.kind === 'none') return false;
  if (m.kind === 'ambiguous' || m.kind === 'suggest') { await sendCandidates(token, ev, cfg, m.fns, m.kind === 'suggest'); return true; }
  if (m.confirm) {
    const label = fnLabel(m.fn, cfg);
    await lineReplyMessages(token, ev.replyToken, [{ type: 'text', text: '你是要開啟「' + label + '」嗎？點下面的按鈕開啟；不是的話，不用理這則訊息。', quickReply: quickReplyItems([{ label: '開啟' + label, text: label }]) }]).catch(() => {});
    return true;
  }
  await clearFlagshipSession(ctx.userId, env); // 切換功能 → 結束手上正在進行的流程
  return executeFunction(m.fn, ctx, ev, token, env, cfg);
}

// ---------- 管理 API：/api/line-config（App「設定」頁面使用；需要管理密碼）----------
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function knownGroupsAndUsers(env, cfg) {
  const out = { groups: [], users: [] };
  let reg = {};
  try { reg = JSON.parse((await env.SYNC_KV.get(REGISTRY_KEY)) || '{}'); } catch (e) { reg = {}; }
  const groups = {};
  Object.keys(reg.groups || {}).forEach((gid) => { groups[gid] = { groupId: gid, name: reg.groups[gid].name || '', seenAt: reg.groups[gid].at || 0 }; });
  try { // 過去記帳紀錄裡出現過的群組也列進來
    JSON.parse((await env.SYNC_KV.get('line:log')) || '[]').forEach((r) => { if (r && r.groupId && !groups[r.groupId]) groups[r.groupId] = { groupId: r.groupId, name: r.groupName || '', seenAt: r.ts || 0 }; });
  } catch (e) {}
  Object.keys(cfg.groups || {}).forEach((gid) => { if (!groups[gid]) groups[gid] = { groupId: gid, name: cfg.groups[gid].name || '', seenAt: 0 }; });
  out.groups = Object.keys(groups).map((gid) => Object.assign(groups[gid], { name: (cfg.groups[gid] && cfg.groups[gid].name) || groups[gid].name, authorized: !!(cfg.groups[gid] && cfg.groups[gid].authorized) }));
  out.users = Object.keys(reg.users || {}).map((uid) => ({ userId: uid, name: reg.users[uid].name || '' }));
  return out;
}
async function handleLineConfigApi(request, env) {
  const adminKey = env.LINE_ADMIN_PASSWORD || '';
  if (!adminKey) return json({ error: 'not_configured', message: '還沒設定管理密碼。請到 Cloudflare → Workers → sda → 設定 → 變數和祕密，新增一個名稱為 LINE_ADMIN_PASSWORD 的變數（內容自己決定），儲存並部署後再回來。' }, 403);
  if (!safeEqual(request.headers.get('x-admin-key'), adminKey)) return json({ error: 'unauthorized', message: '管理密碼不正確。' }, 401);
  if (!env.SYNC_KV) return json({ error: 'KV not bound' }, 500);
  const path = new URL(request.url).pathname;
  const catalog = Object.keys(FUNCTION_CATALOG).map((id) => Object.assign({ id }, FUNCTION_CATALOG[id]));

  if (request.method === 'GET' && path === '/api/line-config') {
    const cfg = await loadLineConfig(env);
    const known = await knownGroupsAndUsers(env, cfg);
    return json({ config: cfg, functions: catalog, groups: known.groups, users: known.users, specs: buildSpecs() });
  }
  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    if (path === '/api/line-config-reset') { // 還原預設不需要帶資料
      await env.SYNC_KV.delete(CONFIG_KEY);
      const cfg = await loadLineConfig(env);
      const known = await knownGroupsAndUsers(env, cfg);
      return json({ ok: true, config: cfg, functions: catalog, groups: known.groups, users: known.users });
    }
    if (!body || typeof body !== 'object') return json({ error: 'bad_request', message: '資料格式不正確' }, 400);
    if (path === '/api/line-config') {
      const res = sanitizeConfig(body && body.config);
      if (res.errors.length) return json({ error: 'invalid', message: res.errors[0], errors: res.errors }, 400);
      await env.SYNC_KV.put(CONFIG_KEY, JSON.stringify(res.config));
      const known = await knownGroupsAndUsers(env, res.config);
      return json({ ok: true, config: res.config, warnings: res.warnings, functions: catalog, groups: known.groups, users: known.users });
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
  if (session && (session.flow === 'stickerkid' || session.flow === 'quick' || session.flow === 'op')) return false; // 集點卡／「紀錄」快速記錄流程的session，交給各自的handler處理
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
      await lineReplyAsk(token, ev.replyToken, '請選擇：單表單模式 或 雙表單模式', ['單表單模式', '雙表單模式']);
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
    await askConfirm(userId, session, record, ev.replyToken, token, env);
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
    await askConfirm(userId, session, record, ev.replyToken, token, env);
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
  // 指令：圖文選單點「日常小秘書」時送出的觸發文字 —— 回一張「按鈕卡片」讓你三選一
  if (/^日常小秘書$/.test(text)) {
    await lineReplyButtons(
      token, ev.replyToken,
      '請選擇記帳方式',
      '事不宜遲！這次想用哪種方式記一筆呢？',
      [
        { label: '🟢 簡易版', text: '簡易版' },
        { label: '🟡 標準版', text: '標準版' },
        { label: '🔴 旗艦版', text: '旗艦版' },
      ]
    );
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
    await lineReply(token, ev.replyToken, '✅ 已綁定同步碼！之後LINE記的🧋飲料/🍱美食/🚆交通會自動同步進App，不用再手動匯入（💰記帳/分帳目前還是要手動處理）。\n\n' + summary);
    return;
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
  for (const ev of events) {
    if (ev.type === 'message' && ev.message && ev.message.type === 'text' && ev.replyToken) {
      try {
        ev.appOrigin = new URL(request.url).origin; // 給「開啟App」按鈕組網址用
        const handled = (await handleKeywordRouter(ev, token, env)) || (await handleOpMessage(ev, token, env)) || (await handleQuickMessage(ev, token, env)) || (await handleFlagshipMessage(ev, token, env)) || (await handleStickerCardMessage(ev, token, env));
        if (!handled) await handleExpenseMessage(ev, token, env);
      } catch (e) {
        try { await lineReply(token, ev.replyToken, '發生了一點問題 🙏 請再試一次'); } catch (e2) {}
      }
    }
  }
  return new Response('OK');
}

// 讀取 LINE 記帳資料（給 App 讀、也方便測試時用瀏覽器查看）
async function handleLineLog(request, env) {
  if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }));
  const kv = env.SYNC_KV;
  if (!kv) return withCORS(json({ error: 'KV not bound' }, 500));
  const raw = await kv.get('line:log');
  const list = raw ? JSON.parse(raw) : [];
  return withCORS(json({ count: list.length, records: list }));
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
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return withCORS(json({ error: 'missing ids' }, 400));

  const raw = await kv.get('line:log');
  const list = raw ? JSON.parse(raw) : [];
  const idSet = new Set(ids);
  const remaining = list.filter((r) => !idSet.has(String(r.id)));
  await kv.put('line:log', JSON.stringify(remaining));
  return withCORS(json({ ok: true, removed: list.length - remaining.length, remaining: remaining.length }));
}

// ---------- 主路由 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/gemini') return handleGemini(request, env);
    if (url.pathname === '/api/sync') return handleSync(request, env);
    if (url.pathname === '/api/line') return handleLine(request, env);
    if (url.pathname.indexOf('/api/line-config') === 0) return handleLineConfigApi(request, env);
    if (url.pathname === '/api/line-log') return handleLineLog(request, env);
    if (url.pathname === '/api/line-log-remove') return handleLineLogRemove(request, env);
    // 其餘交給靜態資源（你的 index.html 等）
    return env.ASSETS.fetch(request);
  },
};

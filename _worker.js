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
    const rec = { data: body.data || {}, updated_at: body.updated_at || Date.now() };
    await kv.put(keyOf(code), JSON.stringify(rec));
    return withCORS(json({ ok: true, updated_at: rec.updated_at }));
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
async function autoSyncRecord(userId, record, env) {
  try {
    const kv = env.SYNC_KV;
    if (!kv || !userId) return false;
    const code = await kv.get('line:usersync:' + userId);
    if (!code) return false;
    const shaped = shapeForAutoSync(record);
    if (!shaped) return false;
    const raw = await kv.get(keyOf(code));
    if (!raw) return false;
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { return false; }
    const data = rec.data || {};
    let arr;
    try { arr = data[shaped.lsKey] ? JSON.parse(data[shaped.lsKey]) : []; } catch (e) { arr = []; }
    arr.unshift(shaped.entry);
    data[shaped.lsKey] = JSON.stringify(arr);
    await kv.put(keyOf(code), JSON.stringify({ data, updated_at: Date.now() }));
    return true;
  } catch (e) { return false; }
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
// 處理「集點卡」的LINE對話流程：打「集點卡」→選孩子→選行為→自動記點。只做1對1、只支援乖寶寶集點卡（互助集點卡目前還沒接LINE）。
async function handleStickerCardMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = !!(ev.source && ev.source.type === 'group');
  if (isGroup || !userId) return false;

  let session = await getFlagshipSession(userId, env);
  if (session && session.flow !== 'stickerkid') return false; // 不是集點卡的session，交給別的handler

  if (!session) {
    if (text !== '集點卡') return false;
    const kids = await fetchSyncedArray(userId, 'sticker_kids', env);
    if (kids === null) {
      await lineReply(token, ev.replyToken, '你還沒綁定同步碼喔，先傳「同步碼 你的碼」綁定（App設定→雲端同步可以看到），才能用LINE記集點卡。');
      return true;
    }
    if (!kids.length) {
      await lineReply(token, ev.replyToken, '你的集點卡裡還沒有任何孩子，先到App「🌟集點卡→👶乖寶寶集點卡」新增一位孩子吧。');
      return true;
    }
    session = { flow: 'stickerkid', stage: 'pickKid', kids, kidId: null };
    await setFlagshipSession(userId, session, env);
    await lineReplyAsk(token, ev.replyToken, '🌟 要幫哪個孩子集點？', kids.map((k) => k.name));
    return true;
  }

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
  const synced = await autoSyncRecord(record.userId, record, env);
  if (synced) record.synced = true;
  list.push(record);
  await kv.put('line:log', JSON.stringify(list));
  return synced;
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
// 📋 「紀錄」功能選單與關鍵字跳轉
//   ・輸入「紀錄」→ 顯示整合選單；也可以不經選單，直接輸入功能名稱快速進入。
//   ・選單按鈕送出的文字 = 關鍵字本身，所以「點按鈕」跟「直接打字」一定走同一條路、進到同一個功能。
//   ・關鍵字只有在「整則訊息完全相符」時才會觸發（避免誤判，例如單打「分帳」不會被當成「分帳管理」）。
//   ・集點卡、待去清單會讀取個人資料，只開放 1對1 聊天室；其餘功能群組也能用。
// ============================================================
const DEFAULT_APP_URL = 'https://sda.hongxiaoge0615.workers.dev';
const RECORD_MENU_KEYWORDS = ['紀錄', '主選單', '回主選單', 'menu', 'home'];
const FUNCTION_KEYWORDS = ['飲料紀錄', '美食紀錄', '交通紀錄', '記帳', '分帳管理', '記一筆分帳', '集點卡', '待去清單'];
const ALL_KEYWORDS = new Set(RECORD_MENU_KEYWORDS.concat(FUNCTION_KEYWORDS));
// 群組裡只認「紀錄」跟中文功能名稱；主選單／menu／home 這種平常聊天容易誤打到的，群組裡不處理
const GROUP_KEYWORDS = new Set(['紀錄'].concat(FUNCTION_KEYWORDS));
const BACK_LABEL = '\u21A9\uFE0F 返回';
const BACK_RE = /^\u21A9\uFE0F?\s*返回$/;
const QUICK_CANCEL_RE = /^(取消|cancel|結束|結束此次對話|離開|退出|quit|exit)$/i;
// 「輸入一句話＋金額」的快速記錄：依使用者選的功能固定分類，不讓AI自己猜
const QUICK_KINDS = {
  food: { keyword: '美食紀錄', label: '🍽️ 美食紀錄', category: 'food', examples: ['拉麵 180', '鼎泰豐小籠包中份現金380'] },
  travel: { keyword: '交通紀錄', label: '🚗 交通紀錄', category: 'travel', examples: ['台北到台中 1490', '計程車 250'] },
  other: { keyword: '記帳', label: '🧾 記帳', category: 'other', examples: ['薪水 30000', '房租 12000'] },
  split: { keyword: '記一筆分帳', label: '💰 分帳', category: 'split', examples: ['晚餐 1200 AA', '唱歌 3000 我先付'] },
};

function normalizeKeyword(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[。.!！?？~～]+$/, '').toLowerCase();
}

async function lineReplyMessages(token, replyToken, messages) {
  return fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ replyToken, messages }),
  });
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

const RECORD_MENU_FALLBACK = '📋 紀錄\n請直接輸入想用的功能名稱：\n・飲料紀錄／美食紀錄／交通紀錄\n・記帳／分帳管理\n・集點卡\n・待去清單';
function recordMenuMessage() {
  const btn = (label, text) => ({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label, text } });
  const section = (title, buttons) => ({
    type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg',
    contents: [{ type: 'text', text: title, weight: 'bold', size: 'sm', color: '#8b7355' }].concat(buttons),
  });
  return {
    type: 'flex',
    altText: '紀錄選單：飲料紀錄／美食紀錄／交通紀錄／記帳／分帳管理／集點卡／待去清單',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'text', text: '📋 紀錄', weight: 'bold', size: 'xl', color: '#5c4b37' },
          { type: 'text', text: '請選擇要使用的功能，也可以直接輸入功能名稱', size: 'xs', color: '#8b8b8b', wrap: true, margin: 'sm' },
          section('飲食與交通紀錄', [btn('🥤 飲料紀錄', '飲料紀錄'), btn('🍽️ 美食紀錄', '美食紀錄'), btn('🚗 交通紀錄', '交通紀錄')]),
          section('帳務管理', [btn('🧾 記帳', '記帳'), btn('💰 分帳管理', '分帳管理')]),
          section('集點卡', [btn('🎁 集點卡', '集點卡')]),
          section('待去清單', [btn('🗺️ 待去清單', '待去清單')]),
          { type: 'text', text: '集點卡、待去清單會讀取你的個人資料，需在與我的1對1聊天室使用', size: 'xxs', color: '#aaaaaa', wrap: true, margin: 'lg' },
        ],
      },
    },
  };
}
async function sendRecordMenu(token, replyToken) {
  await lineReplyCards(token, replyToken, [recordMenuMessage()], RECORD_MENU_FALLBACK);
}

// ----- 快速記錄（美食紀錄／交通紀錄／記帳／記一筆分帳）-----
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
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = !!(ev.source && ev.source.type === 'group');
  const groupId = isGroup ? ((ev.source && ev.source.groupId) || '') : '';
  if (!userId) return false;
  const session = await getFlagshipSession(userId, env);
  if (!session || session.flow !== 'quick') return false;
  const k = QUICK_KINDS[session.kind];
  if (!k) { await clearFlagshipSession(userId, env); return false; }

  if (QUICK_CANCEL_RE.test(text)) {
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, '已取消。', ['紀錄']);
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
    await sendRecordMenu(token, ev.replyToken);
    return true;
  }
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
    userName = (isGroup ? await lineGroupMemberProfile(token, groupId, userId) : await lineProfile(token, userId)) || '';
  } catch (e) {}
  if (isGroup) { try { groupName = (await lineGroupSummary(token, groupId)) || ''; } catch (e) {} }
  const record = buildRecordFromParsed(parsed, text, userId, userName, groupId, groupName, undefined, ev.message.id);
  record.category = k.category; // 依選的功能固定分類
  if (session.kind === 'travel' && session.travelType) record.transportType = session.travelType;
  let synced = false;
  try {
    synced = await saveLineLogRecord(record, env);
  } catch (e) {
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, '存檔時發生問題，請稍後再試一次 🙏', null);
    return true;
  }
  await clearFlagshipSession(userId, env);
  const tail = synced ? '✅ 已自動同步到App'
    : (k.category === 'food' || k.category === 'travel') ? '之後可以到App的「📱LINE記帳」匯入（綁定同步碼後會自動同步）'
      : k.category === 'split' ? '到App的「📱LINE記帳」按「📥匯入分帳」選群組'
        : '到App的「📱LINE記帳」手動匯入';
  const typeLine = session.kind === 'travel' && session.travelType ? TRAVEL_TYPE_LABELS[session.travelType] + '　' : '';
  const doneText = '✅ ' + k.label + ' 已記錄' + (userName ? '（' + userName + '）' : '') + '\n' + typeLine + record.item + '　$' + record.amount + '\n' + tail;
  await lineReplyCards(token, ev.replyToken, [{
    type: 'text', text: doneText,
    quickReply: quickReplyItems([{ label: '再記一筆', text: k.keyword }, { label: '📋 紀錄選單', text: '紀錄' }]),
  }], doneText);
  return true;
}

// ----- 分帳管理／待去清單：LINE裡能做的事＋「開啟App」按鈕（App支援 ?open=split／wishlist 直接開啟）-----
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
        { type: 'message', label: '↩️ 返回選單', text: '紀錄' },
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
  if (!items.length) return '🗺️ 待去清單\n目前還沒有任何地點，按下面的按鈕到App新增第一個吧！';
  const count = {};
  items.forEach((it) => { const s = (it && it.status) || '待去'; count[s] = (count[s] || 0) + 1; });
  const order = ['待去', '已安排', '已完成', '暫不去', '取消'];
  const parts = order.filter((s) => count[s]).map((s) => s + ' ' + count[s]);
  Object.keys(count).filter((s) => order.indexOf(s) < 0).forEach((s) => parts.push(s + ' ' + count[s]));
  const pending = items.filter((it) => it && ((it.status || '待去') === '待去')).slice(0, 5); // App新增的項目放在最前面，所以前5個就是最近新增的
  let text = '🗺️ 待去清單\n共 ' + items.length + ' 個地點：' + parts.join('・');
  if (pending.length) {
    text += '\n\n最近新增的待去地點：\n' + pending.map((it) => '・' + (it.name || '（未命名）') + (it.city ? '（' + it.city + '）' : '')).join('\n');
  }
  return text;
}
async function sendWishlistCard(token, ev, userId, env) {
  const url = (ev.appOrigin || DEFAULT_APP_URL) + '/?open=wishlist&openExternalBrowser=1';
  let code = null;
  try { code = env.SYNC_KV ? await env.SYNC_KV.get('line:usersync:' + userId) : null; } catch (e) {}
  let summary;
  if (!code) {
    summary = '🗺️ 待去清單\n你還沒綁定同步碼，所以這裡看不到清單摘要。傳「同步碼 你的碼」綁定後就會顯示（App「設定→雲端同步」可以看到同步碼）。\n\n完整的待去清單（表格／看板／地圖）在App裡，按下面的按鈕開啟。';
  } else {
    let obj = null;
    try { obj = await fetchSyncedObject(userId, 'wishlist_data_v2', env); } catch (e) {}
    summary = wishlistSummaryText(obj);
  }
  await lineReplyCards(token, ev.replyToken, [
    { type: 'text', text: summary },
    {
      type: 'template', altText: '待去清單',
      template: {
        type: 'buttons',
        text: '要開啟完整的待去清單嗎？',
        actions: [
          { type: 'uri', label: '📱 開啟待去清單', uri: url },
          { type: 'message', label: '↩️ 返回選單', text: '紀錄' },
        ],
      },
    },
  ], summary + '\n\n開啟待去清單：' + url);
}

// ----- 路由：關鍵字 → 功能 -----
async function handleKeywordRouter(ev, token, env) {
  const key = normalizeKeyword(ev.message.text);
  if (!ALL_KEYWORDS.has(key)) return false;
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = !!(ev.source && ev.source.type === 'group');
  if (!userId) return false;
  if (isGroup && !GROUP_KEYWORDS.has(key)) return false;

  // 「記帳」跟簡易版／標準版／旗艦版「選模組」按鈕的文字一樣：正在選模組時，這個字是在回答問題，不是要開新功能
  const session = await getFlagshipSession(userId, env);
  if (key === '記帳' && session && session.flow !== 'quick' && session.flow !== 'stickerkid' && !session.module) return false;

  await clearFlagshipSession(userId, env); // 切換功能 → 結束手上正在進行的流程

  if (RECORD_MENU_KEYWORDS.indexOf(key) >= 0) {
    await sendRecordMenu(token, ev.replyToken);
    return true;
  }
  switch (key) {
    case '飲料紀錄': {
      // 直接進飲料旗艦版問答（跳過選版本、選模組）
      const s = { flow: 'drink', module: 'drink', mode: null, stage: 'core', stepIndex: 0, answers: {}, direct: true };
      await flagshipProceedAfterModule(s, userId, env, token, ev.replyToken);
      return true;
    }
    case '美食紀錄':
      await startQuickRecord('food', userId, env, token, ev.replyToken);
      return true;
    case '交通紀錄':
      await startQuickRecord('travel', userId, env, token, ev.replyToken);
      return true;
    case '記帳':
      await startQuickRecord('other', userId, env, token, ev.replyToken);
      return true;
    case '記一筆分帳':
      await startQuickRecord('split', userId, env, token, ev.replyToken);
      return true;
    case '分帳管理':
      await sendSplitCard(token, ev);
      return true;
    case '待去清單':
      if (isGroup) {
        await lineReply(token, ev.replyToken, '🗺️ 待去清單會讀取你的個人資料，請在與我的1對1聊天室輸入「待去清單」使用喔。');
        return true;
      }
      await sendWishlistCard(token, ev, userId, env);
      return true;
    case '集點卡':
      if (isGroup) {
        await lineReply(token, ev.replyToken, '🎁 集點卡會讀取你的個人資料，請在與我的1對1聊天室輸入「集點卡」使用喔。');
        return true;
      }
      return false; // 交給 handleStickerCardMessage（流程剛清掉，會從頭開始）
    default:
      return false;
  }
}

async function handleFlagshipMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = !!(ev.source && ev.source.type === 'group');
  const groupId = isGroup ? ((ev.source && ev.source.groupId) || '') : '';
  if (!userId) return false; // session用userId分辨，群組裡不同人各自有各自的流程，不會互相干擾

  let session = await getFlagshipSession(userId, env);
  if (session && (session.flow === 'stickerkid' || session.flow === 'quick')) return false; // 集點卡／「紀錄」快速記錄流程的session，交給各自的handler處理

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
        await sendRecordMenu(token, ev.replyToken);
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
    let synced = false;
    try {
      synced = await saveLineLogRecord(record, env);
    } catch (e) {
      await clearFlagshipSession(userId, env);
      await lineReplyQuick(token, ev.replyToken, '存檔時發生問題，請稍後再試一次 🙏', null);
      return true;
    }
    await clearFlagshipSession(userId, env);
    const tailMsg = synced ? '\n✅ 已自動同步到App。' : '\n之後可以到App的「📱LINE記帳」裡匯入。';
    await lineReplyQuick(token, ev.replyToken, '✅ 標準版（雙表單）記錄完成！\n' + record.item + '　$' + record.amount + tailMsg, null);
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
    let synced = false;
    try {
      synced = await saveLineLogRecord(record, env);
    } catch (e) {
      await clearFlagshipSession(userId, env);
      await lineReplyQuick(token, ev.replyToken, '存檔時發生問題，請稍後再試一次 🙏', null);
      return true;
    }
    await clearFlagshipSession(userId, env);
    const tailMsg = synced ? '\n✅ 已自動同步到App。' : '\n之後可以到App的「📱LINE記帳」裡匯入。';
    const doneText = session.flow === 'drink'
      ? '✅ 飲料旗艦版記錄完成！\n' + (record.brand ? record.brand + '・' : '') + record.drink + '　$' + record.amount + tailMsg
      : '✅ 簡易版（雙表單）記錄完成！\n' + record.item + '　$' + record.amount + tailMsg;
    await lineReplyQuick(token, ev.replyToken, doneText, null);
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
  const isGroup = !!(ev.source && ev.source.type === 'group');
  const groupId = isGroup ? ((ev.source && ev.source.groupId) || '') : '';

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
        '看不懂這則訊息耶 😅\n\n・要記帳：請用「品項 金額」，例如：\n　珍奶 60／午餐 120／計程車 250\n・要用其他功能：輸入「紀錄」看選單，或直接輸入功能名稱：\n　飲料紀錄／美食紀錄／交通紀錄／記帳／分帳管理／集點卡／待去清單',
        ['紀錄']);
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

  let synced = false;
  try {
    synced = await saveLineLogRecord(record, env);
  } catch (e) {
    await lineReply(token, ev.replyToken, '記錄時發生問題，請稍後再試 🙏');
    return;
  }

  const catLabel = { drink: '🧋 飲料', food: '🍱 美食', travel: '🚆 交通', other: '📝 其他' }[record.category] || '📝 其他';
  const who = userName ? '（' + userName + '）' : '';
  const syncTag = synced ? '（已自動同步✅）' : '';
  await lineReply(token, ev.replyToken, '✅ 已記錄' + who + syncTag + '\n' + catLabel + '：' + record.item + '　$' + record.amount);
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
        const handled = (await handleKeywordRouter(ev, token, env)) || (await handleQuickMessage(ev, token, env)) || (await handleFlagshipMessage(ev, token, env)) || (await handleStickerCardMessage(ev, token, env));
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
    if (url.pathname === '/api/line-log') return handleLineLog(request, env);
    if (url.pathname === '/api/line-log-remove') return handleLineLogRemove(request, env);
    // 其餘交給靜態資源（你的 index.html 等）
    return env.ASSETS.fetch(request);
  },
};

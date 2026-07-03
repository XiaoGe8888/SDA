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
async function parseExpense(text, env) {
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
    '分類只能是這四種之一：drink（手搖飲料、咖啡、飲品）、food（餐點、食物、小吃）、travel（交通、車票、油錢、停車、計程車）、other（其他）。\n' +
    '如果句子裡沒有可辨識的金額，amount回傳null。\n' +
    '詳細欄位規則（非常重要，沒提到就填null，絕對不要自己猜測腦補）：\n' +
    '- brand/size/topping/sugar/ice：只有分類是drink才需要判斷\n' +
    '- cuisine/portion/diningType：只有分類是food才需要判斷\n' +
    '- transportType/depPort/arrPort：只有分類是travel才需要判斷\n' +
    '- payment：任何分類都可以判斷，只要訊息裡有明確講到付款方式\n' +
    '- 不屬於該分類的欄位一律填null\n' +
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

function flagshipBuildRecord(session, userId, userName) {
  const a = session.answers || {};
  const now = new Date();
  return {
    id: 'L' + now.getTime(),
    item: a.drink || '', amount: Math.round(Number(a.amount) || 0), category: 'drink',
    userId, userName, groupId: '', groupName: '', ts: now.getTime(),
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
function buildRecordFromParsed(parsed, fallbackText, userId, userName, groupId, groupName, tierOverride) {
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
function buildSimpleRecord(session, userId, userName) {
  const a = session.answers || {};
  const now = new Date();
  const catMap = { drink: 'drink', food: 'food', travel: 'travel', split: 'other' };
  const record = {
    id: 'L' + now.getTime(),
    item: a.item || '', amount: Math.round(Number(a.amount) || 0), category: catMap[session.module] || 'other',
    userId, userName, groupId: '', groupName: '', ts: now.getTime(),
  };
  if (session.travelType) record.transportType = session.travelType;
  return record;
}
async function saveLineLogRecord(record, env) {
  const kv = env.SYNC_KV;
  if (!kv) throw new Error('no kv');
  const raw = await kv.get('line:log');
  const list = raw ? JSON.parse(raw) : [];
  list.push(record);
  await kv.put('line:log', JSON.stringify(list));
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
    await lineReplyQuick(token, replyToken, '（接續剛剛的紀錄）要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS);
    return;
  }
  if (!session.mode) {
    const flow = FLAGSHIP_SCHEMAS[session.flow];
    await lineReplyQuick(
      token, replyToken,
      '（接續剛剛的紀錄）\n' + flow.label + '：要用哪種模式？\n單表單：一次問完（或一句話講完）\n雙表單：分兩段問，中間會停一下\n\n要用哪一種？',
      ['單表單模式', '雙表單模式']
    );
    return;
  }
  const flow = FLAGSHIP_SCHEMAS[session.flow];
  if (flow.kind === 'freeform') {
    const prompt = session.stage === 'core' ? flow.core[0].prompt : flow.extended[0].prompt;
    await lineReplyQuick(token, replyToken, '（接續剛剛的紀錄）\n' + prompt, null);
    return;
  }
  const field = flagshipCurrentField(session);
  if (field) await lineReplyQuick(token, replyToken, '（接續剛剛的紀錄）\n' + field.q, field.quick);
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
  await lineReplyQuick(
    token, replyToken,
    flow.label + '：要用哪種模式？\n單表單：一次問完（或一句話講完）\n雙表單：分兩段問，中間會停一下\n\n要用哪一種？',
    ['單表單模式', '雙表單模式']
  );
}

// 處理旗艦版／簡易版／標準版的多輪問答訊息（三種tier共用同一套引擎，用session.flow分辨）。
// 回傳 true 代表這則訊息已經處理完畢；回傳 false 代表跟這套機制無關，交給 handleExpenseMessage 處理。
async function handleFlagshipMessage(ev, token, env) {
  const text = (ev.message.text || '').trim();
  const userId = (ev.source && ev.source.userId) || '';
  const isGroup = !!(ev.source && ev.source.type === 'group');
  if (isGroup || !userId) return false; // 這套多輪問答目前只做1對1

  let session = await getFlagshipSession(userId, env);

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
  if (/^(取消|cancel)$/i.test(text)) {
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
      await lineReplyQuick(token, ev.replyToken, '要記錄哪一種交通呢？', TRAVEL_TYPE_OPTIONS);
      return true;
    }
    await flagshipProceedAfterModule(session, userId, env, token, ev.replyToken);
    return true;
  }

  // ---- 選交通子類型（只有選了🚆交通才會進到這裡）----
  if (session.module === 'travel' && !session.travelType) {
    const tt = TRAVEL_TYPE_TRIGGERS[text];
    if (!tt) {
      await lineReplyQuick(token, ev.replyToken, '請從下面選一種交通方式：', TRAVEL_TYPE_OPTIONS);
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
    if (/^單/.test(text)) session.mode = 'single';
    else if (/^雙/.test(text)) session.mode = 'dual';
    else {
      await lineReplyQuick(token, ev.replyToken, '請選擇：單表單模式 或 雙表單模式', ['單表單模式', '雙表單模式']);
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
      await lineReplyQuick(token, ev.replyToken, flow.core[0].prompt, null);
    } else {
      const field = flagshipCurrentField(session);
      await lineReplyQuick(token, ev.replyToken, field.q, field.quick);
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
      await lineReplyQuick(token, ev.replyToken, flow.extended[0].prompt, null);
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
      await lineReplyQuick(token, ev.replyToken, '還是沒抓到金額耶，直接跟我說金額多少就好', null);
      return true;
    }
    let userName = '';
    try { userName = (await lineProfile(token, userId)) || ''; } catch (e) {}
    const record = buildRecordFromParsed(session.answers, text, userId, userName, '', '', 'standard');
    try {
      await saveLineLogRecord(record, env);
    } catch (e) {
      await clearFlagshipSession(userId, env);
      await lineReplyQuick(token, ev.replyToken, '存檔時發生問題，請稍後再試一次 🙏', null);
      return true;
    }
    await clearFlagshipSession(userId, env);
    await lineReplyQuick(token, ev.replyToken, '✅ 標準版（雙表單）記錄完成！\n' + record.item + '　$' + record.amount + '\n之後可以到App的「📱LINE記帳」裡匯入。', null);
    return true;
  }

  // ---- rigid（簡易版-雙表單 / 旗艦版-飲料）：一題一題問固定欄位 ----
  const field = flagshipCurrentField(session);
  if (field) {
    if (field.numeric) {
      const n = Number(String(text).replace(/[^0-9.]/g, ''));
      if (isNaN(n)) {
        await lineReplyQuick(token, ev.replyToken, '這題要填數字喔，' + field.q, null);
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
        await lineReplyQuick(token, ev.replyToken, summary, nextField.quick);
      } else {
        await setFlagshipSession(userId, session, env);
        await lineReplyQuick(token, ev.replyToken, nextField.q, nextField.quick);
      }
      return true;
    }
    // 全部問完 → 存檔
    let userName = '';
    try { userName = (await lineProfile(token, userId)) || ''; } catch (e) {}
    const record = session.flow === 'drink'
      ? flagshipBuildRecord(session, userId, userName)
      : buildSimpleRecord(session, userId, userName);
    try {
      await saveLineLogRecord(record, env);
    } catch (e) {
      await clearFlagshipSession(userId, env);
      await lineReplyQuick(token, ev.replyToken, '存檔時發生問題，請稍後再試一次 🙏', null);
      return true;
    }
    await clearFlagshipSession(userId, env);
    const doneText = session.flow === 'drink'
      ? '✅ 飲料旗艦版記錄完成！\n' + (record.brand ? record.brand + '・' : '') + record.drink + '　$' + record.amount + '\n之後可以到App的「📱LINE記帳」裡匯入。'
      : '✅ 簡易版（雙表單）記錄完成！\n' + record.item + '　$' + record.amount;
    await lineReplyQuick(token, ev.replyToken, doneText, null);
    return true;
  }

  await setFlagshipSession(userId, session, env);
  const nextField = flagshipCurrentField(session);
  await lineReplyQuick(token, ev.replyToken, nextField.q, nextField.quick);
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

  const parsed = await parseExpense(text, env);
  if (!parsed || parsed.amount == null || isNaN(Number(parsed.amount))) {
    // 群組裡看不懂就安靜略過（大家可能在聊別的事，不要洗版）；1對1才提示格式
    if (!isGroup) {
      await lineReply(token, ev.replyToken, '看不懂這筆耶 😅\n請用「品項 金額」的方式記，例如：\n・珍奶 60\n・午餐 120\n・計程車 250');
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

  const record = buildRecordFromParsed(parsed, text, userId, userName, groupId, groupName);

  try {
    await saveLineLogRecord(record, env);
  } catch (e) {
    await lineReply(token, ev.replyToken, '記錄時發生問題，請稍後再試 🙏');
    return;
  }

  const catLabel = { drink: '🧋 飲料', food: '🍱 美食', travel: '🚆 交通', other: '📝 其他' }[record.category] || '📝 其他';
  const who = userName ? '（' + userName + '）' : '';
  await lineReply(token, ev.replyToken, '✅ 已記錄' + who + '\n' + catLabel + '：' + record.item + '　$' + record.amount);
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
        const handled = await handleFlagshipMessage(ev, token, env);
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

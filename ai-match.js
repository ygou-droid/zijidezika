// =======================================================
// Mochi Chat · AI 向量召回（可选增强）
// 规则：关键词匹配优先且永远可用；只有在后端可用、开关打开、相似度达标时，
//      才使用阿里云百炼 text-embedding-v4 的向量召回结果。
//      后端没启动、调用失败、低于阈值时，全部自动回落到原有关键词匹配。
// =======================================================

(function () {
  'use strict';

  const DEFAULT_THRESHOLD = 0.6;      // 低于这个相似度就当作没召回
  const MAX_TEXTS_PER_REQUEST = 10;   // 与后端限制保持一致
  const MAX_CARDS = 30;               // 单次最多参与召回的字卡数量
  const PROBE_TIMEOUT_MS = 2000;
  const EMBED_TIMEOUT_MS = 15000;

  const matcher = window.MochiChatMatcher;
  if (!matcher) return; // 没有关键词匹配引擎就不启用本模块

  const keywordMatch = matcher.match.bind(matcher);
  const originalRenderDebug = matcher.renderDebug;

  // ===== 向量身份：providerId + model + dimensions + credentialsToken =====
  // 三者中任意一个不同，向量就处在不同的空间里，绝不能混用（双模型改造 · 阶段 3.2）
  // 阶段 5.12：credentialsToken 是服务端对「自定义 Key / 本地模型」的散列，
  // 不同 Key 产生的向量绝不共用缓存；没有自定义凭据时为 ''，键与改造前完全一致
  function identityOf(providerId, model, dimensions, credentials) {
    const credentialsToken = credentials == null ? '' : String(credentials);
    return {
      providerId: String(providerId == null ? '' : providerId),
      model: String(model == null ? '' : model),
      dimensions: Number(dimensions) || 0,
      credentials: credentialsToken
    };
  }
  function identityKey(identity) {
    const base = identity.providerId + '|' + identity.model + '|' + identity.dimensions;
    const credentials = identity.credentials == null ? '' : String(identity.credentials);
    // 没有自定义凭据时保持原键，避免清掉既有缓存
    return credentials === '' ? base : base + '|' + credentials;
  }
  function sameIdentity(a, b) {
    return Boolean(a) && Boolean(b) && identityKey(a) === identityKey(b);
  }
  // 用响应里出现过的字段更新身份；没提供的字段沿用当前值，避免旧服务端把身份冲掉
  function mergeIdentity(current, seen) {
    return identityOf(
      seen.providerId == null ? current.providerId : seen.providerId,
      seen.model == null ? current.model : seen.model,
      seen.dimensions == null ? current.dimensions : seen.dimensions,
      // 阶段 5.12：凭据令牌只在响应携带时更新，平时沿用当前值
      seen.credentialsToken == null ? current.credentials : seen.credentialsToken
    );
  }

  const state = {
    available: false,     // 后端 /api/embed 是否可用
    probeDone: false,
    enabled: true,        // 用户开关
    threshold: DEFAULT_THRESHOLD,
    model: 'text-embedding-v4',
    last: null,           // 最近一次 AI 召回结果（仅用于调试显示）
    requests: 0,          // 已发出的向量请求次数（便于了解用量）
    vectorCache: new Map(),
    // 当前生效的向量身份（来自 /api/health，并在每次 /api/embed 响应后自校验）
    activeIdentity: identityOf('cloud-bailian', 'text-embedding-v4', 1024, ''),
    // 身份每变化一次就自增：在途请求凭它判断自己是否已经过期
    identityVersion: 0,
    identityChanges: 0,   // 身份变化次数（调试用，便于确认没有频繁作废）
    lastError: null       // 最近一次向量失败的人话提示（阶段 3.7）
  };

  // 记录每一条「联系人 + 文本」的向量召回进度，按 key 隔离：
  // key = 联系人 id + '|' + 文本
  // 这样可以做到：同一份文本只请求一次、切换联系人或改了文本不会串用旧结果、
  // 请求还没回来时也不会把上一次的结果当成这一次的。
  const recallResults = new Map();
  const MAX_RESULT_ENTRIES = 50;

  function resultKey(contactId, text) {
    return contactId + '|' + text;
  }

  // 身份发生变化：旧向量与旧召回结果一律作废，同时让所有在途请求过期
  function invalidateForIdentityChange(next) {
    state.activeIdentity = next;
    state.identityVersion++;
    state.identityChanges++;
    state.vectorCache.clear();
    recallResults.clear();
    state.last = null;
  }

  // 每次拿到响应都自校验一次身份：不一致就作废，绝不让两套空间的向量共存
  function syncIdentity(seen) {
    const next = mergeIdentity(state.activeIdentity, seen);
    if (!sameIdentity(next, state.activeIdentity)) invalidateForIdentityChange(next);
    state.model = next.model || state.model;
  }

  function putResult(key, record) {
    // 简单限容：超过上限先清掉最早的记录
    if (recallResults.size >= MAX_RESULT_ENTRIES) {
      recallResults.delete(recallResults.keys().next().value);
    }
    recallResults.set(key, record);
    state.last = record;
  }

  // ===== 1. 小工具 =====
  function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    const value = dot / (Math.sqrt(na) * Math.sqrt(nb));
    if (value > 1 - 1e-12) return 1;
    if (value < -1 + 1e-12) return -1;
    return value;
  }

  // 把一张字卡拼成用于计算向量的文本
  function cardVectorText(card) {
    return [
      card.content,
      (card.keywords || []).join('、'),
      card.scene,
      card.category
    ].filter(function (part) {
      return part && String(part).trim() !== '';
    }).join(' | ');
  }

  // 缓存键 = 身份（providerId|model|dimensions） + 文本
  // 同一句话在不同供应商 / 模型 / 维度下各自成键，不会互相命中
  function cacheKey(text) {
    return identityKey(state.activeIdentity) + '|' + text;
  }

  // ===== 2. 调用后端 /api/embed（带内存缓存，失败不重试）=====
  // 后端错误码 → 用户看得懂的中文（阶段 3.7）
  // 关键词匹配永远可用，所以这些提示都只需要说明「已自动回退」
  const FRIENDLY_ERRORS = {
    local_unavailable: '本地 Ollama 服务已断开，已自动回退到关键词匹配',
    local_model_missing: '本地 Ollama 模型未下载，已自动回退到关键词匹配',
    provider_not_ready: '向量服务尚未就绪，已自动回退到关键词匹配',
    missing_api_key: '云端密钥未配置，已自动回退到关键词匹配',
    request_timeout: '向量请求超时，已自动回退到关键词匹配',
    network_error: '连不上本地服务，已自动回退到关键词匹配',
    dimension_mismatch: '向量维度不一致，已自动回退到关键词匹配'
  };

  function friendlyMessage(error) {
    const code = error && error.code ? String(error.code) : '';
    if (code && FRIENDLY_ERRORS[code]) return FRIENDLY_ERRORS[code];
    const raw = String((error && error.message) || '');
    if (/timeout|超时/i.test(raw)) return FRIENDLY_ERRORS.request_timeout;
    return '本次向量请求失败，已自动回退到关键词匹配';
  }

  // 同一类故障只提示一次，避免刷屏；聊天本身不受影响（关键词兜底照常）
  let lastNotified = '';
  function noteFailure(text) {
    state.lastError = text;
    if (text === lastNotified) return;
    lastNotified = text;
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(noteFailure.timer);
    noteFailure.timer = setTimeout(function () { toast.hidden = true; }, 2600);
  }

  async function embedChunk(texts) {
    // 记下出发时的身份版本：期间若发生变化，说明这个响应已经过期
    const versionAtStart = state.identityVersion;

    let response;
    try {
      // 阶段 5.12：带上自定义凭据（Key 走 Header，本地地址 / 模型走 Body）。
      // 没有配置时 requestExtras 返回空对象，行为与从前完全一致；明文 Key 只在这条请求里存在
      const extras = (window.MochiChatCustomKeys && typeof window.MochiChatCustomKeys.requestExtras === 'function')
        ? window.MochiChatCustomKeys.requestExtras()
        : { headers: {}, body: {} };
      response = await fetch('/api/embed', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, extras.headers || {}),
        body: JSON.stringify(Object.assign({ texts: texts }, extras.body || {})),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
      });
    } catch (error) {
      // 超时或断网：统一带上 code，便于后面翻译成人话
      const timedOut = Boolean(error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
      const wrapped = new Error(timedOut ? '向量请求超时' : String((error && error.message) || '网络请求失败'));
      wrapped.code = timedOut ? 'request_timeout' : 'network_error';
      throw wrapped;
    }

    const data = await response.json().catch(function () { return null; });
    if (!response.ok || !data || data.status !== 'ok') {
      const failure = new Error((data && data.message) || ('HTTP ' + response.status));
      failure.code = data && data.code ? data.code : ('http_' + response.status);
      throw failure;
    }
    state.requests++;
    // 过期的响应直接丢掉：绝不让旧身份的数据写进新身份
    if (state.identityVersion !== versionAtStart) {
      throw new Error('向量服务身份已变化，本次结果作废');
    }
    // 自校验：响应里的 providerId / model / dimensions / credentialsToken 与当前身份不一致就作废旧数据
    syncIdentity({
      providerId: data.providerId,
      model: data.model,
      dimensions: data.dimensions,
      credentialsToken: data.credentialsToken
    });
    return data.embeddings;
  }

  async function embedMany(texts) {
    const result = new Array(texts.length);
    const pendingTexts = [];
    const pendingIndex = [];

    texts.forEach(function (text, position) {
      const cached = state.vectorCache.get(cacheKey(text));
      if (cached) result[position] = cached;
      else { pendingTexts.push(text); pendingIndex.push(position); }
    });

    // 本次批量请求的身份版本：期间身份一变，整批结果都不能用（否则会新旧向量混算）
    const versionAtStart = state.identityVersion;

    for (let start = 0; start < pendingTexts.length; start += MAX_TEXTS_PER_REQUEST) {
      const chunk = pendingTexts.slice(start, start + MAX_TEXTS_PER_REQUEST);
      const chunkIndex = pendingIndex.slice(start, start + MAX_TEXTS_PER_REQUEST);
      const vectors = await embedChunk(chunk);
      if (state.identityVersion !== versionAtStart) {
        throw new Error('向量服务身份在本次请求期间发生变化，结果已作废');
      }
      if (!Array.isArray(vectors) || vectors.length !== chunk.length) {
        throw new Error('返回的向量数量与请求不一致');
      }
      chunk.forEach(function (text, i) {
        state.vectorCache.set(cacheKey(text), vectors[i]);
        result[chunkIndex[i]] = vectors[i];
      });
    }

    return result;
  }

  // ===== 3. 为「某个联系人的某句话」准备 AI 召回结果 =====
  // 同一个 key（联系人 + 文本）只会真正请求一次：
  //   pending → 请求进行中  ready → 已完成  error → 失败（不再自动重试，避免重复计费）
  async function prepareAI(contactId, text) {
    const key = resultKey(contactId, text);
    const existing = recallResults.get(key);

    // 已经做过（或在做）就不再重复请求，这是「一次发送只请求一次」的关键
    if (existing && existing.status !== 'error') return existing;

    if (!state.available || !state.enabled) {
      // 未连接或开关关闭：只写调试信息，不发请求，也不留下任何记录
      // （不写记录，是为了等后端恢复或用户重新开启后还能正常走一次）
      state.last = { contactId: contactId, text: text, status: 'disabled' };
      return null;
    }

    // 阶段 5.8：向量召回也只用聊天字卡，情话 / 朋友圈文案不进语料
    const lib = window.MochiChatCards;
    const getCards = (lib && typeof lib.getChatCardsOf === 'function')
      ? lib.getChatCardsOf
      : lib.getCardsOf;
    const cards = (getCards.call(lib, contactId) || [])
      .filter(function (card) { return card && card.content; })
      .slice(0, MAX_CARDS);

    if (cards.length === 0) {
      putResult(key, { contactId: contactId, text: text, status: 'ready', best: null });
      return recallResults.get(key);
    }

    // 先标记为进行中：请求没回来之前，绝不拿上一次的结果顶替这一句
    const pending = { contactId: contactId, text: text, status: 'pending', best: null };
    putResult(key, pending);

    // 出发时的身份版本：回来时若已变，说明这批结果是旧身份的，一律作废
    const versionAtStart = state.identityVersion;

    try {
      const vectors = await embedMany([text].concat(cards.map(cardVectorText)));
      // 请求期间身份变过：本次结果不再采信，也不允许覆盖新身份的状态
      if (state.identityVersion !== versionAtStart) return null;
      const userVector = vectors[0];
      let best = null;
      cards.forEach(function (card, index) {
        const similarity = cosineSimilarity(userVector, vectors[index + 1]);
        if (!best || similarity > best.similarity) {
          best = { card: card, similarity: similarity };
        }
      });
      putResult(key, { contactId: contactId, text: text, status: 'ready', best: best });
    } catch (error) {
      // 身份已变的情况下不留下任何记录：下一次发送会按新身份重新计算
      if (state.identityVersion !== versionAtStart) return null;
      // 错误文案统一翻译成人话，绝不把生涩的错误码直接丢给用户
      const friendly = friendlyMessage(error);
      putResult(key, {
        contactId: contactId, text: text, status: 'error', best: null,
        code: (error && error.code) || null, message: friendly
      });
      noteFailure(friendly);
    }

    return recallResults.get(key);
  }

  // ===== 3.8 阶段 5.6：角色状态对字卡权重的加成 =====
  // 只做乘性系数，不改动关键词打分与余弦相似度本身
  const STATUS_TAG_BOOST = 1.4;     // 字卡标了当前状态：加权
  const STATUS_TAG_PENALTY = 0.85;  // 字卡没标：轻微降权
  const SLEEPING_PENALTY = 0.15;    // 睡觉时没标睡觉的字卡：大幅降权

  function currentStatusOf(contactId) {
    const api = window.MochiChat;
    if (!api || typeof api.getStatusOf !== 'function') return null;
    try {
      return api.getStatusOf(contactId);
    } catch (error) {
      return null;
    }
  }

  function statusTagsOf(card) {
    if (!card || !Array.isArray(card.statusTag)) return [];
    return card.statusTag.map(function (tag) {
      return String(tag);
    }).filter(function (tag) {
      return tag !== '';
    });
  }

  // 阶段 5.6.2：当前状态的回复行为（matchWeight / 惩罚都从这里读）
  function statusBehaviorOf(contactId) {
    const api = window.MochiChat;
    if (!api || typeof api.getStatusBehavior !== 'function') return null;
    try {
      return api.getStatusBehavior(contactId);
    } catch (error) {
      return null;
    }
  }

  // statusTag 里可以写具体状态 id，也可以写 any / all 表示不限状态
  function statusBoostOf(contactId, card) {
    const status = currentStatusOf(contactId);
    if (!status) return { factor: 1, matched: false, status: null };

    // 加权与未命中惩罚优先取状态配置；老数据 / 接口缺失时退回常量默认
    const behavior = statusBehaviorOf(contactId) || {};
    const boost = isFinite(behavior.matchWeight) ? behavior.matchWeight : STATUS_TAG_BOOST;
    const missPenalty = isFinite(behavior.missPenalty) ? behavior.missPenalty : STATUS_TAG_PENALTY;
    const sleepPenalty = isFinite(behavior.sleepingPenalty) ? behavior.sleepingPenalty : SLEEPING_PENALTY;

    const tags = statusTagsOf(card);
    const matched = tags.indexOf(status.id) !== -1 ||
      tags.indexOf('any') !== -1 ||
      tags.indexOf('all') !== -1;

    if (matched) return { factor: boost, matched: true, status: status };
    if (status.id === 'sleeping') return { factor: sleepPenalty, matched: false, status: status };
    return { factor: missPenalty, matched: false, status: status };
  }

  // 关键词候选按「原分数 × 状态系数」重排，只影响最终选哪张卡
  function applyStatusToKeywordResult(contactId, result) {
    if (!result || !result.matched || !Array.isArray(result.candidates) || result.candidates.length === 0) {
      return result;
    }

    const ranked = result.candidates.map(function (item) {
      const boost = statusBoostOf(contactId, item.card);
      return { item: item, adjusted: item.score * boost.factor, boost: boost };
    });

    let bestScore = 0;
    ranked.forEach(function (entry) {
      if (entry.adjusted > bestScore) bestScore = entry.adjusted;
    });

    const top = ranked.filter(function (entry) { return entry.adjusted === bestScore; });
    const picked = top[Math.floor(Math.random() * top.length)];
    const status = picked.boost.status;

    return Object.assign({}, result, {
      card: picked.item.card,
      score: Math.round(bestScore * 100) / 100,
      matchedKeywords: picked.item.matchedKeywords,
      reply: picked.item.card.content,
      status: status ? {
        id: status.id,
        label: status.label,
        factor: picked.boost.factor,
        matched: picked.boost.matched
      } : null,
      candidates: ranked.map(function (entry) {
        return {
          card: entry.item.card,
          score: Math.round(entry.adjusted * 100) / 100,
          matchedKeywords: entry.item.matchedKeywords
        };
      })
    });
  }

  // ===== 4. 包装 match：优先关键词，其次向量召回 =====
  function aiMatch(contactId, text) {
    // 阶段 5.6：关键词结果先按状态系数重排（关键词算法本身不变）
    const keywordResult = applyStatusToKeywordResult(contactId, keywordMatch(contactId, text));

    const aiInfo = {
      used: false,
      available: state.available,
      enabled: state.enabled,
      similarity: null,
      requests: state.requests
    };

    // 严格按「联系人 + 文本」取结果：切换联系人、改了句子、或请求还没回来，
    // 都不会用到别的 key 的结果
    const record = recallResults.get(resultKey(contactId, text));
    const usable = Boolean(record && record.status === 'ready');

    if (!state.available || !state.enabled) {
      aiInfo.reason = state.available ? '已手动关闭 AI 向量匹配' : '后端不可用（没有启动服务器）';
    } else if (!record) {
      aiInfo.reason = '尚未发起向量请求';
    } else if (record.status === 'pending') {
      // 请求还在路上（比如第一次调用比较慢），这一次先用关键词结果兜底
      aiInfo.reason = '向量请求进行中，本次先用关键词结果';
    } else if (record.status === 'error') {
      aiInfo.reason = '本次未取得向量结果：' + (record.message || '未知原因');
      aiInfo.errorCode = record.code || null;
    } else if (!usable) {
      aiInfo.reason = '本次未取得向量结果（' + record.status + '）';
    } else if (keywordResult.matched) {
      // 关键词命中时保持原有行为，只是把相似度显示出来
      aiInfo.reason = '关键词已命中，沿用关键词结果';
      aiInfo.similarity = record.best ? record.best.similarity : null;
    } else if (record.best) {
      // 阶段 5.6：向量召回也叠加状态系数，再与阈值比较
      const boost = statusBoostOf(contactId, record.best.card);
      const adjusted = record.best.similarity * boost.factor;
      aiInfo.similarity = record.best.similarity;

      if (adjusted >= state.threshold) {
        const card = record.best.card;
        const status = boost.status;
        aiInfo.used = true;
        aiInfo.reason = '关键词未命中，改用向量召回（状态权重 ×' + boost.factor + '）';

        return Object.assign({}, keywordResult, {
          matched: true,
          card: card,
          score: Math.round(adjusted * 100),
          matchedKeywords: [],
          reason: '关键词未命中，由 AI 向量召回命中（相似度 ' + record.best.similarity.toFixed(4) +
            '，状态权重 ×' + boost.factor + '）',
          reply: card.content,
          status: status ? {
            id: status.id,
            label: status.label,
            factor: boost.factor,
            matched: boost.matched
          } : null,
          ai: aiInfo
        });
      }

      aiInfo.reason = '向量相似度 × 状态权重 = ' + adjusted.toFixed(4) + '，低于阈值 ' + state.threshold;
    } else {
      aiInfo.reason = '向量相似度未达到阈值 ' + state.threshold;
    }

    return Object.assign({}, keywordResult, { ai: aiInfo });
  }

  // ===== 5. 包装调试面板：补充 AI 相关信息 =====
  function aiRenderDebug(result) {
    if (typeof originalRenderDebug === 'function') originalRenderDebug(result);

    const body = document.getElementById('debugBody');
    if (!body || !result || !result.ai) return;

    function row(label, value, valueClass) {
      const line = document.createElement('div');
      line.className = 'debug-row';
      const l = document.createElement('span');
      l.className = 'debug-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'debug-value' + (valueClass ? ' ' + valueClass : '');
      v.textContent = value;
      line.appendChild(l);
      line.appendChild(v);
      body.appendChild(line);
    }

    const ai = result.ai;
    row('AI 后端', ai.available ? '已连接' : '未连接（仅关键词匹配）', ai.available ? 'debug-value--hit' : 'debug-value--miss');
    if (ai.similarity !== null && ai.similarity !== undefined) {
      row('最高相似度', ai.similarity.toFixed(4) + '（阈值 ' + state.threshold + '）');
    }
    if (result.status) {
      row('角色状态', result.status.label + '（权重 ×' + result.status.factor +
        (result.status.matched ? '，命中状态标签' : '，未命中状态标签') + '）');
    }
    row('本次选择', ai.used ? 'AI 向量召回' : '关键词匹配', ai.used ? 'debug-value--hit' : '');
    row('AI 说明', ai.reason);
    row('已发请求', String(ai.requests) + ' 次');
  }

  matcher.match = aiMatch;
  matcher.renderDebug = aiRenderDebug;

  // ===== 6. 触发时机（不需要改 script.js）=====
  // script.js 里有两条发送路径：
  //   a) 按回车 → input 的 keydown Enter → 直接 sendMessage()，不会产生 submit 事件
  //   b) 点「发送」按钮 → form 的 submit 事件
  // 所以两条路径都要挂上，另外再加「输入停止后预取」来避开自动回复的 600ms 等待
  const input = document.getElementById('input');
  const composer = document.getElementById('composer');

  const PREPARE_DEBOUNCE_MS = 400; // 停止输入多久后开始预取
  let debounceTimer = null;
  let lastTyped = '';

  function currentText() {
    // 优先取输入框里的实时内容；若已被清空（script.js 会清空）则用最后一次记录
    const live = input ? String(input.value || '').trim() : '';
    return live !== '' ? live : String(lastTyped || '').trim();
  }

  function startPrepare() {
    const text = currentText();
    if (text === '') return;
    const contact = window.MochiChat.getCurrentContact();
    if (!contact) return;
    prepareAI(contact.id, text); // 内部按 key 去重，同一句话不会重复请求
  }

  function cancelDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  if (input) {
    // P1：输入停止约 400ms 后预取，把网络等待挪到「打字的间隙」
    input.addEventListener('input', function () {
      lastTyped = input.value;
      cancelDebounce();
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        startPrepare();
      }, PREPARE_DEBOUNCE_MS);
    });

    // P0：按回车发送（script.js 会 preventDefault，不会产生 submit，必须单独挂）
    // 注意：script.js 的 keydown 监听比我们先注册，它会先把输入框清空，
    // 所以这里绝对不能用 input.value 覆盖 lastTyped，否则拿到的是空串
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      cancelDebounce();
      startPrepare();
    });
  }

  if (composer) {
    // P0：点击「发送」按钮走的是 form submit
    composer.addEventListener('submit', function () {
      cancelDebounce();
      startPrepare();
    });
  }

  // ===== 7. 开关 UI（动态生成，不改 index.html 与 style.css）=====
  function buildToggle() {
    const head = document.querySelector('#debugPanel .debug-head');
    if (!head) return;

    const label = document.createElement('label');
    label.setAttribute(
      'style',
      'margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#A29BA9;cursor:pointer;'
    );

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.enabled && state.available;
    box.disabled = !state.available;

    const tip = document.createElement('span');
    tip.textContent = state.available ? 'AI 向量匹配' : 'AI 未连接';

    box.addEventListener('change', function () {
      state.enabled = box.checked;
    });

    label.appendChild(box);
    label.appendChild(tip);
    head.insertBefore(label, head.querySelector('.debug-toggle'));
  }

  // ===== 8. 启动时探测后端是否可用 =====
  async function probe() {
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const data = await response.json();
      if (response.ok && data && data.features && data.features.embeddingApi === true) {
        state.available = true;
        // 初始身份来自健康检查：providerId / model / dimensions
        syncIdentity({
          providerId: data.provider && data.provider.id,
          model: data.embedding && data.embedding.model,
          dimensions: data.embedding && data.embedding.dimensions
        });
      } else {
        state.available = false;
      }
    } catch (error) {
      state.available = false; // 例如直接双击打开 index.html（file://）时无法连接
    }
    state.probeDone = true;
    state.enabled = state.available;
    buildToggle();
    return state.available;
  }

  // 只刷新身份，不动用户的开关状态（阶段 3.5：切换供应商后由设置面板调用）
  // 内部仍然走 syncIdentity：身份变了就递增版本并清空旧向量与旧召回结果
  async function refreshIdentity() {
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const data = await response.json();
      if (!response.ok || !data) return null;
      syncIdentity({
        providerId: data.provider && data.provider.id,
        model: data.embedding && data.embedding.model,
        dimensions: data.embedding && data.embedding.dimensions
      });
      state.available = Boolean(data.features && data.features.embeddingApi === true);
      return {
        providerId: state.activeIdentity.providerId,
        model: state.activeIdentity.model,
        dimensions: state.activeIdentity.dimensions
      };
    } catch (error) {
      return null;
    }
  }

  probe();

  // ===== 9. 对外接口：便于调试与后续接入 =====
  window.MochiChatAI = {
    getState: function () {
      return {
        available: state.available,
        enabled: state.enabled,
        threshold: state.threshold,
        model: state.model,
        // 只读身份信息（只有标识，不含任何地址、密钥或本地配置）
        activeIdentity: {
          providerId: state.activeIdentity.providerId,
          model: state.activeIdentity.model,
          dimensions: state.activeIdentity.dimensions,
          credentials: state.activeIdentity.credentials
        },
        identityVersion: state.identityVersion,
        identityChanges: state.identityChanges,
        requests: state.requests,
        lastStatus: state.last ? state.last.status : null,
        lastError: state.lastError,
        cached: state.vectorCache.size,
        tracked: recallResults.size
      };
    },
    setEnabled: function (value) {
      state.enabled = Boolean(value) && state.available;
      return state.enabled;
    },
    setThreshold: function (value) {
      if (typeof value === 'number' && value >= -1 && value <= 1) state.threshold = value;
      return state.threshold;
    },
    clearCache: function () {
      state.vectorCache.clear();
      recallResults.clear();
    },
    probe: probe,
    // 供应商切换后调用：复用同一套身份失效机制，不重写一套
    refreshIdentity: refreshIdentity
  };
})();

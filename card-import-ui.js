// =======================================================
// Mochi Chat · 字卡批量导入（阶段 4.1 解析 + 阶段 4.2 查重）
// 4.1：解析文件 → 预览 → 确认后追加到当前联系人
// 4.2：预览时标记「完全重复」与「疑似重复」，由用户勾选后才导入
// 不做自动分类、不做自动打标签（那是后面的事）
// =======================================================

(function () {
  'use strict';

  // ===== 1. 常量 =====
  const MAX_BYTES = 2 * 1024 * 1024; // 超过 2MB 直接拒绝，避免页面卡死
  const MAX_CONTENT = 2000;          // 单张字卡正文上限
  const MAX_PREVIEW = 5;             // 预览只列前 5 条
  const MAX_ERROR_SHOWN = 5;         // 失败原因最多列 5 条
  const CHUNK = 200;                 // 每解析 200 块让出一次主线程

  // 4.2 查重参数
  const SIMILARITY_THRESHOLD = 0.85; // 超过这个相似度就标为「疑似重复」
  const MIN_SEMANTIC_LENGTH = 5;     // 太短的文本不做语义比对，避免误判
  const EMBED_CHUNK = 10;            // 与后端单次请求上限保持一致
  const EMBED_TIMEOUT_MS = 15000;
  const MAX_CORPUS = 200;            // 参与比对的库内字卡上限
  const MAX_AUTO_SEMANTIC = 100;     // 超过这个条数就只在手动点「检测查重」时才算相似度

  // 4.3 自动分类 / 自动标签（纯前端规则，不调用任何外部 API）
  const STOP_WORDS = [
    '我', '你', '他', '她', '它', '们', '的', '了', '是', '在', '有', '和', '与', '就', '都',
    '也', '很', '要', '会', '不', '没', '这', '那', '吗', '啊', '吧', '呢', '哦', '呀', '啦',
    '嘛', '被', '把', '给', '对', '说', '做', '去', '来', '上', '下', '里', '个', '到', '还',
    '我们', '你们', '他们', '什么', '怎么', '可以', '因为', '所以', '但是', '还是', '一个', '时候'
  ];

  // 特征词 → 期望的分类名特征；实际分类必须来自库里已有的分类，绝不新造
  const CATEGORY_RULES = [
    { hints: ['吃', '饭', '饿', '夜宵', '美食', '甜品', '奶茶', '外卖', '烧烤', '火锅'], names: ['饮食', '吃饭', '美食', '食物', '生活', '日常'] },
    { hints: ['累', '困', '辛苦', '疲惫', '难过', '伤心', '委屈', '安慰', '抱抱', '哭', '压力', '自责'], names: ['情绪', '陪伴', '安慰', '关怀', '治愈'] },
    { hints: ['加油', '鼓励', '相信', '可以的', '没关系', '已经很好', '别怕', '挺你'], names: ['鼓励', '打气', '治愈'] },
    { hints: ['周末', '出去玩', '一起', '约', '见面', '来找我', '出门', '逛'], names: ['邀约', '约会', '出行', '日常'] },
    { hints: ['好听', '厉害', '喜欢', '不错', '推荐', '太棒', '好看', '棒'], names: ['夸奖', '赞美', '欣赏'] },
    { hints: ['在吗', '好久', '最近', '开场', '你好', '嗨', '冷场', '第一次'], names: ['破冰', '开场', '寒暄'] },
    { hints: ['醒了', '留言', '睡前', '晚安', '起床', '记得'], names: ['日常', '留言', '陪伴'] }
  ];

  // ===== 2. 页面元素 =====
  const importBtn = document.getElementById('importCardsBtn');
  const importModal = document.getElementById('importModal');
  const importFile = document.getElementById('importFile');
  const importTarget = document.getElementById('importTarget');
  const importLoading = document.getElementById('importLoading');
  const importSummary = document.getElementById('importSummary');
  const importPreview = document.getElementById('importPreview');
  const importErrors = document.getElementById('importErrors');
  const importAutoNote = document.getElementById('importAutoNote');
  const confirmImportBtn = document.getElementById('confirmImportBtn');
  const cancelImportBtn = document.getElementById('cancelImportBtn');
  const detectDupeBtn = document.getElementById('detectDupeBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const selectNoneBtn = document.getElementById('selectNoneBtn');

  // ===== 3. 当前状态 =====
  const state = {
    cards: [],       // 解析成功的字卡：{ content, category, keywords, scene, selected, dupe }
    failures: [],    // 失败原因
    ownerId: null,   // 导入到哪个联系人
    fileName: '',
    busy: false,     // 正在解析文件
    checking: false, // 正在做语义查重
    dedupeMode: 'exact' // exact = 只做了完全重复；semantic = 已做语义查重
  };

  function yieldToUI() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  // ===== 4. 字段校验 =====
  // 关键词：数组或字符串都接受，其他类型算格式错误
  function toKeywords(value) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) {
      return value
        .map(function (item) { return typeof item === 'string' ? item.trim() : String(item); })
        .filter(function (item) { return item !== ''; });
    }
    if (typeof value === 'string') {
      return value.split(/[,，、;；|\s]+/).map(function (w) { return w.trim(); })
        .filter(function (w) { return w !== ''; });
    }
    return null; // 类型不对
  }

  // 把一条原始数据变成字卡；不合法就返回失败原因
  function toCard(raw, where) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: where + '：不是一条字卡对象' };
    }

    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (content === '') {
      return { ok: false, reason: where + '：缺少字卡内容（content）' };
    }
    if (content.length > MAX_CONTENT) {
      return { ok: false, reason: where + '：内容超过 ' + MAX_CONTENT + ' 字' };
    }

    let category = '未分类';
    if (raw.category !== undefined && raw.category !== null && raw.category !== '') {
      if (typeof raw.category !== 'string') {
        return { ok: false, reason: where + '：分类（category）必须是文字' };
      }
      category = raw.category.trim() || '未分类';
    }

    let keywords = [];
    if (raw.keywords !== undefined && raw.keywords !== null && raw.keywords !== '') {
      keywords = toKeywords(raw.keywords);
      if (keywords === null) {
        return { ok: false, reason: where + '：关键词（keywords）必须是数组或文字' };
      }
    }

    let scene = '';
    if (raw.scene !== undefined && raw.scene !== null && raw.scene !== '') {
      if (typeof raw.scene !== 'string') {
        return { ok: false, reason: where + '：场景（scene）必须是文字' };
      }
      scene = raw.scene.trim();
    }

    return {
      ok: true,
      card: { content: content, category: category, keywords: keywords, scene: scene }
    };
  }

  // ===== 5. JSON 解析 =====
  // 接受：[{...}]  或  { cards: [...] }  或  { data: [...] }
  function parseJson(text) {
    const result = { cards: [], failures: [], fatal: null };

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      result.fatal = '不是合法的 JSON 文件（' + (error && error.message ? error.message : '解析失败') + '）';
      return result;
    }

    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.cards)) list = data.cards;
    else if (data && Array.isArray(data.data)) list = data.data;

    if (list === null) {
      result.fatal = 'JSON 顶层必须是字卡数组，或形如 { "cards": [...] } 的对象';
      return result;
    }

    list.forEach(function (item, index) {
      const made = toCard(item, '第 ' + (index + 1) + ' 条');
      if (made.ok) result.cards.push(made.card);
      else result.failures.push(made.reason);
    });

    return result;
  }

  // ===== 6. TXT 解析 =====
  // 支持三种写法（界面上有提示）：
  //   ① 问答对：  问：xxx   答：yyy      （答作为字卡内容，问自动变成关键词）
  //   ② 字段行：  内容：xxx  分类：安慰   关键词：疲惫,辛苦   场景：对方很累时
  //   ③ 纯文本：  一行就是一张字卡
  // 空行用来分隔；空行或缺少内容的条目会被过滤并计入失败条数
  const RE_CONTENT = /^(?:内容|正文|文本|content|text)\s*[:：]\s*(.+)$/i;
  const RE_ANSWER = /^(?:答|回答|回复|answer|a)\s*[:：]\s*(.+)$/i;
  const RE_QUESTION = /^(?:问|问题|question|q)\s*[:：]\s*(.+)$/i;
  const RE_CATEGORY = /^(?:分类|类别|category)\s*[:：]\s*(.+)$/i;
  const RE_KEYWORDS = /^(?:关键词|关键字|标签|keywords|tags)\s*[:：]\s*(.+)$/i;
  const RE_SCENE = /^(?:场景|场景说明|scene)\s*[:：]\s*(.+)$/i;

  function parseTxt(text) {
    const result = { cards: [], failures: [], fatal: null };
    const lines = String(text == null ? '' : text).split(/\r?\n/);

    let current = { content: '', category: '', keywordsText: '', scene: '', question: '' };
    let lineNo = 0;

    function flush() {
      if (current.content.trim() !== '') {
        const keywords = current.keywordsText
          ? toKeywords(current.keywordsText) || []
          : (current.question ? (toKeywords(current.question) || []) : []);
        result.cards.push({
          content: current.content.trim(),
          category: current.category.trim() || '未分类',
          keywords: keywords,
          scene: current.scene.trim()
        });
      } else if (current.content !== '' || current.category || current.keywordsText || current.scene || current.question) {
        // 只写了字段却没内容：算一条无效数据
        result.failures.push('第 ' + lineNo + ' 行附近：缺少字卡内容');
      }
      current = { content: '', category: '', keywordsText: '', scene: '', question: '' };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') { flush(); continue; }
      lineNo = i + 1;

      let matched = line.match(RE_CONTENT) || line.match(RE_ANSWER);
      if (matched) {
        if (current.content !== '') flush(); // 上一张结束
        current.content = matched[1].trim();
        continue;
      }

      matched = line.match(RE_QUESTION);
      if (matched) {
        // 新的「问」意味着上一组问答已经结束
        if (current.content !== '') flush();
        current.question = matched[1].trim();
        continue;
      }

      matched = line.match(RE_CATEGORY);
      if (matched) { current.category = matched[1].trim(); continue; }

      matched = line.match(RE_KEYWORDS);
      if (matched) { current.keywordsText = matched[1].trim(); continue; }

      matched = line.match(RE_SCENE);
      if (matched) { current.scene = matched[1].trim(); continue; }

      // 没有前缀：整行就是一张字卡内容
      if (current.content !== '') flush();
      current.content = line;
    }
    flush();

    // 纯文本也可能写了很长的内容，这里按上限过滤
    result.cards = result.cards.filter(function (card) {
      if (card.content.length > MAX_CONTENT) {
        result.failures.push('内容超过 ' + MAX_CONTENT + ' 字，已跳过');
        return false;
      }
      return true;
    });

    return result;
  }

  // ===== 7. 分片解析：大文件也不卡住页面 =====
  async function parseByType(text, fileName) {
    const isJson = /\.json$/i.test(String(fileName || ''))
      || /^\s*[[{]/.test(String(text || ''));
    const raw = isJson ? parseJson(text) : parseTxt(text);

    // 交回解析结果（解析本身是同步的，但结果与渲染之间会让出主线程）
    const cards = [];
    for (let i = 0; i < raw.cards.length; i++) {
      cards.push(raw.cards[i]);
      if ((i + 1) % CHUNK === 0) await yieldToUI();
    }
    return { cards: cards, failures: raw.failures, fatal: raw.fatal, type: isJson ? 'json' : 'txt' };
  }

  // ===== 7.5 自动分类 / 自动标签（阶段 4.3）=====

  // 只取库里已经存在的分类，不新增分类体系
  function collectExistingCategories() {
    const list = [];
    function absorb(cards) {
      (cards || []).forEach(function (card) {
        const name = String(card.category || '').trim();
        if (name && name !== '未分类' && list.indexOf(name) === -1) list.push(name);
      });
    }
    // 当前联系人的分类优先命中，其次才是其他联系人
    absorb(window.MochiChatCards.getCardsOf(state.ownerId));
    (window.MochiChat.getContacts() || []).forEach(function (contact) {
      absorb(window.MochiChatCards.getCardsOf(contact.id));
    });
    return list;
  }

  // 正文特征 → 已有分类；没有任何特征命中就返回 null（保留「未分类」）
  function suggestCategory(content, categories) {
    const text = String(content || '');
    if (text === '' || categories.length === 0) return null;

    for (let i = 0; i < CATEGORY_RULES.length; i++) {
      const rule = CATEGORY_RULES[i];
      const hit = rule.hints.some(function (word) { return text.indexOf(word) !== -1; });
      if (!hit) continue;

      for (let j = 0; j < rule.names.length; j++) {
        const want = rule.names[j];
        const found = categories.find(function (name) {
          return name === want || name.indexOf(want) !== -1 || want.indexOf(name) !== -1;
        });
        if (found) return found;
      }
    }
    return null;
  }

  // 轻量分词：抓 2-4 字词组，按「词频 × 词长」排序，过滤停用词
  function suggestKeywords(content) {
    const segments = String(content || '').match(/[一-龥]{2,}/g) || [];
    if (segments.length === 0) return [];

    const counter = {};
    segments.forEach(function (segment) {
      for (let size = 2; size <= 4; size++) {
        for (let i = 0; i + size <= segment.length; i++) {
          const gram = segment.slice(i, i + size);
          if (STOP_WORDS.indexOf(gram) !== -1) continue;
          // 含单字停用词的词组也不要（例如「累了」「我的」）
          const dirty = STOP_WORDS.some(function (word) {
            return word.length === 1 && gram.indexOf(word) !== -1;
          });
          if (dirty) continue;
          counter[gram] = (counter[gram] || 0) + 1;
        }
      }
    });

    // 4 字词与 3 字词同分，短词优先，读起来更像「标签」
    const ranked = Object.keys(counter).map(function (word) {
      return { word: word, score: counter[word] * Math.min(word.length, 3) };
    }).sort(function (a, b) {
      return (b.score - a.score) || (a.word.length - b.word.length);
    });

    // 已经选中的词用过的字不再重复利用，避免「一起吃 / 起吃夜 / 吃夜宵」这种叠词
    function sharesChar(a, b) {
      for (let i = 0; i < a.length; i++) {
        if (b.indexOf(a[i]) !== -1) return true;
      }
      return false;
    }

    const picked = [];
    for (let i = 0; i < ranked.length && picked.length < 3; i++) {
      const candidate = ranked[i];
      const overlap = picked.some(function (item) {
        return sharesChar(item.word, candidate.word);
      });
      if (overlap) continue;
      picked.push(candidate);
    }
    return picked.map(function (item) { return item.word; });
  }

  // 只补缺失字段：用户填过的分类/关键词一个字都不动
  async function enrichSuggestions() {
    const categories = collectExistingCategories();

    for (let i = 0; i < state.cards.length; i++) {
      const item = state.cards[i];

      if (!item.category || item.category === '未分类') {
        const guess = suggestCategory(item.content, categories);
        if (guess) {
          item.category = guess;
          item.categoryAuto = true;
        }
      }

      if (!item.keywords || item.keywords.length === 0) {
        const tags = suggestKeywords(item.content);
        if (tags.length > 0) {
          item.keywords = tags;
          item.keywordsAuto = true;
        }
      }

      if ((i + 1) % CHUNK === 0) await yieldToUI();
    }
  }

  // ===== 8. 查重（阶段 4.2）=====

  // 8.1 完全重复：忽略首尾空格后与库内已有字卡逐字相同
  function markExactDuplicates() {
    const existing = window.MochiChatCards.getCardsOf(state.ownerId) || [];
    const seen = {};
    existing.forEach(function (card) {
      seen[String(card.content || '').trim()] = true;
    });

    let count = 0;
    state.cards.forEach(function (item) {
      const key = item.content.trim();
      if (seen[key]) {
        item.dupe = 'exact';
        item.selected = false; // 完全重复默认跳过
        item.similarity = 1;
        count++;
      } else {
        seen[key] = true; // 同一批文件里的重复也算重复
        item.selected = true;
        item.dupe = '';
        item.similarity = null;
      }
    });
    return count;
  }

  // 8.2 语义相似度：复用前端向量请求，不碰 Provider 与缓存
  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  async function embedTexts(texts) {
    const keys = window.MochiChatCustomKeys;
    if (!keys || typeof keys.embed !== 'function') return null;

    const vectors = [];
    for (let start = 0; start < texts.length; start += EMBED_CHUNK) {
      const chunk = texts.slice(start, start + EMBED_CHUNK);
      let result;
      try {
        // 阶段 8：直接走前端向量请求（云端百炼 / 本地 Ollama），不再依赖本机后端
        result = await keys.embed(chunk);
      } catch (error) {
        return null; // 超时 / 断网 / 未配置：静默降级到仅完全重复
      }
      if (!result || !Array.isArray(result.embeddings) || result.embeddings.length !== chunk.length) return null;
      result.embeddings.forEach(function (v) { vectors.push(v); });
    }
    return vectors;
  }

  function aiEnabled() {
    const ai = window.MochiChatAI;
    if (!ai || typeof ai.getState !== 'function') return false;
    const snapshot = ai.getState();
    return snapshot.available === true && snapshot.enabled === true;
  }

  // 语义查重：任何一步失败都退回「只做完全重复」，绝不因此中断导入
  async function markSimilarDuplicates(options) {
    const settings = options || {};
    if (!aiEnabled()) {
      state.dedupeMode = 'exact';
      return 0;
    }

    const existing = (window.MochiChatCards.getCardsOf(state.ownerId) || [])
      .map(function (card) { return String(card.content || '').trim(); })
      .filter(function (text) { return text.length >= MIN_SEMANTIC_LENGTH; })
      .slice(0, MAX_CORPUS);

    // 太短的正文不做语义比对；已经判定为完全重复的也不用再算
    const targets = state.cards.filter(function (item) {
      return item.dupe !== 'exact' && item.content.trim().length >= MIN_SEMANTIC_LENGTH;
    });

    if (existing.length === 0 || targets.length === 0) {
      state.dedupeMode = 'exact';
      return 0;
    }
    if (!settings.force && targets.length > MAX_AUTO_SEMANTIC) {
      // 条数太多就不自动算，等用户点「检测查重」
      state.dedupeMode = 'exact';
      return 0;
    }

    state.checking = true;
    render();

    try {
      const texts = existing.concat(targets.map(function (item) { return item.content.trim(); }));
      const vectors = await embedTexts(texts);
      if (!vectors) {
        state.dedupeMode = 'exact';
        return 0;
      }

      let count = 0;
      targets.forEach(function (item, index) {
        const vector = vectors[existing.length + index];
        let best = 0;
        for (let i = 0; i < existing.length; i++) {
          const value = cosine(vector, vectors[i]);
          if (value > best) best = value;
        }
        item.similarity = best;
        if (best > SIMILARITY_THRESHOLD) {
          item.dupe = 'similar';
          item.selected = false; // 疑似重复默认跳过，用户可以手动勾回来
          count++;
        }
      });

      state.dedupeMode = 'semantic';
      return count;
    } catch (error) {
      state.dedupeMode = 'exact';
      return 0;
    } finally {
      state.checking = false;
      render();
    }
  }

  function countBy(kind) {
    return state.cards.filter(function (item) {
      return kind === 'selected' ? item.selected === true : item.dupe === kind;
    }).length;
  }

  // ===== 9. 渲染 =====
  // 分类 / 关键词都可以手动改；改动只影响最终导入的值
  function makeField(labelText, badgeText, value, auto, edited, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'import-field';

    const span = document.createElement('span');
    span.className = 'import-field-label';
    span.textContent = labelText;

    const input = document.createElement('input');
    input.className = 'import-input';
    input.type = 'text';
    input.value = value;
    input.addEventListener('change', function () {
      onChange(input.value);
      render();
    });

    wrap.appendChild(span);
    wrap.appendChild(input);

    if (auto) {
      const badge = document.createElement('span');
      badge.className = 'auto-tag';
      badge.textContent = edited ? badgeText + '（已手动修改）' : badgeText;
      wrap.appendChild(badge);
    }
    return wrap;
  }

  function render() {
    const total = state.cards.length;
    const exact = countBy('exact');
    const similar = countBy('similar');
    const selected = countBy('selected');
    const bad = state.failures.length;

    if (state.busy) {
      importLoading.hidden = false;
      importLoading.textContent = '正在解析文件，请稍候…';
      importSummary.hidden = true;
    } else if (state.checking) {
      importLoading.hidden = false;
      importLoading.textContent = '正在进行语义查重…';
      importSummary.hidden = true;
    } else {
      importLoading.hidden = true;
      importSummary.hidden = false;
      importSummary.textContent = state.fatal
        ? state.fatal
        : ('成功解析 ' + total + ' 条，其中完全重复 ' + exact + ' 条，疑似重复 ' + similar
          + ' 条，失败 ' + bad + ' 条。已勾选 ' + selected + ' 条，确认后追加到当前联系人的字卡库。');
      importSummary.className = 'import-summary' + (state.fatal ? ' is-error' : (total > 0 ? ' is-ok' : ''));
    }

    importPreview.innerHTML = '';
    state.cards.slice(0, MAX_PREVIEW).forEach(function (card) {
      const item = document.createElement('li');
      item.className = 'import-item' + (card.dupe ? ' is-dupe' : '');

      const head = document.createElement('div');
      head.className = 'import-item-head';

      const tag = document.createElement('span');
      tag.className = 'card-tag';
      tag.textContent = card.category;
      head.appendChild(tag);

      if (card.dupe === 'exact') {
        const mark = document.createElement('span');
        mark.className = 'dupe-tag is-exact';
        mark.textContent = '完全重复';
        head.appendChild(mark);
      } else if (card.dupe === 'similar') {
        const mark = document.createElement('span');
        mark.className = 'dupe-tag is-similar';
        mark.textContent = '疑似重复' + (card.similarity != null ? '（' + card.similarity.toFixed(2) + '）' : '');
        head.appendChild(mark);
      }

      const label = document.createElement('label');
      label.className = 'import-check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = card.selected === true;
      box.addEventListener('change', function () {
        card.selected = box.checked;
        render();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode('导入'));
      head.appendChild(label);

      item.appendChild(head);

      const body = document.createElement('p');
      body.className = 'import-item-content';
      body.textContent = card.content;
      item.appendChild(body);

      const meta = document.createElement('p');
      meta.className = 'import-item-meta';
      const parts = [];
      if (card.keywords.length) parts.push('关键词：' + card.keywords.join('、'));
      if (card.scene) parts.push('场景：' + card.scene);
      meta.textContent = parts.join(' ｜ ');
      if (parts.length) item.appendChild(meta);

      // 4.3：分类与关键词都可以现场改；自动生成的值带浅色小标签
      const fields = document.createElement('div');
      fields.className = 'import-fields';
      fields.appendChild(makeField('分类', 'AI 推荐分类', card.category, card.categoryAuto, card.categoryEdited,
        function (value) {
          card.category = String(value || '').trim() || '未分类';
          if (card.categoryAuto) card.categoryEdited = true;
        }));
      fields.appendChild(makeField('关键词', '自动标签', (card.keywords || []).join(', '), card.keywordsAuto, card.keywordsEdited,
        function (value) {
          const parsed = toKeywords(value);
          card.keywords = parsed === null ? [] : parsed;
          if (card.keywordsAuto) card.keywordsEdited = true;
        }));
      item.appendChild(fields);

      importPreview.appendChild(item);
    });
    if (total > MAX_PREVIEW) {
      const more = document.createElement('li');
      more.className = 'import-more';
      more.textContent = '…… 还有 ' + (total - MAX_PREVIEW) + ' 条（勾选状态对全部条目生效）';
      importPreview.appendChild(more);
    }

    importErrors.innerHTML = '';
    state.failures.slice(0, MAX_ERROR_SHOWN).forEach(function (reason) {
      const item = document.createElement('li');
      item.className = 'import-error';
      item.textContent = reason;
      importErrors.appendChild(item);
    });
    if (bad > MAX_ERROR_SHOWN) {
      const more = document.createElement('li');
      more.className = 'import-error';
      more.textContent = '…… 还有 ' + (bad - MAX_ERROR_SHOWN) + ' 条无效数据被跳过';
      importErrors.appendChild(more);
    }

    // 自动生成提示：默认值，用户可改
    if (importAutoNote) {
      const autoCategory = state.cards.filter(function (item) { return item.categoryAuto; }).length;
      const autoKeywords = state.cards.filter(function (item) { return item.keywordsAuto; }).length;
      if (autoCategory > 0 || autoKeywords > 0) {
        importAutoNote.hidden = false;
        importAutoNote.textContent = '其中 ' + autoCategory + ' 条自动补了分类、' + autoKeywords
          + ' 条自动补了标签（仅为建议值，可在下方输入框里改）。';
      } else {
        importAutoNote.hidden = true;
      }
    }

    const busy = state.busy || state.checking;
    confirmImportBtn.disabled = busy || selected === 0;
    if (detectDupeBtn) detectDupeBtn.disabled = busy || total === 0 || !aiEnabled();
    if (selectAllBtn) selectAllBtn.disabled = busy || total === 0;
    if (selectNoneBtn) selectNoneBtn.disabled = busy || total === 0;
  }

  function reset() {
    state.cards = [];
    state.failures = [];
    state.fatal = null;
    state.fileName = '';
    state.busy = false;
    state.checking = false;
    state.dedupeMode = 'exact';
    importFile.value = '';
    render();
  }

  // ===== 10. 打开 / 关闭 =====
  function open() {
    const ownerId = window.MochiChatCards && window.MochiChatCards.getOwnerId
      ? window.MochiChatCards.getOwnerId()
      : window.MochiChat.getCurrentContact().id;
    const contact = window.MochiChat.getContactById(ownerId);
    state.ownerId = ownerId;
    importTarget.textContent = contact ? contact.name : ownerId;
    reset();
    importModal.hidden = false;
  }

  function close() {
    importModal.hidden = true;
    reset();
  }

  // ===== 11. 读文件 → 解析 → 查重 → 预览 =====
  async function previewFromText(text, fileName, options) {
    const settings = options || {};
    state.busy = true;
    state.fileName = String(fileName || '');
    render();
    await yieldToUI();

    let parsed;
    try {
      parsed = await parseByType(text, fileName);
    } catch (error) {
      parsed = { cards: [], failures: [], fatal: '文件解析失败：' + (error && error.message ? error.message : '未知错误') };
    }

    state.cards = parsed.cards.map(function (card) {
      return {
        content: card.content,
        category: card.category,
        keywords: card.keywords,
        scene: card.scene,
        selected: true,
        dupe: '',
        similarity: null,
        categoryAuto: false,
        keywordsAuto: false,
        categoryEdited: false,
        keywordsEdited: false
      };
    });
    state.failures = parsed.failures;
    state.fatal = parsed.fatal || null;
    state.busy = false;

    // 4.3：只给「缺分类 / 缺标签」的字卡补建议值，用户填过的不动
    await enrichSuggestions();

    markExactDuplicates();
    render();
    await markSimilarDuplicates({ force: settings.force === true });
    render();

    return { ok: countBy('selected') > 0, fatal: state.fatal };
  }

  async function handleFile(file) {
    if (!file) return;
    if (file.size && file.size > MAX_BYTES) {
      state.cards = [];
      state.failures = [];
      state.fatal = '文件太大了（超过 2MB），请先拆分成几个小文件';
      state.busy = false;
      render();
      return;
    }

    state.busy = true;
    render();

    const text = await new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { resolve(''); };
      reader.readAsText(file);
    });

    await previewFromText(text, file.name);
  }

  // ===== 12. 确认保存：只导入勾选的条目，复用字卡库现有保存机制 =====
  function confirmImport() {
    if (state.busy || state.checking) return 0;

    const list = state.cards.filter(function (item) {
      return item.selected === true;
    }).map(function (item) {
      return {
        content: item.content,
        category: item.category,
        keywords: item.keywords,
        scene: item.scene
      };
    });

    if (list.length === 0) return 0;

    const added = window.MochiChatCards.addCards(state.ownerId, list);
    close();
    return added;
  }

  // ===== 13. 事件绑定 =====
  if (importBtn) {
    importBtn.addEventListener('click', open);
  }
  importFile.addEventListener('change', function () {
    handleFile(importFile.files && importFile.files[0]);
  });
  confirmImportBtn.addEventListener('click', confirmImport);
  cancelImportBtn.addEventListener('click', close);

  if (detectDupeBtn) {
    detectDupeBtn.addEventListener('click', async function () {
      markExactDuplicates();
      await markSimilarDuplicates({ force: true });
      render();
    });
  }
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function () {
      state.cards.forEach(function (item) { item.selected = true; });
      render();
    });
  }
  if (selectNoneBtn) {
    selectNoneBtn.addEventListener('click', function () {
      state.cards.forEach(function (item) { item.selected = false; });
      render();
    });
  }

  // 点遮罩 / Esc 也能关掉导入弹窗
  importModal.querySelectorAll('[data-close]').forEach(function (mask) {
    mask.addEventListener('click', close);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !importModal.hidden) close();
  });

  // ===== 14. 对外接口（便于测试与后续阶段复用）=====
  window.MochiChatCardImport = {
    open: open,
    close: close,
    previewFromText: previewFromText,
    confirm: confirmImport,
    parseJson: parseJson,
    parseTxt: parseTxt,
    detectDuplicates: function () {
      markExactDuplicates();
      return markSimilarDuplicates({ force: true });
    },
    getState: function () {
      return {
        ownerId: state.ownerId,
        cards: state.cards.length,
        selected: countBy('selected'),
        exact: countBy('exact'),
        similar: countBy('similar'),
        autoCategory: state.cards.filter(function (i) { return i.categoryAuto; }).length,
        autoKeywords: state.cards.filter(function (i) { return i.keywordsAuto; }).length,
        failures: state.failures.length,
        fatal: state.fatal || null,
        busy: state.busy,
        checking: state.checking,
        dedupeMode: state.dedupeMode
      };
    }
  };
})();

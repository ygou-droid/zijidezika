// =======================================================
// Mochi Chat · 字卡智能匹配（第一版，纯本地规则，不接外部 AI）
// 这个文件既能在浏览器里用，也能被 Node 引入做单元测试
// =======================================================

(function (root) {
  'use strict';

  // ===== 1. 没有命中任何字卡时使用的默认回复（与字卡分开单独设置）=====
  const DEFAULT_REPLIES = [
    '嗯嗯，我在听～不过这张字卡我还不知道该怎么回你，再换个说法试试？',
    '我暂时没有找到合适的字卡来回应这句话呢。',
    '这句话我还没学会怎么答，给我一点时间好吗？',
    '抱歉呀，我这里没有匹配到相关的话术～'
  ];

  // ===== 2. 文本标准化：去掉标点、空格、符号，统一小写 =====
  function normalize(text) {
    return String(text === undefined || text === null ? '' : text)
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}\p{Z}\p{C}]/gu, '');
  }

  // ===== 3. 创建匹配器 =====
  // options.getCards(contactId) => 返回该联系人的字卡数组
  function createMatcher(options) {
    const getCards = options.getCards;
    let defaultIndex = 0;

    // 轮流取一条默认回复
    function pickDefaultReply() {
      const text = DEFAULT_REPLIES[defaultIndex];
      defaultIndex = (defaultIndex + 1) % DEFAULT_REPLIES.length;
      return text;
    }

    // 单张字卡的打分规则（可自行调整权重）
    function scoreCard(card, input) {
      const keywords = card.keywords || [];
      const matchedKeywords = [];
      let score = 0;

      keywords.forEach(function (keyword) {
        const k = normalize(keyword);
        if (k === '') return;

        if (input.indexOf(k) !== -1) {
          matchedKeywords.push(keyword);
          // 关键词越长，说明越具体，分数越高（中文里尤其明显）
          score += k.length * 2;
          // 整句话就是关键词本身，视为完全匹配
          if (input === k) score += 5;
        }
      });

      // 命中的关键词越多，分数越高
      if (matchedKeywords.length > 1) {
        score += (matchedKeywords.length - 1) * 3;
      }

      return { score: score, matchedKeywords: matchedKeywords };
    }

    // 主函数：在「指定联系人自己的字卡库」里找最合适的字卡
    function match(contactId, userText) {
      const input = normalize(userText);
      const cards = (getCards(contactId) || []).slice();

      const base = {
        contactId: contactId,
        userText: String(userText || ''),
        normalizedText: input,
        totalCards: cards.length
      };

      // 情况一：输入是空的
      if (input === '') {
        return Object.assign(base, {
          matched: false,
          card: null,
          score: 0,
          matchedKeywords: [],
          candidates: [],
          reason: '消息里没有可用于匹配的文字（只有标点或空格）。',
          reply: pickDefaultReply()
        });
      }

      // 情况二：这位联系人还没有字卡
      if (cards.length === 0) {
        return Object.assign(base, {
          matched: false,
          card: null,
          score: 0,
          matchedKeywords: [],
          candidates: [],
          reason: '这位联系人的字卡库里还没有任何字卡，请先到「字卡库」添加。',
          reply: pickDefaultReply()
        });
      }

      // 情况三：逐张打分
      const candidates = [];
      cards.forEach(function (card) {
        const result = scoreCard(card, input);
        if (result.score > 0) {
          candidates.push({
            card: card,
            score: result.score,
            matchedKeywords: result.matchedKeywords
          });
        }
      });

      // 一张都没命中
      const emptyKeywordCards = cards.filter(function (card) {
        return !(card.keywords && card.keywords.length > 0);
      }).length;

      if (candidates.length === 0) {
        let reason = '消息中没有出现任何关键词，因此不能随意挑一张字卡来回复。';
        if (emptyKeywordCards === cards.length) {
          reason = '这位联系人的 ' + cards.length + ' 张字卡都没有设置关键词，无法参与匹配。';
        } else if (emptyKeywordCards > 0) {
          reason = '消息中没有出现任何关键词（其中 ' + emptyKeywordCards + ' 张字卡没有关键词）。';
        }
        return Object.assign(base, {
          matched: false,
          card: null,
          score: 0,
          matchedKeywords: [],
          candidates: [],
          reason: reason,
          reply: pickDefaultReply()
        });
      }

      // 取最高分，分数相同则随机挑一张
      let best = candidates[0].score;
      candidates.forEach(function (item) {
        if (item.score > best) best = item.score;
      });
      const top = candidates.filter(function (item) {
        return item.score === best;
      });
      const picked = top[Math.floor(Math.random() * top.length)];

      return Object.assign(base, {
        matched: true,
        card: picked.card,
        score: best,
        matchedKeywords: picked.matchedKeywords,
        candidates: candidates,
        reason: '',
        reply: picked.card.content
      });
    }

    return {
      match: match,
      normalize: normalize,
      pickDefaultReply: pickDefaultReply,
      getDefaultReplies: function () {
        return DEFAULT_REPLIES.slice();
      }
    };
  }

  const api = { normalize: normalize, createMatcher: createMatcher, DEFAULT_REPLIES: DEFAULT_REPLIES };

  // Node 环境下可以 require('./matcher.js') 做单元测试
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  // ===== 4. 浏览器环境：挂到 window 上，并负责调试面板的显示 =====
  if (typeof window !== 'undefined') {
    const matcher = createMatcher({
      getCards: function (contactId) {
        // 阶段 5.8：聊天匹配只用聊天字卡，情话 / 朋友圈文案不进对话池
        const lib = window.MochiChatCards;
        if (lib && typeof lib.getChatCardsOf === 'function') {
          return lib.getChatCardsOf(contactId);
        }
        return lib.getCardsOf(contactId);
      }
    });

    matcher.renderDebug = function (result) {
      const panel = document.getElementById('debugPanel');
      const body = document.getElementById('debugBody');
      const contact = window.MochiChat.getContactById(result.contactId);
      const contactName = contact ? contact.name : '未知联系人';
      body.innerHTML = '';

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

      row('搜索范围', contactName + ' 的字卡库（共 ' + result.totalCards + ' 张）');

      if (result.matched) {
        row('匹配结果', '命中字卡', 'debug-value--hit');
        row('使用回复', result.card.content);
        row('字卡分类', result.card.category || '未分类');
        row('匹配关键词', result.matchedKeywords.join('、'));
        row('匹配分数', String(result.score));
        row('候选字卡', '命中 ' + result.candidates.length + ' 张，最高分 ' + result.score +
          (result.candidates.length > 1 ? '（同分会在候选中随机）' : ''));
      } else {
        row('匹配结果', '未命中，使用默认回复', 'debug-value--miss');
        row('未命中原因', result.reason);
        row('使用回复', result.reply);
      }

      panel.classList.remove('is-empty');
    };

    window.MochiChatMatcher = matcher;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

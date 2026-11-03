// =======================================================
// Mochi Chat · 字卡库（每个联系人有独立的一套字卡）
// 数据保存在浏览器 localStorage，刷新页面不会丢失
// =======================================================

(function () {
  'use strict';

  // ===== 1. 基础配置 =====
  const STORAGE_KEY = 'mochi-chat-cards-v1';

  // 阶段 5.8：字卡类型 —— 一套字卡库管理所有文案
  // chat = 聊天匹配用（默认）；quote = 桌面情话；moment_post = 朋友圈文案；moment_reply = 朋友圈评论
  const TYPE_LABELS = {
    chat: '聊天',
    quote: '情话',
    moment_post: '朋友圈',
    moment_reply: '朋友圈评论',
    signature: '签名'
  };

  // 类型过滤条（字卡库顶部）：聊天 / 情话 / 朋友圈 / 签名
  const TYPE_FILTERS = [
    { id: 'all', label: '全部', match: null },
    { id: 'chat', label: '聊天', match: ['chat'] },
    { id: 'quote', label: '情话', match: ['quote'] },
    { id: 'moment', label: '朋友圈', match: ['moment_post', 'moment_reply'] },
    { id: 'signature', label: '签名', match: ['signature'] }
  ];

  // 阶段 5.8 迁移标记：默认情话 / 朋友圈字卡只注入一次，用户删了就是删了
  const TYPE_MIGRATION_KEY = 'mochi-chat-cards-type-v1';
  // 阶段 5.9 迁移标记：签名卡是后加的，单独给老库也注入一次
  const SIGNATURE_MIGRATION_KEY = 'mochi-chat-cards-signature-v1';

  // 阶段 5.9.2：每种非聊天类型的默认分类，选类型时自动选中、保存时兜底，
  // 避免「个性签名」这类卡全部落进「未分类」
  const TYPE_CATEGORY_DEFAULTS = {
    quote: '情话',
    moment_post: '朋友圈文案',
    moment_reply: '朋友圈评论',
    signature: '签名'
  };

  function defaultCategoryFor(type) {
    return TYPE_CATEGORY_DEFAULTS[type] || '';
  }

  // 首次升级 5.8 时给默认联系人补的示例卡（保证情话 / 自动发圈 / 自动评论开箱即用）
  const DEFAULT_TYPED_CARDS = {
    mochi: {
      quote: [
        '把日子过成软软的，慢一点也没关系。',
        '今天的你也很好，值得被抱一下。',
        '如果今天有点难，就把难过分我一半。',
        '允许自己发呆，也允许自己被好好喜欢。'
      ],
      moment_post: ['路过一家亮着灯的小店，买了杯热的。', '今天的云像被谁揉过，很软。'],
      moment_reply: ['真好看！', '我也想去看看'],
      signature: ['把日子过成软软的', '今天也要软软地过']
    },
    rabbit: {
      quote: [
        '今天的甜度由你决定。',
        '想把你写进今天的菜单。',
        '世界很吵，但你可以只听见自己的呼吸。',
        '今天的风很轻，希望你的心事也一样轻。'
      ],
      moment_post: ['试做了三次奶油卷，这次的弧度终于像样了。', '烤箱预热的十分钟，是一天里最安静的等待。'],
      moment_reply: ['好甜的画面', '下次带我一个'],
      signature: ['奶油味的小事', '甜度刚好的日常']
    },
    bear: {
      quote: [
        '风大的时候，把外套留给你。',
        '早点休息，明天的事明天说。',
        '慢一点也没关系，我一直在这里等你。',
        '无论多晚，这个房间都为你亮着灯。'
      ],
      moment_post: ['凌晨的便利店只有关东煮在冒热气，很安心。', '沿着河边走了四十分钟，什么都没想。'],
      moment_reply: ['嗯，风确实凉了', '早点休息'],
      signature: ['风大的时候外套留给你', '凌晨的便利店常客']
    },
    general: {
      quote: ['你不需要事事完美，今天的你已经很努力了。', '把想说的话留在这里，我会认真读。'],
      moment_post: ['记一件很小的事。'],
      moment_reply: ['真好看！'],
      signature: ['记录一点小事']
    }
  };

  const app = window.MochiChat.getAppElement();
  const contacts = window.MochiChat.getContacts();

  // 第一次使用时自动写入的示例字卡（按联系人 id 分开）
  const SAMPLE_CARDS = {
    mochi: [
      {
        content: '今天辛苦啦，先抱抱你～',
        category: '安慰',
        keywords: ['疲惫', '辛苦', '抱抱'],
        scene: '对方加班或很累的时候'
      },
      {
        content: '你已经做得很好了，不用什么事都完美。',
        category: '鼓励',
        keywords: ['自责', '压力'],
        scene: '对方觉得自己不够好时'
      },
      {
        content: '刚刚看到一只胖乎乎的猫，立刻想到你。',
        category: '破冰',
        keywords: ['冷场', '开场'],
        scene: '很久没聊天，重新开口时'
      }
    ],
    rabbit: [
      {
        content: '周末要不要一起去那家新开的甜品店？',
        category: '邀约',
        keywords: ['周末', '甜品', '出去玩'],
        scene: '想约对方出门时'
      },
      {
        content: '你推荐的歌我循环了一整天，太好听了！',
        category: '夸奖',
        keywords: ['音乐', '分享'],
        scene: '对方分享了喜欢的东西'
      }
    ],
    bear: [
      {
        content: '醒了记得找我，我给你留了小蛋糕。',
        category: '日常',
        keywords: ['留言', '睡前'],
        scene: '对方不在线时留言'
      }
    ]
  };

  // ===== 2. 页面元素 =====
  const openCardsBtn = document.getElementById('openCardsBtn');
  const cardsView = document.getElementById('cardsView');
  const closeCardsBtn = document.getElementById('closeCardsBtn');
  const cardsOwnerText = document.getElementById('cardsOwnerText');
  const libraryOwner = document.getElementById('libraryOwner');
  const cardSearch = document.getElementById('cardSearch');
  const newCardBtn = document.getElementById('newCardBtn');
  const categoryBar = document.getElementById('categoryBar');
  const cardTypeBar = document.getElementById('cardTypeBar');
  const cardGrid = document.getElementById('cardGrid');
  const cardsEmpty = document.getElementById('cardsEmpty');

  const cardModal = document.getElementById('cardModal');
  const cardForm = document.getElementById('cardForm');
  const modalTitle = document.getElementById('modalTitle');
  const cardContent = document.getElementById('cardContent');
  const cardCategory = document.getElementById('cardCategory');
  const cardKeywords = document.getElementById('cardKeywords');
  const cardScene = document.getElementById('cardScene');
  const cardOwner = document.getElementById('cardOwner');
  const cardTypeSelect = document.getElementById('cardType');
  const categoryOptions = document.getElementById('categoryOptions');
  const cancelCardBtn = document.getElementById('cancelCardBtn');

  const confirmModal = document.getElementById('confirmModal');
  const confirmText = document.getElementById('confirmText');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

  const toast = document.getElementById('toast');

  // ===== 3. 当前状态 =====
  let store = {};                 // { 联系人id: [字卡, 字卡] }
  let ownerId = contacts[0].id;   // 当前查看的是哪个联系人的字卡库
  let currentCategory = '全部';   // 当前分类筛选
  let currentType = 'all';        // 阶段 5.8：当前类型筛选（all / chat / quote / moment）
  let editingCardId = null;       // 正在编辑的字卡 id（新建时为 null）
  let pendingDelete = null;       // 等待确认删除的字卡 id

  // ===== 4. 读写 localStorage =====
  function makeId() {
    return 'card-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
  }

  function createSampleStore() {
    const result = {};
    contacts.forEach(function (contact) {
      const list = (SAMPLE_CARDS[contact.id] || []).map(function (item) {
        return {
          id: makeId(),
          content: item.content,
          category: item.category,
          keywords: item.keywords,
          scene: item.scene
        };
      });
      result[contact.id] = list;
    });
    return result;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createSampleStore();

      const data = JSON.parse(raw);
      // 保证每个联系人都有自己的字卡数组（新增联系人时也不会报错）
      contacts.forEach(function (contact) {
        if (!Array.isArray(data[contact.id])) {
          data[contact.id] = [];
        }
      });
      return data;
    } catch (error) {
      // 读取失败就用示例数据兜底
      return createSampleStore();
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      showToast('浏览器无法保存，本次修改刷新后会丢失');
    }
  }

  // ===== 4.5 阶段 5.8 迁移：旧卡补 type，首次注入默认情话 / 朋友圈卡 =====
  function cardTypeOf(card) {
    return (card && card.type && TYPE_LABELS[card.type]) ? card.type : 'chat';
  }

  function migrateTypedCards() {
    // 旧数据没有 type 字段，统一视为聊天字卡（语义匹配行为完全不变）
    contacts.forEach(function (contact) {
      (store[contact.id] || []).forEach(function (card) {
        if (!card.type || !TYPE_LABELS[card.type]) card.type = 'chat';
      });
    });

    // 默认卡只注入一次：标记写进 localStorage，用户删掉后不会复活
    if (localStorage.getItem(TYPE_MIGRATION_KEY)) return;

    contacts.forEach(function (contact) {
      const seed = DEFAULT_TYPED_CARDS[contact.id] || DEFAULT_TYPED_CARDS.general;
      if (!Array.isArray(store[contact.id])) store[contact.id] = [];

      const add = function (type, list, category) {
        (list || []).forEach(function (content) {
          store[contact.id].push({
            id: makeId(),
            content: content,
            category: category,
            keywords: [],
            scene: '',
            statusTag: [],
            type: type
          });
        });
      };

      add('quote', seed.quote, '情话');
      add('moment_post', seed.moment_post, '朋友圈文案');
      add('moment_reply', seed.moment_reply, '朋友圈评论');
    });

    try {
      localStorage.setItem(TYPE_MIGRATION_KEY, '1');
    } catch (error) {
      // 标记存不进去就下次再注入一次，无害
    }

    // 阶段 5.9：签名卡单独注入一次（5.8 时代的老库也能补上）
    if (!localStorage.getItem(SIGNATURE_MIGRATION_KEY)) {
      contacts.forEach(function (contact) {
        const seed = DEFAULT_TYPED_CARDS[contact.id] || DEFAULT_TYPED_CARDS.general;
        if (!Array.isArray(store[contact.id])) store[contact.id] = [];

        (seed.signature || DEFAULT_TYPED_CARDS.general.signature).forEach(function (content) {
          store[contact.id].push({
            id: makeId(),
            content: content,
            category: '签名',
            keywords: [],
            scene: '',
            statusTag: [],
            type: 'signature'
          });
        });
      });

      try {
        localStorage.setItem(SIGNATURE_MIGRATION_KEY, '1');
      } catch (error) {
        // 同上，无害
      }
    }
  }

  // ===== 5. 小工具 =====
  function getOwnerContact() {
    return window.MochiChat.getContactById(ownerId);
  }

  function getOwnerCards() {
    return store[ownerId] || [];
  }

  // 在所有联系人里找到某张字卡，返回 { ownerId, card }
  function findCard(cardId) {
    let result = null;
    contacts.forEach(function (contact) {
      (store[contact.id] || []).forEach(function (card) {
        if (card.id === cardId) result = { ownerId: contact.id, card: card };
      });
    });
    return result;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () {
      toast.hidden = true;
    }, 1800);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ===== 6. 渲染 =====

  // 6.1 两个联系人下拉框（页面顶部的「查看」和弹窗里的「分配给」）
  function renderOwnerSelects() {
    [libraryOwner, cardOwner].forEach(function (select) {
      const keepValue = select.value;
      select.innerHTML = '';
      contacts.forEach(function (contact) {
        const option = el('option', null, contact.name);
        option.value = contact.id;
        select.appendChild(option);
      });
      select.value = select === libraryOwner ? ownerId : keepValue;
    });

    cardOwner.value = editingCardId ? (findCard(editingCardId) || {}).ownerId : ownerId;
  }

  // 6.1b 阶段 5.8：类型过滤条（聊天 / 情话 / 朋友圈）
  function renderTypeBar() {
    if (!cardTypeBar) return;
    cardTypeBar.innerHTML = '';

    TYPE_FILTERS.forEach(function (filter) {
      const chip = el('button', 'category-chip type-chip', filter.label);
      chip.type = 'button';
      if (filter.id === currentType) chip.classList.add('active');
      chip.addEventListener('click', function () {
        currentType = filter.id;
        renderTypeBar();
        renderCards();
      });
      cardTypeBar.appendChild(chip);
    });
  }

  // 6.2 分类筛选按钮
  function renderCategories() {
    const cards = getOwnerCards();
    const categories = ['全部'];
    cards.forEach(function (card) {
      if (card.category && categories.indexOf(card.category) === -1) {
        categories.push(card.category);
      }
    });

    // 如果之前选的分类已经不存在了，就回到「全部」
    if (categories.indexOf(currentCategory) === -1) {
      currentCategory = '全部';
    }

    categoryBar.innerHTML = '';
    categories.forEach(function (name) {
      const chip = el('button', 'category-chip', name);
      chip.type = 'button';
      if (name === currentCategory) chip.classList.add('active');
      chip.addEventListener('click', function () {
        currentCategory = name;
        renderCards();
      });
      categoryBar.appendChild(chip);
    });

    // 分类候选（弹窗里输入分类时的下拉提示）
    // 阶段 5.9.2：各类型的默认分类永远出现在候选里，不依赖库里恰好有这类卡
    categoryOptions.innerHTML = '';
    Object.keys(TYPE_CATEGORY_DEFAULTS).forEach(function (type) {
      const name = TYPE_CATEGORY_DEFAULTS[type];
      if (categories.indexOf(name) === -1) categories.push(name);
    });
    categories.forEach(function (name) {
      if (name === '全部') return;
      const option = el('option', null, name);
      option.value = name;
      categoryOptions.appendChild(option);
    });
  }

  // 6.3 按类型 + 分类 + 搜索词过滤
  function getVisibleCards() {
    const keyword = cardSearch.value.trim().toLowerCase();
    const typeFilter = TYPE_FILTERS.filter(function (item) { return item.id === currentType; })[0] || TYPE_FILTERS[0];

    return getOwnerCards().filter(function (card) {
      // 类型筛选（chat 含没有 type 字段的旧卡）
      if (typeFilter.match && typeFilter.match.indexOf(cardTypeOf(card)) === -1) {
        return false;
      }
      // 分类筛选
      if (currentCategory !== '全部' && card.category !== currentCategory) {
        return false;
      }
      if (keyword === '') return true;

      // 搜索：内容、分类、关键词、适用场景、类型（含中文名）都能搜到
      const type = card.type || '';
      const haystack = [
        card.content,
        card.category,
        (card.keywords || []).join(' '),
        card.scene,
        type,
        TYPE_LABELS[type] || ''
      ].join(' ').toLowerCase();

      return haystack.indexOf(keyword) !== -1;
    });
  }

  // 6.4 字卡列表
  function renderCards() {
    const list = getVisibleCards();
    cardGrid.innerHTML = '';

    if (list.length === 0) {
      cardsEmpty.hidden = false;
    } else {
      cardsEmpty.hidden = true;
    }

    list.forEach(function (card) {
      const item = el('article', 'card-item');

      const top = el('div', 'card-item-top');
      top.appendChild(el('span', 'card-tag', card.category || '未分类'));
      // 阶段 5.8：非聊天卡显示类型小徽标（聊天卡不显示，避免满屏都是）
      const type = cardTypeOf(card);
      if (type !== 'chat') {
        top.appendChild(el('span', 'card-tag card-type-tag', TYPE_LABELS[type]));
      }
      const actions = el('div', 'card-actions');
      const editBtn = el('button', 'card-btn', '编辑');
      editBtn.type = 'button';
      editBtn.addEventListener('click', function () {
        openCardModal(card.id);
      });
      const delBtn = el('button', 'card-btn danger', '删除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () {
        askDelete(card.id);
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      top.appendChild(actions);
      item.appendChild(top);

      item.appendChild(el('p', 'card-content', card.content));

      const meta = el('div', 'card-meta');

      if (card.scene) {
        const sceneRow = el('div', 'card-row');
        sceneRow.appendChild(el('span', 'card-row-label', '场景'));
        sceneRow.appendChild(el('span', 'card-row-value', card.scene));
        meta.appendChild(sceneRow);
      }

      if (card.keywords && card.keywords.length > 0) {
        const keywordRow = el('div', 'card-row');
        keywordRow.appendChild(el('span', 'card-row-label', '关键词'));
        const tags = el('div', 'keyword-tags');
        card.keywords.forEach(function (word) {
          tags.appendChild(el('span', 'keyword-tag', word));
        });
        keywordRow.appendChild(tags);
        meta.appendChild(keywordRow);
      }

      item.appendChild(meta);
      cardGrid.appendChild(item);
    });
  }

  // 6.5 顶部说明文字 + 侧栏入口上的数量
  function renderHeaderInfo() {
    const contact = getOwnerContact();
    const count = getOwnerCards().length;
    cardsOwnerText.textContent = contact.name + ' · ' + count + ' 张字卡';

    const total = contacts.reduce(function (sum, item) {
      return sum + (store[item.id] || []).length;
    }, 0);
    openCardsBtn.textContent = '字卡库 ' + total;
  }

  // 一次性刷新整个字卡库
  function renderAll() {
    renderOwnerSelects();
    renderTypeBar();
    renderCategories();
    renderCards();
    renderHeaderInfo();
  }

  // ===== 7. 打开 / 关闭字卡库 =====
  function openLibrary(contactId) {
    ownerId = contactId || window.MochiChat.getCurrentContact().id;
    currentCategory = '全部';
    currentType = 'all';
    renderAll();
    app.classList.add('show-cards');
    // 手机上打开字卡库时先收起联系人栏
    app.classList.remove('show-sidebar');
  }

  function closeLibrary() {
    app.classList.remove('show-cards');
  }

  // ===== 8. 弹窗：新建 / 编辑 =====
  function openModal(modal) {
    modal.hidden = false;
  }

  function closeModal(modal) {
    modal.hidden = true;
  }

  function openCardModal(cardId) {
    editingCardId = cardId || null;

    if (editingCardId) {
      const found = findCard(editingCardId);
      const card = found.card;
      modalTitle.textContent = '编辑字卡';
      cardContent.value = card.content;
      cardCategory.value = card.category;
      cardKeywords.value = (card.keywords || []).join(', ');
      cardScene.value = card.scene;
      cardTypeSelect.value = cardTypeOf(card);
      cardOwner.value = found.ownerId;
    } else {
      modalTitle.textContent = '新建字卡';
      cardContent.value = '';
      cardCategory.value = '';
      cardKeywords.value = '';
      cardScene.value = '';
      cardTypeSelect.value = 'chat';
      cardOwner.value = ownerId;
    }

    openModal(cardModal);
    cardContent.focus();
  }

  function saveCard() {
    const content = cardContent.value.trim();
    if (content === '') {
      showToast('字卡内容不能为空哦');
      cardContent.focus();
      return;
    }

    const data = {
      content: content,
      // 阶段 5.9.2：分类为空时优先用该类型的默认分类（如签名 →「签名」），聊天卡保持「未分类」
      category: cardCategory.value.trim() || defaultCategoryFor(cardTypeSelect.value) || '未分类',
      keywords: cardKeywords.value
        .split(/[,，、\s]+/)
        .map(function (word) { return word.trim(); })
        .filter(function (word) { return word !== ''; }),
      scene: cardScene.value.trim(),
      // 阶段 5.8：类型跟着表单走，非法值一律按聊天字卡处理
      type: TYPE_LABELS[cardTypeSelect.value] ? cardTypeSelect.value : 'chat'
    };

    const newOwnerId = cardOwner.value;

    if (editingCardId) {
      const found = findCard(editingCardId);
      const oldList = store[found.ownerId];

      if (found.ownerId === newOwnerId) {
        // 还在同一个联系人名下，直接改内容
        Object.assign(found.card, data);
      } else {
        // 换了联系人：从原来的库里移除，加到新的库里（statusTag、type 跟着卡片走）
        store[found.ownerId] = oldList.filter(function (item) {
          return item.id !== editingCardId;
        });
        store[newOwnerId].push(Object.assign(
          { id: editingCardId, statusTag: found.card.statusTag || [], type: found.card.type || '' },
          data
        ));
      }
      ownerId = newOwnerId;
      showToast('字卡已更新');
    } else {
      data.id = makeId();
      store[newOwnerId].push(data);
      ownerId = newOwnerId;
      showToast('字卡已添加');
    }

    saveStore();
    closeModal(cardModal);
    editingCardId = null;
    renderAll();
  }

  // ===== 9. 删除 =====
  function askDelete(cardId) {
    const found = findCard(cardId);
    if (!found) return;

    pendingDelete = cardId;
    const preview = found.card.content.length > 20
      ? found.card.content.slice(0, 20) + '…'
      : found.card.content;
    confirmText.textContent = '确定要删除「' + preview + '」吗？删除后无法恢复。';
    openModal(confirmModal);
  }

  function doDelete() {
    if (!pendingDelete) return;

    const found = findCard(pendingDelete);
    if (found) {
      store[found.ownerId] = store[found.ownerId].filter(function (item) {
        return item.id !== pendingDelete;
      });
      saveStore();
      showToast('字卡已删除');
    }

    pendingDelete = null;
    closeModal(confirmModal);
    renderAll();
  }

  // ===== 10. 事件绑定 =====
  openCardsBtn.addEventListener('click', function () {
    openLibrary();
  });

  closeCardsBtn.addEventListener('click', closeLibrary);

  libraryOwner.addEventListener('change', function () {
    ownerId = libraryOwner.value;
    currentCategory = '全部';
    renderAll();
  });

  cardSearch.addEventListener('input', function () {
    renderCategories();
    renderCards();
  });

  newCardBtn.addEventListener('click', function () {
    openCardModal(null);
  });

  // 阶段 5.9.2：切类型时自动选中该类型的默认分类。
  // 只在分类为空、或是另一种类型的默认分类时替换，不覆盖用户自定义分类（如「安慰」）
  cardTypeSelect.addEventListener('change', function () {
    const next = defaultCategoryFor(cardTypeSelect.value);
    if (next === '') return;
    const current = cardCategory.value.trim();
    const isOtherDefault = Object.keys(TYPE_CATEGORY_DEFAULTS).some(function (type) {
      return type !== cardTypeSelect.value && TYPE_CATEGORY_DEFAULTS[type] === current;
    });
    if (current === '' || current === '未分类' || isOtherDefault) {
      cardCategory.value = next;
    }
  });

  cardForm.addEventListener('submit', function (event) {
    event.preventDefault();
    saveCard();
  });

  cancelCardBtn.addEventListener('click', function () {
    closeModal(cardModal);
    editingCardId = null;
  });

  cancelDeleteBtn.addEventListener('click', function () {
    pendingDelete = null;
    closeModal(confirmModal);
  });

  confirmDeleteBtn.addEventListener('click', doDelete);

  // 点遮罩关闭弹窗
  document.querySelectorAll('[data-close]').forEach(function (mask) {
    mask.addEventListener('click', function () {
      closeModal(cardModal);
      closeModal(confirmModal);
      editingCardId = null;
      pendingDelete = null;
    });
  });

  // Esc 关闭
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    closeModal(cardModal);
    closeModal(confirmModal);
    editingCardId = null;
    pendingDelete = null;
  });

  // ===== 11. 启动：读取已保存的数据 =====
  store = loadStore();
  migrateTypedCards(); // 阶段 5.8：旧卡补 type + 首次注入默认情话/朋友圈卡
  saveStore();
  ownerId = contacts[0].id;
  renderAll();

  // 给聊天界面用的小接口（以后想在聊天里插入字卡可以直接调用）
  window.MochiChatCards = {
    open: openLibrary,
    getCardsOf: function (contactId) {
      return store[contactId] || [];
    },

    // 阶段 5.8：只取聊天字卡 —— 聊天语义匹配必须排除情话 / 朋友圈卡，
    // 否则用户配一堆 quote 卡后，聊天回复会被无关文案污染
    getChatCardsOf: function (contactId) {
      return (store[contactId] || []).filter(function (card) {
        return !card.type || card.type === 'chat';
      });
    },

    // 阶段 4.1：批量导入专用。只做「按现有结构追加 + 复用 saveStore」，
    // 不改存储结构、不做分类、不做查重
    getOwnerId: function () {
      return ownerId;
    },
    addCards: function (contactId, list) {
      if (!Array.isArray(list) || list.length === 0) return 0;
      if (!Array.isArray(store[contactId])) store[contactId] = [];

      list.forEach(function (item) {
        store[contactId].push({
          id: makeId(),
          content: String(item.content).trim(),
          category: item.category || '未分类',
          keywords: Array.isArray(item.keywords) ? item.keywords : [],
          scene: item.scene || '',
          // 阶段 5.6：导入时保留状态标签（缺省为空数组，表示不限状态）
          statusTag: Array.isArray(item.statusTag) ? item.statusTag.map(String) : [],
          // 阶段 5.8：保留类型标记；没写 type 的一律按聊天字卡导入
          type: (typeof item.type === 'string' && TYPE_LABELS[item.type]) ? item.type : 'chat'
        });
      });

      saveStore();
      renderAll();
      showToast('已导入 ' + list.length + ' 张字卡');
      return list.length;
    }
  };
})();

// =======================================================
// Mochi Chat · 多联系人聊天（第一阶段：本地数据版）
// =======================================================

// ===== 1. 联系人数据 =====
// 每个联系人都是一个独立的对象，拥有自己的 id / 名字 / 头像 / 状态 / 聊天记录
// 以后想加联系人，只要在这个数组里再复制一份对象、改改内容就可以了。
const contacts = [
  {
    id: 'mochi',
    name: '小麻薯',
    avatar: '麻',
    avatarColor: 'pink',   // 对应 style.css 里的 .avatar-pink
    status: '在线',
    online: true,
    // 阶段 5.6：动态状态（current 指向 DEFAULT_STATUSES 或 customStatuses 里的 id）
    statusConfig: { current: 'online', customStatuses: [], schedule: [] },
    spaceConfig: { background: 'default', nickname: '小麻薯' }, // 阶段 5.1：空间配置
    messages: [
      { from: 'them', text: '你好呀，我是小麻薯，很高兴认识你 (｡•ᴗ-)♪' },
      { from: 'me',   text: '你好！今天过得怎么样？' },
      { from: 'them', text: '还不错呢，刚刚吃了一块草莓大福～' }
    ]
  },
  {
    id: 'rabbit',
    name: '奶油兔',
    avatar: '兔',
    avatarColor: 'blue',   // 对应 .avatar-blue
    status: '忙碌',
    online: true,
    statusConfig: { current: 'busy', customStatuses: [], schedule: [] },
    spaceConfig: { background: 'default', nickname: '奶油兔' },
    messages: [
      { from: 'them', text: '在的吗？我发现一家超可爱的甜品店！' },
      { from: 'me',   text: '在哪里呀？周末一起去～' }
    ]
  },
  {
    id: 'bear',
    name: '蓝莓熊',
    avatar: '熊',
    avatarColor: 'mint',   // 对应 .avatar-mint
    status: '离开',
    online: false,
    statusConfig: { current: 'away', customStatuses: [], schedule: [] },
    spaceConfig: { background: 'default', nickname: '蓝莓熊' },
    messages: [
      { from: 'them', text: '我睡一会儿，醒来再找你聊天。' }
    ]
  }
];

// =====================================================================
// 阶段 5.10：自定义联系人（新建出来的）持久化
// 只存身份壳：id / 昵称 / 头像 / 颜色；空间配置、状态、朋友圈各自有自己的存储键
// =====================================================================
const CUSTOM_CONTACTS_KEY = 'mochi-chat-contacts-v1';
const BASE_CONTACT_IDS = ['mochi', 'rabbit', 'bear'];
const AVATAR_COLORS = ['pink', 'blue', 'mint'];
const RANDOM_AVATAR_EMOJIS = ['🐱', '🐶', '🐰', '🐻', '🐼', '🦊', '🐨', '🐧', '🍡', '🌙'];

function loadCustomContacts() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_CONTACTS_KEY) || '[]');
    if (!Array.isArray(raw)) return;
    raw.forEach(function (item) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return;
      if (item.id === '' || item.name.trim() === '') return;
      // 已经存在（内置或重复恢复）就跳过
      if (contacts.some(function (contact) { return contact.id === item.id; })) return;

      contacts.push({
        id: item.id,
        name: item.name.trim().slice(0, 20),
        avatar: typeof item.avatar === 'string' ? item.avatar : '',
        avatarColor: AVATAR_COLORS.indexOf(item.avatarColor) !== -1 ? item.avatarColor : 'pink',
        status: '在线',
        online: true,
        statusConfig: { current: 'online', customStatuses: [], schedule: [] },
        spaceConfig: defaultSpaceConfig({ name: item.name.trim().slice(0, 20) }),
        messages: []
      });
    });
  } catch (error) {
    // 读不到就当没有自定义联系人，不影响内置三位
  }
}

function saveCustomContacts() {
  try {
    const list = contacts
      .filter(function (contact) { return BASE_CONTACT_IDS.indexOf(contact.id) === -1; })
      .map(function (contact) {
        return {
          id: contact.id,
          name: contact.name,
          avatar: contact.avatar,
          avatarColor: contact.avatarColor
        };
      });
    localStorage.setItem(CUSTOM_CONTACTS_KEY, JSON.stringify(list));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

// 先恢复，后面所有按联系人遍历的读档（背景 / 状态 / 朋友圈）才能带上新联系人
loadCustomContacts();

// =====================================================================
// 阶段 5.6：联系人动态状态（在线 / 忙碌 / 离开 / 睡觉 + 自定义 + 时间规则）
// 状态存在 contact.statusConfig 里，单独持久化到 localStorage
// =====================================================================
const STATUS_STORAGE_KEY = 'mochi-chat-status-v1';

// 四个内置状态：id 稳定，color 用于圆点，其余是阶段 5.6.2 的回复行为内置默认
// busy 默认慢回复；away 默认不回复（概率 0，可在设置里调）
const DEFAULT_STATUSES = [
  { id: 'online',   label: '在线', color: '#6FD39A', replyDelay: 0,    replyProbability: 1, matchWeight: 1.4, missPenalty: 0.85, sleepingPenalty: 0.15 },
  { id: 'busy',     label: '忙碌', color: '#F2686B', replyDelay: 3000, replyProbability: 1, matchWeight: 1.4, missPenalty: 0.85, sleepingPenalty: 0.15 },
  { id: 'away',     label: '离开', color: '#F2C14E', replyDelay: 0,    replyProbability: 0, matchWeight: 1.4, missPenalty: 0.85, sleepingPenalty: 0.15 },
  { id: 'sleeping', label: '睡觉', color: '#A88BEA', replyDelay: 0,    replyProbability: 1, matchWeight: 1.4, missPenalty: 0.85, sleepingPenalty: 0.15 }
];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || ''));
}

function makeStatusId() {
  return 'custom-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000);
}

function timeToMinutes(value) {
  if (!TIME_PATTERN.test(String(value || ''))) return null;
  const parts = String(value).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

// 该联系人可用的全部状态：内置在前，自定义在后
function getStatusesOf(contact) {
  const config = contact && contact.statusConfig;
  const custom = (config && Array.isArray(config.customStatuses)) ? config.customStatuses : [];
  return DEFAULT_STATUSES.concat(custom);
}

function findStatusOf(contact, statusId) {
  const list = getStatusesOf(contact);
  const found = list.filter(function (item) { return item.id === statusId; })[0];
  return found || list[0];
}

// 状态 → 旧字段（contact.status / contact.online），让旧代码与调试面板不崩
function syncLegacyStatusFields(contact) {
  const status = findStatusOf(contact, contact.statusConfig.current);
  contact.status = status.label;
  contact.online = status.id !== 'sleeping' && status.id !== 'away';
  return status;
}

// 阶段 5.6.2：状态的回复行为。旧数据缺字段时自动补齐默认值（0 / 1 / 1.4）
function normalizeStatusBehavior(raw, fallback) {
  const base = fallback || {};
  const data = (raw && typeof raw === 'object') ? raw : {};
  function numOr(value, fallbackValue) {
    const n = Number(value);
    return isFinite(n) ? n : fallbackValue;
  }
  return {
    replyDelay: Math.min(30000, Math.max(0, Math.round(numOr(data.replyDelay, numOr(base.replyDelay, 0))))),
    replyProbability: Math.min(1, Math.max(0, numOr(data.replyProbability, numOr(base.replyProbability, 1)))),
    matchWeight: Math.min(3, Math.max(0.1, numOr(data.matchWeight, numOr(base.matchWeight, 1.4)))),
    missPenalty: Math.min(1, Math.max(0, numOr(data.missPenalty, numOr(base.missPenalty, 0.85)))),
    sleepingPenalty: Math.min(1, Math.max(0, numOr(data.sleepingPenalty, numOr(base.sleepingPenalty, 0.15))))
  };
}

function normalizeStatusConfig(contact) {
  const raw = (contact.statusConfig && typeof contact.statusConfig === 'object') ? contact.statusConfig : {};

  const customStatuses = [];
  (Array.isArray(raw.customStatuses) ? raw.customStatuses : []).forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    const label = String(item.label || '').trim();
    if (label === '') return;
    const id = (typeof item.id === 'string' && item.id.indexOf('custom-') === 0) ? item.id : makeStatusId();
    if (customStatuses.some(function (status) { return status.id === id; })) return;

    const status = {
      id: id,
      label: label.slice(0, 10),
      color: isHexColor(item.color) ? String(item.color) : '#7FC8F8'
    };
    // 阶段 5.6.2：行为字段平铺在自定义状态对象上，旧数据自动补默认值
    Object.assign(status, normalizeStatusBehavior(item, null));
    customStatuses.push(status);
  });

  const allIds = DEFAULT_STATUSES.map(function (status) { return status.id; })
    .concat(customStatuses.map(function (status) { return status.id; }));
  const current = allIds.indexOf(raw.current) !== -1 ? raw.current : 'online';

  // 时间规则：非法条目直接丢弃，避免坏数据让定时器空转
  const schedule = [];
  (Array.isArray(raw.schedule) ? raw.schedule : []).forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    const start = String(item.start || '');
    const end = String(item.end || '');
    if (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) return;
    if (allIds.indexOf(item.statusId) === -1) return;
    schedule.push({ start: start, end: end, statusId: item.statusId });
  });

  // 阶段 5.6.2：预设状态的参数改动存在 overrides 里（内置常量本身不可变）
  const rawOverrides = (raw.overrides && typeof raw.overrides === 'object') ? raw.overrides : {};
  const overrides = {};
  DEFAULT_STATUSES.forEach(function (status) {
    if (rawOverrides[status.id]) {
      overrides[status.id] = normalizeStatusBehavior(rawOverrides[status.id], status);
    }
  });

  contact.statusConfig = {
    current: current,
    customStatuses: customStatuses,
    schedule: schedule,
    overrides: overrides,
    autoStatusId: allIds.indexOf(raw.autoStatusId) !== -1 ? raw.autoStatusId : ''
  };
  syncLegacyStatusFields(contact);
  return contact.statusConfig;
}

// 取某个状态的回复行为：预设先看 overrides，其次内置默认；自定义直接读对象字段
// 不传 statusId 时取该联系人「当前」状态的行为
function getStatusBehaviorOf(contact, statusId) {
  if (!contact) return normalizeStatusBehavior(null, null);
  const config = (contact.statusConfig && typeof contact.statusConfig === 'object') ? contact.statusConfig : {};
  const wanted = (typeof statusId === 'string' && statusId !== '') ? statusId : config.current;
  const status = findStatusOf(contact, wanted);
  if (!status) return normalizeStatusBehavior(null, null);

  const override = (config.overrides && config.overrides[status.id]) || null;
  return normalizeStatusBehavior(override, status);
}

// 修改某个状态的回复行为（预设写 overrides，自定义写自己的字段）
function updateStatusBehavior(statusId, patch) {
  const contact = getContactById(currentId);
  if (!contact) return null;

  const config = normalizeStatusConfig(contact);
  const status = findStatusOf(contact, statusId);
  if (!status || status.id !== statusId) return null;

  const merged = normalizeStatusBehavior(
    Object.assign(getStatusBehaviorOf(contact, statusId), patch || {}),
    status
  );

  if (statusId.indexOf('custom-') === 0) {
    config.customStatuses.forEach(function (item) {
      if (item.id === statusId) Object.assign(item, merged);
    });
  } else {
    config.overrides[statusId] = merged;
  }

  saveStatusConfigs();
  return merged;
}

function loadStatusConfigs() {
  contacts.forEach(normalizeStatusConfig);

  try {
    const saved = JSON.parse(localStorage.getItem(STATUS_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;

    contacts.forEach(function (contact) {
      const item = saved[contact.id];
      if (!item || typeof item !== 'object') return;
      contact.statusConfig = {
        current: item.current,
        customStatuses: item.customStatuses,
        schedule: item.schedule,
        overrides: item.overrides,
        autoStatusId: item.autoStatusId
      };
      normalizeStatusConfig(contact);
    });
  } catch (error) {
    // 读不到或格式坏了就用默认状态，不影响聊天
  }
}

function saveStatusConfigs() {
  try {
    const data = {};
    contacts.forEach(function (contact) {
      const config = normalizeStatusConfig(contact);
      data[contact.id] = {
        current: config.current,
        customStatuses: config.customStatuses,
        schedule: config.schedule,
        overrides: config.overrides,
        autoStatusId: config.autoStatusId
      };
    });
    localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

// 对外：当前状态的 id / 文案 / 颜色
function getStatusOf(contactId) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return { id: 'online', label: '在线', color: '#6FD39A' };
  const status = syncLegacyStatusFields(contact);
  return { id: status.id, label: status.label, color: status.color };
}

function setContactStatus(contactId, statusId, options) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;
  const config = normalizeStatusConfig(contact);
  const target = findStatusOf(contact, statusId);

  config.current = target.id;
  // 手动选择会清掉「自动切换」标记，避免定时器把用户的选择改回去
  config.autoStatusId = (options && options.auto) ? target.id : '';
  syncLegacyStatusFields(contact);
  saveStatusConfigs();
  refreshStatusViews();
  return target;
}

// 时间规则命中判断：支持跨午夜（23:00 → 07:00）
function matchStatusSchedule(schedule, date) {
  const now = date instanceof Date ? date : new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  for (let i = 0; i < schedule.length; i++) {
    const rule = schedule[i];
    const start = timeToMinutes(rule.start);
    const end = timeToMinutes(rule.end);
    if (start === null || end === null || start === end) continue;

    const hit = start < end
      ? (minutes >= start && minutes < end)
      : (minutes >= start || minutes < end);
    if (hit) return rule.statusId;
  }
  return '';
}

// 每分钟跑一次：命中规则就切过去；离开区间后只回落「自动切过去」的那个状态
function runStatusSchedule(date) {
  let changed = false;

  contacts.forEach(function (contact) {
    const config = normalizeStatusConfig(contact);
    const targetId = matchStatusSchedule(config.schedule, date);

    if (targetId !== '') {
      if (config.current !== targetId) {
        config.current = targetId;
        config.autoStatusId = targetId;
        changed = true;
      }
      return;
    }

    if (config.autoStatusId && config.current === config.autoStatusId) {
      config.current = 'online';
      config.autoStatusId = '';
      changed = true;
    }
  });

  if (changed) {
    contacts.forEach(syncLegacyStatusFields);
    saveStatusConfigs();
    refreshStatusViews();
  }
  return changed;
}

function startStatusScheduler() {
  runStatusSchedule();
  setInterval(function () {
    runStatusSchedule();
  }, 60 * 1000);
}

// 只重刷状态相关的 UI，不重绘消息（避免定时器把滚动位置打乱）
function refreshStatusViews() {
  if (typeof renderContactList === 'function') renderContactList();
  if (typeof renderHeader === 'function') renderHeader();
  if (typeof renderStatusPanel === 'function') renderStatusPanel();
}

// 自定义状态：添加 / 删除（创建时可以带回复行为，缺省用滑块当前值补齐）
function addCustomStatus(label, color, behavior) {
  const contact = getContactById(currentId);
  if (!contact) return null;
  const text = String(label || '').trim().slice(0, 10);
  if (text === '') return null;

  const config = normalizeStatusConfig(contact);
  const status = {
    id: makeStatusId(),
    label: text,
    color: isHexColor(color) ? String(color) : '#7FC8F8'
  };
  Object.assign(status, normalizeStatusBehavior(behavior || {}, null));
  config.customStatuses.push(status);
  saveStatusConfigs();
  refreshStatusViews();
  return status;
}

function removeCustomStatus(statusId) {
  const contact = getContactById(currentId);
  if (!contact) return false;

  const config = normalizeStatusConfig(contact);
  const before = config.customStatuses.length;
  config.customStatuses = config.customStatuses.filter(function (status) {
    return status.id !== statusId;
  });
  if (config.customStatuses.length === before) return false;

  // 正在使用 / 被规则引用的自定义状态被删掉后，回退到在线
  if (config.current === statusId) config.current = 'online';
  if (config.autoStatusId === statusId) config.autoStatusId = '';
  config.schedule = config.schedule.filter(function (rule) {
    return rule.statusId !== statusId;
  });

  saveStatusConfigs();
  refreshStatusViews();
  return true;
}

function addStatusSchedule(start, end, statusId) {
  const contact = getContactById(currentId);
  if (!contact) return null;
  if (!TIME_PATTERN.test(String(start || '')) || !TIME_PATTERN.test(String(end || ''))) return null;
  if (timeToMinutes(start) === timeToMinutes(end)) return null;

  const config = normalizeStatusConfig(contact);
  if (!findStatusOf(contact, statusId)) return null;

  const rule = { start: String(start), end: String(end), statusId: String(statusId) };
  config.schedule.push(rule);
  saveStatusConfigs();
  runStatusSchedule();
  refreshStatusViews();
  return rule;
}

function removeStatusSchedule(index) {
  const contact = getContactById(currentId);
  if (!contact) return false;

  const config = normalizeStatusConfig(contact);
  if (index < 0 || index >= config.schedule.length) return false;
  config.schedule.splice(index, 1);
  saveStatusConfigs();
  runStatusSchedule();
  refreshStatusViews();
  return true;
}

// 当前正在聊天的联系人 id（页面刚打开时默认选第一个）
let currentId = contacts[0].id;

// ===== 2. 页面元素 =====
const contactList = document.getElementById('contactList');
const messagesBox = document.getElementById('messages');
const input = document.getElementById('input');
const form = document.getElementById('composer');
const app = document.querySelector('.app');
const backBtn = document.getElementById('backBtn');
const spaceBg = document.getElementById('spaceBg');
const spaceVeil = document.getElementById('spaceVeil');
const spaceBgOptions = document.getElementById('spaceBgOptions');
const chatAvatar = document.getElementById('chatAvatar');
const chatName = document.getElementById('chatName');
const chatStatus = document.getElementById('chatStatus');
const meAvatarNode = document.getElementById('meAvatar');
const meNameNode = document.getElementById('meName');

// 阶段 5.6：角色状态相关控件
const statusTargetName = document.getElementById('statusTargetName');
const statusCurrentSelect = document.getElementById('statusCurrentSelect');
const statusCustomLabel = document.getElementById('statusCustomLabel');
const statusCustomColor = document.getElementById('statusCustomColor');
const statusCustomAddBtn = document.getElementById('statusCustomAddBtn');
const statusCustomList = document.getElementById('statusCustomList');
const statusScheduleStart = document.getElementById('statusScheduleStart');
const statusScheduleEnd = document.getElementById('statusScheduleEnd');
const statusScheduleStatus = document.getElementById('statusScheduleStatus');
const statusScheduleAddBtn = document.getElementById('statusScheduleAddBtn');
const statusScheduleList = document.getElementById('statusScheduleList');
// 阶段 5.6.2：回复行为滑块
const statusDelayInput = document.getElementById('statusDelayInput');
const statusDelayValue = document.getElementById('statusDelayValue');
const statusProbInput = document.getElementById('statusProbInput');
const statusProbValue = document.getElementById('statusProbValue');
const statusWeightInput = document.getElementById('statusWeightInput');
const statusWeightValue = document.getElementById('statusWeightValue');

// 阶段 5.7：朋友圈面板
const momentsPanel = document.getElementById('momentsPanel');
const momentsCover = document.getElementById('momentsCover');
const momentsCloseBtn = document.getElementById('momentsCloseBtn');
const momentsPublishBtn = document.getElementById('momentsPublishBtn');
const momentsAvatar = document.getElementById('momentsAvatar');
const momentsName = document.getElementById('momentsName');
const momentsSignature = document.getElementById('momentsSignature');
const momentsCompose = document.getElementById('momentsCompose');
const momentsComposeText = document.getElementById('momentsComposeText');
const momentsComposeCount = document.getElementById('momentsComposeCount');
const momentsComposeCancel = document.getElementById('momentsComposeCancel');
const momentsComposeSubmit = document.getElementById('momentsComposeSubmit');
const momentsList = document.getElementById('momentsList');
// 阶段 5.9：封面更换 + 互评开关
const momentsCoverBtn = document.getElementById('momentsCoverBtn');
const momentsCoverInput = document.getElementById('momentsCoverInput');
const momentsCrossInput = document.getElementById('momentsCrossInput');

// 阶段 5.7.2：朋友圈互动设置
const momentsTargetName = document.getElementById('momentsTargetName');
const momentsAutoPostInput = document.getElementById('momentsAutoPostInput');
const momentsAutoPostValue = document.getElementById('momentsAutoPostValue');
const momentsAutoPostHint = document.getElementById('momentsAutoPostHint');
const momentsLikeInput = document.getElementById('momentsLikeInput');
const momentsLikeValue = document.getElementById('momentsLikeValue');
const momentsCommentInput = document.getElementById('momentsCommentInput');
const momentsCommentValue = document.getElementById('momentsCommentValue');
const momentsTestPostBtn = document.getElementById('momentsTestPostBtn');

// ===== 3. 自动回复 =====
// 不再使用固定示例回复，改为从「当前联系人自己的字卡库」里智能匹配
// 匹配规则写在 matcher.js 里，默认回复也单独放在那里
// ===== 4. 小工具 =====
// 创建一个元素：el('div', 'bubble', '文字')
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 根据 id 找到对应的联系人对象
function getContactById(id) {
  return contacts.find(function (contact) {
    return contact.id === id;
  });
}

// ===== 4.5 基础资料：「我」与联系人的头像 / 昵称（阶段 5.5）=====
const ME_STORAGE_KEY = 'mochi-chat-me-v1';
const meProfile = { name: '我', avatar: '' };

function isImageAvatar(value) {
  return typeof value === 'string' && value.indexOf('data:image/') === 0;
}

// 头像是图片就铺 background-image，否则回落到文字
function applyAvatar(node, avatar, fallbackText, baseClass) {
  if (!node) return node;
  const base = baseClass || 'avatar';
  if (isImageAvatar(avatar)) {
    node.className = base + ' has-image';
    node.style.backgroundImage = 'url("' + avatar + '")';
    node.textContent = '';
  } else {
    node.className = base;
    node.style.backgroundImage = '';
    node.textContent = avatar || fallbackText || '';
  }
  return node;
}

function firstChar(text) {
  return String(text || '').trim().charAt(0) || '?';
}

function loadMeProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(ME_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return;
    if (typeof raw.name === 'string' && raw.name.trim() !== '') {
      meProfile.name = raw.name.trim().slice(0, 20);
    }
    if (isImageAvatar(raw.avatar)) meProfile.avatar = raw.avatar;
  } catch (error) {
    // 读不到就用默认资料
  }
}

function saveMeProfile() {
  try {
    localStorage.setItem(ME_STORAGE_KEY, JSON.stringify(meProfile));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

// 侧栏底部的「我」+ 设置里的预览
function renderMeProfile() {
  applyAvatar(meAvatarNode, meProfile.avatar, '我', 'me-avatar');
  if (meNameNode) meNameNode.textContent = meProfile.name || '我的账号';
  const preview = document.getElementById('meAvatarPreview');
  if (preview) applyAvatar(preview, meProfile.avatar, '我', 'avatar avatar-me');
}

// 取某个联系人的最后一条消息，用于左侧列表的预览文字
function getLastMessageText(contact) {
  if (contact.messages.length === 0) {
    return '还没有聊天记录';
  }
  const last = contact.messages[contact.messages.length - 1];
  const prefix = last.from === 'me' ? '我：' : '';
  return prefix + last.text;
}

// ===== 5. 渲染（把数据变成页面上的内容）=====

// 5.1 渲染左侧联系人列表
function renderContactList() {
  contactList.innerHTML = '';

  contacts.forEach(function (contact) {
    const li = el('li', 'contact');
    // 当前聊天的联系人加上 active 高亮样式
    if (contact.id === currentId) {
      li.classList.add('active');
    }
    li.dataset.id = contact.id;

    const avatar = applyAvatar(
      el('div'),
      contact.avatar,
      firstChar(contact.name),
      'avatar avatar-' + contact.avatarColor
    );

    const info = el('div', 'contact-info');
    // 阶段 5.6：名字后面跟状态圆点 + 文案，颜色取当前状态
    const status = getStatusOf(contact.id);
    const nameRow = el('span', 'contact-name', contact.name);
    const dot = el('i', 'contact-status-dot');
    dot.style.background = status.color;
    nameRow.appendChild(dot);
    nameRow.appendChild(el('em', 'contact-status-text', status.label));
    info.appendChild(nameRow);
    info.appendChild(el('span', 'contact-msg', getLastMessageText(contact)));

    li.appendChild(avatar);
    li.appendChild(info);

    // 点击就「进入」这个联系人的空间（阶段 5.1）
    li.addEventListener('click', function () {
      enterSpace(contact.id);
    });

    contactList.appendChild(li);
  });
}

// 5.2 渲染顶部信息（头像、名字、在线状态）
function renderHeader() {
  const contact = getContactById(currentId);

  applyAvatar(chatAvatar, contact.avatar, firstChar(contact.name), 'avatar avatar-' + contact.avatarColor);
  chatName.textContent = contact.name;

  // 阶段 5.6：状态文案 + 圆点颜色都取 statusConfig.current
  const status = getStatusOf(contact.id);
  chatStatus.style.setProperty('--status-color', status.color);
  chatStatus.dataset.status = status.id;
  chatStatus.classList.remove('is-online', 'is-offline');
  chatStatus.classList.add(status.id === 'sleeping' ? 'is-offline' : 'is-online');

  // 阶段 5.6.2：「正在输入…」/「已读」是临时态，优先级高于状态文案
  if (typingContacts.has(contact.id)) {
    chatStatus.textContent = '正在输入…';
  } else if (readContacts.has(contact.id)) {
    chatStatus.textContent = '已读';
  } else {
    chatStatus.textContent = status.label;
  }
}

// 5.3 渲染聊天窗口的消息
function renderMessages() {
  const contact = getContactById(currentId);
  messagesBox.innerHTML = '';

  messagesBox.appendChild(el('div', 'time-tip', '今天'));

  if (contact.messages.length === 0) {
    messagesBox.appendChild(el('div', 'empty-tip', '还没有消息，和 ' + contact.name + ' 打个招呼吧～'));
  }

  contact.messages.forEach(function (message) {
    const isMe = message.from === 'me';
    const row = el('div', 'msg ' + (isMe ? 'msg-me' : 'msg-them'));
    // 杂志采访模式用的发言者标签（气泡模式下由 CSS 隐藏，不再带【】括号）
    const speaker = el('span', 'speaker', isMe ? (meProfile.name || '我') : contact.name);
    const bubble = el('div', 'bubble', message.text);

    if (isMe) {
      row.appendChild(speaker);
      row.appendChild(bubble);
      row.appendChild(applyAvatar(el('div'), meProfile.avatar, '我', 'avatar avatar-me'));
    } else {
      row.appendChild(applyAvatar(
        el('div'),
        contact.avatar,
        firstChar(contact.name),
        'avatar avatar-' + contact.avatarColor
      ));
      row.appendChild(speaker);
      row.appendChild(bubble);
    }

    messagesBox.appendChild(row);
  });

  // 阶段 5.6.2：等待回复期间，末尾挂一个「正在输入」的三点气泡
  if (typingContacts.has(contact.id)) {
    const row = el('div', 'msg msg-them');
    row.appendChild(applyAvatar(
      el('div'),
      contact.avatar,
      firstChar(contact.name),
      'avatar avatar-' + contact.avatarColor
    ));
    const bubble = el('div', 'bubble typing-bubble');
    bubble.appendChild(el('span', 'typing-dot'));
    bubble.appendChild(el('span', 'typing-dot'));
    bubble.appendChild(el('span', 'typing-dot'));
    row.appendChild(bubble);
    messagesBox.appendChild(row);
  }

  scrollToBottom();
}

// 一次性刷新整个界面（列表 + 顶部 + 消息）
function renderAll() {
  renderContactList();
  renderHeader();
  renderMessages();
}

// 让聊天窗口滚动到最新消息
function scrollToBottom() {
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

// ===== 6. 切换联系人 =====
function selectContact(id) {
  currentId = id;
  renderAll();

  // 手机端选完联系人后自动收起侧栏
  app.classList.remove('show-sidebar');
  // 阶段 5.6：设置面板开着时，状态区跟着切到新联系人
  if (!settingsPanel.hidden) renderStatusPanel();
  // 阶段 5.7.2：切换联系人时给一次自动发圈机会（有 1 小时冷却，不会刷屏）
  maybeAutoPostMoment(getContactById(id));
  input.focus();
}

// ===== 7. 发送消息 =====
// 阶段 5.6.2：回复行为的临时 UI 态（正在输入 / 已读），不写入聊天记录
const typingContacts = new Set();
const readContacts = new Set();
const typingTimers = {};
const readTimers = {};
const BASE_REPLY_DELAY = 600; // 没有延迟设置时的自然反应时间

function setTyping(contactId, on) {
  if (on) typingContacts.add(contactId);
  else typingContacts.delete(contactId);

  clearTimeout(typingTimers[contactId]);
  if (on) {
    // 兜底：万一回调被卡住，60 秒后也会自己消失
    typingTimers[contactId] = setTimeout(function () {
      typingContacts.delete(contactId);
      renderHeader();
      renderMessages();
    }, 60 * 1000);
  }

  if (contactId === currentId) {
    renderHeader();
    renderMessages();
  }
}

function markContactRead(contactId) {
  readContacts.add(contactId);
  clearTimeout(readTimers[contactId]);
  readTimers[contactId] = setTimeout(function () {
    readContacts.delete(contactId);
    renderHeader();
  }, 1800);
  if (contactId === currentId) renderHeader();
}

// 概率拦截时把原因写进调试面板（不触发匹配，避免顺手发起向量请求）
function renderNoReplyDebug(contact, behavior) {
  const panel = document.getElementById('debugPanel');
  const body = document.getElementById('debugBody');
  if (!panel || !body) return;

  body.innerHTML = '';
  function row(label, value) {
    const line = el('div', 'debug-row');
    line.appendChild(el('span', 'debug-label', label));
    line.appendChild(el('span', 'debug-value debug-value--miss', value));
    body.appendChild(line);
  }

  row('匹配结果', '未回复（回复概率拦截）');
  row('角色状态', contact.status);
  row('回复概率', Math.round(behavior.replyProbability * 100) + '%');
  panel.classList.remove('is-empty');
}

function sendMessage() {
  const text = input.value.trim();

  // 空消息不发送
  if (text === '') {
    input.focus();
    return;
  }

  // 记住“此刻”正在聊的联系人，避免等待回复期间切走联系人导致消息跑错
  const targetId = currentId;
  const contact = getContactById(targetId);

  // 只保存到当前联系人的聊天记录里
  contact.messages.push({ from: 'me', text: text });

  input.value = '';
  renderAll();

  // 阶段 5.6.2：是否回复、隔多久回复，由对方此刻的状态决定
  const behavior = getStatusBehaviorOf(contact);
  if (Math.random() >= behavior.replyProbability) {
    // 没抽中：不触发字卡匹配，顶部短暂显示「已读」
    markContactRead(targetId);
    renderNoReplyDebug(contact, behavior);
    return;
  }

  // 延迟一会儿回复，看起来更像真的在聊天（状态可以加长这段等待）
  setTyping(targetId, true);
  const replyDelay = Math.max(BASE_REPLY_DELAY, behavior.replyDelay || 0);
  setTimeout(function () {
    setTyping(targetId, false);

    // 只在「发送时那个联系人」自己的字卡库里匹配
    const result = window.MochiChatMatcher.match(targetId, text);
    contact.messages.push({ from: 'them', text: result.reply });

    // 更新调试信息区域
    window.MochiChatMatcher.renderDebug(result);

    renderAll();
  }, replyDelay);
}

// 点击「发送」按钮
form.addEventListener('submit', function (event) {
  event.preventDefault(); // 阻止页面刷新
  sendMessage();
});

// 按回车也能发送
input.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

// ===== 8. 手机端显示 / 隐藏联系人栏 =====
backBtn.addEventListener('click', function () {
  app.classList.toggle('show-sidebar');
});

// ===== 9. 调试面板：收起 / 展开 =====
const debugPanel = document.getElementById('debugPanel');
const debugToggle = document.getElementById('debugToggle');

debugToggle.addEventListener('click', function () {
  const collapsed = debugPanel.classList.toggle('is-collapsed');
  debugToggle.textContent = collapsed ? '展开' : '收起';
});

// ===== 9.5 空间模式（阶段 5.1：角色空间入口）=====
// 背景只用 CSS 渐变，不引入图片、不新增依赖
const SPACE_STORAGE_KEY = 'mochi-chat-space-v1';
const SPACE_BACKGROUNDS = [
  { id: 'default', label: '暮色绒雾', color: 'radial-gradient(120% 100% at 18% 0%, #4A3560 0%, #2A2140 46%, #171223 100%)' },
  { id: 'night',   label: '夜色深空', color: 'radial-gradient(120% 100% at 80% 0%, #23305E 0%, #161B38 50%, #0B0D1C 100%)' },
  { id: 'mint',    label: '深海薄荷', color: 'radial-gradient(120% 100% at 30% 0%, #1C5B4E 0%, #113A34 50%, #08201E 100%)' }
];

// 阶段 5.5.5：两个滑块统一用 0-100 的整数百分比存储
function toPercent(value, fallback) {
  const num = Number(value);
  if (!isFinite(num)) return fallback;
  return Math.min(100, Math.max(0, Math.round(num)));
}

// 旧版存的是 0~1 的小数（没有 opacityUnit 标记），读档时换算成百分比
function readOpacity(value, legacy, fallback) {
  const num = Number(value);
  if (!isFinite(num)) return fallback;
  return toPercent(legacy && num <= 1 ? num * 100 : num, fallback);
}

// 阶段 5.5.6：滑块 0-100 是「不透明度」——0 = 完全透明，100 = 实心
// rgba / opacity 要的是 alpha，所以这里把「透明度」反回来：1 - (100 - 值) / 100
// 等价于 值 / 100，但写成反转透明度的形式，避免以后又把方向写反
function percentToAlpha(percent) {
  const p = Number(percent);
  if (!isFinite(p)) return 0.65;
  return 1 - (100 - Math.min(100, Math.max(0, p))) / 100;
}

function clampBgOpacity(value) {
  return toPercent(value, 0);
}

function clampPanelOpacity(value) {
  return toPercent(value, 65);
}

// 阶段 5.7.2：朋友圈互动概率（0-100 的整数百分比），每个联系人独立
function normalizeMomentsConfig(raw) {
  const data = (raw && typeof raw === 'object') ? raw : {};
  return {
    autoPostChance: toPercent(data.autoPostChance, 30),   // 每小时自动发一条的概率
    likeChance: toPercent(data.likeChance, 80),
    commentChance: toPercent(data.commentChance, 50),
    lastAutoPostAt: Number(data.lastAutoPostAt) || 0,     // 冷却用：上次自动发圈的时间
    // 阶段 5.9：我发动态时，允不允许其他角色也来点赞 / 评论（默认允许）
    enableCrossInteraction: data.enableCrossInteraction !== false
  };
}

function defaultSpaceConfig(contact) {
  return {
    background: 'default',
    nickname: contact.name,
    // 桌面这层「底」的不透明度：0 = 完全透明（壁纸清晰），100 = 实心暗色
    bgOpacity: 0,
    bgOpacityMode: 'veil',
    panelOpacity: 65,
    opacityUnit: 'pct',
    avatar: '',
    // 阶段 5.9：朋友圈自定义封面（base64 图片，空串 = 用默认渐变色）
    momentsCover: '',
    momentsConfig: normalizeMomentsConfig(null)
  };
}

// 旧联系人没有 spaceConfig、或字段不完整时，统一补齐默认值
function normalizeSpaceConfig(contact) {
  const raw = (contact.spaceConfig && typeof contact.spaceConfig === 'object') ? contact.spaceConfig : {};
  const background = SPACE_BACKGROUNDS.some(function (item) { return item.id === raw.background; })
    ? raw.background : 'default';
  const nickname = (typeof raw.nickname === 'string' && raw.nickname.trim() !== '')
    ? raw.nickname.trim()
    : (typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : contact.name);
  const avatar = typeof raw.avatar === 'string' ? raw.avatar : '';
  // 没有 opacityUnit 标记的就是 5.5.5 之前的小数存储，需要 ×100
  const legacyOpacity = raw.opacityUnit !== 'pct';
  // 桌面滑块以前存的是「壁纸可见度」（100 = 壁纸清晰），
  // 现在改成「桌面底色不透明度」（0 = 壁纸清晰），旧数据要 100 - 值 翻转一次
  const legacyBg = raw.bgOpacityMode !== 'veil';
  const bgPercent = readOpacity(raw.bgOpacity, legacyOpacity, legacyBg ? 100 : 0);
  // 阶段 5.3：聊天外观设置也在这里兜底，旧数据自动补默认值
  contact.spaceConfig = {
    background: background,
    nickname: nickname,
    name: nickname,
    bgOpacity: legacyBg ? 100 - bgPercent : bgPercent,
    bgOpacityMode: 'veil',
    panelOpacity: readOpacity(raw.panelOpacity, legacyOpacity, 65),
    opacityUnit: 'pct',
    avatar: avatar,
    chatStyle: normalizeChatStyle(raw.chatStyle),
    // 阶段 5.9：自定义朋友圈封面，旧存档自动补空串（用默认渐变色）
    momentsCover: (typeof raw.momentsCover === 'string' && raw.momentsCover !== '') ? raw.momentsCover : '',
    // 阶段 5.7.2：旧存档没有这一项时自动补默认值
    momentsConfig: normalizeMomentsConfig(raw.momentsConfig)
  };

  // 阶段 5.5：资料字段与联系人本体保持同步（avatar 为空时保留原文字头像）
  contact.name = nickname;
  if (avatar) contact.avatar = avatar;

  return contact.spaceConfig;
}

function loadSpaceConfigs() {
  contacts.forEach(normalizeSpaceConfig);

  try {
    const raw = localStorage.getItem(SPACE_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;

    contacts.forEach(function (contact) {
      const item = saved[contact.id];
      if (!item || typeof item !== 'object') return;
      if (SPACE_BACKGROUNDS.some(function (b) { return b.id === item.background; })) {
        contact.spaceConfig.background = item.background;
      }
      if (typeof item.nickname === 'string' && item.nickname.trim() !== '') {
        contact.spaceConfig.nickname = item.nickname.trim();
      } else if (typeof item.name === 'string' && item.name.trim() !== '') {
        contact.spaceConfig.nickname = item.name.trim();
      }
      const legacyOpacity = item.opacityUnit !== 'pct';
      const legacyBg = item.bgOpacityMode !== 'veil';
      if (typeof item.bgOpacity === 'number') {
        const bgPercent = readOpacity(item.bgOpacity, legacyOpacity, 100);
        contact.spaceConfig.bgOpacity = legacyBg ? 100 - bgPercent : bgPercent;
      }
      // 打上标记，避免 normalize 时被当成旧数据再翻转一次
      contact.spaceConfig.bgOpacityMode = 'veil';
      if (typeof item.panelOpacity === 'number') {
        contact.spaceConfig.panelOpacity = readOpacity(item.panelOpacity, legacyOpacity, 65);
      }
      if (typeof item.avatar === 'string') {
        contact.spaceConfig.avatar = item.avatar;
        if (item.avatar) contact.avatar = item.avatar;
      }
      // 昵称改动也要回写到联系人本体，保证列表 / 顶部 / 字卡归属同步
      contact.name = contact.spaceConfig.nickname;
      if (item.chatStyle && typeof item.chatStyle === 'object') {
        contact.spaceConfig.chatStyle = normalizeChatStyle(item.chatStyle);
      }
      // 阶段 5.7.2：朋友圈互动参数
      if (item.momentsConfig && typeof item.momentsConfig === 'object') {
        contact.spaceConfig.momentsConfig = normalizeMomentsConfig(item.momentsConfig);
      }
      // 阶段 5.9：自定义朋友圈封面
      if (typeof item.momentsCover === 'string' && item.momentsCover !== '') {
        contact.spaceConfig.momentsCover = item.momentsCover;
      }
    });
  } catch (error) {
    // 读不到或格式坏了，就用默认值，不影响聊天
  }
}

function saveSpaceConfigs() {
  try {
    const data = {};
    contacts.forEach(function (contact) {
      data[contact.id] = {
        background: contact.spaceConfig.background,
        nickname: contact.spaceConfig.nickname,
        bgOpacity: clampBgOpacity(contact.spaceConfig.bgOpacity),
        bgOpacityMode: 'veil',
        panelOpacity: clampPanelOpacity(contact.spaceConfig.panelOpacity),
        opacityUnit: 'pct',
        avatar: typeof contact.spaceConfig.avatar === 'string' ? contact.spaceConfig.avatar : '',
        name: contact.name,
        chatStyle: normalizeChatStyle(contact.spaceConfig.chatStyle),
        // 阶段 5.9：封面跟着空间配置一起落盘
        momentsCover: typeof contact.spaceConfig.momentsCover === 'string' ? contact.spaceConfig.momentsCover : '',
        momentsConfig: normalizeMomentsConfig(contact.spaceConfig.momentsConfig)
      };
    });
    localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

// 阶段 5.7.2：修改某个联系人的朋友圈互动概率（0-100），立即落盘
function setMomentsChance(contactId, key, value) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;

  const allowed = ['autoPostChance', 'likeChance', 'commentChance'];
  if (allowed.indexOf(key) === -1) return null;

  const config = normalizeSpaceConfig(contact);
  config.momentsConfig[key] = toPercent(value, config.momentsConfig[key]);
  saveSpaceConfigs();
  return config.momentsConfig;
}

// 阶段 5.9：设置「允许其他角色互相评论」开关（存布尔值，立即落盘）
function setMomentsCrossToggle(contactId, enabled) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;

  const config = normalizeSpaceConfig(contact);
  config.momentsConfig.enableCrossInteraction = enabled !== false;
  saveSpaceConfigs();
  return config.momentsConfig;
}

function getMomentsConfigOf(contactId) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return normalizeMomentsConfig(null);
  return normalizeSpaceConfig(contact).momentsConfig;
}

// 「30%」翻译成「约每小时 0.3 条」：每小时最多 1 条，期望值就是概率本身
function formatAutoPostHint(chance) {
  if (!chance) return '已关闭';
  const perHour = Math.round((Number(chance) / 100) * 10) / 10;
  return '约每小时 ' + perHour + ' 条';
}

function syncMomentsControls(contact) {
  if (!momentsAutoPostInput) return;

  const target = contact || getContactById(currentId);
  if (!target) return;

  const config = normalizeSpaceConfig(target).momentsConfig;

  if (momentsTargetName) momentsTargetName.textContent = target.name;

  momentsAutoPostInput.value = String(config.autoPostChance);
  momentsAutoPostValue.textContent = config.autoPostChance + '%';
  if (momentsAutoPostHint) momentsAutoPostHint.textContent = formatAutoPostHint(config.autoPostChance);

  momentsLikeInput.value = String(config.likeChance);
  momentsLikeValue.textContent = config.likeChance + '%';

  momentsCommentInput.value = String(config.commentChance);
  momentsCommentValue.textContent = config.commentChance + '%';

  // 阶段 5.9：互评开关跟随当前联系人配置
  if (momentsCrossInput) momentsCrossInput.checked = config.enableCrossInteraction !== false;
}

function renderSpaceOptions() {
  spaceBgOptions.innerHTML = '';
  SPACE_BACKGROUNDS.forEach(function (preset) {
    const button = el('button', 'space-bg-swatch', '');
    button.type = 'button';
    button.dataset.bg = preset.id;
    button.title = '背景：' + preset.label;
    button.setAttribute('aria-label', '背景：' + preset.label);
    button.style.background = preset.color;
    button.addEventListener('click', function () {
      setSpaceBackground(currentId, preset.id);
    });
    spaceBgOptions.appendChild(button);
  });
}

// 阶段 5.5.5：两个 0-100 滑块与百分比数字统一同步
function syncOpacityControls(config) {
  if (!config) return;
  if (spaceBgOpacityInput) spaceBgOpacityInput.value = String(config.bgOpacity);
  if (spaceBgOpacityValue) spaceBgOpacityValue.textContent = config.bgOpacity + '%';
  if (panelOpacityInput) panelOpacityInput.value = String(config.panelOpacity);
  if (panelOpacityValue) panelOpacityValue.textContent = config.panelOpacity + '%';
}

// 把当前联系人的空间配置刷到页面上（背景层 + 选中的色块）
function applySpace() {
  const contact = getContactById(currentId);
  if (!contact) return;
  const config = normalizeSpaceConfig(contact);
  const preset = SPACE_BACKGROUNDS.filter(function (item) { return item.id === config.background; })[0];

  spaceBg.dataset.bg = config.background;
  spaceBg.style.background = preset ? preset.color : '';
  // 桌面背景不透明度 = 壁纸上面那层底色的不透明度：
  // 0 = 完全透明（壁纸原样清晰），100 = 实心暗色（壁纸被完全盖住）
  spaceBg.style.opacity = '1';
  chatBgLayer.style.opacity = '1';
  const veilAlpha = Math.round(config.bgOpacity) / 100;
  if (spaceVeil) spaceVeil.style.opacity = String(veilAlpha);
  // 面板毛玻璃不透明度：0 = 只剩磨砂滤镜与边框，100 = 实心深色玻璃
  document.documentElement.style.setProperty('--panel-bg-alpha', String(percentToAlpha(config.panelOpacity)));
  syncOpacityControls(config);

  Array.prototype.slice.call(spaceBgOptions.children).forEach(function (button) {
    if (button.dataset.bg === config.background) button.classList.add('is-active');
    else button.classList.remove('is-active');
  });

  applyChatStyle(); // 阶段 5.3：空间变了，聊天外观也跟着换
}

// 桌面背景不透明度（0-100）：0 = 透出壁纸，100 = 实心暗色；拖动中不写盘
function setSpaceBgOpacity(contactId, value, persist) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;
  normalizeSpaceConfig(contact);
  contact.spaceConfig.bgOpacity = clampBgOpacity(Number(value));
  if (persist) saveSpaceConfigs();
  if (contact.id === currentId) applySpace();
  return contact.spaceConfig.bgOpacity;
}

// 面板毛玻璃不透明度（0-100），实时改写 CSS 变量；拖动过程不写盘
function setPanelOpacity(contactId, value, persist) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;
  normalizeSpaceConfig(contact);
  contact.spaceConfig.panelOpacity = clampPanelOpacity(Number(value));
  document.documentElement.style.setProperty('--panel-bg-alpha', String(percentToAlpha(contact.spaceConfig.panelOpacity)));
  if (persist) saveSpaceConfigs();
  return contact.spaceConfig.panelOpacity;
}

function setSpaceBackground(contactId, backgroundId) {
  const contact = getContactById(contactId);
  if (!contact) return null;
  if (!SPACE_BACKGROUNDS.some(function (item) { return item.id === backgroundId; })) return null;

  normalizeSpaceConfig(contact);
  contact.spaceConfig.background = backgroundId;
  saveSpaceConfigs();
  applySpace();
  return contact.spaceConfig.background;
}

function enterSpace(id) {
  currentId = id;
  renderAll();
  applySpace();
  applySpaceLight();
  setSpaceChat(false); // 默认只留桌面（背景 + 小组件 + Dock）
  settingsPanel.hidden = true; // 换房间时收起设置 / 外观面板
  app.classList.remove('show-cards');
  app.classList.add('show-space');
  app.classList.remove('show-sidebar');
  refreshHomeWidgets();
  updateHomeState();
  input.focus();
}

function exitSpace() {
  app.classList.remove('show-space');
  app.classList.remove('show-home');
  settingsPanel.hidden = true;
  restoreChat(); // 回到大厅时聊天面板恢复原状
  // 手机上回到大厅；桌面端这条规则只在窄屏生效，不影响布局
  app.classList.add('show-sidebar');
}

// ===== 9.6 聊天卡片开关与昼夜光影（阶段 5.2 / 5.4）=====
const spaceLight = document.getElementById('spaceLight');

let spaceLightPhase = 'day';

function spacePhaseForHour(hour) {
  if (hour >= 6 && hour < 17) return 'day';     // 白天：阳光
  if (hour >= 17 && hour < 20) return 'dusk';  // 黄昏：暖色
  return 'night';                               // 夜晚：冷色
}

function applySpaceLight(hour) {
  spaceLightPhase = spacePhaseForHour(hour == null ? new Date().getHours() : hour);
  spaceLight.className = 'space-light is-' + spaceLightPhase;
  app.dataset.light = spaceLightPhase;
}

function setSpaceChat(open) {
  if (open) {
    app.classList.add('chat-open');
    messagesBox.hidden = false;
    form.hidden = false;
    debugPanel.hidden = false;
    scrollToBottom();
    input.focus();
  } else {
    app.classList.remove('chat-open');
    messagesBox.hidden = true;
    form.hidden = true;
    debugPanel.hidden = true;
  }
  updateHomeState(); // 阶段 5.4：主页小组件只在无面板时显示
}

// 退出空间（或首次进入前）恢复聊天面板的可见性
function restoreChat() {
  app.classList.remove('chat-open');
  messagesBox.hidden = false;
  form.hidden = false;
  debugPanel.hidden = false;
}

function showSpaceToast(text) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showSpaceToast.timer);
  showSpaceToast.timer = setTimeout(function () { toast.hidden = true; }, 2200);
}

// ===== 9.7 聊天外观：气泡模式 / 信纸模式（阶段 5.3）=====
const chatEl = document.querySelector('.chat');
const chatBgLayer = document.getElementById('chatBg');
const modeBubbleBtn = document.getElementById('modeBubbleBtn');
const modeInterviewBtn = document.getElementById('modeInterviewBtn');
const styleColorOptions = document.getElementById('styleColorOptions');
const styleColorInput = document.getElementById('styleColorInput');
const styleOpacityInput = document.getElementById('styleOpacityInput');
const styleOpacityValue = document.getElementById('styleOpacityValue');
const styleGlassInput = document.getElementById('styleGlassInput');
const styleBgFile = document.getElementById('styleBgFile');
const styleClearBgBtn = document.getElementById('styleClearBgBtn');
const chatPanelBgFile = document.getElementById('chatPanelBgFile');
const chatPanelBgClearBtn = document.getElementById('chatPanelBgClearBtn');
const spaceBgOpacityInput = document.getElementById('spaceBgOpacityInput');
const spaceBgOpacityValue = document.getElementById('spaceBgOpacityValue');
const panelOpacityInput = document.getElementById('panelOpacityInput');
const panelOpacityValue = document.getElementById('panelOpacityValue');

const BUBBLE_COLORS = ['#FFFFFF', '#FFE3EC', '#FFF3D6', '#DFF6EC', '#E3ECFF', '#F3E8FF'];
// 阶段 5.5.1：报纸排版样式 —— 1 个白底 + 3 个暗底，适配暗黑环境
const PAPER_STYLES = [
  { id: 'minimal', label: '极简白' },
  { id: 'night', label: '夜间黑' },
  { id: 'slate', label: '深灰护眼' },
  { id: 'amber', label: '复古暗黄' }
];
// 旧版样式（信纸 plain/lined/grid、5.4 的 vintage/ink）→ 新纸面的兼容映射
const LEGACY_PAPER_MAP = {
  plain: 'minimal',
  lined: 'amber',
  grid: 'slate',
  vintage: 'amber',
  ink: 'slate'
};
const BG_IMAGE_MAX = 600 * 1024; // 上传背景图上限 600KB，避免拖垮 localStorage

function defaultChatStyle() {
  return {
    mode: 'bubble',          // 'bubble' 气泡 / 'interview' 报纸采访
    bubbleColor: '#FFFFFF',
    bubbleOpacity: 0.86,
    glassEffect: false,
    paperStyle: 'minimal',   // 报纸排版样式
    chatBackground: '',      // 阶段 5.5.2：桌面壁纸（#spaceBg / #chatBg 层）
    chatPanelBg: ''          // 阶段 5.5.2：聊天内容区背景图
  };
}

// 任何脏数据都兜回默认值，绝不让外观设置把页面弄崩
function normalizeChatStyle(raw) {
  const style = defaultChatStyle();
  if (!raw || typeof raw !== 'object') return style;

  // 兼容老数据：mode: 'letter' 自动迁移为 'interview'
  if (raw.mode === 'interview' || raw.mode === 'letter') style.mode = 'interview';
  else if (raw.mode === 'bubble') style.mode = 'bubble';

  if (/^#[0-9a-fA-F]{6}$/.test(String(raw.bubbleColor))) style.bubbleColor = raw.bubbleColor;
  if (typeof raw.bubbleOpacity === 'number' && isFinite(raw.bubbleOpacity)) {
    style.bubbleOpacity = Math.min(1, Math.max(0.3, raw.bubbleOpacity));
  }
  if (typeof raw.glassEffect === 'boolean') style.glassEffect = raw.glassEffect;

  const paper = raw.paperStyle || raw.letterStyle;
  if (PAPER_STYLES.some(function (item) { return item.id === paper; })) {
    style.paperStyle = paper;
  } else if (LEGACY_PAPER_MAP[paper]) {
    style.paperStyle = LEGACY_PAPER_MAP[paper];
  }

  if (typeof raw.chatBackground === 'string'
    && raw.chatBackground.indexOf('data:image/') === 0
    && raw.chatBackground.length <= BG_IMAGE_MAX * 2) {
    style.chatBackground = raw.chatBackground;
  }
  if (typeof raw.chatPanelBg === 'string'
    && raw.chatPanelBg.indexOf('data:image/') === 0
    && raw.chatPanelBg.length <= BG_IMAGE_MAX * 2) {
    style.chatPanelBg = raw.chatPanelBg;
  }
  return style;
}

function hexToRgba(hex, opacity) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex));
  if (!match) return 'rgba(255, 255, 255, ' + opacity + ')';
  const value = parseInt(match[1], 16);
  return 'rgba(' + ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255) + ', ' + opacity + ')';
}

function getChatStyleOf(contactId) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return defaultChatStyle();
  normalizeSpaceConfig(contact);
  return normalizeChatStyle(contact.spaceConfig.chatStyle);
}

// 改外观：合并 → 校验 → 落盘 → 实时刷新页面
function updateChatStyle(contactId, patch) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;
  normalizeSpaceConfig(contact);
  const merged = normalizeChatStyle(Object.assign({}, contact.spaceConfig.chatStyle, patch || {}));
  contact.spaceConfig.chatStyle = merged;
  saveSpaceConfigs();
  if (contact.id === currentId) {
    applyChatStyle();
    syncStylePanel();
  }
  return merged;
}

// 把当前联系人的聊天外观刷到页面上（模式 / 气泡色 / 毛玻璃 / 报纸样式 / 背景）
function applyChatStyle() {
  const style = getChatStyleOf(currentId);
  app.dataset.chatMode = style.mode;
  app.dataset.paper = style.paperStyle;
  app.dataset.glass = style.glassEffect ? 'on' : 'off';
  chatEl.style.setProperty('--bubble-bg', hexToRgba(style.bubbleColor, style.bubbleOpacity));

  // 阶段 5.5.2：聊天内容区背景图（气泡 / 采访模式共用）
  if (style.chatPanelBg) {
    chatEl.style.setProperty('--chat-panel-image', 'url("' + style.chatPanelBg + '")');
    app.classList.add('has-panel-bg');
  } else {
    chatEl.style.setProperty('--chat-panel-image', 'none');
    app.classList.remove('has-panel-bg');
  }

  if (style.chatBackground) {
    chatBgLayer.style.backgroundImage = 'url("' + style.chatBackground + '")';
    app.classList.add('has-chat-bg');
  } else {
    chatBgLayer.style.backgroundImage = '';
    app.classList.remove('has-chat-bg');
  }
}

function renderColorOptions() {
  styleColorOptions.innerHTML = '';
  BUBBLE_COLORS.forEach(function (color) {
    const button = el('button', 'style-color-swatch', '');
    button.type = 'button';
    button.dataset.color = color;
    button.title = color;
    button.setAttribute('aria-label', '气泡颜色 ' + color);
    button.style.background = color;
    styleColorOptions.appendChild(button);
  });
}

// 面板控件与当前配置保持同步
function syncStylePanel() {
  const style = getChatStyleOf(currentId);

  if (style.mode === 'bubble') modeBubbleBtn.classList.add('is-active');
  else modeBubbleBtn.classList.remove('is-active');
  if (style.mode === 'interview') modeInterviewBtn.classList.add('is-active');
  else modeInterviewBtn.classList.remove('is-active');

  styleColorInput.value = style.bubbleColor;
  styleOpacityInput.value = String(style.bubbleOpacity);
  styleOpacityValue.textContent = Math.round(style.bubbleOpacity * 100) + '%';
  styleGlassInput.checked = style.glassEffect;

  const currentContact = getContactById(currentId);
  const spaceConfig = currentContact ? normalizeSpaceConfig(currentContact) : defaultSpaceConfig({ name: '我' });
  syncOpacityControls(spaceConfig);

  Array.prototype.slice.call(styleColorOptions.children).forEach(function (button) {
    // 取色器会给小写十六进制，比较高亮时忽略大小写
    if (button.dataset.color.toLowerCase() === style.bubbleColor.toLowerCase()) button.classList.add('is-active');
    else button.classList.remove('is-active');
  });
}

// 外观现在常驻在「设置」面板里：打开 / 关闭都交给设置面板
function openStylePanel() {
  syncStylePanel();
  openSettingsPanel();
}

function closeStylePanel() {
  saveSpaceConfigs(); // 关面板时再确认一次已保存
  closeSettingsPanel();
}

modeBubbleBtn.addEventListener('click', function () {
  updateChatStyle(currentId, { mode: 'bubble' });
});
modeInterviewBtn.addEventListener('click', function () {
  updateChatStyle(currentId, { mode: 'interview' });
});
styleColorInput.addEventListener('input', function () {
  updateChatStyle(currentId, { bubbleColor: styleColorInput.value });
});
styleOpacityInput.addEventListener('input', function () {
  updateChatStyle(currentId, { bubbleOpacity: parseFloat(styleOpacityInput.value) });
});
styleGlassInput.addEventListener('change', function () {
  updateChatStyle(currentId, { glassEffect: styleGlassInput.checked });
});
styleColorOptions.addEventListener('click', function (event) {
  if (event.target && event.target.dataset && event.target.dataset.color) {
    updateChatStyle(currentId, { bubbleColor: event.target.dataset.color });
  }
});
// 桌面背景不透明度（0-100）：拖动即时生效，松手（change）时才写入本地存储
if (spaceBgOpacityInput) {
  spaceBgOpacityInput.addEventListener('input', function () {
    const value = clampBgOpacity(parseFloat(spaceBgOpacityInput.value));
    if (spaceBgOpacityValue) spaceBgOpacityValue.textContent = value + '%';
    setSpaceBgOpacity(currentId, value, false);
  });
  spaceBgOpacityInput.addEventListener('change', function () {
    setSpaceBgOpacity(currentId, parseFloat(spaceBgOpacityInput.value), true);
  });
}

// 面板毛玻璃不透明度（0-100）：拖动实时改 CSS 变量，松手落盘
if (panelOpacityInput) {
  panelOpacityInput.addEventListener('input', function () {
    const value = clampPanelOpacity(parseFloat(panelOpacityInput.value));
    if (panelOpacityValue) panelOpacityValue.textContent = value + '%';
    setPanelOpacity(currentId, value, false);
  });
  panelOpacityInput.addEventListener('change', function () {
    const value = clampPanelOpacity(parseFloat(panelOpacityInput.value));
    if (panelOpacityValue) panelOpacityValue.textContent = value + '%';
    setPanelOpacity(currentId, value, true);
  });
}

// 加分项：上传本地图片做聊天背景（FileReader → base64 → localStorage，限 600KB）
styleBgFile.addEventListener('change', function () {
  const file = styleBgFile.files && styleBgFile.files[0];
  if (!file) return;

  if (file.size > BG_IMAGE_MAX) {
    showSpaceToast('图片太大了（超过 600KB），换一张小一点的吧');
    styleBgFile.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function () {
    updateChatStyle(currentId, { chatBackground: String(reader.result) });
    showSpaceToast('桌面壁纸已更新');
    styleBgFile.value = '';
  };
  reader.onerror = function () {
    showSpaceToast('这张图读不出来，换一张试试');
    styleBgFile.value = '';
  };
  reader.readAsDataURL(file);
});

styleClearBgBtn.addEventListener('click', function () {
  updateChatStyle(currentId, { chatBackground: '' });
  showSpaceToast('已清除桌面壁纸');
});

// 阶段 5.5.2：聊天内容区背景图（只作用于 .messages，不影响桌面）
if (chatPanelBgFile) {
  chatPanelBgFile.addEventListener('change', function () {
    const file = chatPanelBgFile.files && chatPanelBgFile.files[0];
    if (!file) return;

    if (file.size > BG_IMAGE_MAX) {
      showSpaceToast('图片太大了（超过 600KB），换一张小一点的吧');
      chatPanelBgFile.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = function () {
      updateChatStyle(currentId, { chatPanelBg: String(reader.result) });
      showSpaceToast('聊天框背景已更新');
      chatPanelBgFile.value = '';
    };
    reader.onerror = function () {
      showSpaceToast('这张图读不出来，换一张试试');
      chatPanelBgFile.value = '';
    };
    reader.readAsDataURL(file);
  });
}

if (chatPanelBgClearBtn) {
  chatPanelBgClearBtn.addEventListener('click', function () {
    updateChatStyle(currentId, { chatPanelBg: '' });
    showSpaceToast('已清除聊天框背景');
  });
}

// ===== 9.7.1 基础资料：修改「我」与当前联系人的头像 / 昵称（阶段 5.5）=====
const meNameInput = document.getElementById('meNameInput');
const contactNameInput = document.getElementById('contactNameInput');
const meAvatarFile = document.getElementById('meAvatarFile');
const contactAvatarFile = document.getElementById('contactAvatarFile');
const openProfileBtn = document.getElementById('openProfileBtn');

const PROFILE_IMAGE_MAX = 600 * 1024;

function readProfileImage(file, onDone) {
  if (!file) return;
  if (file.size > PROFILE_IMAGE_MAX) {
    showSpaceToast('图片太大了（超过 600KB），换一张小一点的吧');
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    onDone(String(reader.result));
  };
  reader.onerror = function () {
    showSpaceToast('这张图读不出来，换一张试试');
  };
  reader.readAsDataURL(file);
}

function updateMeProfile(patch) {
  if (patch && typeof patch.name === 'string') {
    const name = patch.name.trim().slice(0, 20);
    meProfile.name = name || '我';
  }
  if (patch && typeof patch.avatar === 'string') {
    meProfile.avatar = patch.avatar;
  }
  saveMeProfile();
  renderMeProfile();
  renderMessages(); // 「我」的头像 / 采访标签实时联动
  syncProfilePanel();
  return meProfile;
}

function updateContactProfile(contactId, patch) {
  const contact = getContactById(contactId || currentId);
  if (!contact) return null;
  const config = normalizeSpaceConfig(contact);

  if (patch && typeof patch.name === 'string') {
    const name = patch.name.trim().slice(0, 20);
    if (name) {
      contact.name = name;
      config.nickname = name;
      config.name = name;
    }
  }
  if (patch && typeof patch.avatar === 'string') {
    config.avatar = patch.avatar;
    if (patch.avatar) contact.avatar = patch.avatar;
  }

  saveSpaceConfigs();
  // 阶段 5.10：自定义联系人的昵称 / 头像改动也要落盘
  saveCustomContacts();
  renderAll(); // 联系人列表 / 顶部 Header / 消息头像同步
  renderMeProfile();
  syncProfilePanel();
  return contact;
}

// 设置面板里的资料控件回填
function syncProfilePanel() {
  const mePreview = document.getElementById('meAvatarPreview');
  const contactPreview = document.getElementById('contactAvatarPreview');

  if (mePreview) applyAvatar(mePreview, meProfile.avatar, '我', 'avatar avatar-me');
  if (meNameInput && document.activeElement !== meNameInput) meNameInput.value = meProfile.name;

  const contact = getContactById(currentId);
  if (!contact) return;
  if (contactPreview) {
    applyAvatar(contactPreview, contact.avatar, firstChar(contact.name), 'avatar avatar-' + contact.avatarColor);
  }
  if (contactNameInput && document.activeElement !== contactNameInput) {
    contactNameInput.value = contact.name;
  }
}

if (meNameInput) {
  meNameInput.addEventListener('change', function () {
    const value = meNameInput.value.trim();
    if (!value) {
      meNameInput.value = meProfile.name; // 空昵称不允许，回填当前值
      return;
    }
    updateMeProfile({ name: value });
  });
}

if (contactNameInput) {
  contactNameInput.addEventListener('change', function () {
    const value = contactNameInput.value.trim();
    const contact = getContactById(currentId);
    if (!value) {
      contactNameInput.value = contact ? contact.name : '';
      return;
    }
    updateContactProfile(currentId, { name: value });
  });
}

if (meAvatarFile) {
  meAvatarFile.addEventListener('change', function () {
    const file = meAvatarFile.files && meAvatarFile.files[0];
    meAvatarFile.value = '';
    readProfileImage(file, function (dataUrl) {
      updateMeProfile({ avatar: dataUrl });
      showSpaceToast('我的头像已更新');
    });
  });
}

if (contactAvatarFile) {
  contactAvatarFile.addEventListener('change', function () {
    const file = contactAvatarFile.files && contactAvatarFile.files[0];
    contactAvatarFile.value = '';
    readProfileImage(file, function (dataUrl) {
      updateContactProfile(currentId, { avatar: dataUrl });
      showSpaceToast('联系人头像已更新');
    });
  });
}

// ===== 阶段 5.10：点「我」→ 居中的资料卡弹窗（不再跳设置面板） =====
const meProfileModal = document.getElementById('meProfileModal');
const meProfileAvatarBtn = document.getElementById('meProfileAvatarBtn');
const meProfileAvatarNode = document.getElementById('meProfileAvatar');
const meProfileNameInput = document.getElementById('meProfileNameInput');
const meProfileAvatarFile = document.getElementById('meProfileAvatarFile');
const closeMeProfileBtn = document.getElementById('closeMeProfileBtn');

function syncMeProfileModal() {
  applyAvatar(meProfileAvatarNode, meProfile.avatar, '我', 'avatar avatar-me');
  if (meProfileNameInput && document.activeElement !== meProfileNameInput) {
    meProfileNameInput.value = meProfile.name || '';
  }
}

function openMeProfileModal() {
  if (!meProfileModal) return;
  syncMeProfileModal();
  meProfileModal.hidden = false;
}

function closeMeProfileModal() {
  if (meProfileModal) meProfileModal.hidden = true;
}

if (openProfileBtn) {
  openProfileBtn.addEventListener('click', openMeProfileModal);
}

if (meProfileModal) {
  meProfileModal.addEventListener('click', function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute('data-close-me')) {
      closeMeProfileModal();
    }
  });
}

if (closeMeProfileBtn) closeMeProfileBtn.addEventListener('click', closeMeProfileModal);

if (meProfileAvatarBtn && meProfileAvatarFile) {
  meProfileAvatarBtn.addEventListener('click', function () {
    meProfileAvatarFile.value = '';
    meProfileAvatarFile.click();
  });

  meProfileAvatarFile.addEventListener('change', function () {
    const file = meProfileAvatarFile.files && meProfileAvatarFile.files[0];
    if (!file) return;
    readProfileImage(file, function (dataUrl) {
      updateMeProfile({ avatar: dataUrl });
      syncMeProfileModal();
      showSpaceToast('我的头像已更新');
    });
  });
}

if (meProfileNameInput) {
  meProfileNameInput.addEventListener('change', function () {
    const value = meProfileNameInput.value.trim();
    if (!value) {
      meProfileNameInput.value = meProfile.name; // 空昵称不允许，回填当前值
      return;
    }
    updateMeProfile({ name: value });
    syncMeProfileModal();
  });
}

// ===== 阶段 5.10：新建联系人（随机默认头像，自带完整的空间 / 朋友圈配置） =====
const addContactBtn = document.getElementById('addContactBtn');
const addContactModal = document.getElementById('addContactModal');
const addContactForm = document.getElementById('addContactForm');
const addContactName = document.getElementById('addContactName');
const cancelAddContactBtn = document.getElementById('cancelAddContactBtn');

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function openAddContactModal() {
  if (!addContactModal) return;
  if (addContactName) addContactName.value = '';
  addContactModal.hidden = false;
  setTimeout(function () {
    if (addContactName) addContactName.focus();
  }, 0);
}

function closeAddContactModal() {
  if (addContactModal) addContactModal.hidden = true;
}

// 创建一位空白联系人：空间配置 + 朋友圈配置一出生就齐全，点进去不会白屏
function createContact(rawName) {
  const name = String(rawName || '').trim().slice(0, 20);
  if (!name) return null;

  const contact = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name,
    avatar: randomItem(RANDOM_AVATAR_EMOJIS),
    avatarColor: randomItem(AVATAR_COLORS),
    status: '在线',
    online: true,
    statusConfig: { current: 'online', customStatuses: [], schedule: [] },
    spaceConfig: defaultSpaceConfig({ name: name }),
    messages: []
  };

  contacts.push(contact);
  saveCustomContacts();
  renderContactList();
  enterSpace(contact.id);
  showSpaceToast('新联系人「' + name + '」已创建');
  return contact;
}

if (addContactBtn) addContactBtn.addEventListener('click', openAddContactModal);
if (cancelAddContactBtn) cancelAddContactBtn.addEventListener('click', closeAddContactModal);

if (addContactModal) {
  addContactModal.addEventListener('click', function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute('data-close-add')) {
      closeAddContactModal();
    }
  });
}

if (addContactForm) {
  addContactForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!createContact(addContactName ? addContactName.value : '')) {
      showSpaceToast('先给 TA 起个名字吧');
      return;
    }
    closeAddContactModal();
  });
}

renderColorOptions();

// ===== 9.8 主控台：悬浮 Dock / 桌面小组件 / 设置面板（阶段 5.4）=====
const dockHomeBtn = document.getElementById('dockHomeBtn');
const dockChatBtn = document.getElementById('dockChatBtn');
const dockContactsBtn = document.getElementById('dockContactsBtn');
const dockCardsBtn = document.getElementById('dockCardsBtn');
const dockSettingsBtn = document.getElementById('dockSettingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const settingsProviderBtn = document.getElementById('settingsProviderBtn');
const homeClock = document.getElementById('homeClock');
const homeDate = document.getElementById('homeDate');
const homeQuoteText = document.getElementById('homeQuoteText');
const homeQuoteFrom = document.getElementById('homeQuoteFrom');
// 阶段 5.11：桌面天气组件（真实 API）
const weatherCityBtn = document.getElementById('weatherCityBtn');
const weatherTemp = document.getElementById('weatherTemp');
const weatherDesc = document.getElementById('weatherDesc');
const weatherSunrise = document.getElementById('weatherSunrise');
const weatherCityModal = document.getElementById('weatherCityModal');
const weatherCityForm = document.getElementById('weatherCityForm');
const weatherCityInput = document.getElementById('weatherCityInput');
const cancelWeatherCityBtn = document.getElementById('cancelWeatherCityBtn');

// 阶段 5.11：应用信息（主标题 / 副标题）
const logoText = document.getElementById('logoText');
const logoSub = document.getElementById('logoSub');
const appTitleInput = document.getElementById('appTitleInput');
const appSubtitleInput = document.getElementById('appSubtitleInput');

// 阶段 5.8：桌面情话不再用写死的文案池，全部从字卡库 type === 'quote' 的卡里读。
// 原来的内置句子已迁移到 cards.js 的 DEFAULT_TYPED_CARDS，作为首次升级注入的默认卡。
const HOME_QUOTE_FALLBACK = '今天过得怎么样？';

const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function refreshHomeClock(now) {
  const date = now instanceof Date ? now : new Date();
  if (homeClock) homeClock.textContent = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  if (homeDate) {
    homeDate.textContent = date.getFullYear() + '年' + (date.getMonth() + 1) + '月'
      + date.getDate() + '日 · 周' + WEEK_NAMES[date.getDay()];
  }
}

function refreshHomeQuote() {
  if (!homeQuoteText) return;
  const contact = getContactById(currentId);

  // 阶段 5.8：只从该联系人字卡库读 type === 'quote' 的情话卡，多条随机展示
  let quote = '';
  try {
    const lib = window.MochiChatCards;
    if (lib && typeof lib.getCardsOf === 'function') {
      const quotes = (lib.getCardsOf(currentId) || []).filter(function (card) {
        return card && card.type === 'quote' &&
          typeof card.content === 'string' && card.content.trim() !== '';
      });
      if (quotes.length > 0) {
        quote = quotes[Math.floor(Math.random() * quotes.length)].content.trim();
      }
    }
  } catch (error) {
    // 字卡库还没加载好（首屏）就先显示默认句，稍后会再刷新一次
  }

  // 没配情话卡时的默认句
  if (!quote) quote = HOME_QUOTE_FALLBACK;

  homeQuoteText.textContent = '「' + quote + '」';
  // 右下角显示联系人署名，不再写「梦角情话」
  if (homeQuoteFrom) {
    homeQuoteFrom.textContent = '—— ' + (contact ? contact.name : '梦角');
  }
}

// ===== 阶段 5.11：桌面天气（wttr.in 免费接口，失败再试 vvhan，全程兜底不崩） =====
const WEATHER_STORAGE_KEY = 'mochi-chat-weather-v1';
const WEATHER_DEFAULT_CITY = '北京';
const WEATHER_TIMEOUT = 8000;
const weatherState = { city: '', loading: false };

// 英文天气描述 → 中文（wttr.in 是英文，vvhan 本身就是中文）
const WEATHER_CN_RULES = [
  [/thunder|storm/i, '雷阵雨'],
  [/heavy rain/i, '大雨'],
  [/moderate rain/i, '中雨'],
  [/light rain|patchy rain|drizzle/i, '小雨'],
  [/freezing|sleet/i, '雨夹雪'],
  [/blizzard|heavy snow/i, '大雪'],
  [/snow/i, '雪'],
  [/fog/i, '雾'],
  [/mist/i, '薄雾'],
  [/haze/i, '霾'],
  [/overcast/i, '阴'],
  [/partly cloudy/i, '多云'],
  [/cloudy/i, '多云'],
  [/sunny|clear/i, '晴'],
  [/wind/i, '大风']
];

function translateWeather(desc) {
  const text = String(desc || '').trim();
  if (text === '') return '未知';
  // 已经是中文就直接用
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  for (let i = 0; i < WEATHER_CN_RULES.length; i++) {
    if (WEATHER_CN_RULES[i][0].test(text)) return WEATHER_CN_RULES[i][1];
  }
  return text;
}

function loadWeatherCity() {
  try {
    const raw = JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY) || 'null');
    const city = raw && typeof raw.city === 'string' ? raw.city.trim() : '';
    weatherState.city = city || WEATHER_DEFAULT_CITY;
  } catch (error) {
    weatherState.city = WEATHER_DEFAULT_CITY;
  }
  return weatherState.city;
}

function saveWeatherCity(city) {
  weatherState.city = city;
  try {
    localStorage.setItem(WEATHER_STORAGE_KEY, JSON.stringify({ city: city }));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

// wttr.in 给的是 12 小时制 "06:12 AM"，统一转成 24 小时
function formatSunrise(value) {
  const text = String(value || '').trim();
  if (text === '') return '';
  const match = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return text;
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = (match[3] || '').toUpperCase();
  if (suffix === 'PM' && hour < 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  return (hour < 10 ? '0' + hour : String(hour)) + ':' + minute;
}

function weatherFail() {
  if (weatherTemp) weatherTemp.textContent = '--°';
  if (weatherDesc) weatherDesc.textContent = '获取失败';
  if (weatherSunrise) weatherSunrise.textContent = '日出 未知';
}

function applyWeather(data) {
  if (!data) {
    weatherFail();
    return;
  }
  if (weatherTemp) weatherTemp.textContent = data.temp;
  if (weatherDesc) weatherDesc.textContent = data.desc;
  if (weatherSunrise) weatherSunrise.textContent = '日出 ' + (data.sunrise || '未知');
}

function fetchWeatherJson(url) {
  const options = {};
  if (window.AbortSignal && typeof window.AbortSignal.timeout === 'function') {
    options.signal = window.AbortSignal.timeout(WEATHER_TIMEOUT);
  }
  return fetch(url, options).then(function (response) {
    if (!response.ok) throw new Error('http ' + response.status);
    return response.json();
  });
}

// wttr.in：current_condition[0].temp_C / weatherDesc，weather[0].astronomy[0].sunrise
function parseWttrWeather(json) {
  const current = json && json.current_condition && json.current_condition[0];
  if (!current) return null;
  const astronomy = json.weather && json.weather[0] && json.weather[0].astronomy && json.weather[0].astronomy[0];
  const temp = Math.round(Number(current.temp_C));
  return {
    temp: isFinite(temp) ? temp + '°' : '--°',
    desc: translateWeather(current.weatherDesc && current.weatherDesc[0] && current.weatherDesc[0].value),
    sunrise: formatSunrise(astronomy && astronomy.sunrise)
  };
}

// vvhan：data.tem / data.wea / data.sunrise
function parseVvhanWeather(json) {
  const data = json && json.data;
  if (!data || json.success === false) return null;
  const temp = Math.round(Number(data.tem));
  return {
    temp: isFinite(temp) ? temp + '°' : '--°',
    desc: translateWeather(data.wea),
    sunrise: formatSunrise(data.sunrise)
  };
}

function fetchWeather() {
  if (weatherState.loading) return;
  if (typeof fetch !== 'function') {
    weatherFail();
    return;
  }

  weatherState.loading = true;

  const city = weatherState.city || WEATHER_DEFAULT_CITY;
  if (weatherCityBtn) weatherCityBtn.textContent = city;
  if (weatherDesc) weatherDesc.textContent = '获取中…';

  const encoded = encodeURIComponent(city);

  fetchWeatherJson('https://wttr.in/' + encoded + '?format=j1')
    .then(function (json) {
      const data = parseWttrWeather(json);
      return data || Promise.reject(new Error('wttr empty'));
    })
    .catch(function () {
      // 备用：vvhan 公开接口（同样免鉴权）
      return fetchWeatherJson('https://api.vvhan.com/api/weather?city=' + encoded)
        .then(function (json) {
          const data = parseVvhanWeather(json);
          return data || Promise.reject(new Error('vvhan empty'));
        });
    })
    .then(function (data) {
      applyWeather(data);
    })
    .catch(function () {
      weatherFail();
    })
    .then(function () {
      weatherState.loading = false;
    });
}

// ===== 阶段 5.11：应用信息（主标题 / 副标题） =====
const APP_INFO_KEY = 'mochi-chat-app-info-v1';
const APP_INFO_DEFAULTS = { title: 'Mochi Chat', subtitle: '麻薯聊天 · 温柔的对话' };
const appInfo = { title: APP_INFO_DEFAULTS.title, subtitle: APP_INFO_DEFAULTS.subtitle };

function loadAppInfo() {
  try {
    const raw = JSON.parse(localStorage.getItem(APP_INFO_KEY) || 'null');
    if (raw && typeof raw.title === 'string' && raw.title.trim() !== '') {
      appInfo.title = raw.title.trim().slice(0, 24);
    }
    if (raw && typeof raw.subtitle === 'string') {
      appInfo.subtitle = raw.subtitle.trim().slice(0, 40);
    }
  } catch (error) {
    // 读不到就用默认标题
  }
}

function saveAppInfo() {
  try {
    localStorage.setItem(APP_INFO_KEY, JSON.stringify(appInfo));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

function applyAppInfo() {
  if (logoText) logoText.textContent = appInfo.title || APP_INFO_DEFAULTS.title;
  if (logoSub) logoSub.textContent = appInfo.subtitle;
  document.title = appInfo.title || APP_INFO_DEFAULTS.title;
}

function syncAppInfoInputs() {
  if (appTitleInput && document.activeElement !== appTitleInput) appTitleInput.value = appInfo.title;
  if (appSubtitleInput && document.activeElement !== appSubtitleInput) appSubtitleInput.value = appInfo.subtitle;
}

function updateAppInfo(patch) {
  if (patch && typeof patch.title === 'string') {
    const title = patch.title.trim().slice(0, 24);
    appInfo.title = title || APP_INFO_DEFAULTS.title;
  }
  if (patch && typeof patch.subtitle === 'string') {
    appInfo.subtitle = patch.subtitle.trim().slice(0, 40);
  }
  saveAppInfo();
  applyAppInfo();
  return appInfo;
}

function refreshHomeWidgets() {
  refreshHomeClock();
  refreshHomeQuote();
}

// 主页 = 空间模式 + 没有任何面板打开
function isHomeView() {
  return app.classList.contains('show-space')
    && !app.classList.contains('chat-open')
    && !app.classList.contains('show-cards')
    && !app.classList.contains('show-sidebar')
    && settingsPanel.hidden;
}

function syncDockActive() {
  const inSpace = app.classList.contains('show-space');
  const states = [
    [dockHomeBtn, app.classList.contains('show-home')],
    [dockChatBtn, app.classList.contains('chat-open')],
    [dockContactsBtn, inSpace && app.classList.contains('show-sidebar')],
    [dockCardsBtn, app.classList.contains('show-cards')],
    [dockSettingsBtn, !settingsPanel.hidden]
  ];
  states.forEach(function (pair) {
    if (!pair[0]) return;
    if (pair[1]) pair[0].classList.add('is-active');
    else pair[0].classList.remove('is-active');
  });
}

let homeStateBusy = false; // 防重入：任何情况下都不会嵌套触发

function updateHomeState() {
  if (homeStateBusy) return app.classList.contains('show-home');
  homeStateBusy = true;
  try {
    const home = isHomeView();
    // 只在值真的变化时才写 class，避免触发额外的样式/监听连锁反应
    if (home && !app.classList.contains('show-home')) app.classList.add('show-home');
    if (!home && app.classList.contains('show-home')) app.classList.remove('show-home');
    syncDockActive();
    return home;
  } finally {
    homeStateBusy = false;
  }
}

function closeOtherPanels(keep) {
  if (keep !== 'chat') setSpaceChat(false);
  if (keep !== 'contacts') app.classList.remove('show-sidebar');
  if (keep !== 'cards') app.classList.remove('show-cards');
  if (keep !== 'settings') settingsPanel.hidden = true;
  // 阶段 5.7：其它面板打开时顺手收起朋友圈
  if (keep !== 'moments' && momentsPanel) momentsPanel.hidden = true;
}

function goHome() {
  closeOtherPanels('home');
  refreshHomeWidgets();
  updateHomeState();
}

function openChatPanel() {
  closeOtherPanels('chat');
  setSpaceChat(true);
}

function toggleContactsPanel() {
  if (app.classList.contains('show-sidebar')) {
    app.classList.remove('show-sidebar');
    updateHomeState();
    return;
  }
  closeOtherPanels('contacts');
  app.classList.add('show-sidebar');
  updateHomeState();
}

// ===== 阶段 5.6：角色状态面板（设置里那块）=====
function renderStatusItems(contact, config) {
  if (statusCustomList) {
    statusCustomList.innerHTML = '';
    if (config.customStatuses.length === 0) {
      statusCustomList.appendChild(el('li', 'status-empty', '还没有自定义状态'));
    } else {
      config.customStatuses.forEach(function (status) {
        const li = el('li', 'status-item');
        const dot = el('i', 'status-item-dot');
        dot.style.background = status.color;
        li.appendChild(dot);
        li.appendChild(el('span', 'status-item-text', status.label));

        const remove = el('button', 'status-item-del', '×');
        remove.type = 'button';
        remove.dataset.statusId = status.id;
        remove.title = '删除这个状态';
        li.appendChild(remove);
        statusCustomList.appendChild(li);
      });
    }
  }

  if (statusScheduleList) {
    statusScheduleList.innerHTML = '';
    if (config.schedule.length === 0) {
      statusScheduleList.appendChild(el('li', 'status-empty', '还没有时间段规则'));
    } else {
      config.schedule.forEach(function (rule, index) {
        const status = findStatusOf(contact, rule.statusId);
        const li = el('li', 'status-item');
        const dot = el('i', 'status-item-dot');
        dot.style.background = status.color;
        li.appendChild(dot);
        li.appendChild(el('span', 'status-item-text', rule.start + ' → ' + rule.end + ' · ' + status.label));

        const remove = el('button', 'status-item-del', '×');
        remove.type = 'button';
        remove.dataset.scheduleIndex = String(index);
        remove.title = '删除这条规则';
        li.appendChild(remove);
        statusScheduleList.appendChild(li);
      });
    }
  }
}

// 阶段 5.6.2：同步「回复行为」滑块，显示的是当前选中状态的行为
function syncStatusBehaviorControls(contact) {
  if (!statusDelayInput || !statusProbInput || !statusWeightInput) return;

  const config = normalizeStatusConfig(contact);
  const behavior = getStatusBehaviorOf(contact, config.current);

  const delaySeconds = Math.round(behavior.replyDelay / 100) / 10; // 毫秒 → 秒（一位小数）
  statusDelayInput.value = String(delaySeconds);
  statusDelayValue.textContent = delaySeconds + 's';

  const probPercent = Math.round(behavior.replyProbability * 100);
  statusProbInput.value = String(probPercent);
  statusProbValue.textContent = probPercent + '%';

  const weight = Math.round(behavior.matchWeight * 10) / 10;
  statusWeightInput.value = String(weight);
  statusWeightValue.textContent = '×' + weight;
}

function renderStatusPanel() {
  const contact = getContactById(currentId);
  if (!contact || !statusCurrentSelect) return;

  const config = normalizeStatusConfig(contact);
  const statuses = getStatusesOf(contact);

  if (statusTargetName) statusTargetName.textContent = contact.name;

  statusCurrentSelect.innerHTML = '';
  statuses.forEach(function (status) {
    const option = document.createElement('option');
    option.value = status.id;
    option.textContent = status.label;
    if (status.id === config.current) option.selected = true;
    statusCurrentSelect.appendChild(option);
  });

  if (statusScheduleStatus) {
    const keep = statusScheduleStatus.value;
    statusScheduleStatus.innerHTML = '';
    statuses.forEach(function (status) {
      const option = document.createElement('option');
      option.value = status.id;
      option.textContent = status.label;
      statusScheduleStatus.appendChild(option);
    });
    statusScheduleStatus.value = statuses.some(function (status) { return status.id === keep; })
      ? keep
      : statuses[0].id;
  }

  renderStatusItems(contact, config);
  syncStatusBehaviorControls(contact);
  syncMomentsControls(contact);
}

function openSettingsPanel() {
  closeOtherPanels('settings');
  settingsPanel.hidden = false;
  syncStylePanel();   // 打开设置即同步气泡 / 报纸 / 背景等外观状态
  syncProfilePanel(); // 阶段 5.5：同步头像与昵称
  syncAppInfoInputs(); // 阶段 5.11：同步应用标题 / 副标题
  renderStatusPanel(); // 阶段 5.6：同步角色状态（下拉 / 自定义 / 时间规则）
  updateHomeState();
}

function closeSettingsPanel() {
  settingsPanel.hidden = true;
  saveSpaceConfigs(); // 兜底保存（透明度等拖动类设置）
  updateHomeState();
}

function openCardsPanel() {
  closeOtherPanels('cards');
  if (window.MochiChatCards && typeof window.MochiChatCards.open === 'function') {
    window.MochiChatCards.open();
  }
  updateHomeState();
}

function openProviderFromSettings() {
  if (window.MochiChatProviderUI && typeof window.MochiChatProviderUI.open === 'function') {
    window.MochiChatProviderUI.open();
  } else {
    const fallback = document.getElementById('openProviderBtn');
    if (fallback) fallback.click();
  }
}

dockHomeBtn.addEventListener('click', goHome);
dockChatBtn.addEventListener('click', function () {
  if (app.classList.contains('chat-open')) {
    setSpaceChat(false);
    updateHomeState();
    return;
  }
  openChatPanel();
});
dockContactsBtn.addEventListener('click', toggleContactsPanel);
dockCardsBtn.addEventListener('click', openCardsPanel);
dockSettingsBtn.addEventListener('click', function () {
  if (settingsPanel.hidden) openSettingsPanel();
  else closeSettingsPanel();
});

settingsCloseBtn.addEventListener('click', closeSettingsPanel);
settingsProviderBtn.addEventListener('click', openProviderFromSettings);

// 阶段 5.6：角色状态交互（切换 / 加自定义 / 删自定义 / 加规则 / 删规则）
if (statusCurrentSelect) {
  statusCurrentSelect.addEventListener('change', function () {
    setContactStatus(currentId, statusCurrentSelect.value);
  });
}

// 阶段 5.6.2：三个行为滑块，改的是当前选中的那个状态（预设 / 自定义都行）
if (statusDelayInput) {
  statusDelayInput.addEventListener('input', function () {
    const seconds = Number(statusDelayInput.value);
    statusDelayValue.textContent = seconds + 's';
    updateStatusBehavior(statusCurrentSelect.value, { replyDelay: Math.round(seconds * 1000) });
  });
}

if (statusProbInput) {
  statusProbInput.addEventListener('input', function () {
    const percent = Number(statusProbInput.value);
    statusProbValue.textContent = percent + '%';
    updateStatusBehavior(statusCurrentSelect.value, { replyProbability: percent / 100 });
  });
}

if (statusWeightInput) {
  statusWeightInput.addEventListener('input', function () {
    const weight = Number(statusWeightInput.value);
    statusWeightValue.textContent = '×' + weight;
    updateStatusBehavior(statusCurrentSelect.value, { matchWeight: weight });
  });
}

// 阶段 5.7.2：朋友圈互动概率（作用于当前联系人）
if (momentsAutoPostInput) {
  momentsAutoPostInput.addEventListener('input', function () {
    const chance = Number(momentsAutoPostInput.value);
    momentsAutoPostValue.textContent = chance + '%';
    if (momentsAutoPostHint) momentsAutoPostHint.textContent = formatAutoPostHint(chance);
    setMomentsChance(currentId, 'autoPostChance', chance);
  });
}

if (momentsLikeInput) {
  momentsLikeInput.addEventListener('input', function () {
    const chance = Number(momentsLikeInput.value);
    momentsLikeValue.textContent = chance + '%';
    setMomentsChance(currentId, 'likeChance', chance);
  });
}

if (momentsCommentInput) {
  momentsCommentInput.addEventListener('input', function () {
    const chance = Number(momentsCommentInput.value);
    momentsCommentValue.textContent = chance + '%';
    setMomentsChance(currentId, 'commentChance', chance);
  });
}

// 阶段 5.9.1：无视概率和冷却，立刻让当前联系人发一条动态
if (momentsTestPostBtn) {
  momentsTestPostBtn.addEventListener('click', function () {
    const contact = getContactById(currentId);
    if (!contact) return;

    if (maybeAutoPostMoment(contact, { force: true, ignoreChance: true })) {
      showSpaceToast(contact.name + ' 刚发了一条新动态');
    } else {
      showSpaceToast('发送失败，请重试');
    }
  });
}

// 阶段 5.9：「允许其他角色互相评论」开关
if (momentsCrossInput) {
  momentsCrossInput.addEventListener('change', function () {
    setMomentsCrossToggle(currentId, momentsCrossInput.checked);
  });
}

if (statusCustomAddBtn) {
  statusCustomAddBtn.addEventListener('click', function () {
    // 新状态的行为直接取三个滑块的当前值，所见即所得
    const created = addCustomStatus(
      statusCustomLabel ? statusCustomLabel.value : '',
      statusCustomColor ? statusCustomColor.value : '',
      {
        replyDelay: Math.round(Number(statusDelayInput ? statusDelayInput.value : 0) * 1000),
        replyProbability: Number(statusProbInput ? statusProbInput.value : 100) / 100,
        matchWeight: Number(statusWeightInput ? statusWeightInput.value : 1.4)
      }
    );
    if (!created) {
      showSpaceToast('先给状态起个名字吧');
      return;
    }
    if (statusCustomLabel) statusCustomLabel.value = '';
  });
}

if (statusCustomList) {
  statusCustomList.addEventListener('click', function (event) {
    const statusId = event.target && event.target.dataset ? event.target.dataset.statusId : '';
    if (statusId) removeCustomStatus(statusId);
  });
}

if (statusScheduleAddBtn) {
  statusScheduleAddBtn.addEventListener('click', function () {
    const rule = addStatusSchedule(
      statusScheduleStart ? statusScheduleStart.value : '',
      statusScheduleEnd ? statusScheduleEnd.value : '',
      statusScheduleStatus ? statusScheduleStatus.value : ''
    );
    if (!rule) showSpaceToast('时间段不合法：开始和结束不能相同哦');
  });
}

if (statusScheduleList) {
  statusScheduleList.addEventListener('click', function (event) {
    const index = event.target && event.target.dataset ? event.target.dataset.scheduleIndex : '';
    if (index !== undefined && index !== '') removeStatusSchedule(Number(index));
  });
}

// ===== 阶段 5.11：天气地区切换（点击地区文字打开小弹窗） =====
function openWeatherCityModal() {
  if (!weatherCityModal) return;
  if (weatherCityInput) weatherCityInput.value = weatherState.city || WEATHER_DEFAULT_CITY;
  weatherCityModal.hidden = false;
  setTimeout(function () {
    if (weatherCityInput) weatherCityInput.focus();
  }, 0);
}

function closeWeatherCityModal() {
  if (weatherCityModal) weatherCityModal.hidden = true;
}

if (weatherCityBtn) {
  weatherCityBtn.addEventListener('click', openWeatherCityModal);
}

if (cancelWeatherCityBtn) cancelWeatherCityBtn.addEventListener('click', closeWeatherCityModal);

if (weatherCityModal) {
  weatherCityModal.addEventListener('click', function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute('data-close-weather')) {
      closeWeatherCityModal();
    }
  });
}

if (weatherCityForm) {
  weatherCityForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const city = weatherCityInput ? weatherCityInput.value.trim().slice(0, 20) : '';
    if (!city) {
      showSpaceToast('先填一个城市名吧');
      return;
    }
    saveWeatherCity(city);
    closeWeatherCityModal();
    fetchWeather();
  });
}

// ===== 阶段 5.11：应用信息输入（实时同步左上角标题） =====
if (appTitleInput) {
  appTitleInput.addEventListener('input', function () {
    updateAppInfo({ title: appTitleInput.value });
  });
}

if (appSubtitleInput) {
  appSubtitleInput.addEventListener('input', function () {
    updateAppInfo({ subtitle: appSubtitleInput.value });
  });
}

// 字卡库是 cards.js 自己开关的，关掉后同步一次主页状态（不再用 MutationObserver 观察自身属性）
const closeCardsBtnNode = document.getElementById('closeCardsBtn');
if (closeCardsBtnNode) {
  closeCardsBtnNode.addEventListener('click', function () {
    // 等 cards.js 的监听器先关掉面板，再同步主页状态（微任务，不用定时器）
    Promise.resolve().then(updateHomeState);
  });
}

// 时钟按需刷新（进入空间 / 回主页 / 点 Dock 时），不挂常驻定时器
refreshHomeWidgets();

// 阶段 5.11：应用信息恢复 + 天气首屏拉取一次
loadAppInfo();
applyAppInfo();
syncAppInfoInputs();
loadWeatherCity();
if (weatherCityBtn) weatherCityBtn.textContent = weatherState.city;
fetchWeather();

// =====================================================================
// 阶段 5.7：朋友圈（按联系人隔离的本地数据 + 毛玻璃面板）
// 只读写自己的存储项，不动聊天记录与字卡
// =====================================================================
const MOMENTS_STORAGE_KEY = 'mochi-chat-moments-v1';

const MOMENTS_SIGNATURES = {
  mochi: '把日子过成软软的',
  rabbit: '奶油味的小事',
  bear: '慢慢走，慢慢看'
};

// 封面配色：优先按联系人 id，其次按头像色的色系
const MOMENTS_COVERS = {
  mochi: ['#8D6FC0', '#2A2340'],
  rabbit: ['#C98FB4', '#3A2436'],
  bear: ['#5C7FA8', '#253246'],
  pink: ['#C98FB4', '#3A2436'],
  purple: ['#8D6FC0', '#2A2340'],
  blue: ['#5C7FA8', '#253246'],
  mint: ['#6FAF9A', '#213530'],
  yellow: ['#C7A85E', '#332B1E']
};

// 首次打开时铺的示例动态（之后都以 localStorage 为准）
const MOMENTS_SEEDS = {
  mochi: [
    {
      content: '今天把窗帘换成奶白色的，阳光落进来像一块焦糖布丁。',
      hoursAgo: 5,
      likes: ['rabbit'],
      comments: [{ user: 'rabbit', text: '听起来好甜，想去看一眼' }]
    },
    {
      content: '楼下新开的面包店，出炉的时候整条街都是黄油味。',
      hoursAgo: 27,
      likes: ['me'],
      comments: []
    },
    {
      content: '夜里三点还醒着，听见风把晾衣架吹得叮当响。',
      hoursAgo: 52,
      likes: [],
      comments: [{ user: 'bear', text: '早点睡呀' }]
    }
  ],
  rabbit: [
    {
      content: '试做了三次奶油卷，这次的弧度终于像样了。',
      hoursAgo: 3,
      likes: ['mochi', 'me'],
      comments: [{ user: 'mochi', text: '留一个给我！' }]
    },
    {
      content: '把烤箱调到 160 度的时候，整个厨房都在发光。',
      hoursAgo: 30,
      likes: ['bear'],
      comments: []
    }
  ],
  bear: [
    {
      content: '凌晨的便利店只有关东煮在冒热气，很安心。',
      hoursAgo: 8,
      likes: ['rabbit'],
      comments: [{ user: 'rabbit', text: '下次带我一个' }]
    },
    {
      content: '沿着河边走了四十分钟，风很轻，什么都没想。',
      hoursAgo: 40,
      likes: ['me'],
      comments: []
    }
  ]
};

let momentsStore = {};
let momentsContactId = '';
let momentsCommentingId = '';

function makeMomentId() {
  return 'moment-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000);
}

function normalizeMoment(item) {
  if (!item || typeof item !== 'object') return null;
  const content = String(item.content || '').trim();
  if (content === '') return null;

  const likes = [];
  (Array.isArray(item.likes) ? item.likes : []).forEach(function (user) {
    const name = String(user || '');
    if (name !== '' && likes.indexOf(name) === -1) likes.push(name);
  });

  const comments = [];
  (Array.isArray(item.comments) ? item.comments : []).forEach(function (comment) {
    if (!comment || typeof comment !== 'object') return;
    const text = String(comment.text || '').trim();
    if (text === '') return;
    comments.push({
      id: typeof comment.id === 'string' && comment.id !== '' ? comment.id : makeMomentId(),
      user: comment.user === 'me' ? 'me' : String(comment.user || 'contact'),
      text: text.slice(0, 100)
    });
  });

  return {
    id: typeof item.id === 'string' && item.id !== '' ? item.id : makeMomentId(),
    content: content.slice(0, 300),
    images: [],
    timestamp: Number(item.timestamp) || Date.now(),
    author: item.author === 'me' ? 'me' : 'contact',
    likes: likes,
    comments: comments
  };
}

function buildSeedMoments(contactId) {
  const seeds = MOMENTS_SEEDS[contactId] || [];
  return seeds.map(function (seed, index) {
    return normalizeMoment({
      id: 'seed-' + contactId + '-' + index,
      content: seed.content,
      timestamp: Date.now() - (Number(seed.hoursAgo) || 1) * 3600 * 1000,
      likes: seed.likes || [],
      comments: seed.comments || []
    });
  }).filter(Boolean);
}

function loadMoments() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(MOMENTS_STORAGE_KEY) || 'null');
  } catch (error) {
    saved = null;
  }

  momentsStore = (saved && typeof saved === 'object') ? saved : {};
  let changed = false;

  contacts.forEach(function (contact) {
    const list = momentsStore[contact.id];
    if (!Array.isArray(list)) {
      // 没有就铺示例数据，保证第一次打开不是空的
      momentsStore[contact.id] = buildSeedMoments(contact.id);
      changed = true;
      return;
    }

    const cleaned = list.map(normalizeMoment).filter(Boolean);
    if (cleaned.length !== list.length) changed = true;
    momentsStore[contact.id] = cleaned;
  });

  if (changed) saveMoments();
}

function saveMoments() {
  try {
    localStorage.setItem(MOMENTS_STORAGE_KEY, JSON.stringify(momentsStore));
  } catch (error) {
    // 存不了就只在本次会话生效
  }
}

function getMomentsOf(contactId) {
  const list = momentsStore[contactId];
  return Array.isArray(list) ? list : [];
}

function getMomentName(user) {
  if (user === 'me') return meProfile.name || '我';
  const contact = getContactById(user);
  return contact ? contact.name : '朋友';
}

// 阶段 5.9：个性签名 —— 优先从该联系人字卡库 type === 'signature' 的卡随机抽一条，
// 没配就退回内置签名；每次打开面板都会重新抽
function pickMomentSignature(contactId) {
  try {
    const lib = window.MochiChatCards;
    if (lib && typeof lib.getCardsOf === 'function') {
      const pool = (lib.getCardsOf(contactId) || []).filter(function (card) {
        return card && card.type === 'signature' &&
          typeof card.content === 'string' && card.content.trim() !== '';
      });
      if (pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)].content.trim().slice(0, 40);
      }
    }
  } catch (error) {
    // 字卡库读不到就退回内置签名
  }
  return MOMENTS_SIGNATURES[contactId] || '记录一点小事';
}

function formatMomentTime(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (!isFinite(diff) || diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 3600 * 1000) return Math.floor(diff / 86400000) + ' 天前';

  const date = new Date(Number(timestamp));
  return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
}

function buildMomentNode(contact, moment) {
  const wrap = el('article', 'moment');
  const isMine = moment.author === 'me';
  const authorName = isMine ? (meProfile.name || '我') : contact.name;
  const authorAvatar = isMine ? meProfile.avatar : contact.avatar;
  const authorClass = isMine ? 'avatar avatar-me' : 'avatar avatar-' + contact.avatarColor;

  wrap.appendChild(applyAvatar(el('div'), authorAvatar, firstChar(authorName), authorClass + ' moment-avatar'));

  const body = el('div', 'moment-body');
  body.appendChild(el('span', 'moment-author', authorName));
  body.appendChild(el('p', 'moment-text', moment.content));

  const meta = el('div', 'moment-meta');
  meta.appendChild(el('span', 'moment-time', formatMomentTime(moment.timestamp)));

  const liked = moment.likes.indexOf('me') !== -1;
  const likeBtn = el('button', 'moment-action' + (liked ? ' is-active' : ''), liked ? '取消赞' : '赞');
  likeBtn.type = 'button';
  likeBtn.dataset.likeId = moment.id;
  meta.appendChild(likeBtn);

  const commentBtn = el('button', 'moment-action', '评论');
  commentBtn.type = 'button';
  commentBtn.dataset.commentId = moment.id;
  meta.appendChild(commentBtn);

  body.appendChild(meta);

  if (moment.likes.length > 0) {
    const likes = el('div', 'moment-likes');
    likes.appendChild(el('span', 'moment-likes-heart', '♥'));
    likes.appendChild(el('span', '', moment.likes.map(getMomentName).join('、')));
    body.appendChild(likes);
  }

  if (moment.comments.length > 0) {
    const comments = el('div', 'moment-comments');
    moment.comments.forEach(function (comment) {
      const line = el('div', 'moment-comment');
      line.appendChild(el('b', '', getMomentName(comment.user) + '：'));
      line.appendChild(document.createTextNode(comment.text));
      comments.appendChild(line);
    });
    body.appendChild(comments);
  }

  // 点「评论」后只在这一条下面展开输入框
  if (momentsCommentingId === moment.id) {
    const form = el('form', 'moment-comment-form');
    const input = el('input', 'moment-comment-input');
    input.type = 'text';
    input.maxLength = 100;
    input.placeholder = '说点什么…';
    input.dataset.commentInputId = moment.id;

    const send = el('button', 'moment-comment-send', '发送');
    send.type = 'submit';

    form.appendChild(input);
    form.appendChild(send);
    body.appendChild(form);
  }

  wrap.appendChild(body);
  return wrap;
}

function renderMomentsPanel() {
  const contact = getContactById(momentsContactId || currentId);
  if (!contact || !momentsPanel) return;

  momentsContactId = contact.id;

  applyAvatar(
    momentsAvatar,
    contact.avatar,
    firstChar(contact.name),
    'avatar avatar-' + contact.avatarColor + ' moments-avatar'
  );
  momentsName.textContent = contact.name;
  momentsSignature.textContent = pickMomentSignature(contact.id);

  // 阶段 5.9：自定义封面（base64）优先，没传就用默认渐变色
  const spaceConfig = normalizeSpaceConfig(contact);
  if (spaceConfig.momentsCover) {
    momentsCover.style.background = 'url(' + spaceConfig.momentsCover + ') center / cover no-repeat';
  } else {
    const cover = MOMENTS_COVERS[contact.id] || MOMENTS_COVERS[contact.avatarColor] || ['#8D6FC0', '#2A2340'];
    momentsCover.style.background =
      'radial-gradient(120% 140% at 15% 0%, rgba(255, 255, 255, 0.3), transparent 62%),' +
      ' linear-gradient(135deg, ' + cover[0] + ' 0%, ' + cover[1] + ' 100%)';
  }

  momentsList.innerHTML = '';
  const list = getMomentsOf(contact.id)
    .slice()
    .sort(function (a, b) { return b.timestamp - a.timestamp; });

  if (list.length === 0) {
    momentsList.appendChild(el('p', 'moments-empty', '还没有动态，发一条试试'));
    return;
  }

  list.forEach(function (moment) {
    momentsList.appendChild(buildMomentNode(contact, moment));
  });
}

function openMomentsPanel(contactId) {
  const contact = getContactById(contactId || currentId);
  if (!contact || !momentsPanel) return;

  momentsContactId = contact.id;
  momentsCommentingId = '';
  if (momentsCompose) momentsCompose.hidden = true;

  momentsPanel.hidden = false;

  // 阶段 5.9.1：点开面板时兜底，别让用户看到空列表
  const list = getMomentsOf(contact.id);
  if (list.length === 0) {
    // 一条都没有：无视概率和冷却，确保至少能看到一条梦角的动态
    maybeAutoPostMoment(contact, { force: true, ignoreChance: true });
  } else {
    const newest = list.reduce(function (max, item) {
      return Math.max(max, Number(item.timestamp) || 0);
    }, 0);
    // 最新一条超过 2 小时：无视冷却再判一次（概率照常生效）
    if (Date.now() - newest >= 2 * 60 * 60 * 1000) {
      maybeAutoPostMoment(contact, { force: true });
    }
  }

  renderMomentsPanel();
}

function closeMomentsPanel() {
  if (momentsPanel) momentsPanel.hidden = true;
  momentsCommentingId = '';
}

function toggleMomentLike(momentId) {
  const moment = getMomentsOf(momentsContactId).filter(function (item) {
    return item.id === momentId;
  })[0];
  if (!moment) return false;

  const index = moment.likes.indexOf('me');
  if (index === -1) moment.likes.push('me');
  else moment.likes.splice(index, 1);

  saveMoments();
  renderMomentsPanel();
  return true;
}

function addMomentComment(momentId, text) {
  const content = String(text || '').trim().slice(0, 100);
  if (content === '') return false;

  const moment = getMomentsOf(momentsContactId).filter(function (item) {
    return item.id === momentId;
  })[0];
  if (!moment) return false;

  moment.comments.push({ id: makeMomentId(), user: 'me', text: content });
  momentsCommentingId = '';
  saveMoments();
  renderMomentsPanel();
  return true;
}

// ===== 阶段 5.7.2：梦角自动发圈 / 自动点赞评论 =====
const MOMENTS_AUTO_COOLDOWN = 60 * 60 * 1000;    // 同一联系人 1 小时内最多自动发 1 条
const MOMENTS_CHECK_INTERVAL = 5 * 60 * 1000;    // 每 5 分钟检查一次
const MOMENTS_REACTION_MIN = 5000;               // 我发完动态后，梦角 5-10 秒内反应
const MOMENTS_REACTION_MAX = 10000;

// 发圈文案池：按当前状态挑，找不到就用 general
const MOMENTS_AUTO_TEXTS = {
  online: [
    '路过一家亮着灯的小店，买了杯热的。',
    '今天的云像被谁揉过，很软。',
    '把桌面收拾干净，心里也空出一块地方。',
    '窗台上的绿萝又长出一片新叶子。'
  ],
  busy: [
    '事情堆到明天再说，先喝口水。',
    '忙到没顾上吃饭，一看已经三点了。',
    '今天的时间好像被人按了快进。'
  ],
  away: [
    '出门走走，风比想象中凉。',
    '等红灯的时候看见一只很胖的猫。',
    '绕着小区走了两圈，路灯一盏盏亮起来。'
  ],
  sleeping: [
    '晚安，剩下的明天再想。',
    '关灯之后，房间安静得能听见呼吸。',
    '又是这个点，睡不着就来发条朋友圈。'
  ],
  general: [
    '记一件很小的事。',
    '今天也还不错。',
    '随手一拍。'
  ]
};

// 评论话术池：按联系人各有一套，缺省用 general
const MOMENTS_REPLY_TEXTS = {
  mochi: ['真好看！', '这是哪里呀？', '我也想去看看', '看饿了…', '拍得真好'],
  rabbit: ['好甜的画面', '下次带我一个', '这是哪里呀？', '看饿了…'],
  bear: ['嗯，风确实凉了', '早点休息', '这个角度不错', '记下了'],
  general: ['真好看！', '这是哪里呀？', '下次带我一个', '记下了']
};

// 挑一条发圈文案：优先用该联系人字卡库里 type === 'moment_post' 的卡，
// 一张都没有（或字卡库读不到）就退回按状态分类的硬编码文案池，保证永远有内容可发
function pickMomentText(contact) {
  try {
    const lib = window.MochiChatCards;
    if (lib && typeof lib.getCardsOf === 'function') {
      const cards = lib.getCardsOf(contact.id) || [];
      const pool = cards.filter(function (card) {
        return card && card.type === 'moment_post' &&
          typeof card.content === 'string' && card.content.trim() !== '';
      });
      if (pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)].content.trim().slice(0, 300);
      }
    }
  } catch (error) {
    // 字卡库读不到就当没有，继续走内置文案池
  }

  const status = getStatusOf(contact.id);
  const list = MOMENTS_AUTO_TEXTS[status.id] || MOMENTS_AUTO_TEXTS.general;
  const pool = (list && list.length > 0) ? list : MOMENTS_AUTO_TEXTS.general;
  const text = pool[Math.floor(Math.random() * pool.length)];
  return (typeof text === 'string' && text !== '') ? text : '记一件很小的事。';
}

// 概率 + 冷却双闸门：页面加载 / 切换联系人 / 定时器都会来问一次
// options.force       —— 无视冷却
// options.ignoreChance —— 连概率也无视（测试按钮 / 空面板兜底用）
function maybeAutoPostMoment(contact, options) {
  if (!contact) return false;

  const opts = options || {};
  const config = normalizeSpaceConfig(contact).momentsConfig;

  if (!opts.ignoreChance) {
    if (!config.autoPostChance) return false;
    if (Math.random() * 100 >= config.autoPostChance) return false;
  }

  const now = Date.now();
  if (!opts.force && now - config.lastAutoPostAt < MOMENTS_AUTO_COOLDOWN) return false;

  // 偶尔带一位朋友的点赞，免得看起来没人理
  const likes = [];
  if (Math.random() < 0.6) {
    const others = contacts.filter(function (item) { return item.id !== contact.id; });
    if (others.length > 0) likes.push(others[Math.floor(Math.random() * others.length)].id);
  }

  if (!Array.isArray(momentsStore[contact.id])) momentsStore[contact.id] = [];
  const moment = {
    id: makeMomentId(),
    content: pickMomentText(contact),
    images: [],
    timestamp: now,
    author: 'contact',
    likes: likes,
    comments: []
  };
  momentsStore[contact.id].unshift(moment);

  config.lastAutoPostAt = now;
  saveMoments();
  saveSpaceConfigs();

  if (momentsPanel && !momentsPanel.hidden && momentsContactId === contact.id) {
    renderMomentsPanel();
  }

  // 阶段 5.9.2：梦角自动发圈后，其他角色也可能按各自概率来点赞 / 评论
  // （开关、抽取人数、延迟 3-8 秒、moment_reply 字卡话术都由 scheduleCrossInteractions 统一处理）
  scheduleCrossInteractions(contact.id, moment.id);

  return true;
}

// 我发完动态后，梦角延迟 5-10 秒按概率点赞 / 评论
// 阶段 5.8/5.9 共用：某个联系人发评论时的话术池 ——
// 优先用他自己字卡库里 type === 'moment_reply' 的卡，没配再退回内置话术
function collectReplyPool(contactId) {
  let pool = MOMENTS_REPLY_TEXTS[contactId] || MOMENTS_REPLY_TEXTS.general;
  try {
    const lib = window.MochiChatCards;
    if (lib && typeof lib.getCardsOf === 'function') {
      const replies = (lib.getCardsOf(contactId) || []).filter(function (card) {
        return card && card.type === 'moment_reply' &&
          typeof card.content === 'string' && card.content.trim() !== '';
      });
      if (replies.length > 0) {
        pool = replies.map(function (card) { return card.content.trim(); });
      }
    }
  } catch (error) {
    // 字卡库读不到就退回内置话术
  }
  return pool;
}

// 阶段 5.9：我发动态后，除了当前联系人，再随机抽 1-2 个其他角色来互动。
// 各自按自己的概率点赞，评论从他们自己的 moment_reply 字卡里抽，延迟 3-8 秒依次出现。
function scheduleCrossInteractions(ownerId, momentId) {
  const owner = getContactById(ownerId);
  if (!owner) return false;

  const config = getMomentsConfigOf(ownerId);
  if (!config.enableCrossInteraction) return false;

  const others = contacts.filter(function (item) { return item.id !== ownerId; });
  if (others.length === 0) return false;

  // 随机抽 1-2 个（只有一个候选时就只抽 1 个）
  const shuffled = others.slice().sort(function () { return Math.random() - 0.5; });
  const takeTwo = others.length > 1 && Math.random() < 0.5;
  const picked = shuffled.slice(0, takeTwo ? 2 : 1);

  picked.forEach(function (contact, index) {
    // 基础 3-6 秒随机，第二个角色再错开 2 秒，整体落在 3-8 秒、依次出现
    const delay = 3000 + Math.floor(Math.random() * 3000) + index * 2000;

    setTimeout(function () {
      const moment = getMomentsOf(ownerId).filter(function (item) {
        return item.id === momentId;
      })[0];
      if (!moment) return;

      // 各自的概率在回调那一刻读取，中途改滑块也生效
      const live = getMomentsConfigOf(contact.id);
      let changed = false;

      if (Math.random() * 100 < live.likeChance && moment.likes.indexOf(contact.id) === -1) {
        moment.likes.push(contact.id);
        changed = true;
      }

      if (Math.random() * 100 < live.commentChance) {
        const pool = collectReplyPool(contact.id);
        moment.comments.push({
          id: makeMomentId(),
          user: contact.id,
          text: pool[Math.floor(Math.random() * pool.length)]
        });
        changed = true;
      }

      if (!changed) return;

      saveMoments();
      if (momentsPanel && !momentsPanel.hidden && momentsContactId === ownerId) {
        renderMomentsPanel();
      }
    }, delay);
  });

  return true;
}

function scheduleMomentsReaction(contactId, momentId) {
  const contact = getContactById(contactId);
  if (!contact) return false;

  const config = getMomentsConfigOf(contactId);
  if (!config.likeChance && !config.commentChance) return false;

  const delay = MOMENTS_REACTION_MIN +
    Math.floor(Math.random() * (MOMENTS_REACTION_MAX - MOMENTS_REACTION_MIN + 1));

  setTimeout(function () {
    const moment = getMomentsOf(contactId).filter(function (item) {
      return item.id === momentId;
    })[0];
    if (!moment) return;

    // 用触发那一刻的配置，用户中途改滑块也能生效
    const live = getMomentsConfigOf(contactId);
    let changed = false;

    if (Math.random() * 100 < live.likeChance && moment.likes.indexOf(contactId) === -1) {
      moment.likes.push(contactId);
      changed = true;
    }

    if (Math.random() * 100 < live.commentChance) {
      // 阶段 5.8：评论优先用该联系人字卡库 type === 'moment_reply' 的卡，没配再退回内置话术
      const pool = collectReplyPool(contactId);

      moment.comments.push({
        id: makeMomentId(),
        user: contactId,
        text: pool[Math.floor(Math.random() * pool.length)]
      });
      changed = true;
    }

    if (!changed) return;

    saveMoments();
    if (momentsPanel && !momentsPanel.hidden && momentsContactId === contactId) {
      renderMomentsPanel();
    }
  }, delay);

  return true;
}

// 每 5 分钟给所有联系人一次自动发圈机会（1 小时冷却，最多 1 条/小时）
function startMomentsScheduler() {
  setInterval(function () {
    contacts.forEach(function (contact) {
      maybeAutoPostMoment(contact);
    });
  }, MOMENTS_CHECK_INTERVAL);
}

function publishMoment() {
  const text = momentsComposeText ? String(momentsComposeText.value).trim().slice(0, 300) : '';
  if (text === '') {
    showSpaceToast('写点什么再发吧');
    return false;
  }

  const list = momentsStore[momentsContactId];
  if (!Array.isArray(list)) {
    momentsStore[momentsContactId] = [];
  }

  // 自己的动态挂在当前联系人的列表里，标记 author 方便用我的头像和昵称显示
  const moment = {
    id: makeMomentId(),
    content: text,
    images: [],
    timestamp: Date.now(),
    author: 'me',
    likes: [],
    comments: []
  };
  momentsStore[momentsContactId].unshift(moment);

  if (momentsComposeText) momentsComposeText.value = '';
  if (momentsComposeCount) momentsComposeCount.textContent = '0/300';
  if (momentsCompose) momentsCompose.hidden = true;

  saveMoments();
  renderMomentsPanel();

  // 阶段 5.7.2：发完立刻给梦角排一次「延迟反应」
  scheduleMomentsReaction(momentsContactId, moment.id);
  // 阶段 5.9：再随机抽 1-2 个其他角色来互动（可全局按联系人关闭）
  scheduleCrossInteractions(momentsContactId, moment.id);
  return true;
}

// 头像 = 朋友圈入口
if (chatAvatar) {
  chatAvatar.classList.add('moments-entry');
  chatAvatar.setAttribute('role', 'button');
  chatAvatar.setAttribute('tabindex', '0');
  chatAvatar.setAttribute('title', '查看朋友圈');

  chatAvatar.addEventListener('click', function () {
    openMomentsPanel(currentId);
  });
  chatAvatar.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMomentsPanel(currentId);
    }
  });
}

if (momentsCloseBtn) momentsCloseBtn.addEventListener('click', closeMomentsPanel);

// ===== 阶段 5.9：更换朋友圈封面（base64 存进 spaceConfig.momentsCover） =====
if (momentsCoverBtn && momentsCoverInput) {
  momentsCoverBtn.addEventListener('click', function () {
    momentsCoverInput.value = '';
    momentsCoverInput.click();
  });

  momentsCoverInput.addEventListener('change', function () {
    const file = momentsCoverInput.files && momentsCoverInput.files[0];
    if (!file) return;

    if (file.type && file.type.indexOf('image/') !== 0) {
      showSpaceToast('只能选图片哦');
      return;
    }
    // localStorage 总量约 5MB，base64 还会再膨胀 1/3，超过 1.5MB 直接拦下
    if (file.size > 1.5 * 1024 * 1024) {
      showSpaceToast('图片太大了（超过 1.5MB），换一张小的吧');
      return;
    }

    const reader = new FileReader();
    reader.onload = function () {
      const dataUrl = String(reader.result || '');
      const contact = getContactById(momentsContactId || currentId);
      if (!contact || !dataUrl) return;

      const config = normalizeSpaceConfig(contact);
      config.momentsCover = dataUrl;
      saveSpaceConfigs();
      renderMomentsPanel();
      showSpaceToast('封面已更新');
    };
    reader.onerror = function () {
      showSpaceToast('这张图读不出来，换一张试试');
    };
    reader.readAsDataURL(file);
  });
}

// 点面板外的暗色区域关闭
if (momentsPanel) {
  momentsPanel.addEventListener('click', function (event) {
    if (event.target === momentsPanel) closeMomentsPanel();
  });
}

if (momentsPublishBtn) {
  momentsPublishBtn.addEventListener('click', function () {
    if (!momentsCompose) return;
    momentsCompose.hidden = !momentsCompose.hidden;
    if (!momentsCompose.hidden && momentsComposeText) momentsComposeText.focus();
  });
}

if (momentsComposeText) {
  momentsComposeText.addEventListener('input', function () {
    if (momentsComposeCount) {
      momentsComposeCount.textContent = momentsComposeText.value.length + '/300';
    }
  });
}

if (momentsComposeCancel) {
  momentsComposeCancel.addEventListener('click', function () {
    if (momentsCompose) momentsCompose.hidden = true;
  });
}

if (momentsComposeSubmit) momentsComposeSubmit.addEventListener('click', publishMoment);

// 点赞 / 展开评论输入框
if (momentsList) {
  momentsList.addEventListener('click', function (event) {
    const target = event.target;
    if (!target || !target.dataset) return;

    if (target.dataset.likeId) {
      toggleMomentLike(target.dataset.likeId);
      return;
    }

    if (target.dataset.commentId) {
      momentsCommentingId = momentsCommentingId === target.dataset.commentId ? '' : target.dataset.commentId;
      renderMomentsPanel();

      const input = momentsList.querySelector('[data-comment-input-id="' + momentsCommentingId + '"]');
      if (input) input.focus();
    }
  });

  momentsList.addEventListener('submit', function (event) {
    const form = event.target;
    if (!form || !form.classList || !form.classList.contains('moment-comment-form')) return;
    event.preventDefault();

    const input = form.querySelector('.moment-comment-input');
    if (input) addMomentComment(input.dataset.commentInputId, input.value);
  });
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && momentsPanel && !momentsPanel.hidden) closeMomentsPanel();
});

// ===== 10. 打开页面时先渲染一次 =====
loadMeProfile();     // 阶段 5.5：先恢复「我」的资料，再渲染消息头像
loadStatusConfigs(); // 阶段 5.6：先恢复联系人状态，再渲染列表与顶部
loadMoments();       // 阶段 5.7：恢复朋友圈数据（没有就铺示例）

// 阶段 5.7.2：进页面先给当前联系人一次自动发圈判定，之后每 5 分钟检查一次
maybeAutoPostMoment(getContactById(currentId));
startMomentsScheduler();
loadSpaceConfigs();
renderMeProfile();
renderSpaceOptions();
syncProfilePanel();
renderAll();
applySpace();
applySpaceLight();
applyChatStyle();

// 阶段 5.4：默认直接进入当前联系人的桌面视图（背景 + 小组件 + Dock）
enterSpace(currentId);

// 阶段 5.6：状态定时器 —— 立即跑一次，之后每分钟检查时间规则
startStatusScheduler();

// ===== 11. 对外接口 =====
// 给 cards.js（字卡库）使用，聊天功能本身不依赖它
window.MochiChat = {
  getContacts: function () {
    return contacts;
  },
  getContactById: getContactById,
  getCurrentContact: function () {
    return getContactById(currentId);
  },
  // 阶段 5.10：联系人系统
  getCurrentId: function () {
    return currentId;
  },
  createContact: createContact,
  getMeProfile: function () {
    return meProfile;
  },
  getAppElement: function () {
    return app;
  },

  // 阶段 5.1：空间模式
  enterSpace: enterSpace,
  exitSpace: exitSpace,
  isSpaceMode: function () {
    return app.classList.contains('show-space');
  },
  getSpaceConfig: function (id) {
    const contact = getContactById(id || currentId);
    return contact ? normalizeSpaceConfig(contact) : null;
  },
  setSpaceBackground: setSpaceBackground,
  getSpaceBackgrounds: function () {
    return SPACE_BACKGROUNDS.slice();
  },

  // 阶段 5.2：房间与光影
  getSpaceLightPhase: function () {
    return spaceLightPhase;
  },
  setSpaceLightHour: function (hour) {
    applySpaceLight(hour);
    return spaceLightPhase;
  },
  setSpaceChat: setSpaceChat,
  isSpaceChatOpen: function () {
    return app.classList.contains('chat-open');
  },

  // 阶段 5.3：聊天外观
  getChatStyle: getChatStyleOf,
  setChatStyle: updateChatStyle,
  openStylePanel: openStylePanel,
  closeStylePanel: closeStylePanel,
  getBubbleColors: function () {
    return BUBBLE_COLORS.slice();
  },
  getPaperStyles: function () {
    return PAPER_STYLES.slice();
  },
  // 兼容旧接口名
  getLetterStyles: function () {
    return PAPER_STYLES.slice();
  },
  setBgOpacity: setSpaceBgOpacity,
  setPanelOpacity: setPanelOpacity,

  // 阶段 5.6：角色状态
  getStatusConfig: function (id) {
    const contact = getContactById(id || currentId);
    return contact ? normalizeStatusConfig(contact) : null;
  },
  getStatuses: function (id) {
    const contact = getContactById(id || currentId);
    return contact ? getStatusesOf(contact) : DEFAULT_STATUSES.slice();
  },
  getStatusOf: getStatusOf,
  // 阶段 5.6.2：某个状态的回复行为（延迟 / 概率 / 加权），不传 statusId 取当前状态
  getStatusBehavior: function (contactId, statusId) {
    const contact = getContactById(contactId || currentId);
    return getStatusBehaviorOf(contact, statusId || (contact ? contact.statusConfig.current : ''));
  },
  updateStatusBehavior: function (contactId, statusId, patch) {
    const wanted = getContactById(contactId || currentId);
    if (wanted && wanted.id === currentId) {
      return updateStatusBehavior(statusId, patch);
    }
    // 别的联系人：临时切 current 再改回来，行为数据本身是按联系人存的
    const keep = currentId;
    currentId = wanted ? wanted.id : currentId;
    const result = updateStatusBehavior(statusId, patch);
    currentId = keep;
    return result;
  },
  setContactStatus: function (id, statusId) {
    const status = setContactStatus(id, statusId);
    return status ? status.id : null;
  },
  addCustomStatus: addCustomStatus,
  removeCustomStatus: removeCustomStatus,
  addStatusSchedule: addStatusSchedule,
  removeStatusSchedule: removeStatusSchedule,
  runStatusSchedule: runStatusSchedule,
  getDefaultStatuses: function () {
    return DEFAULT_STATUSES.slice();
  },

  // 阶段 5.7：朋友圈
  getMoments: function (contactId) {
    return getMomentsOf(contactId || currentId);
  },
  openMoments: openMomentsPanel,
  closeMoments: closeMomentsPanel,
  toggleMomentLike: toggleMomentLike,
  addMomentComment: addMomentComment,
  publishMoment: publishMoment,

  // 阶段 5.7.2：朋友圈互动概率与自动行为
  getMomentsConfig: getMomentsConfigOf,
  setMomentsChance: setMomentsChance,
  setMomentsCrossToggle: setMomentsCrossToggle,
  maybeAutoPostMoment: maybeAutoPostMoment,
  scheduleMomentsReaction: scheduleMomentsReaction,

  // 阶段 5.4：主控台
  goHome: goHome,
  openChatPanel: openChatPanel,
  toggleContactsPanel: toggleContactsPanel,
  openCardsPanel: openCardsPanel,
  openSettingsPanel: openSettingsPanel,
  closeSettingsPanel: closeSettingsPanel,
  isSettingsOpen: function () {
    return !settingsPanel.hidden;
  },
  isHomeView: isHomeView,
  getActiveDock: function () {
    const map = { dockHomeBtn: 'home', dockChatBtn: 'chat', dockContactsBtn: 'contacts', dockCardsBtn: 'cards', dockSettingsBtn: 'settings' };
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
      const node = document.getElementById(keys[i]);
      if (node && node.classList.contains('is-active')) return map[keys[i]];
    }
    return '';
  },
  refreshHomeClock: function (date) {
    refreshHomeClock(date instanceof Date ? date : undefined);
    return homeClock ? homeClock.textContent : '';
  },
  getHomeQuote: function () {
    return homeQuoteText ? homeQuoteText.textContent : '';
  }
};

// 阶段 5.8：首屏渲染时 cards.js 还没加载，情话卡读不到只能先显示默认句；
// 这里等所有脚本执行完再刷新一次，让真正的情话卡上桌
setTimeout(function () {
  refreshHomeWidgets();
}, 0);

// ==========================================================================
// 阶段 6：移动端视口 / 软键盘适配
// 把可视高度写进 --app-vh，让 .app 与全屏聊天面板跟着键盘一起缩短，
// 输入框与最新消息不会被软键盘盖住（iOS Safari + 安卓 Chrome 都适用）
// ==========================================================================
(function () {
  const rootStyle = document.documentElement.style;

  function isMobile() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 768px)').matches;
  }

  function syncViewportHeight() {
    const vv = window.visualViewport;
    const height = vv && vv.height ? vv.height : window.innerHeight;
    if (!height) return;
    rootStyle.setProperty('--app-vh', Math.round(height) + 'px');

    // 可视高度比布局视口矮一大截 = 软键盘弹出，收起 Dock 让聊天面板贴住键盘
    const shrunk = window.innerHeight - height;
    const keyboardOpen = isMobile() && shrunk > 140;
    if (document.body) {
      document.body.classList.toggle('keyboard-open', keyboardOpen);
    }
  }

  // 键盘弹出后把最新消息顶到可视区里
  function keepLatestMessageVisible() {
    if (!isMobile()) return;
    const input = document.getElementById('input');
    if (!input || document.activeElement !== input) return;
    const messages = document.getElementById('messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('orientationchange', function () {
    setTimeout(syncViewportHeight, 150);
    setTimeout(keepLatestMessageVisible, 320);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      syncViewportHeight();
      keepLatestMessageVisible();
    });
    window.visualViewport.addEventListener('scroll', function () {
      syncViewportHeight();
      keepLatestMessageVisible();
    });
  }

  // 聚焦输入框后等键盘动画结束再垫一次底
  document.addEventListener('focusin', function (event) {
    if (!event.target || event.target.id !== 'input') return;
    setTimeout(function () {
      syncViewportHeight();
      keepLatestMessageVisible();
    }, 260);
  });

  syncViewportHeight();
})();

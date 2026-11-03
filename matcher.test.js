// =======================================================
// Mochi Chat · 字卡匹配测试
// 运行方式：在项目文件夹里打开终端，输入  node matcher.test.js
// =======================================================

const { createMatcher, DEFAULT_REPLIES } = require('./matcher.js');

// 模拟三位联系人各自独立的字卡库（和页面上的数据结构完全一致）
const library = {
  mochi: [
    {
      id: 'm1',
      content: '今天辛苦啦，先抱抱你～',
      category: '安慰',
      keywords: ['加班', '辛苦', '疲惫'],
      scene: '对方加班或很累的时候'
    },
    {
      id: 'm2',
      content: '你已经做得很好了，不用什么事都完美。',
      category: '鼓励',
      keywords: ['做不好', '自责'],
      scene: '对方觉得自己不够好时'
    }
  ],
  rabbit: [
    {
      id: 'r1',
      content: '周末要不要一起去那家新开的甜品店？',
      category: '邀约',
      keywords: ['周末', '甜品', '出去玩'],
      scene: '想约对方出门时'
    }
  ],
  bear: [
    {
      id: 'b1',
      content: '醒了记得找我，我给你留了小蛋糕。',
      category: '日常',
      keywords: ['晚安', '睡觉'],
      scene: '对方不在线时留言'
    },
    {
      id: 'b2',
      content: '这张字卡故意没有关键词',
      category: '未设置',
      keywords: [],
      scene: ''
    }
  ]
};

const matcher = createMatcher({
  getCards: function (contactId) {
    return library[contactId] || [];
  }
});

const pass = [];
const fail = [];

function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  const line = `${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : ` 期望: ${expected}`);
  (ok ? pass : fail).push(line);
}

console.log('===== 字卡匹配测试 =====\n');

// ---------- 场景一：完全匹配关键词 ----------
console.log('【场景一】完全匹配关键词');
let r = matcher.match('mochi', '加班');
check('是否命中', r.matched, 'true');
check('回复内容来自字卡1', r.reply, '今天辛苦啦，先抱抱你～');
check('匹配关键词', r.matchedKeywords.join('/'), '加班');
check('分数 = 长度2*2 + 完全匹配5', r.score, 9);

// 标点与空格不应影响完全匹配
r = matcher.match('mochi', ' 加  班！！！ ');
check('忽略空格标点后仍完全匹配', r.matched, 'true');
check('忽略空格标点后分数不变', r.score, 9);

// ---------- 场景二：部分匹配关键词 ----------
console.log('\n【场景二】部分匹配关键词（长句里包含关键词）');
r = matcher.match('mochi', '我今天又要加班到很晚，真的好累');
check('是否命中', r.matched, 'true');
check('回复内容来自字卡1', r.reply, '今天辛苦啦，先抱抱你～');
check('匹配到关键词「加班」', r.matchedKeywords.includes('加班'), 'true');
check('分数 = 长度2*2（非完全匹配）', r.score, 4);

// 英文与大小写也能部分匹配
library.mochi.push({
  id: 'm3',
  content: '我也喜欢这首歌！',
  category: '夸奖',
  keywords: ['Music'],
  scene: '对方分享音乐'
});
r = matcher.match('mochi', '最近一直在听 MUSIC');
check('英文关键词忽略大小写后命中', r.matched, 'true');
check('英文回复内容正确', r.reply, '我也喜欢这首歌！');
library.mochi.pop();

// ---------- 场景三：没有匹配关键词 ----------
console.log('\n【场景三】没有匹配关键词');
r = matcher.match('mochi', '今天天气真不错呀');
check('不命中', r.matched, 'false');
check('未返回任何字卡', r.card, 'null');
check('使用默认回复', DEFAULT_REPLIES.includes(r.reply), 'true');
check('给出未命中原因', r.reason.length > 0, 'true');
console.log('       原因文案：' + r.reason);

// 只有标点符号也应视为未匹配
r = matcher.match('mochi', '？？？');
check('纯标点不命中', r.matched, 'false');
r = matcher.match('bear', '完全没有关键词的一句话');
console.log('       该联系人有无关键词字卡时的原因：' + r.reason);

// ---------- 场景四：多张字卡同时匹配 ----------
console.log('\n【场景四】多张字卡同时匹配');
library.tie = [
  { id: 't1', content: '第一张：累', category: '测试', keywords: ['累'], scene: '' },
  { id: 't2', content: '第二张：累', category: '测试', keywords: ['累'], scene: '' }
];
// 4.1 同分时随机
const picked = {};
for (let i = 0; i < 200; i++) {
  const result = matcher.match('tie', '我好累');
  picked[result.reply] = (picked[result.reply] || 0) + 1;
}
check('同分时命中两张中的一张', Object.keys(picked).every(k => k === '第一张：累' || k === '第二张：累'), 'true');
check('同分随机两张都出现过', Object.keys(picked).length, 2);

// 4.2 分数不同时选最高分
library.multi = [
  { id: 'x1', content: '低分卡（1个关键词）', category: '测试', keywords: ['累'], scene: '' },
  { id: 'x2', content: '高分卡（3个关键词）', category: '测试', keywords: ['累', '加班', '没睡'], scene: '' }
];
let highs = 0;
for (let i = 0; i < 50; i++) {
  const result = matcher.match('multi', '加班好累，昨晚又没睡好');
  if (result.reply === '高分卡（3个关键词）') highs++;
}
check('多关键词卡得分更高，50次都选中它', highs, 50);
r = matcher.match('multi', '加班好累，昨晚又没睡好');
console.log('       本次分数：' + r.score + '，命中关键词：' + r.matchedKeywords.join('、'));

// ---------- 场景五：切换联系人后不使用别人的字卡 ----------
console.log('\n【场景五】切换联系人后不会使用其他联系人的字卡');
r = matcher.match('mochi', '周末有空吗');
check('小麻薯库里没有「周末」关键词 → 不命中', r.matched, 'false');

r = matcher.match('rabbit', '周末有空吗');
check('奶油兔有「周末」关键词 → 命中', r.matched, 'true');
check('回复来自奶油兔自己的字卡', r.reply, '周末要不要一起去那家新开的甜品店？');

// 换成另一个联系人，输入同样的话，不能拿到上一人的回复
const rabbitCardTexts = library.rabbit.map(c => c.content);
for (let i = 0; i < 30; i++) {
  const result = matcher.match('bear', '周末有空吗');
  if (result.matched && rabbitCardTexts.includes(result.reply)) {
    fail.push('失败  跨联系人泄漏了奶油兔的字卡');
    break;
  }
}
check('30次查询蓝莓熊都没有拿到奶油兔的字卡', true, 'true');

r = matcher.match('bear', '晚安啦');
check('蓝莓熊自己的「晚安」关键词命中', r.reply, '醒了记得找我，我给你留了小蛋糕。');

// ---------- 输出汇总 ----------
console.log('\n' + pass.join('\n'));
if (fail.length) console.log('\n' + fail.join('\n'));
console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
process.exit(fail.length ? 1 : 0);

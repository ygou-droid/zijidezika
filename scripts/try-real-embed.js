// =======================================================
// Mochi Chat · 一次性真实 Embedding 调用验证（脚本本身不会自动运行）
// 运行命令（务必带 --env-file-if-exists=.env）：
//   node --env-file-if-exists=.env scripts/try-real-embed.js
// 说明：本脚本只发起一次批量请求，不做任何重试，避免重复计费
// =======================================================

'use strict';

const { createBailianClient } = require('../lib/bailian.js');
const { cosineSimilarity, validateTexts } = require('../lib/vector.js');

// 本次要比较的两句话
const SENTENCES = [
  '今天工作很累，想休息一下。',
  '今天有点疲惫，想放松一会儿。'
];

(async function main() {
  const client = createBailianClient(); // 密钥与地址均从 process.env 读取，脚本里不出现任何密钥
  const info = client.describe();

  console.log('===== 真实 Embedding 调用验证（仅一次请求，不重试）=====');
  console.log('API 密钥：            ' + (info.hasApiKey ? '已读取（内容不会显示）' : '未检测到'));
  console.log('自定义 Base URL：     ' + (process.env.DASHSCOPE_BASE_URL ? '已配置' : '未配置（使用默认地址）'));

  if (!info.hasApiKey) {
    console.log('');
    console.log('结果：               未调用');
    console.log('原因：               没有检测到 DASHSCOPE_API_KEY。');
    console.log('做法：               复制 .env.example 为 .env，填入你的密钥后重新运行本脚本。');
    process.exit(1);
  }

  // 先本地校验，避免无效请求产生费用
  try {
    validateTexts(SENTENCES, { maxCount: client.maxTexts, maxLength: client.maxTextLength });
  } catch (error) {
    console.log('');
    console.log('结果：               未调用');
    console.log('原因：               ' + (error.message || '输入校验未通过'));
    process.exit(1);
  }

  let embeddings;
  try {
    const result = await client.embedTexts(SENTENCES); // 一次批量请求，两句话一起算
    embeddings = result.embeddings;
    console.log('');
    console.log('请求结果：           成功');
    console.log('模型名称：           ' + result.model);
    console.log('向量数量：           ' + embeddings.length + ' 条');
    console.log('向量维度：           ' + embeddings[0].length);
    console.log('维度是否一致：       ' + (embeddings[0].length === embeddings[1].length ? '是' : '否'));
  } catch (error) {
    // 错误信息统一脱敏后再输出，绝不打印密钥、请求头或完整环境变量
    const code = error.code || '未知错误';
    const safeMessage = client.redact(String(error.message || '')).slice(0, 200);
    console.log('');
    console.log('请求结果：           失败');
    console.log('错误代码：           ' + code);
    console.log('错误信息（已脱敏）： ' + safeMessage);
    process.exit(1);
  }

  const similarity = cosineSimilarity(embeddings[0], embeddings[1]);
  console.log('');
  console.log('句子一：             ' + SENTENCES[0]);
  console.log('句子二：             ' + SENTENCES[1]);
  console.log('余弦相似度：         ' + similarity.toFixed(4));
  console.log('');
  console.log('提示：一般大于 0.7 表示语义很接近，0.3 以下表示基本不相关。');
  process.exit(0);
})();

// 兜底：任何未捕获的异常也只输出脱敏后的短信息
process.on('unhandledRejection', function (error) {
  const secret = process.env.DASHSCOPE_API_KEY;
  const safe = String((error && error.message) || error || '')
    .split(secret && secret.length >= 4 ? secret : ' no-secret ')
    .join('***');
  console.log('');
  console.log('请求结果：           失败');
  console.log('错误信息（已脱敏）： ' + safe.slice(0, 200));
  process.exit(1);
});

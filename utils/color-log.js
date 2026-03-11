// 🎨 统一颜色日志工具 — 让启动信息一目了然
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  // 前景色
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
  bWhite:  '\x1b[97m',
  red:     '\x1b[31m',
  bRed:    '\x1b[91m',
  green:   '\x1b[32m',
  bGreen:  '\x1b[92m',
  yellow:  '\x1b[33m',
  bYellow: '\x1b[93m',
  cyan:    '\x1b[36m',
  bCyan:   '\x1b[96m',
  magenta: '\x1b[35m',
  bMagenta:'\x1b[95m',
  blue:    '\x1b[34m',
  bBlue:   '\x1b[94m',
};

/**
 * 输出带颜色的键值对日志
 * @param {string} tag - 标签，如 "[Voice]"
 * @param {string} label - 标签描述
 * @param {string} value - 值（会高亮）
 * @param {string} [color='bCyan'] - 值的颜色
 */
function kvLog(tag, label, value, color = 'bCyan') {
  const tagColor = c.gray;
  const valColor = c[color] || c.bCyan;
  console.log(`${tagColor}${tag}${c.reset} ${c.white}${label}${c.reset} ${valColor}${c.bold}${value}${c.reset}`);
}

/**
 * 自动高亮日志中的关键信息
 * 用法：colorLog('✅ 桌面通知服务器启动: http://127.0.0.1:18788')
 */
function colorLog(text) {
  let out = text;

  // 模型名称 → 亮青色加粗
  out = out.replace(
    /\b(gpt-[a-z0-9._-]+|claude[- ][a-z0-9. _-]+|deepseek-[a-z0-9._-]+|qwen[a-z0-9._-]*|gemini-[a-z0-9._-]+|speech-[a-z0-9._-]+|cosyvoice[a-z0-9._-]*|whisper[a-z0-9._-]*|dall-e[a-z0-9._-]*|moonshot[a-z0-9._-]*|glm[a-z0-9._-]*|ernie[a-z0-9._-]*|minimax[a-z0-9._-]*)\b/gi,
    `${c.bCyan}${c.bold}$1${c.reset}`
  );

  // 音色 ID → 亮洋红色加粗
  out = out.replace(
    /\b(xiaotuantuan[a-z0-9._-]*|female-[a-z0-9._-]+|male-[a-z0-9._-]+|diadia[a-z0-9._-]*|qiaopi[a-z0-9._-]*|tianxin[a-z0-9._-]*|lovely_girl|Sweet_Girl|Cute_Elf|zh-CN-[A-Za-z]+Neural)\b/gi,
    `${c.bMagenta}${c.bold}$1${c.reset}`
  );

  // URL → 亮绿色加粗
  out = out.replace(
    /(https?:\/\/[^\s,'\"]+)/g,
    `${c.bGreen}${c.bold}$1${c.reset}`
  );

  // 文件路径（Windows） → 暗白色
  out = out.replace(
    /([A-Z]:\\[^\s,'"]+)/g,
    `${c.dim}${c.white}$1${c.reset}`
  );

  // 版本号 v开头 → 亮青色
  out = out.replace(
    /\b(v\d+\.\d+[.\d]*)\b/g,
    `${c.bCyan}$1${c.reset}`
  );

  // PID → 亮黄色
  out = out.replace(
    /\bPID (\d+)/g,
    `PID ${c.bYellow}$1${c.reset}`
  );

  // 数字统计 → 亮黄色（如 "19 providers", "175 models"）
  out = out.replace(
    /\b(\d+)\s+(providers?|models?|cores?|分钟|个文件|次)\b/g,
    `${c.bYellow}$1${c.reset} $2`
  );

  // current: 后面的模型名 → 亮青色加粗
  out = out.replace(
    /current:\s*([^\s,]+(?:\s+[^\s,]+)*)/gi,
    `current: ${c.bCyan}${c.bold}$1${c.reset}`
  );

  // 端口号 :数字 → 亮黄色
  out = out.replace(
    /:(\d{4,5})\b/g,
    `:${c.bYellow}$1${c.reset}`
  );

  // 成功状态词 → 亮绿色
  out = out.replace(
    /\b(成功|完成|就绪|已启动|已连接|running|started|ready|loaded|created)\b/g,
    `${c.bGreen}$1${c.reset}`
  );

  // 失败/错误状态词 → 亮红色
  out = out.replace(
    /\b(失败|错误|异常|error|failed|stopped|crashed|timeout)\b/gi,
    `${c.bRed}$1${c.reset}`
  );

  // 警告状态词 → 亮黄色
  out = out.replace(
    /\b(警告|注意|warning|unknown)\b/gi,
    `${c.bYellow}$1${c.reset}`
  );

  // 配置值（冒号后面的值）→ 亮白加粗
  // 匹配 "情绪: happy" 或 "语速: 1.1x" 或 "音量: 3"
  out = out.replace(
    /(情绪|语速|音量|间隔)[:：]\s*([^\s|,]+)/g,
    (_, label, val) => `${label}: ${c.bWhite}${c.bold}${val}${c.reset}`
  );

  console.log(out);
}

/**
 * 带前缀标签的彩色日志
 */
function tagLog(tag, text) {
  const tagStr = `${c.gray}[${tag}]${c.reset}`;
  // 对 text 部分做 colorLog 处理但不直接输出
  let out = text;
  // 复用 colorLog 的替换逻辑
  out = applyColors(out);
  console.log(`${tagStr} ${out}`);
}

/**
 * 纯替换颜色（不输出）
 */
function applyColors(text) {
  let out = text;

  out = out.replace(
    /\b(gpt-[a-z0-9._-]+|claude[- ][a-z0-9. _-]+|deepseek-[a-z0-9._-]+|qwen[a-z0-9._-]*|gemini-[a-z0-9._-]+|speech-[a-z0-9._-]+|cosyvoice[a-z0-9._-]*|minimax[a-z0-9._-]*)\b/gi,
    `${c.bCyan}${c.bold}$1${c.reset}`
  );
  out = out.replace(
    /\b(xiaotuantuan[a-z0-9._-]*|female-[a-z0-9._-]+|zh-CN-[A-Za-z]+Neural)\b/gi,
    `${c.bMagenta}${c.bold}$1${c.reset}`
  );
  out = out.replace(/(https?:\/\/[^\s,'\"]+)/g, `${c.bGreen}${c.bold}$1${c.reset}`);
  out = out.replace(/([A-Z]:\\[^\s,'"]+)/g, `${c.dim}${c.white}$1${c.reset}`);
  out = out.replace(/\b(v\d+\.\d+[.\d]*)\b/g, `${c.bCyan}$1${c.reset}`);
  out = out.replace(/\bPID (\d+)/g, `PID ${c.bYellow}$1${c.reset}`);
  out = out.replace(/\b(\d+)\s+(providers?|models?|cores?|分钟|个文件|次)\b/g, `${c.bYellow}$1${c.reset} $2`);
  out = out.replace(/current:\s*([^\s,]+(?:\s+[^\s,]+)*)/gi, `current: ${c.bCyan}${c.bold}$1${c.reset}`);
  out = out.replace(/:(\d{4,5})\b/g, `:${c.bYellow}$1${c.reset}`);
  out = out.replace(/\b(成功|完成|就绪|已启动|已连接|running|started|ready|loaded|created)\b/g, `${c.bGreen}$1${c.reset}`);
  out = out.replace(/\b(失败|错误|异常|error|failed|stopped|crashed|timeout)\b/gi, `${c.bRed}$1${c.reset}`);
  out = out.replace(/\b(警告|注意|warning|unknown)\b/gi, `${c.bYellow}$1${c.reset}`);
  out = out.replace(/(情绪|语速|音量|间隔)[:：]\s*([^\s|,]+)/g, (_, label, val) => `${label}: ${c.bWhite}${c.bold}${val}${c.reset}`);

  return out;
}

module.exports = { c, colorLog, kvLog, tagLog, applyColors };

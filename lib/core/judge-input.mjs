// 旁路判别的输入预处理：用户输入在发给外部模型之前先在本地过一遍。
//
// 判别模型要看的是用户说的那句话，不是他贴进来的代码、日志和文档。不处理的话有三个问题：
// 粘贴的内容被原样发到第三方接口；粘贴内容里的「记住：以后…」会被判成记忆，
// 免确认模式下直接成为每个会话都注入的规则；每轮都为一大段无关文本付一次调用。
//
// 这里只做判断得准的事：去掉围栏代码块和成片的代码、日志行，抹掉形如密钥的字符串，
// 剩下的还很长就不送判。不纯靠信号词过滤——「参考这篇 iwiki」这种没有信号词的句子正是旁路存在的理由。

// 去掉代码和粘贴块之后仍超过这个长度的输入不送判。
// 真实使用里输入长度的中位数是 33 个字，超过 500 的都是粘贴的大段内容，判别结果全是「不记」。
export const JUDGE_INPUT_MAX = 500
// 短于这个长度的输入（「好」「继续」）不可能是值得沉淀的约定。
export const JUDGE_INPUT_MIN = 6

const REDACTED = '[已隐去]'
const CJK = /[㐀-鿿]/

// 一眼能认出来的密钥格式，整段替换。
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
]
// 「密码 / token / api key」后面跟着的值。只在值看起来像凭证时才抹：
// 不含中文，并且带数字或者足够长。「token 过期了」「密码错误怎么办」「token count」都不动。
const LABELED_SECRET = /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密码|口令|密钥)\s*(?:[:=：]|是|为)?\s*)([A-Za-z0-9!@#$%^&*._+\-=/]{4,})/gi
const looksLikeCredential = (value) => /\d/.test(value) || value.length >= 16

export function redactSecrets(text) {
  let count = 0
  let out = String(text || '')
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      count++
      return REDACTED
    })
  }
  out = out.replace(LABELED_SECRET, (whole, label, value) => {
    if (value === REDACTED || !looksLikeCredential(value)) return whole
    count++
    return `${label}${REDACTED}`
  })
  return { text: out, count }
}

// 这一行像不像粘贴进来的代码或日志。含中文的行一律不算，宁可少去掉也不能把用户的话删了。
function looksPasted(line) {
  if (!line.trim() || CJK.test(line)) return false
  return /^\s*at\s+\S+.*[(:]\d+/.test(line) // JS 调用栈
    || /^\s*File ".*", line \d+/.test(line) // Python 调用栈
    || /^Traceback \(most recent call last\)/.test(line)
    || /^\s*\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(line) // 带时间戳的日志
    || /^\s*\[?(?:DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE)\]?[\s:]/.test(line)
    || /^(?:\+\+\+|---|@@) /.test(line) // diff 头
    || /^(?:\t| {2,})\S/.test(line) // 缩进的代码行
    || /[{};]\s*$/.test(line)
    || /^\s*(?:import|export|const|let|var|function|class|def|return|if|for|while|#include|package|public|private|func|fn)\b/.test(line)
}

// 去掉围栏代码块（没闭合的一直去到末尾）和连续 3 行以上像代码、日志的行。
export function stripPastedBlocks(text) {
  const kept = []
  let fence = ''
  let run = []
  let stripped = false
  // 空行可以夹在一片代码中间，但不计入行数：一行代码加两个空行不算一片。
  const flushRun = () => {
    if (run.filter((line) => line.trim()).length >= 3) stripped = true
    else kept.push(...run)
    run = []
  }
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const mark = line.match(/^\s*(```|~~~)/)
    if (fence) {
      if (mark && mark[1] === fence) fence = ''
      continue
    }
    if (mark) {
      flushRun()
      fence = mark[1]
      stripped = true
      continue
    }
    if (looksPasted(line)) {
      run.push(line)
      continue
    }
    // 夹在两片代码之间的空行不打断这一片。
    if (!line.trim() && run.length > 0) {
      run.push(line)
      continue
    }
    flushRun()
    kept.push(line)
  }
  flushRun()
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), stripped }
}

// 返回 { text, skip, stripped, redacted }。skip 非空表示这条输入不送判，值是原因。
export function prepareJudgeInput(raw) {
  const blocks = stripPastedBlocks(raw)
  const secrets = redactSecrets(blocks.text)
  const text = secrets.text.trim()
  const length = Array.from(text).length
  let skip = ''
  if (length < JUDGE_INPUT_MIN) skip = 'too-short'
  else if (length > JUDGE_INPUT_MAX) skip = 'too-long'
  return { text, skip, stripped: blocks.stripped, redacted: secrets.count }
}

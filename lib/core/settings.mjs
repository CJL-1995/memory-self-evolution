// 用户可调配置，落在 ~/.memory-self-evolution/config.json。
// 缺文件、缺字段、字段类型不对都回退到默认值，保证配置写坏了也不影响记忆可用。

import fsp from 'node:fs/promises'
import path from 'node:path'
import { DECAY_DAYS, ROOT, paths } from './config.mjs'

const CONFIG_FILE = paths.config

export const DEFAULTS = {
  // 关掉后 hook 不再注入任何记忆，MCP 工具也只读不写。
  enabled: true,
  // 每一类记忆每轮最多召回几条。rule 和 project 各自排序、各自截断，所以每轮最多注入 2 × 这个数。
  // 它是上限而非配额：过不了门控就一条都不注入。实测 97 条输入里只有 7 条会碰到 3 这个上限。
  recallTopK: 3,
  // rule 的召回下限，作用在每一条上，不是只卡 top1。与 rule 自己的 top1×0.6 取更高的那个作为保留线，
  // 再截到 recallTopK。设为 -1 即关闭；领先幅度也关时这一类退化为纯 Top-K。
  //
  // 当前值的依据（打分改为减固定背景均值、两类分别召回之后，47 条记忆上实测）：
  //   rule    0.22 -> 相关召回 26/28，无关输入带出 rule 的 11/51
  //   project 0.29 -> 相关召回 17/18，无关输入带出 project 的 0/51；0.22 时会有 4/51
  // 完整扫描表用 npm run verify 重新生成。下面是改造前（合在一起、减池均值）定 0.22 时的记录：
  //
  // 取 0.22 的依据（16 条相关 + 11 条无关输入实测，见 tools/verify-gate.mjs）：
  //   相关输入 top1  0.160 ~ 0.567   无关输入 top1  0.089 ~ 0.285，重叠区 0.160~0.285
  //   0.22 -> 相关召回 14/16，总误放行 2/11，其中含 project 的 0/11
  //   0.30 -> 相关召回 12/16，总误放行 0/11
  // 关键在于误放行的代价不对称：被误召回的两条都是 rule，而 rule 在会话开始已无条件注入过，
  // 重复出现一次几乎零成本；真正会污染上下文的是 project 被无关输入拉进来，实测在所有阈值下都是 0。
  // 所以这里偏向召回。若 project 组显著增长，需要重跑 verify-gate 重新标定。
  //
  // 2026-10-11 在 47 条记忆上重新标定（46 条相关 + 51 条无关输入）：
  //   0.22 -> 相关召回 42/46，总误放行 13/51，其中含 project 的 0/51
  //   0.30 -> 相关召回 32/46，总误放行 2/51
  //   无关输入能拿到的最高 project 分是 0.176，0.22 留有余量
  // 结论不变，保留 0.22。
  recallMinScore: 0.22,
  // project 的召回下限，规则同上，用 project 自己的 top1 算保留线。
  // 比 rule 高：project 被无关输入带出来才是真正的上下文污染，这条线要留在无关输入的最高 project 分之上。
  recallMinScoreProject: 0.29,
  // 领先幅度门控默认关闭，原因见 config.mjs 的说明：多条同时相关时会误拒。
  recallMinMargin: -1,
  // 写盘前是否弹确认。旁路和阻塞都适用，不决定走哪条通路。
  // false 时：旁路直接写入；阻塞模式在分组信号明确时直接落盘，信号缺失时仍弹确认。
  confirm: true,
  // true 为旁路：后台判别。写记忆工具不出现在客户端工具列表里。
  // false 为阻塞：主模型调用 memory_propose，旁路不启动。两条通路互斥。
  // 切换只走 node tools/setup.mjs sidepath|blocking，不走 memory_config。
  sideJudge: true,
  // stop 里等待仍在判别的旁路任务的毫秒数。已经判别完的待确认项不等这一轮，回答已经返回后才等。
  sideWaitMs: 12000,
  // 闲置满多少天实际扣一次置信度。日检每天只跑一次，改动从次日首次会话开始生效。
  decayDays: DECAY_DAYS,
  // 旁路接口。不同用户的厂商和模型不同，这里不提供缺省值。
  // 安装脚本写入；也可以之后自己改 config.json。密钥在 side-secret.json 的 apiKey，同样必填。
  sideApiBase: '',
  sideApiModel: '',
}

const SCHEMA = {
  enabled: 'boolean',
  recallTopK: 'number',
  recallMinScore: 'number',
  recallMinScoreProject: 'number',
  recallMinMargin: 'number',
  confirm: 'boolean',
  sideJudge: 'boolean',
  sideWaitMs: 'number',
  decayDays: 'number',
  sideApiBase: 'string',
  sideApiModel: 'string',
}

// 类型之外的取值约束：读取时不满足则回退默认值，修改时直接拒绝。
const CONSTRAINTS = {
  decayDays: { test: (v) => Number.isInteger(v) && v >= 1, hint: '正整数' },
  recallTopK: { test: (v) => Number.isInteger(v) && v >= 1, hint: '正整数' },
}

let cache = null

export async function loadSettings() {
  if (cache) return cache
  const out = { ...DEFAULTS }
  let raw = null
  try {
    raw = await fsp.readFile(CONFIG_FILE, 'utf-8')
  } catch (e) {
    // 首次运行没有配置文件是正常的，直接用默认值。
    if (e.code !== 'ENOENT') console.error(`[memory] 读取配置失败，改用默认值: ${e.message}`)
    cache = out
    return out
  }
  try {
    const parsed = JSON.parse(raw)
    for (const [key, type] of Object.entries(SCHEMA)) {
      if (parsed[key] === undefined) continue
      if (typeof parsed[key] !== type) {
        console.error(`[memory] 配置项 ${key} 类型应为 ${type}，已忽略`)
        continue
      }
      const rule = CONSTRAINTS[key]
      if (rule && !rule.test(parsed[key])) {
        console.error(`[memory] 配置项 ${key} 应为${rule.hint}，收到 ${parsed[key]}，改用默认值 ${DEFAULTS[key]}`)
        continue
      }
      out[key] = parsed[key]
    }
  } catch (e) {
    console.error(`[memory] config.json 解析失败，改用默认值: ${e.message}`)
  }
  cache = out
  return out
}

// 返回 { ok, message }，由调用方决定怎么呈现给用户。
export async function updateSetting(key, rawValue) {
  const type = SCHEMA[key]
  if (!type) return { ok: false, message: `未知配置项「${key}」，可用：${Object.keys(SCHEMA).join('、')}` }

  let value = rawValue
  if (type === 'number') {
    value = Number(rawValue)
    if (!Number.isFinite(value)) return { ok: false, message: `${key} 需要数字，收到「${rawValue}」` }
  } else if (type === 'boolean') {
    const s = String(rawValue).toLowerCase()
    if (!['true', 'false', 'on', 'off', '1', '0'].includes(s)) {
      return { ok: false, message: `${key} 需要 true/false，收到「${rawValue}」` }
    }
    value = ['true', 'on', '1'].includes(s)
  } else {
    value = String(rawValue)
  }
  const rule = CONSTRAINTS[key]
  if (rule && !rule.test(value)) return { ok: false, message: `${key} 需要${rule.hint}，收到「${rawValue}」` }

  const current = await loadSettings()
  const next = { ...current, [key]: value }
  const tmp = `${CONFIG_FILE}.tmp.${process.pid}`
  try {
    await fsp.mkdir(ROOT, { recursive: true })
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
    await fsp.rename(tmp, CONFIG_FILE)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, message: `写入配置失败：${e.message}` }
  }
  cache = next
  return { ok: true, message: `${key} 已设为 ${value}` }
}

export async function describeSettings() {
  const s = await loadSettings()
  return Object.entries(SCHEMA).map(([key]) => ({
    key,
    value: s[key],
    isDefault: s[key] === DEFAULTS[key],
  }))
}

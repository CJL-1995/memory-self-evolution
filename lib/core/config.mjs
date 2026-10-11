// 平台无关的核心配置。Cursor、codebuddy 与 WorkBuddy 适配器共用同一份常量与路径，
// 避免三端各自硬编码导致行为漂移。

import os from 'node:os'
import path from 'node:path'

// 记忆是用户级跨会话资产，固定落在用户主目录，与随会话漂移的工作区路径解耦。
export const ROOT = path.join(os.homedir(), '.memory-self-evolution')

// 记忆只分两组，决定的是「怎么用」而不是「属于什么主题」：
//   rule    无条件遵守的偏好与规范，会话开始时全量注入
//   project 需要时才查阅的项目事实，靠向量召回按需注入
// 主题维度不再建模——早期的自由标签（编码规范 / 项目背景-液态玻璃…）已被向量召回取代，
// 检索该由语义负责，而不是靠人为维护一套分类法。
export const GROUPS = ['rule', 'project']
export const DEFAULT_GROUP = 'rule'

// 置信度演化：闲置满 decayDays 天衰减 DECAY_STEP，降到 DEPRECATED_AT 及以下标记废弃（不自动删除）。
// decayDays 可在 config.json 中修改，DECAY_DAYS 是它的默认值。
// 新记忆 0.5 起步，一次都没被用到的话两个周期后到 0.4，即默认最短 60 天被遗忘。
export const INITIAL_CONFIDENCE = 0.5
export const REINFORCE_STEP = 0.1
export const RECALL_STEP = 0.05
export const DECAY_STEP = 0.05
export const DECAY_DAYS = 30
export const DEPRECATED_AT = 0.4
// 置信度上限。同一条记忆每个本地日的加分合计不超过 REINFORCE_STEP，再加上这个上限，
// 置信度只区分「在用」和「闲置」，不再随召回次数无限累积。
// 上限决定一条热过的记忆冷下来后多久被遗忘：从上限扣到 DEPRECATED_AT 需要
// (CONFIDENCE_MAX − DEPRECATED_AT) / DECAY_STEP 个周期，取 1 即 12 个周期。
export const CONFIDENCE_MAX = 1

// 单次读取的条数上限。
export const READ_LIMIT = 50

// 门控通过后的相对保留线：分数需达到 top1 的此比例。
// 与绝对下限 recallMinScore 取更高的那个，再截到 topK。
// 相对线挡住强命中带进来的边缘条目；绝对下限挡住弱命中时落到下限之下的尾巴。
export const RECALL_KEEP_RATIO = 0.6

// 门控阈值的默认值在 settings.mjs，可由 config.json 覆盖。
//
// 阈值不是常数，它是「模型 × 编码方式 × 记忆池」的函数：换模型、改编码、池子构成变化后
// 都必须用 tools/verify-gate.mjs 重新标定。此前两次变更（nomic 换 bge、正文换标签+正文）
// 都让原阈值立即失准，这是有实测记录的。
//
// 「领先幅度」门控（要求 top1 明显领先 top2）默认关闭：语义聚集的记忆会让幅度塌缩，
// 例如「回答我时用中文」的 top1=0.567、top2=0.517（两条都确实相关），幅度仅 0.051 会被误拒。
// 根因是信号选错——领先幅度衡量「有没有唯一赢家」，而相关性本就不唯一。

export const paths = {
  candidates: path.join(ROOT, 'candidates.json'),
  config: path.join(ROOT, 'config.json'),
  decayState: path.join(ROOT, 'decay-state.json'),
  embeddings: path.join(ROOT, 'embeddings.jsonl'),
  group: (group) => path.join(ROOT, `${group}.jsonl`),
  sideDir: path.join(ROOT, 'side'),
  sideJob: (key) => path.join(ROOT, 'side', `${key}.json`),
  sideLatest: (agent) => path.join(ROOT, 'side', `latest-${agent}.json`),
  // 弹窗确认的用户气泡是友好文案。下一轮 prompt 用这份文件把提问说明还给模型。
  sideConfirm: (agent, sessionKey = '') => path.join(ROOT, 'side', `confirm-${agent}-${sessionKey || 'unknown'}.json`),
  // 旁路 API 密钥。不进 config.json，避免 memory_config 把密钥回给模型。
  sideSecret: path.join(ROOT, 'side-secret.json'),
  // 旁路分析 sessionID 的 HMAC 本地密钥，独立存放并限制为当前用户可读写。
  sessionSecret: path.join(ROOT, 'session-secret'),
  // 给人核对的快照。写入时整份覆盖，不进仓库。
  snapshot: path.join(ROOT, 'memories.md'),
}

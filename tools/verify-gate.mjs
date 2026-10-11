#!/usr/bin/env node
// 召回与门控的回归基线。测的是「该不该注入、注入得对不对」这个决策。
//
// 标注方式：每条输入标一个「期望命中的记忆正文片段」。标签概念已移除，
// 所以不再用标签做弱标签，直接按正文匹配，判定更严格也更贴近实际效果。
//
// 阈值不是常数，它是「模型 × 编码方式 × 记忆池」的函数。
// 换模型、改编码、记忆池构成变化后都必须重跑本脚本重新标定。
// 末尾的分数分布和阈值扫描就是标定用的：同一批输入在不同 recallMinScore 下的命中与放行。
//
// 相关输入依赖各自的记忆池，放在 ~/.memory-self-evolution/verify-cases.json，不随仓库分发：
//   { "relevant": [["用户口吻的输入", "期望命中的记忆正文片段"]], "irrelevant": ["..."], "minHit": 14 }
// irrelevant 可省略，省略时使用下方的通用无关输入；minHit 省略时要求相关输入全部命中。
// 期望片段已经不在任何记忆里的用例算过期，单独列出，不计入统计。
//
// 用法：node tools/verify-gate.mjs

import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../lib/core/config.mjs'
import { readAllMemories } from '../lib/core/store.mjs'
import { applyGate, recall } from '../lib/core/recall.mjs'
import { loadSettings } from '../lib/core/settings.mjs'

const CASES_FILE = path.join(ROOT, 'verify-cases.json')

function loadCases() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'))
  } catch (e) {
    console.error(`读取用例文件失败 ${CASES_FILE}: ${e.message}`)
    console.error('请按脚本头部注释的格式，用自己记忆库里的内容编写相关输入。')
    return null
  }
  const valid = Array.isArray(data?.relevant) && data.relevant.length > 0
    && data.relevant.every((item) => Array.isArray(item) && item.length === 2 && item.every((s) => typeof s === 'string' && s.trim()))
  if (!valid) {
    console.error(`用例文件 ${CASES_FILE} 的 relevant 必须是非空的 [输入, 期望片段] 数组`)
    return null
  }
  return data
}

// 日常开发和闲聊里的通用输入，不指向任何具体的偏好或项目事实，门控不应为它们拉进 project 记忆。
// 条数多一些，放行率才估得稳：11 条时差一条就是 9 个百分点。
const DEFAULT_IRRELEVANT = [
  '帮我把这个 JSON 格式化一下',
  '今天天气怎么样',
  '把这段文字翻译成英文',
  '解释一下快速排序的原理',
  '帮我写个正则匹配邮箱',
  '这个按钮点了没反应',
  '帮我重命名这个变量',
  '这个报错是什么意思',
  '跑一下测试',
  '帮我看下这个文件',
  '这个方法怎么用',
  '这个正则为什么匹配不上',
  '帮我把这个函数名改得更清楚一点',
  '解释一下 TCP 三次握手',
  '这段 SQL 为什么这么慢',
  '把这个列表按时间倒序排一下',
  'HTTP 状态码 502 是什么意思',
  '帮我算一下这两个日期差几天',
  '这个 Python 脚本报 KeyError 怎么办',
  '推荐几本讲操作系统的书',
  '把这个字符串转成驼峰命名',
  '二分查找的边界条件怎么写',
  '这个 CSS 为什么不居中',
  '帮我写一个冒泡排序',
  '什么是闭包',
  '这个接口返回 404 是哪里的问题',
  '把这个时间戳转成北京时间',
  'Docker 容器怎么查看端口映射',
  '这个 shell 命令是什么意思',
  '帮我起个变量名',
  '链表怎么反转',
  '明天上海会下雨吗',
  '一公里等于多少英里',
  '这个 JSON 少了个逗号在哪',
  '帮我写一封请假邮件',
  'Redis 的过期策略有哪些',
  '这个循环为什么是死循环',
  '把这两个数组合并去重',
  '解释一下什么是哈希冲突',
  '这段代码的时间复杂度是多少',
  'Mac 上怎么截图',
  '帮我生成一个 UUID',
  'vim 怎么退出',
  '这个报错栈怎么看',
  '什么是死锁',
  'curl 怎么带 header',
  '二叉树的层序遍历怎么写',
  '帮我想个周报的标题',
  '什么是 RESTful',
  '这个函数的返回值是什么类型',
  'npm install 卡住了怎么办',
]

const cases = loadCases()
if (!cases) {
  process.exitCode = 1
  process.exit()
}
const IRRELEVANT = Array.isArray(cases.irrelevant) && cases.irrelevant.length > 0 ? cases.irrelevant : DEFAULT_IRRELEVANT

const settings = await loadSettings()
const pool = await readAllMemories()

// 每条输入只编码一次，拿到不过门控的完整排序。不同阈值下的结果都由 applyGate 从这份排序算出，
// 和 recall() 走的是同一个函数，所以扫描出来的数字就是线上行为。
const rankAll = (q) => recall([q], pool, { gate: false, topK: pool.length })
const keptAt = (ranked, minScore) => applyGate(ranked, { topK: settings.recallTopK, minScore, minMargin: settings.recallMinMargin })

const stale = []
const relevant = []
for (const [q, expect] of cases.relevant) {
  if (!pool.some((m) => m.text.includes(expect))) {
    stale.push({ q, expect })
    continue
  }
  relevant.push({ q, expect, ranked: await rankAll(q) })
}
const irrelevant = []
for (const q of IRRELEVANT) irrelevant.push({ q, ranked: await rankAll(q) })

const isHit = (c, minScore) => keptAt(c.ranked, minScore).some((h) => h.memory.text.includes(c.expect))
const hasProject = (hits) => hits.some((h) => h.memory.category === 'project')

const current = settings.recallMinScore
console.log(`召回池 ${pool.length} 条，相关输入 ${relevant.length} 条，无关输入 ${irrelevant.length} 条，当前阈值 ${current}\n`)

const misses = relevant.filter((c) => !isHit(c, current))
const hit = relevant.length - misses.length

// 误放行分两种，代价差别很大：
//   命中 rule —— rule 在会话开始已无条件注入，重复出现一次成本很低，可容忍
//   命中 project —— 往上下文里塞进本轮完全不需要的项目事实，这才是真污染
const leaks = irrelevant.map((c) => ({ ...c, hits: keptAt(c.ranked, current) })).filter((c) => c.hits.length > 0)
const harmful = leaks.filter((c) => hasProject(c.hits)).length

console.log(`相关输入正确召回：${hit}/${relevant.length}`)
console.log(`无关输入误放行：  ${leaks.length}/${irrelevant.length}（其中含 project 的 ${harmful} 条为真污染）`)

if (misses.length) {
  console.log('\n未召回的相关输入：')
  for (const m of misses) {
    const top = m.ranked[0]
    console.log(`  「${m.q}」期望含「${m.expect}」-> top1 ${top ? `${top.score.toFixed(3)} ${top.memory.text.slice(0, 24)}` : '无'}`)
  }
}
if (leaks.length) {
  console.log('\n误放行的无关输入：')
  for (const l of leaks) {
    const top = l.hits[0]
    console.log(`  ${hasProject(l.hits) ? '[真污染]' : '[可容忍]'} 「${l.q}」-> [${top.memory.category}] ${top.score.toFixed(3)} ${top.memory.text.slice(0, 24)}`)
  }
}
if (stale.length) {
  console.log('\n过期用例（期望片段已不在任何记忆里，未计入统计）：')
  for (const s of stale) console.log(`  「${s.q}」期望含「${s.expect}」`)
}

// 标定用：分数分布与阈值扫描。
const sorted = (xs) => xs.slice().sort((a, b) => a - b)
const span = (xs) => {
  const s = sorted(xs)
  return s.length ? `${s[0].toFixed(3)} ~ ${s.at(-1).toFixed(3)}，中位 ${s[Math.floor(s.length / 2)].toFixed(3)}` : '无'
}
const targetScores = relevant.map((c) => c.ranked.find((h) => h.memory.text.includes(c.expect)).score)
const irrelevantTops = irrelevant.filter((c) => c.ranked.length).map((c) => c.ranked[0].score)
const projectTops = irrelevant.map((c) => c.ranked.find((h) => h.memory.category === 'project')).filter(Boolean).map((h) => h.score)

console.log('\n分数分布')
console.log(`  相关输入的目标分数          ${span(targetScores)}`)
console.log(`  无关输入的 top1             ${span(irrelevantTops)}`)
console.log(`  无关输入的最高 project 分   ${projectTops.length ? Math.max(...projectTops).toFixed(3) : '无 project 记忆'}（阈值要留在它之上）`)

const grid = Array.from({ length: 10 }, (_, i) => Math.round((0.16 + i * 0.02) * 100) / 100)
const thresholds = sorted([...new Set(current >= 0 ? [...grid, current] : grid)])
console.log('\n阈值扫描（其余门控参数取当前配置）')
console.log('  阈值    相关命中    无关放行    其中带 project')
for (const t of thresholds) {
  const hits = relevant.filter((c) => isHit(c, t)).length
  const kept = irrelevant.map((c) => keptAt(c.ranked, t)).filter((h) => h.length > 0)
  const mark = t === current ? '  <- 当前' : ''
  console.log(`  ${t.toFixed(2)}    ${String(hits).padStart(3)}/${relevant.length}      ${String(kept.length).padStart(3)}/${irrelevant.length}      ${kept.filter(hasProject).length}${mark}`)
}

// 下限随记忆池变化：中心化的语料均值依赖池子构成，增删记忆会让所有分数平移，
// 所以这个数字是「当前池子下的已知可达值」，不是恒定目标。调整前先看清失败项是真退步还是池子变了。
const MIN_HIT = Number.isInteger(cases.minHit) ? Math.min(cases.minHit, relevant.length) : relevant.length
const MAX_HARMFUL = 0
let failed = false
if (harmful > MAX_HARMFUL) {
  console.error(`\n校验失败：${harmful} 条无关输入拉进了 project 记忆，超过上限 ${MAX_HARMFUL}`)
  failed = true
}
if (hit < MIN_HIT) {
  console.error(`\n校验失败：正确召回 ${hit} 低于下限 ${MIN_HIT}`)
  failed = true
}
// 用 exitCode 而非 process.exit()：后者会在 onnxruntime 线程还活着时强行退出，
// 触发 "mutex lock failed" 的 abort，把真正的失败原因淹没在崩溃栈里。
process.exitCode = failed ? 1 : 0
console.log(failed ? '' : '\n校验通过')

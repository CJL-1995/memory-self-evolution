import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHarness } from './helpers/memory.mjs'

const ranked = scores => scores.map((score, i) => ({ memory: { id: `m${i}` }, score }))
// 被测模块跑在测试夹具的独立上下文里，返回的数组和这里的字面量不是同一个 Array，先摊开再比较。
const ids = hits => [...hits].map(hit => hit.memory.id)
const DEFAULT = { topK: 10, minScore: 0.22, minMargin: -1 }
const SPLIT = { topK: 3, minScore: 0.22, minScoreProject: 0.29, minMargin: -1 }
const mixed = items => items.map(([id, category, score]) => ({ memory: { id, category }, score }))

async function loadRecall(t) {
  const h = await createMemoryHarness(t, { realRecall: true })
  return h.load('lib/core/recall.mjs')
}
const loadGate = async t => (await loadRecall(t)).applyGate

test('门控：top1 不到绝对下限时一条都不返回，空排序也不报错', async t => {
  const applyGate = await loadGate(t)
  assert.deepEqual(ids(applyGate(ranked([0.219, 0.2, 0.1]), DEFAULT)), [])
  assert.deepEqual(ids(applyGate([], DEFAULT)), [])
  assert.deepEqual(ids(applyGate(ranked([0.22, 0.1]), DEFAULT)), ['m0'])
})

test('门控：保留线取绝对下限与 top1×0.6 中更高的一个', async t => {
  const applyGate = await loadGate(t)
  // 强命中：相对线 0.30 高于下限，0.29 被挡住。
  assert.deepEqual(ids(applyGate(ranked([0.5, 0.31, 0.29, 0.23]), DEFAULT)), ['m0', 'm1'])
  // 弱命中：相对线 0.15 低于下限，仍按 0.22 卡每一条。
  assert.deepEqual(ids(applyGate(ranked([0.25, 0.23, 0.2, 0.16]), DEFAULT)), ['m0', 'm1'])
})

test('门控：Top-K 是上限，门控全关时退化为纯 Top-K', async t => {
  const applyGate = await loadGate(t)
  assert.equal(applyGate(ranked(Array(12).fill(0.5)), DEFAULT).length, 10)
  assert.equal(applyGate(ranked(Array(12).fill(0.5)), { ...DEFAULT, topK: 3 }).length, 3)
  assert.deepEqual(ids(applyGate(ranked([0.5, 0.05, -0.1]), { topK: 10, minScore: -1, minMargin: -1 })), ['m0', 'm1', 'm2'])
})

test('门控：领先幅度单独开启时只用相对线收窄，幅度不足则整体拒绝', async t => {
  const applyGate = await loadGate(t)
  const marginOnly = { topK: 10, minScore: -1, minMargin: 0.05 }
  assert.deepEqual(ids(applyGate(ranked([0.5, 0.48]), marginOnly)), [])
  assert.deepEqual(ids(applyGate(ranked([0.5, 0.31, 0.29]), marginOnly)), ['m0', 'm1'])
  assert.deepEqual(ids(applyGate(ranked([0.1]), marginOnly)), ['m0'])
})

test('分别门控：两类各用各的阈值，结果先 rule 后 project，不按分数合并排序', async t => {
  const { gateByGroup } = await loadRecall(t)
  const ranked = mixed([['p1', 'project', 0.5], ['r1', 'rule', 0.4], ['p2', 'project', 0.31], ['r2', 'rule', 0.25], ['p3', 'project', 0.25]])
  // r2 的 0.25 过得了 rule 的线，p3 同样是 0.25 却过不了 project 的 0.29。
  assert.deepEqual(ids(gateByGroup(ranked, SPLIT)), ['r1', 'r2', 'p1', 'p2'])
})

test('分别门控：一类的强命中不抬高另一类的保留线，一类过不了下限也不影响另一类', async t => {
  const { applyGate, gateByGroup } = await loadRecall(t)
  const strongRule = mixed([['r1', 'rule', 0.9], ['p1', 'project', 0.4], ['r2', 'rule', 0.3]])
  // 合在一起算时，rule 的 0.9 会把保留线抬到 0.54，project 的 0.4 被挡掉。
  assert.deepEqual(ids(applyGate(strongRule, DEFAULT)), ['r1'])
  assert.deepEqual(ids(gateByGroup(strongRule, SPLIT)), ['r1', 'p1'])
  assert.deepEqual(ids(gateByGroup(mixed([['p1', 'project', 0.28], ['r1', 'rule', 0.23]]), SPLIT)), ['r1'])
  assert.deepEqual(ids(gateByGroup(mixed([['p1', 'project', 0.3], ['r1', 'rule', 0.21]]), SPLIT)), ['p1'])
  assert.deepEqual(ids(gateByGroup([], SPLIT)), [])
})

test('分别门控：每一类各自截到 topK', async t => {
  const { gateByGroup } = await loadRecall(t)
  const ranked = mixed([...Array.from({ length: 5 }, (_, i) => [`r${i}`, 'rule', 0.5]), ...Array.from({ length: 5 }, (_, i) => [`p${i}`, 'project', 0.5])])
  assert.deepEqual(ids(gateByGroup(ranked, SPLIT)), ['r0', 'r1', 'r2', 'p0', 'p1', 'p2'])
  assert.equal(gateByGroup(ranked, { ...SPLIT, topK: 1 }).length, 2)
})

test('recall() 的门控结果与对完整排序直接调用 gateByGroup 一致', async t => {
  const h = await createMemoryHarness(t, { realRecall: true })
  await h.seed('rule', [
    { id: 'a', text: '相关', category: 'rule', confidence: 0.5 },
    { id: 'b', text: '不相关', category: 'rule', confidence: 0.5 },
  ])
  await h.seed('project', [
    { id: 'p', text: '相关', category: 'project', confidence: 0.5 },
    { id: 'q', text: '不相关', category: 'project', confidence: 0.5 },
  ])
  const store = await h.load('lib/core/store.mjs')
  const { gateByGroup, recall } = await h.load('lib/core/recall.mjs')
  const pool = await store.readAllMemories()
  // 不过门控时两类合在一起按分数排，供判重取最相近的几条。
  const all = await recall(['问题'], pool, { gate: false, topK: pool.length })
  assert.deepEqual(ids(all), ['a', 'p', 'b', 'q'])
  assert.deepEqual(ids(await recall(['问题'], pool)), ['a', 'p'])
  assert.deepEqual(ids(await recall(['问题'], pool)), ids(gateByGroup(all, SPLIT)))
  // 只关掉 rule 的下限：rule 退化为纯 Top-K，project 仍按自己的下限过滤。
  assert.deepEqual(ids(await recall(['问题'], pool, { minScore: -1 })), ['a', 'b', 'p'])
  assert.deepEqual(ids(await recall(['问题'], pool, { minScoreProject: -1 })), ['a', 'p', 'q'])
})

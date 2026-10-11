import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHarness } from './helpers/memory.mjs'

const ranked = scores => scores.map((score, i) => ({ memory: { id: `m${i}` }, score }))
// 被测模块跑在测试夹具的独立上下文里，返回的数组和这里的字面量不是同一个 Array，先摊开再比较。
const ids = hits => [...hits].map(hit => hit.memory.id)
const DEFAULT = { topK: 10, minScore: 0.22, minMargin: -1 }

async function loadGate(t) {
  const h = await createMemoryHarness(t, { realRecall: true })
  return (await h.load('lib/core/recall.mjs')).applyGate
}

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

test('recall() 的门控结果与对完整排序直接调用 applyGate 一致', async t => {
  const h = await createMemoryHarness(t, { realRecall: true })
  await h.seed('rule', [
    { id: 'a', text: '相关', category: 'rule', confidence: 0.5 },
    { id: 'b', text: '不相关', category: 'rule', confidence: 0.5 },
  ])
  const store = await h.load('lib/core/store.mjs')
  const { applyGate, recall } = await h.load('lib/core/recall.mjs')
  const pool = await store.readAllMemories()
  const all = await recall(['问题'], pool, { gate: false, topK: pool.length })
  assert.deepEqual(ids(all), ['a', 'b'])
  assert.deepEqual(ids(await recall(['问题'], pool)), ids(applyGate(all, DEFAULT)))
  assert.deepEqual(ids(await recall(['问题'], pool, { minScore: -1 })), ['a', 'b'])
})

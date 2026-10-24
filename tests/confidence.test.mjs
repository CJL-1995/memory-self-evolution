import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryHarness, memory } from './helpers/memory.mjs'

const exec = promisify(execFile)
const DAY = 86400000
const START = '2026-09-29T04:00:00.000Z'

test('所有新建入口的底层初始值固定 0.5，不接受外部置信度', async t => {
  const h = await createMemoryHarness(t)
  const writer = await h.load('lib/core/writer.mjs')
  for (const confidence of [undefined, 0, -1, 0.9, 3, NaN, Infinity]) {
    const mem = await writer.persistMemory({ text: '必须记录错误原因', category: 'rule', confidence })
    assert.equal(mem.confidence, 0.5)
    assert.equal('observations' in mem, false)
  }
  assert.ok((await h.records()).every(mem => mem.confidence === 0.5 && !('observations' in mem)))
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  assert.ok((await h.records()).every(mem => !mem.deprecated))
})

test('强化和合并每个本地日合计最多加 0.1，封顶 1，无次数统计、无浮点累加误差', async t => {
  const h = await createMemoryHarness(t, { now: START })
  const writer = await h.load('lib/core/writer.mjs')
  const created = await writer.persistMemory({ text: '日志包含原因', category: 'project' })
  h.clock.now += DAY
  const reinforced = await writer.reinforceMemory(created.id)
  assert.equal(reinforced.confidence, 0.6)
  assert.equal(reinforced.gained, 0.1)
  const merged = await writer.mergeMemory(created.id, '日志包含原因与排查线索')
  assert.equal(merged.confidence, 0.6)
  assert.equal(merged.gained, 0)
  assert.equal(merged.id, created.id)
  assert.equal(merged.text, '日志包含原因与排查线索')
  assert.equal(h.state.vectorRefreshes, 1)
  for (let i = 0; i < 6; i++) {
    h.clock.now += DAY
    await writer.reinforceMemory(created.id)
  }
  const stored = (await h.records('project'))[0]
  assert.equal(stored.confidence, 1)
  assert.equal('gained' in stored, false)
  assert.doesNotMatch(await fsp.readFile(path.join(h.root, 'memories.html'), 'utf8'), /观测|召回频率/)
})

test('旧正式记忆兼容读取，保留历史置信度，更新时清理 observations', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('old', { confidence: 0.75, observations: 20, evidence: '原始证据' })])
  const store = await h.load('lib/core/store.mjs')
  const old = (await store.readGroup('rule'))[0]
  assert.equal(old.confidence, 0.75)
  assert.equal('observations' in old, false)
  assert.equal((await h.records())[0].observations, 20)
  const writer = await h.load('lib/core/writer.mjs')
  await writer.reinforceMemory('old')
  const updated = (await h.records())[0]
  assert.equal(updated.confidence, 0.85)
  assert.equal(updated.evidence, '原始证据')
  assert.equal('observations' in updated, false)
})

test('批量实际召回每 id 每天加一次 0.05，去重且忽略失效或已删除记录', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a'), memory('untouched'), memory('deprecated', { deprecated: true })])
  await h.seed('project', [memory('p', { category: 'project', lastSeen: '2020-01-01T00:00:00.000Z' })])
  const writer = await h.load('lib/core/writer.mjs')
  const result = await writer.rewardRecalledMemories(['a', 'a', 'p', 'missing', 'deprecated'])
  assert.equal(result.length, 2)
  const rules = new Map((await h.records()).map(mem => [mem.id, mem]))
  assert.equal(rules.get('a').confidence, 0.55)
  assert.equal(rules.get('untouched').confidence, 0.5)
  assert.equal(rules.get('deprecated').confidence, 0.5)
  assert.equal(rules.get('deprecated').deprecated, true)
  assert.ok((await h.records('project'))[0].lastSeen > '2020-01-01T00:00:00.000Z')
  assert.equal((await writer.rewardRecalledMemories(['a'])).length, 0)
  assert.equal((await h.records()).find(mem => mem.id === 'a').confidence, 0.55)
  h.clock.now += DAY
  await writer.rewardRecalledMemories(['a'])
  assert.equal((await h.records()).find(mem => mem.id === 'a').confidence, 0.6)
  assert.equal(h.state.vectorRefreshes, 0)
  assert.equal((await writer.rewardRecalledMemories([])).length, 0)
})

for (const confirm of [true, false]) {
  test(`实际召回输出加分，confirm=${confirm}`, async t => {
    const h = await createMemoryHarness(t, { now: START })
    h.settings.confirm = confirm
    await h.seed('rule', [memory('hit'), memory('miss')])
    h.state.hits = ['hit', 'hit']
    const render = await h.load('lib/core/render.mjs')
    const text = await render.renderRecall(['用户问题'])
    assert.match(text, /置信度 0.55/)
    assert.equal(text.split('规则 hit').length - 1, 1)
    assert.equal((await h.records()).find(mem => mem.id === 'miss').confidence, 0.5)
    assert.match(await render.renderRecall(['用户下一轮问题']), /置信度 0.55/)
    assert.equal((await h.records()).find(mem => mem.id === 'hit').confidence, 0.55)
    h.clock.now += DAY
    assert.match(await render.renderRecall(['第二天的问题']), /置信度 0.6/)
    assert.equal((await h.records()).find(mem => mem.id === 'hit').confidence, 0.6)
  })
}

test('关闭功能、空输入、无命中和召回失败不加分', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('a')])
  const render = await h.load('lib/core/render.mjs')
  h.state.hits = ['a']
  assert.equal(await render.renderRecall([]), '')
  h.settings.enabled = false
  assert.equal(await render.renderRecall(['问题']), '')
  h.settings.enabled = true
  h.state.hits = []
  assert.equal(await render.renderRecall(['问题']), '')
  h.state.recallError = new Error('模拟召回失败')
  assert.equal(await render.renderRecall(['问题']), '')
  assert.equal((await h.records())[0].confidence, 0.5)
  assert.ok(h.errors.some(line => line.includes('模拟召回失败')))
})

test('会话开始按置信度选前 50 条，但不会因为注入而加分', async t => {
  const h = await createMemoryHarness(t)
  const rules = Array.from({ length: 52 }, (_, i) => memory(`r${i}`, { confidence: 0.45 + i / 100 }))
  rules.push(memory('deleted', { confidence: 9, deprecated: true }))
  await h.seed('rule', rules)
  const before = await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8')
  const render = await h.load('lib/core/render.mjs')
  const text = await render.renderSessionStart()
  assert.match(text, /规则 r51（/)
  assert.doesNotMatch(text, /规则 r0（|规则 r1（|规则 deleted（/)
  assert.match(text, /其余 2 条按置信度截断/)
  assert.equal(await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8'), before)
  assert.match(text, /后台自动提取/)
  assert.doesNotMatch(text, /记忆沉淀未启用|memory_propose|沉淀规则/)
})

test('会话开始不列出项目事实，记忆再少也一样', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('project', [memory('only', { category: 'project', text: '唯一的一条项目事实' })])
  const render = await h.load('lib/core/render.mjs')
  assert.doesNotMatch(await render.renderSessionStart(), /项目事实|唯一的一条项目事实/)
})

test('每轮召回按 rule 和 project 分两组列出，没有命中的一组不出现', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('r1'), memory('r2')])
  await h.seed('project', [memory('p1', { category: 'project', text: '项目事实 p1' })])
  const render = await h.load('lib/core/render.mjs')
  h.state.hits = ['p1', 'r1']
  const both = await render.renderRecall(['问题'])
  assert.match(both, /## 规则\n\n- 规则 r1（置信度 0\.55，相关度 0\.90）\n\n## 项目事实\n\n- 项目事实 p1（置信度 0\.55，相关度 0\.90）/)
  assert.doesNotMatch(both, /规则 r2/)
  h.clock.now += DAY
  h.state.hits = ['p1']
  const onlyProject = await render.renderRecall(['第二天的问题'])
  assert.match(onlyProject, /## 项目事实\n\n- 项目事实 p1（置信度 0\.6/)
  assert.doesNotMatch(onlyProject, /## 规则/)
})

test('通用召回用于判重或评测时没有置信度副作用', async t => {
  const h = await createMemoryHarness(t, { realRecall: true })
  await h.seed('rule', [memory('a', { text: '相关' }), memory('b', { text: '不相关' })])
  const store = await h.load('lib/core/store.mjs')
  const recall = await h.load('lib/core/recall.mjs')
  const pool = await store.readAllMemories()
  const before = await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8')
  assert.equal((await recall.recall(['问题'], pool, { topK: 3, gate: false })).length, 2)
  assert.equal((await recall.recall(['问题'], pool)).length, 1)
  assert.equal(await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8'), before)
  const render = await h.load('lib/core/render.mjs')
  await render.renderRecall(['问题'])
  const updated = new Map((await h.records()).map(mem => [mem.id, mem]))
  assert.equal(updated.get('a').confidence, 0.55)
  assert.equal(updated.get('b').confidence, 0.5)
})

test('置信度写入失败仍返回召回正文，并保留排查日志、释放写锁', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('a')])
  h.state.hits = ['a']
  h.state.writeError = true
  const render = await h.load('lib/core/render.mjs')
  assert.match(await render.renderRecall(['问题']), /规则 a（置信度 0.5/)
  assert.equal((await h.records())[0].confidence, 0.5)
  assert.ok(h.errors.some(line => line.includes('ids=a') && line.includes('模拟记忆写入失败')))
  assert.equal((await fsp.readdir(h.root)).some(name => name.startsWith('.memory-write')), false)
  h.state.writeError = false
  assert.match(await render.renderRecall(['重试']), /置信度 0.55/)
})

test('同进程并发的新建、强化、合并、召回与废弃刷新不丢更新', async t => {
  const h = await createMemoryHarness(t)
  const ids = Array.from({ length: 8 }, (_, i) => `a${i}`)
  await h.seed('rule', ids.map(id => memory(id)))
  const writer = await h.load('lib/core/writer.mjs')
  await Promise.all([
    ...ids.map(id => writer.reinforceMemory(id)),
    ...ids.map(id => writer.rewardRecalledMemories([id])),
    writer.mergeMemory('a0', '合并后的正文'),
    writer.persistMemory({ text: '并发写入的新规则', category: 'rule' }),
    writer.decayMemoriesOncePerDay(),
  ])
  const rules = await h.records()
  assert.equal(rules.length, 9)
  // 每条记忆当天先后被召回和强化，无论顺序都应合计 +0.1；少于它说明有更新被覆盖。
  for (const id of ids) assert.equal(rules.find(mem => mem.id === id).confidence, 0.6)
  assert.equal(rules.find(mem => mem.id === 'a0').text, '合并后的正文')
  assert.ok(rules.every(mem => !mem.deprecated))
})

test('跨进程并发加分不丢失', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', Array.from({ length: 8 }, (_, i) => memory(`a${i}`)))
  const helper = new URL('./helpers/memory.mjs', import.meta.url).href
  const child = `import { createMemoryHarness } from ${JSON.stringify(helper)}; const h = await createMemoryHarness(null, { home: process.argv[1] }); const writer = await h.load('lib/core/writer.mjs'); for (let i = 0; i < 8; i++) await writer[process.argv[2]](process.argv[2] === 'reinforceMemory' ? 'a' + i : ['a' + i]);`
  await Promise.all(['reinforceMemory', 'rewardRecalledMemories'].map(operation => exec(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', child, h.home, operation])))
  // 两个进程对同一批记忆分别强化和召回，每条当天合计 +0.1；少于它说明跨进程丢了更新。
  assert.deepEqual((await h.records()).map(mem => mem.confidence), Array(8).fill(0.6))
})

test('新记忆未衰减时有效，满 30 天实际扣分，不高于 0.4 即废弃', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('new'), memory('old', { confidence: 0.4, lastSeen: new Date(Date.now() - 31 * 86400000).toISOString() })])
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  const rules = new Map((await h.records()).map(mem => [mem.id, mem]))
  assert.equal(rules.get('new').confidence, 0.5)
  assert.equal(rules.get('new').deprecated, false)
  assert.equal(rules.get('old').confidence, 0.35)
  assert.equal(rules.get('old').deprecated, true)
  assert.equal((await writer.reinforceMemory('old')).confidence, 0.45)
  assert.equal((await h.records()).find(mem => mem.id === 'old').deprecated, false)
})

test('候选池已移除：Stop 不读对话记录，遗留的 candidates.json 不被读取也不被改动', async t => {
  const h = await createMemoryHarness(t, { argv: ['hook', '--agent', 'codebuddy'] })
  await h.seed('rule', [memory('r1')])
  const leftover = path.join(h.root, 'candidates.json')
  const body = JSON.stringify({ candidates: [{ fingerprint: 'x', text: '以后都用中文回答', observations: 9, sessions: ['s'] }], rejected: [] })
  await fsp.writeFile(leftover, body)
  const running = h.load('bin/memory.mjs')
  for (let i = 0; i < 1000 && !h.stdin.listenerCount('end'); i++) await delay(1)
  h.stdin.emit('data', JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: path.join(h.home, 'missing-transcript.jsonl') }))
  h.stdin.emit('end')
  await running
  assert.equal(h.output.join(''), '{}')
  assert.equal(h.errors.some(line => /transcript|候选/.test(line)), false)
  const started = await (await h.load('lib/core/render.mjs')).renderSessionStart()
  assert.match(started, /规则 r1/)
  assert.doesNotMatch(started, /待确认候选|memory_review/)
  assert.equal(h.state.reads.has(leftover), false)
  assert.equal(await fsp.readFile(leftover, 'utf8'), body)
})

test('旁路通知展示实际加分，不展示旧 observations', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  for (const action of ['reinforce', 'merge']) {
    const base = { action, targetText: '旧规则', mergedText: '新规则', observations: 10 }
    assert.match(side.formatNotice({ ...base, gained: 0.1 }), /置信度 \+0.1$/)
    assert.match(side.formatNotice({ ...base, gained: 0.05 }), /置信度 \+0.05$/)
    assert.match(side.formatNotice({ ...base, gained: 0 }), /置信度不变/)
    assert.doesNotMatch(side.formatNotice({ ...base, gained: 0.1 }), /观测|召回频率/)
  }
})

test('记忆正文不足 6 个字或超过 400 个字时拒绝写入，新建与合并一致', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('old', { text: '原有的一条规则' })])
  const writer = await h.load('lib/core/writer.mjs')
  const tooLong = '长'.repeat(401)
  for (const text of ['用中文', '五个字不够', tooLong]) {
    await assert.rejects(writer.persistMemory({ text, category: 'rule' }), /记忆正文(不足 6|超过 400) 个字/)
    await assert.rejects(writer.mergeMemory('old', text), /记忆正文(不足 6|超过 400) 个字/)
  }
  // 前后的空白不计入长度，边界值本身可以写入。
  await assert.rejects(writer.persistMemory({ text: '  五个字不够  ', category: 'rule' }), /不足 6 个字/)
  assert.equal((await writer.persistMemory({ text: '刚好六个字的', category: 'rule' })).text, '刚好六个字的')
  assert.equal((await writer.mergeMemory('old', '长'.repeat(400))).text.length, 400)
  const rules = await h.records()
  assert.equal(rules.length, 2)
  assert.equal(writer.memoryTextProblem('一条正常长度的记忆'), '')
})

test('CLI 直接新建同样固定 0.5', async t => {
  const h = await createMemoryHarness(t, { argv: ['rule', 'add', 'CLI新规则'] })
  await h.load('bin/memory.mjs')
  assert.equal((await h.records())[0].confidence, 0.5)
})

test('实际置信度恰好减至 0.4 时废弃，不因浮点误差漏判', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('boundary', { confidence: 0.45, lastSeen: new Date(Date.now() - 31 * 86400000).toISOString() })])
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  assert.equal((await h.records())[0].confidence, 0.4)
  assert.equal((await h.records())[0].deprecated, true)
})

test('持锁进程退出后自动恢复，空的遗留锁目录也不阻塞', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('a')])
  const { stdout } = await exec(process.execPath, ['-e', 'console.log(process.pid)'])
  const owner = `owner-${Number(stdout.trim())}-exited`
  const lock = path.join(h.root, '.memory-write.lock')
  await fsp.mkdir(lock)
  await fsp.writeFile(path.join(lock, owner), '')
  const writer = await h.load('lib/core/writer.mjs')
  await writer.rewardRecalledMemories(['a'])
  assert.equal((await h.records())[0].confidence, 0.55)
  assert.ok(h.errors.some(line => line.includes('回收已退出进程')))
  await fsp.mkdir(lock)
  await writer.reinforceMemory('a')
  assert.equal((await h.records())[0].confidence, 0.6)
})

test('写锁被活着的进程占用时，召回加分只等一小会儿就放弃，召回内容照常返回', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('a')])
  h.state.hits = ['a']
  const render = await h.load('lib/core/render.mjs')
  const lock = path.join(h.root, '.memory-write.lock')
  const owner = path.join(lock, `owner-${process.pid}-held`)
  await fsp.mkdir(lock)
  await fsp.writeFile(owner, '')

  const startedAt = Date.now()
  const text = await render.renderRecall(['问题'])
  const elapsed = Date.now() - startedAt
  assert.match(text, /规则 a（置信度 0\.5，/)
  assert.ok(elapsed >= 250 && elapsed < 2000, `等了 ${elapsed} 毫秒`)
  assert.equal((await h.records())[0].confidence, 0.5)
  assert.ok(h.errors.some(line => line.includes('写锁被占用，放弃本次召回加分') && line.includes('ids=a')))
  assert.equal(h.errors.some(line => line.includes('召回置信度更新失败') || line.includes('记忆写事务失败')), false)
  // 没有抢走别人的锁，也没有留下自己的准备目录。
  assert.deepEqual(await fsp.readdir(lock), [path.basename(owner)])
  assert.equal((await fsp.readdir(h.root)).some(name => name.startsWith('.memory-write-')), false)

  // 锁放开之后，当天下一次命中会把这次没加上的分补上。
  await fsp.rm(lock, { recursive: true })
  assert.match(await render.renderRecall(['再问一次']), /规则 a（置信度 0\.55，/)
})

test('写锁存在超过 15 秒视为残留，占锁的进程号还活着也回收；不到 15 秒不回收', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('a')])
  const writer = await h.load('lib/core/writer.mjs')
  const lock = path.join(h.root, '.memory-write.lock')
  const hold = async secondsAgo => {
    await fsp.mkdir(lock)
    await fsp.writeFile(path.join(lock, `owner-${process.pid}-stuck`), '')
    const at = new Date(Date.now() - secondsAgo * 1000)
    await fsp.utimes(lock, at, at)
  }

  await hold(14)
  assert.equal((await writer.rewardRecalledMemories(['a'])).length, 0)
  assert.equal((await h.records())[0].confidence, 0.5)
  assert.equal(h.errors.some(line => line.includes('回收超过')), false)
  await fsp.rm(lock, { recursive: true })

  await hold(16)
  assert.equal((await writer.reinforceMemory('a')).confidence, 0.6)
  assert.ok(h.errors.some(line => line.includes('回收超过 15 秒未释放的记忆写锁') && line.includes(`owner-${process.pid}-stuck`)))
  assert.equal((await fsp.readdir(h.root)).some(name => name.startsWith('.memory-write')), false)
})

test('同一本地日内先召回后强化只补到 0.1，加满后不再写盘，跨天重新计', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a')])
  const writer = await h.load('lib/core/writer.mjs')
  const file = path.join(h.root, 'rule.jsonl')
  await writer.rewardRecalledMemories(['a'])
  assert.equal((await h.records())[0].confidence, 0.55)
  const topped = await writer.reinforceMemory('a')
  assert.equal(topped.confidence, 0.6)
  assert.equal(topped.gained, 0.05)
  const before = await fsp.readFile(file, 'utf8')
  assert.equal((await writer.reinforceMemory('a')).gained, 0)
  assert.equal((await writer.rewardRecalledMemories(['a'])).length, 0)
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  h.clock.now += DAY
  assert.equal((await writer.reinforceMemory('a')).gained, 0.1)
  assert.equal((await writer.rewardRecalledMemories(['a'])).length, 0)
  assert.equal((await h.records())[0].confidence, 0.7)
})

test('新建当天不再加分，次日起正常', async t => {
  const h = await createMemoryHarness(t, { now: START })
  const writer = await h.load('lib/core/writer.mjs')
  const created = await writer.persistMemory({ text: '新建的项目事实', category: 'project' })
  assert.equal((await writer.rewardRecalledMemories([created.id])).length, 0)
  assert.equal((await writer.reinforceMemory(created.id)).gained, 0)
  assert.equal((await h.records('project'))[0].confidence, 0.5)
  h.clock.now += DAY
  await writer.rewardRecalledMemories([created.id])
  assert.equal((await h.records('project'))[0].confidence, 0.55)
})

test('置信度封顶 1，到顶后的召回仍刷新衰减起点，日检把超过上限的历史值压回上限', async t => {
  const h = await createMemoryHarness(t, { now: START })
  const ago = days => new Date(h.clock.now - days * DAY).toISOString()
  const old = ago(29)
  await h.seed('rule', [
    memory('top', { confidence: 1, lastSeen: old }),
    memory('legacy', { confidence: 3.95, lastSeen: old }),
    memory('legacy-idle', { confidence: 2, lastSeen: ago(40) }),
  ])
  const writer = await h.load('lib/core/writer.mjs')
  await writer.rewardRecalledMemories(['top'])
  const rows = async () => new Map((await h.records()).map(mem => [mem.id, mem]))
  assert.equal((await rows()).get('top').confidence, 1)
  assert.equal((await rows()).get('top').lastSeen, START)
  assert.equal(await writer.decayMemoriesOncePerDay(), 2)
  assert.equal((await rows()).get('legacy').confidence, 1)
  assert.equal((await rows()).get('legacy').lastSeen, old)
  assert.equal((await rows()).get('legacy-idle').confidence, 0.95)
  h.clock.now += DAY
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  assert.equal((await rows()).get('legacy').confidence, 0.95)
  assert.equal((await rows()).get('top').confidence, 1)
})

test('当天已加过分的召回不进写锁、不写盘', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a')])
  h.state.hits = ['a']
  const render = await h.load('lib/core/render.mjs')
  const file = path.join(h.root, 'rule.jsonl')
  const reads = () => h.state.reads.get(file) || 0
  assert.match(await render.renderRecall(['第一次']), /置信度 0.55/)
  const before = await fsp.readFile(file, 'utf8')
  const readsBefore = reads()
  assert.match(await render.renderRecall(['同一天第二次']), /规则 a（置信度 0.55/)
  // 只剩读召回池那一次；加分路径会在写锁内再读一遍分组文件。
  assert.equal(reads() - readsBefore, 1)
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  assert.equal((await fsp.readdir(h.root)).some(name => name.startsWith('.memory-write')), false)
})

test('HMAC sessionID 对同一轮输入稳定且不同输入不可复用', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const payload = { conversation_id: 'conversation-a', generation_id: 'generation-a' }
  const first = side.sessionIDFor('local-secret', 'cursor', payload, '记住这条项目事实')
  const duplicate = side.sessionIDFor('local-secret', 'cursor', payload, '记住这条项目事实')

  assert.equal(first, duplicate)
  assert.match(first, /^s_[a-f0-9]{64}$/)
  assert.notEqual(first, side.sessionIDFor('other-secret', 'cursor', payload, '记住这条项目事实'))
  assert.notEqual(first, side.sessionIDFor('local-secret', 'cursor', { ...payload, generation_id: 'generation-b' }, '记住这条项目事实'))
  assert.notEqual(first, side.sessionIDFor('local-secret', 'cursor', payload, '记住另一条项目事实'))
})

test('重复 prompt Hook 原子复用同一个 sessionID 且只启动一次分析', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const payload = { conversation_id: 'conversation-a', generation_id: 'generation-a' }
  const args = { agent: 'cursor', payload, promptText: '用户希望长期记住这条项目事实' }

  const [first, duplicate] = await Promise.all([
    side.maybeStartSideJob(args),
    side.maybeStartSideJob(args),
  ])
  assert.equal(first, duplicate)
  assert.match(first, /^s_[a-f0-9]{64}$/)
  assert.equal(h.state.spawns.length, 1)
  assert.equal((await fsp.readdir(path.join(h.root, 'side'))).filter(name => name.endsWith('.json')).length, 1)
  assert.equal((await fsp.stat(path.join(h.root, 'session-secret'))).mode & 0o777, 0o600)

  const file = path.join(h.root, 'side', `${first}.json`)
  const job = JSON.parse(await fsp.readFile(file, 'utf8'))
  await fsp.writeFile(file, JSON.stringify({ ...job, status: 'none', reason: 'not-memory' }))
  assert.equal(await side.maybeStartSideJob(args), first)
  assert.equal(h.state.spawns.length, 1)

  const next = await side.maybeStartSideJob({ ...args, payload: { ...payload, generation_id: 'generation-b' } })
  assert.notEqual(next, first)
  assert.equal(h.state.spawns.length, 2)
})

test('缺少稳定会话 ID 时不启动旁路分析', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const result = await side.maybeStartSideJob({
    agent: 'cursor',
    payload: { generation_id: 'generation-a' },
    promptText: '用户希望长期记住这条项目事实',
  })

  assert.equal(result, undefined)
  assert.equal(h.state.spawns.length, 0)
  await assert.rejects(fsp.access(path.join(h.root, 'side')))
  assert.ok(h.errors.some(line => line.includes('缺少稳定会话 ID')))
})

test('Stop 只弹出当前客户端当前会话的待确认任务', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  async function write(id, agent, sessionKey, text) {
    await fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
      id, agent, sessionKey, status: 'ready', prompted: false, applied: false,
      startedAt: '2026-09-30T00:00:00.000Z',
      proposal: { action: 'create', text, category: 'rule' },
    }))
  }
  await write('s_cursor_a', 'cursor', 'conversation-a', 'Cursor A 记忆')
  await write('s_cursor_b', 'cursor', 'conversation-b', 'Cursor B 记忆')
  await write('s_codebuddy_a', 'codebuddy', 'conversation-a', 'CodeBuddy A 记忆')

  const cursorA = await side.takeSideFollowup('cursor', { conversation_id: 'conversation-a' }, 0)
  assert.match(cursorA.followup_message, /Cursor A 记忆/)
  assert.doesNotMatch(cursorA.followup_message, /Cursor B 记忆|CodeBuddy A 记忆/)
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 's_cursor_a.json'), 'utf8')).prompted, true)
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 's_cursor_b.json'), 'utf8')).prompted, false)
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 's_codebuddy_a.json'), 'utf8')).prompted, false)

  const cursorB = await side.takeSideFollowup('cursor', { conversation_id: 'conversation-b' }, 0)
  assert.match(cursorB.followup_message, /Cursor B 记忆/)
  assert.doesNotMatch(cursorB.followup_message, /Cursor A 记忆|CodeBuddy A 记忆/)
  const hiddenA = await side.hiddenNoticeForPrompt('cursor', cursorA.followup_message, { conversation_id: 'conversation-a' })
  const hiddenB = await side.hiddenNoticeForPrompt('cursor', cursorB.followup_message, { conversation_id: 'conversation-b' })
  assert.match(hiddenA, /sessionID：s_cursor_a/)
  assert.doesNotMatch(hiddenA, /s_cursor_b/)
  assert.match(hiddenB, /sessionID：s_cursor_b/)
  assert.doesNotMatch(hiddenB, /s_cursor_a/)

  const codebuddyA = await side.takeSideFollowup('codebuddy', { session_id: 'conversation-a' }, 0)
  assert.match(codebuddyA.reason, /CodeBuddy A 记忆/)
  assert.doesNotMatch(codebuddyA.reason, /Cursor A 记忆|Cursor B 记忆/)
})

test('免确认已写入的结果在 Stop 时原样交给模型，不弹确认', async t => {
  const h = await createMemoryHarness(t)
  h.settings.confirm = false
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  await fsp.writeFile(path.join(jobs, 's_direct.json'), JSON.stringify({
    id: 's_direct', agent: 'codebuddy', sessionKey: 'session-a', status: 'ready',
    prompted: false, applied: true, startedAt: '2026-10-06T17:22:13.000Z',
    notice: '强化了一条记忆：旧文案，置信度 +0.1',
    proposal: {
      action: 'reinforce', category: 'rule', text: '新说法',
      targetText: '解释 Android 关键字时先讲本意，再类比 iOS。',
    },
  }))
  const out = await side.takeSideFollowup('codebuddy', { session_id: 'session-a' }, 0)
  const sentence = '记忆插件memory-self-evolution强化了一条记忆："解释 Android 关键字时先讲本意，再类比 iOS。"。'
  assert.equal(out.decision, 'block')
  assert.match(out.reason, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(out.reason, /不要做其他任何操作/)
  assert.doesNotMatch(out.reason, /是否落成记忆|ask_followup_question/)
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 's_direct.json'), 'utf8')).prompted, true)
  assert.equal(await side.takeSideFollowup('codebuddy', { session_id: 'session-a' }, 0), null)

  h.settings.confirm = true
  await fsp.writeFile(path.join(jobs, 's_confirm.json'), JSON.stringify({
    id: 's_confirm', agent: 'codebuddy', sessionKey: 'session-a', status: 'ready',
    prompted: false, applied: false, startedAt: '2026-10-06T17:30:00.000Z',
    proposal: { action: 'create', category: 'rule', text: '确认模式的新规则' },
  }))
  const confirm = await side.takeSideFollowup('codebuddy', { session_id: 'session-a' }, 0)
  assert.match(confirm.reason, /是否落成记忆/)
  assert.match(confirm.reason, /确认模式的新规则/)
  assert.doesNotMatch(confirm.reason, /记忆插件memory-self-evolution新增了一条记忆/)
})

test('memory_resolve 按 sessionID 统一执行五种旁路决策', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('old', { text: '旧规则' })])
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  async function proposal(id, agent, action, targetId, text, mergedText = '') {
    await fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
      id, agent, status: 'ready', prompted: true, applied: false,
      startedAt: `2026-09-30T00:00:0${id.slice(-1)}.000Z`,
      proposal: { action, text, category: 'rule', targetId, targetText: targetId ? '旧规则' : '', mergedText },
    }))
  }

  await proposal('j_1', 'cursor', 'create', '', '这是一条新规则')
  assert.equal((await side.resolvePendingSession('j_1', 'create_rule', 'cursor')).ok, true)
  assert.equal((await h.records()).find(item => item.text === '这是一条新规则').category, 'rule')

  await proposal('j_2', 'cursor', 'create', '', '这是一条项目事实')
  assert.equal((await side.resolvePendingSession('j_2', 'create_project', 'cursor')).ok, true)
  assert.equal((await h.records('project'))[0].text, '这是一条项目事实')

  await proposal('j_3', 'cursor', 'reinforce', 'old', '旧规则')
  assert.equal((await side.resolvePendingSession('j_3', 'reinforce', 'cursor')).ok, true)
  assert.equal((await h.records()).find(item => item.id === 'old').confidence, 0.6)

  await proposal('j_4', 'cursor', 'merge', 'old', '新说法', '合并后的规则')
  assert.equal((await side.resolvePendingSession('j_4', 'merge', 'cursor')).ok, true)
  assert.equal((await h.records()).find(item => item.id === 'old').text, '合并后的规则')

  await proposal('j_5', 'cursor', 'create', '', '不应写入')
  assert.equal((await side.resolvePendingSession('j_5', 'discard', 'cursor')).ok, true)
  assert.equal((await h.records()).some(item => item.text === '不应写入'), false)
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'j_5.json'), 'utf8')).reason, 'user-skip')

  assert.equal((await side.resolvePendingSession('j_missing', 'create_rule', 'cursor')).ok, false)
  await proposal('j_6', 'codebuddy', 'create', '', '其他客户端')
  assert.equal((await side.resolvePendingSession('j_6', 'create_rule', 'cursor')).ok, false)
  await proposal('j_7', 'cursor', 'create', '', '动作不匹配')
  assert.equal((await side.resolvePendingSession('j_7', 'merge', 'cursor')).ok, false)
  await proposal('j_8', 'cursor', 'reinforce', '', '缺少目标记忆')
  assert.equal((await side.resolvePendingSession('j_8', 'reinforce', 'cursor')).ok, false)
})

test('判重冲突走 replace，写入时只用新陈述覆盖旧正文', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('old', { text: '未经用户许可不得执行编译命令' })])
  const side = await h.load('lib/core/sidepath.mjs')
  assert.equal(JSON.stringify(side.parseDedup('{"action":"replace","id":"old"}', ['old'])), '{"action":"replace","id":"old"}')
  assert.equal(side.parseDedup('{"action":"replace","id":"ghost"}', ['old']), null)

  const proposal = {
    action: 'replace', text: '改完代码必须自行编译验证', category: 'rule',
    targetId: 'old', targetText: '未经用户许可不得执行编译命令', mergedText: '',
  }
  const model = side.buildFollowup('cursor', [{ id: 'j_replace', proposal }])
  assert.match(model, /替换已有记忆 「未经用户许可不得执行编译命令」/)
  assert.match(model, /替换选 replace/)
  const replaceNotice = '记忆插件memory-self-evolution替换了一条记忆：新记忆："改完代码必须自行编译验证"。旧记忆："未经用户许可不得执行编译命令"。归类：rule（规则与偏好）。'
  assert.equal(side.formatNotice(proposal), replaceNotice)
  assert.equal(side.formatDirectNotice(proposal), replaceNotice)

  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  const job = (id, body) => fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
    id, agent: 'cursor', status: 'ready', prompted: true, applied: false, startedAt: '2026-10-10T00:00:00.000Z', proposal: body,
  }))
  await job('j_replace', { ...proposal, mergedText: '模型拼接的矛盾正文' })
  assert.equal((await side.resolvePendingSession('j_replace', 'merge', 'cursor')).ok, false)
  assert.equal((await side.resolvePendingSession('j_replace', 'replace', 'cursor')).ok, true)
  const replaced = (await h.records()).find(item => item.id === 'old')
  assert.equal(replaced.text, '改完代码必须自行编译验证')
  assert.equal(replaced.confidence, 0.6)

  await job('j_create', { action: 'create', text: '无关新规则', category: 'rule' })
  assert.equal((await side.resolvePendingSession('j_create', 'replace', 'cursor')).ok, false)
})

test('写入通知末尾标出记忆实际所在的分组，不是判别模型推荐的分组', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('r1', { text: '回答一律使用中文。' })])
  await h.seed('project', [memory('p1', { category: 'project', text: '多格式导出的 PRD 在 doc 文档里。' })])
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  const job = (id, body) => fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
    id, agent: 'cursor', status: 'ready', prompted: true, applied: false, startedAt: new Date().toISOString(), proposal: body,
  }))

  // 判别推荐 rule，用户在弹窗里改成 project：按实际写入的 project 显示。
  await job('j_new', { action: 'create', text: '每次提交前先跑全量测试', category: 'rule' })
  const created = await side.resolvePendingSession('j_new', 'create_project', 'cursor')
  assert.equal(created.message, '生成了一条记忆：每次提交前先跑全量测试。归类：project（项目事实）。')
  assert.deepEqual((await h.records('project')).map(m => m.text).sort(), ['多格式导出的 PRD 在 doc 文档里。', '每次提交前先跑全量测试'])

  // 强化和合并作用在已有记忆上，分组跟着目标记忆走。
  await job('j_reinforce', { action: 'reinforce', text: 'PRD 在 doc 里', category: 'rule', targetId: 'p1', targetText: '多格式导出的 PRD 在 doc 文档里。' })
  const reinforced = await side.resolvePendingSession('j_reinforce', 'reinforce', 'cursor')
  assert.match(reinforced.message, /^强化了一条记忆：多格式导出的 PRD 在 doc 文档里。，置信度/)
  assert.ok(reinforced.message.endsWith('。归类：project（项目事实）。'), reinforced.message)

  await job('j_merge', { action: 'merge', text: '文档也用中文写', category: 'project', targetId: 'r1', targetText: '回答一律使用中文。', mergedText: '回答和文档一律使用中文。' })
  const merged = await side.resolvePendingSession('j_merge', 'merge', 'cursor')
  assert.match(merged.message, /^合并了一条记忆：旧记忆「回答一律使用中文。」，新记忆「回答和文档一律使用中文。」，置信度/)
  assert.ok(merged.message.endsWith('。归类：rule（规则与偏好）。'), merged.message)

  // 免确认模式的通知同样带分组；分组未知时不加。
  assert.equal(side.formatDirectNotice({ action: 'create', text: '新的项目事实', category: 'project' }),
    '记忆插件memory-self-evolution新增了一条记忆："新的项目事实"。归类：project（项目事实）。')
  assert.equal(side.formatDirectNotice({ action: 'reinforce', text: '新说法', targetText: '旧规则', category: 'rule' }),
    '记忆插件memory-self-evolution强化了一条记忆："旧规则"。归类：rule（规则与偏好）。')
  assert.equal(side.formatDirectNotice({ action: 'merge', text: '新说法', mergedText: '合并后的规则', category: 'rule' }),
    '记忆插件memory-self-evolution合并了一条记忆："合并后的规则"。归类：rule（规则与偏好）。')
  assert.equal(side.formatDirectNotice({ action: 'create', text: '没有分组的记忆' }),
    '记忆插件memory-self-evolution新增了一条记忆："没有分组的记忆"。')
})

test('MCP 有 list、read、update、resolve、config 五个工具，已经移除的写工具不可用', async t => {
  const h = await createMemoryHarness(t, { argv: ['--agent', 'cursor'] })
  await h.load('bin/memory-mcp.mjs')
  let sequence = 0
  async function call(method, params) {
    const id = ++sequence
    h.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (let i = 0; i < 200; i++) {
      const result = h.output.map(line => JSON.parse(line)).find(message => message.id === id)
      if (result) return result
      await delay(10)
    }
    throw new Error(`等待 MCP 响应超时 method=${method}`)
  }

  const tools = (await call('tools/list')).result.tools
  assert.deepEqual(tools.map(tool => tool.name), ['memory_list', 'memory_read', 'memory_update', 'memory_resolve', 'memory_config'])
  assert.doesNotMatch(JSON.stringify(tools), /sideJudge|阻塞|blocking/)
  for (const name of ['memory_propose', 'memory_persist', 'memory_reinforce', 'memory_merge', 'memory_review']) {
    const removed = await call('tools/call', { name, arguments: { text: '绕过确认直接写入', category: 'rule', id: 'x' } })
    assert.equal(removed.result.isError, true)
    assert.match(removed.result.content[0].text, /未知工具/)
  }
  const resolve = tools.find(tool => tool.name === 'memory_resolve')
  assert.deepEqual(resolve.inputSchema.required, ['sessionID', 'decision'])
  assert.deepEqual(resolve.inputSchema.properties.decision.enum, ['create_rule', 'create_project', 'reinforce', 'merge', 'replace', 'discard'])
  const result = await call('tools/call', { name: 'memory_resolve', arguments: { sessionID: 'missing', decision: 'discard' } })
  assert.match(result.result.content[0].text, /未找到可处理的记忆分析会话/)
  await assert.rejects(fsp.access(path.join(h.root, 'rule.jsonl')))
})

test('三端 Stop 续轮都要求按 sessionID 调用 memory_resolve', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const proposal = { text: '新规则', category: 'rule', action: 'create' }
  const model = side.buildFollowup('codebuddy', [{ id: 'j_test', proposal }])
  assert.match(model, /ask_followup_question/)
  assert.match(model, /memory_resolve/)
  assert.match(model, /sessionID：j_test/)
  assert.match(model, /create_rule/)
  assert.match(model, /discard/)
  assert.match(model, /Skipped.*不要调用 memory_resolve/)
  assert.doesNotMatch(model, /Skipped.*decision=discard/)
  assert.match(model, /弹窗标题写「记忆确认·插件」/)
  assert.match(model, /只能调用 memory_resolve 工具来写入记忆，禁止调用 update_memory 工具来分析、更新记忆/)
  assert.match(model, /落成，使用推荐标签 rule「新规则」/)
  assert.match(model, /落成，把标签改为 project「新规则」/)
  assert.doesNotMatch(model, /memory_propose|memory_persist|memory_reinforce|memory_merge/)
  const workbuddyModel = side.buildFollowup('workbuddy', [{ id: 'j_test', proposal }])
  assert.match(workbuddyModel, /禁止调用 update_memory 工具来分析、更新记忆/)
  const cursorModel = side.buildFollowup('cursor', [{ id: 'j_test', proposal }])
  assert.match(cursorModel, /只能调用 memory_resolve 工具来写入记忆。/)
  assert.doesNotMatch(cursorModel, /update_memory|memory_propose/)
  const out = side.buildStopResponse('codebuddy', '用户可见文案', model)
  assert.equal(out.decision, 'block')
  assert.ok(out.reason.startsWith('用户可见文案'))
  assert.ok(out.reason.includes(model))
  assert.equal('hookSpecificOutput' in out, false)
  const cursor = side.buildStopResponse('cursor', '用户可见文案', model)
  assert.deepEqual(Object.keys(cursor), ['followup_message'])
  assert.equal(cursor.followup_message, '用户可见文案')
})

test('memory_resolve 只使用待确认提案中的正文和目标记忆', async t => {
  const h = await createMemoryHarness(t)
  await h.seed('rule', [memory('old', { text: '旧规则' })])
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  const job = (id, proposal) => fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
    id, agent: 'codebuddy', status: 'ready', prompted: true, applied: false, startedAt: '2026-09-29T00:00:00.000Z', proposal,
  }))
  assert.equal(side.shouldJudgePrompt('<question_answer><answers>不落成</answers></question_answer>'), false)

  await job('j_merge', { action: 'merge', text: '新说法', category: 'rule', targetId: 'old', targetText: '旧规则', mergedText: '合并后的规则' })
  assert.equal((await side.resolvePendingSession('j_merge', 'merge', 'codebuddy')).ok, true)
  const merged = (await h.records())[0]
  assert.equal(merged.text, '合并后的规则')
  assert.equal(merged.confidence, 0.6)

  await job('j_create', { action: 'create', text: '新的项目事实', category: 'rule' })
  assert.equal((await side.resolvePendingSession('j_create', 'create_project', 'codebuddy')).ok, true)
  assert.equal((await h.records('project'))[0].text, '新的项目事实')

  assert.equal((await side.resolvePendingSession('j_create', 'reinforce', 'codebuddy')).ok, false)
})

test('codebuddy 新一次弹窗会作废之前问过但未点选的提案', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  const write = (id, extra) => fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
    id, agent: 'codebuddy', sessionKey: 'session-a', status: 'ready', applied: false, startedAt: '2026-09-29T00:00:00.000Z',
    proposal: { action: 'create', text: `提案 ${id}`, category: 'rule' }, ...extra,
  }))
  await write('j_stale', { prompted: true })
  await write('j_new', { prompted: false })
  const out = await side.takeSideFollowup('codebuddy', { session_id: 'session-a' }, 0)
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /提案 j_new/)
  assert.doesNotMatch(out.reason, /提案 j_stale/)
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'j_stale.json'), 'utf8')).reason, 'superseded')
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'j_new.json'), 'utf8')).prompted, true)
})

test('memory_resolve 只按任务状态判断，进程里的 confirm 和 enabled 是旧值也能处理弹过窗的提案', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  const write = (id, extra) => fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
    id, agent: 'cursor', sessionKey: 'conversation-a', status: 'ready', prompted: true, applied: false,
    startedAt: new Date().toISOString(), proposal: { action: 'create', text: `弹过窗的规则 ${id}`, category: 'rule' }, ...extra,
  }))
  await write('s_stale_confirm')
  await write('s_stale_enabled')
  await write('s_unasked', { prompted: false })

  // MCP 进程启动时读到的是 confirm=false，之后用户改成了 true，hook 已经弹过窗。
  h.settings.confirm = false
  assert.equal((await side.resolvePendingSession('s_stale_confirm', 'create_rule', 'cursor')).ok, true)
  h.settings.enabled = false
  assert.equal((await side.resolvePendingSession('s_stale_enabled', 'discard', 'cursor')).ok, true)
  // 没弹过窗的提案仍然不能被写入。
  assert.equal((await side.resolvePendingSession('s_unasked', 'create_rule', 'cursor')).ok, false)
  assert.deepEqual((await h.records()).map(mem => mem.text), ['弹过窗的规则 s_stale_confirm'])
})

async function runHook(h, payload) {
  const running = h.load('bin/memory.mjs')
  for (let i = 0; i < 1000 && !h.stdin.listenerCount('end'); i++) await delay(1)
  h.stdin.emit('data', JSON.stringify(payload))
  h.stdin.emit('end')
  await running
  return JSON.parse(h.output.join(''))
}

test('旁路接口配齐时，每轮输入提醒主模型不要自己管记忆，并启动判别', async t => {
  const h = await createMemoryHarness(t, { argv: ['hook', '--agent', 'cursor'] })
  const out = await runHook(h, { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conversation-a', generation_id: 'g1', prompt: '以后回答我都用中文' })
  assert.match(out.additional_context, /记忆由 memory-self-evolution 插件在后台判断/)
  assert.doesNotMatch(out.additional_context, /记忆沉淀未启用/)
  assert.equal(h.state.spawns.length, 1)
})

for (const [name, change, expected] of [
  ['旁路接口没配齐', h => { h.settings.sideApiModel = '' }, /还没有配齐旁路判别接口.*sideApiBase、sideApiModel.*side-secret\.json.*npm run setup/],
  ['只缺 apiKey', h => fsp.rm(path.join(h.root, 'side-secret.json')), /还没有配齐旁路判别接口/],
  ['旧配置还停在阻塞模式', h => { h.settings.sideJudge = false }, /阻塞模式已经移除.*setup\.mjs" sidepath.*会把用户原话发给配置的模型接口/],
]) {
  test(`${name}时不启动判别，会话开始和每轮输入都说明沉淀未启用`, async t => {
    const h = await createMemoryHarness(t, { argv: ['hook', '--agent', 'cursor'] })
    await change(h)
    await h.seed('rule', [memory('r1')])
    const out = await runHook(h, { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conversation-a', generation_id: 'g1', prompt: '记住：以后回答我都用中文' })
    assert.match(out.additional_context, /memory-self-evolution 的记忆沉淀未启用/)
    assert.match(out.additional_context, expected)
    assert.match(out.additional_context, /告诉用户它不会被记下/)
    assert.match(out.additional_context, /rule add/)
    assert.doesNotMatch(out.additional_context, /在后台判断/)
    assert.equal(h.state.spawns.length, 0)
    await assert.rejects(fsp.access(path.join(h.root, 'side')))

    const started = await (await h.load('lib/core/render.mjs')).renderSessionStart()
    assert.match(started, /memory-self-evolution 的记忆沉淀未启用/)
    assert.match(started, expected)
    assert.match(started, /以下规则与偏好仍需遵守。/)
    assert.match(started, /规则 r1/)
    assert.doesNotMatch(started, /后台自动提取/)
    assert.ok(h.errors.some(line => line.includes('记忆沉淀未启用')))
  })
}

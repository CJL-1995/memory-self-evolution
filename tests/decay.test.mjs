import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryHarness, memory } from './helpers/memory.mjs'

const DAY = 86400000
const START = '2026-09-29T04:00:00.000Z'
const exec = promisify(execFile)
const stamp = h => new Date(h.clock.now).toISOString()
const daysAgo = (h, days) => new Date(h.clock.now - days * DAY).toISOString()
const stateFile = h => path.join(h.root, 'decay-state.json')
const readState = async h => JSON.parse(await fsp.readFile(stateFile(h), 'utf8'))

test('满30天才实际扣0.05并重置时间，未到期不改时间，跨多个周期只扣一次', async t => {
  const h = await createMemoryHarness(t, { now: START })
  const recent = daysAgo(h, 30 - 1 / DAY)
  await h.seed('rule', [
    memory('due', { lastSeen: daysAgo(h, 30) }),
    memory('recent', { lastSeen: recent }),
    memory('long-idle', { confidence: 0.8, lastSeen: daysAgo(h, 180) }),
  ])
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal(await writer.decayMemoriesOncePerDay(), 2)
  const rows = new Map((await h.records()).map(mem => [mem.id, mem]))
  assert.equal(rows.get('due').confidence, 0.45)
  assert.equal(rows.get('due').lastSeen, START)
  assert.equal(rows.get('recent').confidence, 0.5)
  assert.equal(rows.get('recent').lastSeen, recent)
  assert.equal(rows.get('long-idle').confidence, 0.75)
  assert.equal(rows.get('long-idle').lastSeen, START)
  assert.equal((await readState(h)).lastRunAt, START)
})

test('decayDays改为7时按7天判断满周期', async t => {
  const h = await createMemoryHarness(t, { now: START })
  h.settings.decayDays = 7
  const recent = daysAgo(h, 7 - 1 / DAY)
  await h.seed('rule', [memory('due', { lastSeen: daysAgo(h, 7) }), memory('recent', { lastSeen: recent })])
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  const rows = new Map((await h.records()).map(mem => [mem.id, mem]))
  assert.equal(rows.get('due').confidence, 0.45)
  assert.equal(rows.get('due').lastSeen, START)
  assert.equal(rows.get('recent').confidence, 0.5)
  assert.equal(rows.get('recent').lastSeen, recent)
})

test('连续两个闲置周期实际为0.45、0.4，降到0.4即废弃，之后不再自动恢复或继续扣分', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
  const writer = await h.load('lib/core/writer.mjs')
  for (const expected of [0.45, 0.4]) {
    assert.equal(await writer.decayMemoriesOncePerDay(), 1)
    const mem = (await h.records())[0]
    assert.equal(mem.confidence, expected)
    assert.equal(mem.lastSeen, stamp(h))
    assert.equal(mem.deprecated, expected <= 0.4)
    h.clock.now += 30 * DAY
  }
  const before = await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8')
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  assert.equal(await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8'), before)
})

test('本地日期内只扫描一次，跨会话共享标记，次日重新检查', async t => {
  const now = new Date(2026, 8, 29, 23, 59).toISOString()
  const h = await createMemoryHarness(t, { now })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 31) })])
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  const reads = h.state.reads.get(path.join(h.root, 'rule.jsonl'))
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  assert.equal(h.state.reads.get(path.join(h.root, 'rule.jsonl')), reads)
  assert.equal((await readState(h)).lastRunDate, '2026-09-29')
  const other = await createMemoryHarness(t, { home: h.home, now })
  assert.equal(await (await other.load('lib/core/writer.mjs')).decayMemoriesOncePerDay(), 0)
  assert.equal(other.state.reads.get(path.join(h.root, 'rule.jsonl')), undefined)
  h.clock.now += 2 * 60000
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  assert.equal((await readState(h)).lastRunDate, '2026-09-30')
  assert.equal((await h.records())[0].lastSeen, now)
})

test('多个并发sessionStart只执行一次日检', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
  const render = await h.load('lib/core/render.mjs')
  const outputs = await Promise.all(Array.from({ length: 5 }, () => render.renderSessionStart()))
  assert.ok(outputs.every(text => text.includes('置信度 0.45')))
  assert.equal((await h.records())[0].confidence, 0.45)
  assert.equal(h.errors.filter(line => line.includes('每日衰减完成')).length, 1)
})

test('每日遗忘扫描顺带清理前一天已弹窗但未处理的僵尸任务', async t => {
  const h = await createMemoryHarness(t, { now: START })
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs)
  async function write(id, extra) {
    await fsp.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({
      id,
      agent: 'cursor',
      sessionKey: 'conversation-a',
      status: 'ready',
      prompted: true,
      applied: false,
      startedAt: daysAgo(h, 1),
      promptedAt: daysAgo(h, 1),
      proposal: { action: 'create', text: `提案 ${id}`, category: 'rule' },
      ...extra,
    }))
  }
  await write('zombie-old', {})
  await write('pending-today', { startedAt: START, promptedAt: START })
  await write('not-prompted', { prompted: false })

  const render = await h.load('lib/core/render.mjs')
  await render.renderSessionStart()
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'zombie-old.json'), 'utf8')).reason, 'daily-zombie-cleanup')
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'pending-today.json'), 'utf8')).status, 'ready')
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'not-prompted.json'), 'utf8')).status, 'ready')

  await write('zombie-after-scan', {})
  await render.renderSessionStart()
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'zombie-after-scan.json'), 'utf8')).status, 'ready')

  h.clock.now += DAY
  await render.renderSessionStart()
  assert.equal(JSON.parse(await fsp.readFile(path.join(jobs, 'zombie-after-scan.json'), 'utf8')).reason, 'daily-zombie-cleanup')
})

test('不同进程共用当天执行标记，不重复扣分', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
  const helper = new URL('./helpers/memory.mjs', import.meta.url).href
  const code = `import { createMemoryHarness } from ${JSON.stringify(helper)}; const h = await createMemoryHarness(null, { home: process.argv[1], now: process.argv[2] }); const writer = await h.load('lib/core/writer.mjs'); console.log(await writer.decayMemoriesOncePerDay());`
  const results = await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', code, h.home, START])))
  assert.equal(results.reduce((total, result) => total + Number(result.stdout.trim()), 0), 1)
  assert.equal((await h.records())[0].confidence, 0.45)
})

for (const [operation, increment] of [['rewardRecalledMemories', 0.05], ['reinforceMemory', 0.1], ['mergeMemory', 0.1]]) {
  test(`${operation}在实际扣分后加分并重置衰减起点，不恢复历史扣分`, async t => {
    const h = await createMemoryHarness(t, { now: START })
    await h.seed('rule', [memory('a', { confidence: 0.7, lastSeen: daysAgo(h, 90) })])
    const writer = await h.load('lib/core/writer.mjs')
    await writer.decayMemoriesOncePerDay()
    assert.equal((await h.records())[0].confidence, 0.65)
    h.clock.now += DAY
    if (operation === 'rewardRecalledMemories') await writer[operation](['a'])
    else await writer[operation]('a', '更新后的规则')
    const activeAt = stamp(h)
    const expected = Math.round((0.65 + increment) * 100) / 100
    assert.equal((await h.records())[0].confidence, expected)
    assert.equal((await h.records())[0].lastSeen, activeAt)
    h.clock.now += 29 * DAY
    await writer.decayMemoriesOncePerDay()
    assert.equal((await h.records())[0].confidence, expected)
    assert.equal((await h.records())[0].lastSeen, activeAt)
    h.clock.now += DAY
    await writer.decayMemoriesOncePerDay()
    assert.equal((await h.records())[0].confidence, Math.round((expected - 0.05) * 100) / 100)
    assert.equal((await h.records())[0].lastSeen, stamp(h))
  })
}

test('不高于0.4和已标记废弃的记忆不参与召回、判重、编码或中心化', async t => {
  const h = await createMemoryHarness(t, { now: START, realRecall: true })
  await h.seed('rule', [
    memory('low', { text: '低强度记忆', confidence: 0.4, lastSeen: START }),
    memory('deprecated', { text: '废弃记忆', confidence: 0.9, deprecated: true, lastSeen: START }),
    memory('valid', { text: '有效记忆', confidence: 0.45, lastSeen: START }),
  ])
  const store = await h.load('lib/core/store.mjs')
  assert.deepEqual([...(await store.readAllMemories())].map(mem => mem.id), ['valid'])
  const all = await store.readAllMemories({ includeDeprecated: true })
  const recall = await h.load('lib/core/recall.mjs')
  for (const gate of [true, false]) {
    const hits = await recall.recall(['问题'], all, { gate })
    assert.deepEqual([...hits].map(hit => hit.memory.id), ['valid'])
  }
  assert.ok(!h.state.embeddedTexts.includes('低强度记忆'))
  assert.ok(!h.state.embeddedTexts.includes('废弃记忆'))
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal((await writer.rewardRecalledMemories(['low', 'deprecated'])).length, 0)
  const render = await h.load('lib/core/render.mjs')
  const text = await render.renderSessionStart()
  assert.match(text, /有效记忆/)
  assert.doesNotMatch(text, /低强度记忆|废弃记忆/)
  assert.equal((await h.records()).find(mem => mem.id === 'low').deprecated, true)
})

test('强化或合并废弃记忆后仍不高于0.4时不能恢复', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { confidence: 0.1, deprecated: true, lastSeen: START })])
  const writer = await h.load('lib/core/writer.mjs')
  assert.equal((await writer.reinforceMemory('a')).deprecated, true)
  h.clock.now += DAY
  assert.equal((await writer.mergeMemory('a', '更新后的规则正文')).deprecated, true)
  h.clock.now += DAY
  const boundary = await writer.reinforceMemory('a')
  assert.equal(boundary.confidence, 0.4)
  assert.equal(boundary.deprecated, true)
  h.clock.now += DAY
  const restored = await writer.reinforceMemory('a')
  assert.equal(restored.confidence, 0.5)
  assert.equal(restored.deprecated, false)
})

test('新记忆一次都没被用到时第30天0.45、第60天0.4并被遗忘', async t => {
  const h = await createMemoryHarness(t, { now: START })
  const writer = await h.load('lib/core/writer.mjs')
  const store = await h.load('lib/core/store.mjs')
  await writer.persistMemory({ text: '没人再提起的记忆', category: 'project' })
  const current = async () => (await h.records('project'))[0]
  h.clock.now += 29 * DAY
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  h.clock.now += DAY
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  assert.equal((await current()).confidence, 0.45)
  assert.equal((await store.readAllMemories()).length, 1)
  h.clock.now += 29 * DAY
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  h.clock.now += DAY
  assert.equal(await writer.decayMemoriesOncePerDay(), 1)
  assert.equal((await current()).confidence, 0.4)
  assert.equal((await current()).deprecated, true)
  assert.equal((await store.readAllMemories()).length, 0)
})

for (const failingFile of ['project.jsonl', 'decay-state.json']) {
  test(`${failingFile}写失败不标记当天完成，重试不重复扣已成功记录`, async t => {
    const h = await createMemoryHarness(t, { now: START })
    await h.seed('rule', [memory('r', { lastSeen: daysAgo(h, 30) })])
    await h.seed('project', [memory('p', { category: 'project', lastSeen: daysAgo(h, 30) })])
    h.state.failRenameTo = failingFile
    const render = await h.load('lib/core/render.mjs')
    assert.match(await render.renderSessionStart(), /规则 r（置信度 0.45/)
    await assert.rejects(fsp.access(stateFile(h)), { code: 'ENOENT' })
    assert.ok(h.errors.some(line => line.includes('每日维护失败') && line.includes('模拟记忆写入失败')))
    h.state.failRenameTo = ''
    await render.renderSessionStart()
    assert.equal((await h.records())[0].confidence, 0.45)
    assert.equal((await h.records('project'))[0].confidence, 0.45)
    assert.equal((await readState(h)).lastRunAt, START)
  })
}

test('记忆读取异常不能当成空库完成日检，损坏记录不能被覆盖', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
  const writer = await h.load('lib/core/writer.mjs')
  h.state.failRead = 'rule.jsonl'
  await assert.rejects(writer.decayMemoriesOncePerDay(), /模拟读取失败/)
  await assert.rejects(fsp.access(stateFile(h)), { code: 'ENOENT' })
  h.state.failRead = ''
  const file = path.join(h.root, 'rule.jsonl')
  for (const invalid of ['{invalid}', '{}', 'null', '{"text":12}']) {
    await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
    await fsp.appendFile(file, `${invalid}\n`)
    const before = await fsp.readFile(file, 'utf8')
    await assert.rejects(writer.decayMemoriesOncePerDay())
    assert.equal(await fsp.readFile(file, 'utf8'), before)
    await assert.rejects(fsp.access(stateFile(h)), { code: 'ENOENT' })
  }
})

test('损坏日检标记会重做检查，但时间戳防止当天再次扣分', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
  const writer = await h.load('lib/core/writer.mjs')
  await writer.decayMemoriesOncePerDay()
  await fsp.writeFile(stateFile(h), '{invalid}')
  assert.equal(await writer.decayMemoriesOncePerDay(), 0)
  assert.equal((await h.records())[0].confidence, 0.45)
  assert.ok(h.errors.some(line => line.includes('读取每日衰减状态失败')))
})

for (const agent of ['cursor', 'codebuddy', 'workbuddy']) {
  for (const sideJudge of [true, false]) {
    test(`${agent} sideJudge=${sideJudge} 会话开始先衰减再注入，Stop不衰减`, async t => {
      const h = await createMemoryHarness(t, { now: START, argv: ['hook', '--agent', agent] })
      h.settings.sideJudge = sideJudge
      await h.seed('rule', [memory('expired', { confidence: 0.4, lastSeen: daysAgo(h, 30) }), memory('active', { lastSeen: daysAgo(h, 30) })])
      const running = h.load('bin/memory.mjs')
      for (let i = 0; i < 1000 && !h.stdin.listenerCount('end'); i++) await delay(1)
      assert.ok(h.stdin.listenerCount('end'))
      h.stdin.emit('data', JSON.stringify({ hook_event_name: agent === 'cursor' ? 'sessionStart' : 'SessionStart' }))
      h.stdin.emit('end')
      await running
      const result = JSON.parse(h.output.join(''))
      const text = agent === 'cursor' ? result.additional_context : result.hookSpecificOutput.additionalContext
      assert.match(text, /规则 active（置信度 0.45/)
      assert.doesNotMatch(text, /规则 expired/)
      assert.equal((await h.records()).find(mem => mem.id === 'expired').deprecated, true)
      const stopped = await createMemoryHarness(t, { home: h.home, now: new Date(h.clock.now + 31 * DAY).toISOString(), argv: ['hook', '--agent', agent] })
      stopped.settings.sideJudge = sideJudge
      const stop = stopped.load('bin/memory.mjs')
      for (let i = 0; i < 1000 && !stopped.stdin.listenerCount('end'); i++) await delay(1)
      assert.ok(stopped.stdin.listenerCount('end'))
      stopped.stdin.emit('data', JSON.stringify({ hook_event_name: agent === 'cursor' ? 'stop' : 'Stop' }))
      stopped.stdin.emit('end')
      await stop
      assert.equal((await readState(h)).lastRunAt, START)
      assert.equal((await h.records()).find(mem => mem.id === 'active').confidence, 0.45)
    })
  }
}

test('禁用插件时sessionStart不执行日检', async t => {
  const h = await createMemoryHarness(t, { now: START })
  await h.seed('rule', [memory('a', { lastSeen: daysAgo(h, 30) })])
  h.settings.enabled = false
  assert.equal(await (await h.load('lib/core/render.mjs')).renderSessionStart(), '')
  assert.equal((await h.records())[0].confidence, 0.5)
  await assert.rejects(fsp.access(stateFile(h)), { code: 'ENOENT' })
})

// 用户主动整理记忆：删除、合并、改写、回收站、打开 memories.md，以及整理记忆用的 skill 的安装。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryHarness, memory } from './helpers/memory.mjs'
import { INSTALL_HOSTS } from '../tools/hosts/index.mjs'
import { SKILL_NAME } from '../tools/hosts/shared.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const SKILL_SOURCE = path.join(repo, 'skills', SKILL_NAME, 'SKILL.md')
const NOW = '2026-10-15T04:00:00.000Z'
const DAY = 86400000

async function readTrash(h) {
  const body = await fsp.readFile(path.join(h.root, 'trash.jsonl'), 'utf8').catch(() => '')
  return body.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function setup(t) {
  const h = await createMemoryHarness(t, { now: NOW })
  await h.seed('rule', [
    memory('r1', { text: '回答一律使用中文。', confidence: 0.8 }),
    memory('r2', { text: '回答我的时候用中文。', confidence: 0.6, lastSeen: '2026-10-14T00:00:00.000Z', firstSeen: '2026-09-01T00:00:00.000Z' }),
    memory('r3', { text: '改完代码不要自动提交。', confidence: 1 }),
  ])
  await h.seed('project', [memory('p1', { category: 'project', text: '多格式导出的 PRD 在 doc 文档里。', confidence: 0.9 })])
  const manage = await h.load('lib/core/manage.mjs')
  return { h, manage }
}

async function proposal(h, id, targetId) {
  const jobs = path.join(h.root, 'side')
  await fsp.mkdir(jobs, { recursive: true })
  const file = path.join(jobs, `${id}.json`)
  await fsp.writeFile(file, JSON.stringify({
    id, agent: 'claude', sessionKey: 's', status: 'ready', prompted: true, applied: false, startedAt: NOW,
    proposal: { action: 'reinforce', text: '新说法', category: 'rule', targetId, targetText: '旧' },
  }))
  return async () => JSON.parse(await fsp.readFile(file, 'utf8'))
}

test('删除：从分组文件和快照里去掉，进回收站，删掉向量，指向它的待确认提案作废', async (t) => {
  const { h, manage } = await setup(t)
  const pending = await proposal(h, 's_pending', 'r3')
  const other = await proposal(h, 's_other', 'r1')

  const message = await manage.updateMemory({ action: 'delete', id: 'r3' })
  assert.match(message, /^已删除规则与偏好里的一条记忆：「改完代码不要自动提交。」（id r3）。在回收站里保留 30 天/)
  assert.ok(message.includes(`node "${path.join(repo, 'bin', 'memory.mjs')}" restore r3`))
  assert.match(message, /另有 1 条指向它的待确认提案已作废。$/)

  assert.deepEqual((await h.records()).map((m) => m.id).sort(), ['r1', 'r2'])
  assert.doesNotMatch(await fsp.readFile(path.join(h.root, 'memories.md'), 'utf8'), /改完代码不要自动提交/)
  const [trashed] = await readTrash(h)
  assert.equal(trashed.id, 'r3')
  assert.equal(trashed.deletedReason, 'delete')
  assert.equal(trashed.deletedAt, NOW)
  assert.deepEqual(h.state.droppedVectors, ['r3'])
  assert.equal((await pending()).reason, 'target-changed')
  assert.equal((await other()).status, 'ready')

  await assert.rejects(manage.updateMemory({ action: 'delete', id: 'r3' }), /未找到记忆 r3/)
})

test('合并：保留 id、正文换成给定的 text 并重算向量，id2 进回收站，置信度取较高的', async (t) => {
  const { h, manage } = await setup(t)
  const pending = await proposal(h, 's_pending', 'r2')

  const message = await manage.updateMemory({ action: 'merge', id: 'r2', id2: 'r1', text: '回答用户的问题时一律使用中文。' })
  assert.match(message, /^已合并两条记忆。保留 r2，正文改为「回答用户的问题时一律使用中文。」，置信度 0\.8。并掉的 r1「回答一律使用中文。」在回收站里保留 30 天/)
  assert.match(message, /另有 1 条指向它的待确认提案已作废。$/)

  const rules = await h.records()
  assert.deepEqual(rules.map((m) => m.id).sort(), ['r2', 'r3'])
  const kept = rules.find((m) => m.id === 'r2')
  assert.equal(kept.text, '回答用户的问题时一律使用中文。')
  assert.equal(kept.confidence, 0.8)
  assert.equal(kept.firstSeen, '2026-09-01T00:00:00.000Z')
  const [trashed] = await readTrash(h)
  assert.deepEqual([trashed.id, trashed.deletedReason, trashed.mergedInto], ['r1', 'merge', 'r2'])
  assert.equal(h.state.vectorRefreshes, 1)
  assert.deepEqual(h.state.droppedVectors, ['r1'])
  assert.equal((await pending()).reason, 'target-changed')
})

test('合并：两条在不同分组时沿用保留那条的分组；参数不全或不合要求时拒绝且不改动任何文件', async (t) => {
  const { h, manage } = await setup(t)
  const before = [await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8'), await fsp.readFile(path.join(h.root, 'project.jsonl'), 'utf8')]
  for (const [args, error] of [
    [{ action: 'merge', id: 'r1', text: '合并后的规则正文。' }, /合并缺少 id2/],
    [{ action: 'merge', id: 'r1', id2: 'r2' }, /合并缺少 text：合并后的正文由用户给出/],
    [{ action: 'merge', id: 'r1', id2: 'r1', text: '合并后的规则正文。' }, /不能是同一条/],
    [{ action: 'merge', id: 'r1', id2: 'nope', text: '合并后的规则正文。' }, /未找到记忆 nope/],
    [{ action: 'merge', id: 'r1', id2: 'r2', text: '太短' }, /不足 6 个字/],
    [{ action: 'replace', id: 'r1' }, /改写缺少 text/],
    [{ action: 'replace', id: 'r1', text: '长'.repeat(401) }, /超过 400 个字/],
    [{ action: 'remove', id: 'r1' }, /action 只能是 delete、merge、replace/],
    [{ action: 'delete' }, /缺少 id/],
  ]) await assert.rejects(manage.updateMemory(args), error)
  assert.deepEqual([await fsp.readFile(path.join(h.root, 'rule.jsonl'), 'utf8'), await fsp.readFile(path.join(h.root, 'project.jsonl'), 'utf8')], before)
  assert.deepEqual(await readTrash(h), [])

  await manage.updateMemory({ action: 'merge', id: 'p1', id2: 'r3', text: '多格式导出的 PRD 在 doc 文档里，改完代码不要自动提交。' })
  assert.deepEqual((await h.records()).map((m) => m.id).sort(), ['r1', 'r2'])
  const [merged] = await h.records('project')
  assert.equal(merged.id, 'p1')
  assert.equal(merged.confidence, 1)
  assert.equal((await readTrash(h))[0].category, 'rule')
})

test('改写：只换正文并重算向量，置信度和其它字段不变', async (t) => {
  const { h, manage } = await setup(t)
  const before = (await h.records()).find((m) => m.id === 'r2')
  const message = await manage.updateMemory({ action: 'replace', id: 'r2', text: '回答我的问题时一律用简体中文。' })
  assert.equal(message, '已改写记忆 r2：原来是「回答我的时候用中文。」，现在是「回答我的问题时一律用简体中文。」，置信度 0.6 不变。')
  const after = (await h.records()).find((m) => m.id === 'r2')
  assert.deepEqual({ ...after, text: before.text }, before)
  assert.equal(h.state.vectorRefreshes, 1)
  assert.deepEqual(await readTrash(h), [])
})

test('回收站：可以恢复回原来的分组，不能重复恢复；超过 30 天的在每日维护时清掉', async (t) => {
  const { h, manage } = await setup(t)
  await manage.updateMemory({ action: 'delete', id: 'p1' })
  await manage.updateMemory({ action: 'delete', id: 'r3' })
  const writer = await h.load('lib/core/writer.mjs')
  // 夹具里的模块跑在另一个 vm 上下文中，返回的数组要先转成本上下文的值再比较。
  const ids = async () => JSON.parse(JSON.stringify((await writer.listTrash()).map((item) => item.id)))
  assert.deepEqual((await ids()).sort(), ['p1', 'r3'])

  const restored = await writer.restoreMemory('p1')
  assert.equal(restored.category, 'project')
  assert.equal('deletedAt' in restored, false)
  assert.deepEqual((await h.records('project')).map((m) => m.id), ['p1'])
  await assert.rejects(writer.restoreMemory('p1'), /回收站里没有记忆 p1/)
  assert.deepEqual(await ids(), ['r3'])

  // 第 29 天还在，第 31 天的每日维护清掉。
  h.clock.now = Date.parse(NOW) + 29 * DAY
  await writer.decayMemoriesOncePerDay()
  assert.deepEqual(await ids(), ['r3'])
  h.clock.now = Date.parse(NOW) + 31 * DAY
  await writer.decayMemoriesOncePerDay()
  assert.deepEqual(await ids(), [])
  assert.ok(h.errors.some((line) => line.includes('回收站清掉 1 条超过 30 天的记忆')))
})

test('命令行：trash 列出回收站，restore 恢复', async (t) => {
  const { h, manage } = await setup(t)
  await manage.updateMemory({ action: 'delete', id: 'r3' })
  const list = await createMemoryHarness(t, { home: h.home, now: NOW, argv: ['trash'] })
  await list.load('bin/memory.mjs')
  assert.match(list.output.join('\n'), /回收站（共 1 条/)
  assert.match(list.output.join('\n'), /1\. 改完代码不要自动提交。（rule，id r3，删除于 2026-10-15T04:00:00.000Z）/)
  const restore = await createMemoryHarness(t, { home: h.home, now: NOW, argv: ['restore', 'r3'] })
  await restore.load('bin/memory.mjs')
  assert.match(restore.output.join('\n'), /已恢复到 rule：改完代码不要自动提交。/)
  assert.ok((await h.records()).some((m) => m.id === 'r3'))
})

async function mcp(t, home, now = NOW) {
  const h = await createMemoryHarness(t, { home, now, argv: ['--agent', 'claude'] })
  await h.load('bin/memory-mcp.mjs')
  let sequence = 0
  const call = async (method, params) => {
    const id = ++sequence
    h.stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    for (let i = 0; i < 300; i++) {
      const result = h.output.map((line) => JSON.parse(line)).find((message) => message.id === id)
      if (result) return result
      await delay(10)
    }
    throw new Error(`等待 MCP 响应超时 method=${method}`)
  }
  return { h, call, tool: async (name, args) => (await call('tools/call', { name, arguments: args })).result }
}

test('MCP：memory_update 的参数定义，执行结果原样返回，出错时以 isError 返回原因', async (t) => {
  const { h } = await setup(t)
  const { tool, call } = await mcp(t, h.home)
  const schema = (await call('tools/list')).result.tools.find((item) => item.name === 'memory_update').inputSchema
  assert.deepEqual(schema.required, ['action', 'id'])
  assert.deepEqual(schema.properties.action.enum, ['delete', 'merge', 'replace'])
  assert.deepEqual(Object.keys(schema.properties), ['action', 'id', 'id2', 'text'])

  const done = await tool('memory_update', { action: 'replace', id: 'r1', text: '回答用户的问题时一律使用中文。' })
  assert.equal(done.isError, undefined)
  assert.match(done.content[0].text, /^已改写记忆 r1/)
  const failed = await tool('memory_update', { action: 'delete', id: 'missing' })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /未找到记忆 missing/)
})

test('MCP：memory_list 带 open=true 时刷新并打开 memories.md，打不开时给出路径；不带时和原来一样', async (t) => {
  const { h } = await setup(t)
  const { tool, h: server } = await mcp(t, h.home)
  const snapshot = path.join(h.root, 'memories.md')
  await fsp.rm(snapshot, { force: true })

  const plain = await tool('memory_list', {})
  assert.doesNotMatch(plain.content[0].text, /memories\.md/)
  assert.equal(server.state.spawns.length, 0)

  const opened = await tool('memory_list', { open: true })
  assert.match(opened.content[0].text, /^rule    3 条/)
  assert.ok(opened.content[0].text.endsWith(`已用默认程序打开全部记忆：${snapshot}`))
  assert.match(await fsp.readFile(snapshot, 'utf8'), /改完代码不要自动提交/)
  assert.deepEqual(JSON.parse(JSON.stringify(server.state.spawns[0].slice(0, 2))), ['xdg-open', [snapshot]])

  server.state.spawnExitCode = 3
  const failed = await tool('memory_list', { open: true })
  assert.ok(failed.content[0].text.endsWith(`没能打开文件（xdg-open 退出码 3），全部记忆在：${snapshot}`))
})

test('skill：四端都装到各自的个人 skill 目录，卸载时只删本插件的那一个', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memory-skill-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  for (const dir of ['.cursor', '.codebuddy', '.workbuddy', '.claude']) await fsp.mkdir(path.join(home, dir))
  // 用户自己的另一个 skill 不能被动到。
  await fsp.mkdir(path.join(home, '.claude', 'skills', 'mine'), { recursive: true })
  await fsp.writeFile(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '自己的 skill')
  const ctx = { nodeBin: '/node', hookScript: '/repo/bin/memory.mjs', mcpScript: '/repo/bin/memory-mcp.mjs', skillSource: SKILL_SOURCE, pathEnv: '' }
  const expected = { cursor: '.cursor/skills', codebuddy: '.codebuddy/skills', workbuddy: '.workbuddy/skills', claude: '.claude/skills' }
  const source = await fsp.readFile(SKILL_SOURCE, 'utf8')

  for (const host of INSTALL_HOSTS) {
    assert.match(host.register(home, ctx), /; skill added/)
    const file = path.join(home, expected[host.id], SKILL_NAME, 'SKILL.md')
    assert.equal(await fsp.readFile(file, 'utf8'), source, host.id)
    assert.match(host.register(home, ctx), /; skill updated/)
  }
  // Cursor 自带 skill 的目录不能放东西。
  assert.equal(fs.existsSync(path.join(home, '.cursor', 'skills-cursor')), false)

  for (const host of INSTALL_HOSTS) {
    assert.equal(host.removeSkill(home), `已删除 ${SKILL_NAME}`)
    assert.equal(host.removeSkill(home), '未安装本插件 skill，已跳过')
    assert.equal(fs.existsSync(path.join(home, expected[host.id], SKILL_NAME)), false)
  }
  assert.equal(await fsp.readFile(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8'), '自己的 skill')
})

test('SKILL.md 符合四端对 skill 的要求，并写明只允许调用的工具', async () => {
  const body = await fsp.readFile(SKILL_SOURCE, 'utf8')
  const front = /^---\n([\s\S]*?)\n---\n/.exec(body)
  assert.ok(front, '缺少 frontmatter')
  const name = /^name: (.+)$/m.exec(front[1])[1]
  const description = /^description: (.+)$/m.exec(front[1])[1]
  assert.equal(name, SKILL_NAME)
  assert.match(name, /^[a-z0-9-]{1,64}$/)
  assert.ok(description.length > 0 && description.length <= 1024)
  // Cursor 默认带 disable-model-invocation，那样只有点名时才加载；这个 skill 要能按用户的说法自动加载。
  assert.doesNotMatch(front[1], /disable-model-invocation/)
  for (const toolName of ['memory_list', 'memory_read', 'memory_update']) assert.ok(body.includes(toolName), toolName)
  assert.match(body, /## 只允许调用的工具/)
  assert.match(body, /## 禁止事项/)
})

// Claude Code 这一端的行为。Cursor、CodeBuddy、WorkBuddy 由两份快照锁住，不在这里测。

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryHarness, memory } from './helpers/memory.mjs'
import claudeInstall, { ALLOW_RULE, findClaude } from '../tools/hosts/claude.mjs'
import { INSTALL_HOSTS, selectHosts } from '../tools/hosts/index.mjs'

const RESOLVE_TOOL = 'mcp__memory-self-evolution__memory_resolve'

// 每次调用是一个新的 hook 进程：新的夹具、同一个用户目录。
async function runHook(t, base, agent, payload, patch = {}) {
  const h = await createMemoryHarness(t, { home: base.home, argv: ['hook', '--agent', agent] })
  Object.assign(h.settings, { sideWaitMs: 0, ...patch })
  const running = h.load('bin/memory.mjs')
  for (let i = 0; i < 1000 && !h.stdin.listenerCount('end'); i++) await delay(1)
  h.stdin.emit('data', JSON.stringify(payload))
  h.stdin.emit('end')
  await running
  const out = JSON.parse(h.output.join(''))
  return { out, text: out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : '', spawns: h.state.spawns.length, errors: h.errors }
}

const prompt = (text, extra = {}) => ({
  hook_event_name: 'UserPromptSubmit', session_id: 'session-a', transcript_path: '/tmp/t.jsonl', cwd: '/tmp', prompt_id: 'prompt-1', permission_mode: 'default', prompt: text, ...extra,
})

async function sideJobs(base) {
  const dir = path.join(base.root, 'side')
  const names = (await fsp.readdir(dir).catch(() => [])).filter((name) => name.startsWith('s_'))
  return Promise.all(names.map(async (name) => JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))))
}

test('Claude 会话开始：用 hookSpecificOutput 注入规则，职责边界只约束插件自己', async (t) => {
  const base = await createMemoryHarness(t)
  await base.seed('rule', [memory('r1')])
  const start = await runHook(t, base, 'claude', { hook_event_name: 'SessionStart', session_id: 'session-a', source: 'startup' })
  assert.equal(start.out.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(start.text, /规则 r1/)
  assert.match(start.text, /不要替这个插件做记忆分析、查重或写入/)
  assert.match(start.text, /不改变你对 Claude Code 自带记忆的处理/)
  // 另外三端那句「即使用户明确要求记住……也不要……写入」会和 Claude 自带的记忆冲突，不能出现在这里。
  assert.doesNotMatch(start.text, /即使用户明确要求记住或更新记忆/)

  const noApi = await runHook(t, base, 'claude', { hook_event_name: 'SessionStart', session_id: 'session-a', source: 'startup' }, { sideApiModel: '' })
  assert.match(noApi.text, /memory-self-evolution 的记忆沉淀未启用/)
  assert.match(noApi.text, /规则 r1/)
})

test('Claude 每轮输入：提醒只约束插件，按 prompt_id 区分同一会话里内容相同的两次输入', async (t) => {
  const base = await createMemoryHarness(t)
  const first = await runHook(t, base, 'claude', prompt('以后回答我都用中文'))
  assert.equal(first.out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(first.text, /不要替这个插件判断是否该记/)
  assert.match(first.text, /不影响 Claude Code 自带的记忆/)
  assert.doesNotMatch(first.text, /其它记忆写工具/)
  assert.equal(first.spawns, 1)

  // 宿主重试同一条输入：同一个 prompt_id，不再启动第二次判别。
  assert.equal((await runHook(t, base, 'claude', prompt('以后回答我都用中文'))).spawns, 0)
  // 用户又说了一遍同样的话：新的 prompt_id，重新判别。
  assert.equal((await runHook(t, base, 'claude', prompt('以后回答我都用中文', { prompt_id: 'prompt-2' }))).spawns, 1)

  const jobs = await sideJobs(base)
  assert.deepEqual(jobs.map((job) => [job.agent, job.sessionKey, job.generationKey]).sort(), [['claude', 'session-a', 'prompt-1'], ['claude', 'session-a', 'prompt-2']])
})

test('Claude 只读文档里写明的字段，子任务、斜杠命令和客户端送进来的通知都不送去判别', async (t) => {
  const base = await createMemoryHarness(t)
  let id = 0
  const spawned = async (text, extra = {}) => (await runHook(t, base, 'claude', prompt(text, { prompt_id: `p-${++id}`, ...extra }))).spawns

  assert.equal(await spawned('以后提交代码前都先跑测试', { agent_id: 'agent-1', agent_type: 'Explore' }), 0)
  assert.equal(await spawned('/code-review ultra 以后都这样'), 0)
  assert.equal(await spawned('/loop 5m 检查一下部署'), 0)
  assert.equal(await spawned('<task-notification>后台任务完成了，以后都这样通知</task-notification>'), 0)
  assert.equal(await spawned('<system-reminder>以后都要遵守这条提醒</system-reminder>'), 0)
  // 以路径开头的一句话不是斜杠命令。
  assert.equal(await spawned('/Users/me/data 这个目录以后都不要动'), 1)
  assert.equal(await spawned('以后提交代码前都先跑测试'), 1)

  // 别的客户端用的 user_prompt 字段，Claude 这一端不读。
  const other = await runHook(t, base, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'session-a', prompt_id: 'p-x', user_prompt: '以后回答我都用中文' })
  assert.deepEqual(other.out, {})
  assert.equal(other.spawns, 0)
  // 没有 session_id 就不启动判别，不去读别的客户端的会话字段。
  const noSession = await runHook(t, base, 'claude', { hook_event_name: 'UserPromptSubmit', conversation_id: 'conv-1', prompt_id: 'p-y', prompt: '以后回答我都用中文' })
  assert.equal(noSession.spawns, 0)
  assert.ok(noSession.errors.some((line) => line.includes('缺少稳定会话 ID')))
})

test('Claude 回答结束：用 decision block 续轮，指令里给出提问工具和写入工具的全名；子任务结束不续轮', async (t) => {
  const base = await createMemoryHarness(t)
  await fsp.mkdir(path.join(base.root, 'side'), { recursive: true })
  const job = {
    id: 's_claude', agent: 'claude', sessionKey: 'session-a', status: 'ready', prompted: false, applied: false,
    startedAt: new Date().toISOString(), proposal: { action: 'create', text: '提交代码前先跑完整测试。', category: 'rule' },
  }
  const file = path.join(base.root, 'side', 's_claude.json')
  await fsp.writeFile(file, JSON.stringify(job))

  const sub = await runHook(t, base, 'claude', { hook_event_name: 'Stop', session_id: 'session-a', agent_id: 'agent-1' })
  assert.deepEqual(sub.out, {})
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).prompted, false)

  const stop = await runHook(t, base, 'claude', { hook_event_name: 'Stop', session_id: 'session-a', stop_hook_active: false })
  assert.deepEqual(Object.keys(stop.out), ['decision', 'reason'])
  assert.equal(stop.out.decision, 'block')
  assert.match(stop.out.reason, /MEMORY_CONFIRM_V1/)
  assert.match(stop.out.reason, /调用 AskUserQuestion，/)
  assert.ok(stop.out.reason.includes(`只能调用 ${RESOLVE_TOOL} 来写入这个插件的记忆`))
  assert.match(stop.out.reason, /sessionID：s_claude/)
  assert.doesNotMatch(stop.out.reason, /update_memory|ask_followup_question|AskQuestion，/)
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).prompted, true)

  // 续的那一轮结束时 Stop 再触发一次，已经问过的提案不会再弹。
  const again = await runHook(t, base, 'claude', { hook_event_name: 'Stop', session_id: 'session-a', stop_hook_active: true })
  assert.deepEqual(again.out, {})

  const side = await base.load('lib/core/sidepath.mjs')
  assert.equal((await side.resolvePendingSession('s_claude', 'create_rule', 'cursor')).ok, false)
  assert.equal((await side.resolvePendingSession('s_claude', 'create_rule', 'claude')).ok, true)
})

test('会话开始的注入只在 Claude 这一端截到 1 万字以内，另外三端不受影响', async (t) => {
  const base = await createMemoryHarness(t)
  const long = (i) => `第 ${i} 条很长的规则：${'这条规则写得很细，'.repeat(40)}`
  await base.seed('rule', Array.from({ length: 50 }, (_, i) => memory(`r${i}`, { text: long(i), confidence: 1 - i / 100 })))

  const claude = await runHook(t, base, 'claude', { hook_event_name: 'SessionStart', session_id: 'session-a', source: 'startup' })
  assert.ok(claude.text.length <= 10000, `长度 ${claude.text.length}`)
  assert.match(claude.text, /第 0 条很长的规则/)
  assert.doesNotMatch(claude.text, /第 49 条很长的规则/)
  const listed = (claude.text.match(/^\d+\. /gm) || []).length
  assert.ok(listed > 0 && listed < 50)
  assert.ok(claude.text.endsWith(`（其余 ${50 - listed} 条因单次注入的长度上限未列出）`))
  assert.ok(claude.errors.some((line) => line.includes('超过 10000 字的上限')))

  const cursor = await createMemoryHarness(t, { home: base.home, argv: ['hook', '--agent', 'cursor'] })
  const running = cursor.load('bin/memory.mjs')
  for (let i = 0; i < 1000 && !cursor.stdin.listenerCount('end'); i++) await delay(1)
  cursor.stdin.emit('data', JSON.stringify({ hook_event_name: 'sessionStart', conversation_id: 'conv-1' }))
  cursor.stdin.emit('end')
  await running
  const text = JSON.parse(cursor.output.join('')).additional_context
  assert.ok(text.length > 10000)
  assert.equal((text.match(/^\d+\. /gm) || []).length, 50)
  assert.doesNotMatch(text, /长度上限/)
})

// —— 安装侧 ——

const ctx = { nodeBin: '/node', hookScript: '/repo/bin/memory.mjs', mcpScript: '/repo/bin/memory-mcp.mjs', pathEnv: '' }
const ARCHON_STOP = { hooks: [{ type: 'command', command: 'archon hook stop --agent claude --native-event Stop', timeout: 45 }] }

// 假的 claude 命令：把参数记到同目录的 calls.log，用一个标记文件模拟「是否已注册」。
async function fakeClaude(dir) {
  await fsp.mkdir(dir, { recursive: true })
  const bin = path.join(dir, 'claude')
  await fsp.writeFile(bin, `#!/bin/sh
here="$(dirname "$0")"
echo "$@" >> "$here/calls.log"
if [ "$2" = "remove" ]; then
  if [ -f "$here/registered" ]; then rm "$here/registered"; exit 0; fi
  echo "No MCP server found with name: $5" >&2
  exit 1
fi
if [ "$2" = "add" ]; then touch "$here/registered"; exit 0; fi
exit 0
`, { mode: 0o755 })
  return bin
}

const desktopDir = (home, version) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code', version, 'abc123', 'claude.app', 'Contents', 'MacOS')
const calls = async (dir) => (await fsp.readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)

async function claudeHome(t, settings) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memory-claude-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  if (settings !== undefined) {
    await fsp.mkdir(path.join(home, '.claude'), { recursive: true })
    if (settings !== null) await fsp.writeFile(path.join(home, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
  }
  return home
}

const readSettings = async (home) => JSON.parse(await fsp.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'))

test('Claude 安装：hook 写进 settings.json 并保留已有内容，MCP 通过 claude mcp add 注册，免批准规则只在同意后才加', async (t) => {
  const home = await claudeHome(t, {
    enabledPlugins: { 'some-plugin@market': true },
    hooks: { Stop: [ARCHON_STOP] },
    permissions: { allow: ['Bash(gh pr merge:*)'] },
  })
  await fakeClaude(desktopDir(home, '2.1.9'))
  const newest = desktopDir(home, '2.1.295')
  await fakeClaude(newest)

  assert.equal(findClaude(home, ctx), path.join(newest, 'claude'))
  assert.deepEqual(claudeInstall.questions(home, ctx).map((q) => q.key), ['allowResolve'])

  const first = claudeInstall.register(home, ctx)
  assert.equal(first, `hooks SessionStart added, UserPromptSubmit added, Stop added; mcp added; 免批准规则 未添加（需要时在 ~/.claude/settings.json 的 permissions.allow 里加 "${ALLOW_RULE}"）`)
  const command = '"/node" "/repo/bin/memory.mjs" hook --agent claude'
  let settings = await readSettings(home)
  assert.deepEqual(settings.enabledPlugins, { 'some-plugin@market': true })
  assert.deepEqual(settings.permissions, { allow: ['Bash(gh pr merge:*)'] })
  assert.deepEqual(settings.hooks.Stop, [ARCHON_STOP, { matcher: '', hooks: [{ type: 'command', command, timeout: 20 }] }])
  assert.deepEqual(settings.hooks.SessionStart, [{ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }])
  assert.deepEqual(settings.hooks.UserPromptSubmit, [{ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }])
  // Claude Code 不读 ~/.claude/mcp.json，不能往那里写。
  await assert.rejects(fsp.access(path.join(home, '.claude', 'mcp.json')))
  assert.deepEqual(await calls(newest), [
    'mcp remove --scope user memory-self-evolution',
    'mcp add --scope user memory-self-evolution -- /node /repo/bin/memory-mcp.mjs --agent claude',
  ])
  assert.deepEqual(await calls(desktopDir(home, '2.1.9')), [])

  // 再装一次并同意免批准：hook 只更新不追加，MCP 先移除再加。
  const second = claudeInstall.register(home, { ...ctx, allowResolve: true })
  assert.equal(second, 'hooks SessionStart updated, UserPromptSubmit updated, Stop updated; mcp updated; 免批准规则 已添加')
  settings = await readSettings(home)
  assert.equal(settings.hooks.Stop.length, 2)
  assert.deepEqual(settings.permissions.allow, ['Bash(gh pr merge:*)', ALLOW_RULE])
  assert.equal(ALLOW_RULE, RESOLVE_TOOL)
  assert.deepEqual(claudeInstall.questions(home, ctx), [])
  assert.match(claudeInstall.register(home, ctx), /免批准规则 已存在$/)

  // 卸载：只去掉自己加的东西。
  assert.equal(claudeInstall.removeHooks(home), '已删除 3 条 hook，已去掉免批准规则')
  settings = await readSettings(home)
  assert.deepEqual(settings.hooks, { Stop: [ARCHON_STOP] })
  assert.deepEqual(settings.permissions, { allow: ['Bash(gh pr merge:*)'] })
  assert.deepEqual(settings.enabledPlugins, { 'some-plugin@market': true })
  assert.equal(claudeInstall.removeMcp(home, ctx), '已删除 memory-self-evolution')
  assert.equal(claudeInstall.removeMcp(home, ctx), '未注册本插件 MCP，已跳过')
  assert.equal(claudeInstall.removeHooks(home), '未注册本插件 hook，已跳过')
})

test('Claude 安装：找不到 claude 命令时 hook 照常注册并给出手动命令；PATH 里的 claude 优先；没装 Claude Code 时跳过', async (t) => {
  const bare = await claudeHome(t, null)
  const message = claudeInstall.register(bare, { ...ctx, allowResolve: true })
  assert.match(message, /^hooks SessionStart added, UserPromptSubmit added, Stop added; mcp 未注册：没有找到 claude 命令。装好后手动运行：claude mcp add --scope user memory-self-evolution -- \/node \/repo\/bin\/memory-mcp\.mjs --agent claude; 免批准规则 已添加$/)
  assert.deepEqual((await readSettings(bare)).permissions, { allow: [ALLOW_RULE] })
  assert.match(claudeInstall.removeMcp(bare, ctx), /^没有找到 claude 命令，已跳过。需要时手动运行：claude mcp remove --scope user memory-self-evolution$/)
  assert.equal(claudeInstall.removeHooks(bare), '已删除 3 条 hook，已去掉免批准规则')
  assert.deepEqual(await readSettings(bare), { hooks: {} })

  const onPath = await claudeHome(t, null)
  const pathDir = path.join(onPath, 'bin')
  const desktop = desktopDir(onPath, '2.1.295')
  await fakeClaude(pathDir)
  await fakeClaude(desktop)
  assert.equal(findClaude(onPath, { pathEnv: `/nonexistent${path.delimiter}${pathDir}` }), path.join(pathDir, 'claude'))
  assert.equal(findClaude(onPath, { pathEnv: '', claudeBin: '/custom/claude' }), '/custom/claude')
  claudeInstall.register(onPath, { ...ctx, pathEnv: pathDir })
  assert.equal((await calls(pathDir)).length, 2)
  assert.deepEqual(await calls(desktop), [])

  const none = await claudeHome(t)
  assert.equal(claudeInstall.register(none, ctx), '未安装，已跳过')
  assert.deepEqual(claudeInstall.questions(none, ctx), [])
  assert.equal(claudeInstall.removeHooks(none), '客户端目录不存在，已跳过')
  assert.equal(claudeInstall.removeMcp(none, ctx), '客户端目录不存在，已跳过')
  await assert.rejects(fsp.access(path.join(none, '.claude')))
})

test('--only 只选中一端，名字不对时报错并列出可选的名字', () => {
  assert.deepEqual(selectHosts('').map((host) => host.id), ['cursor', 'codebuddy', 'workbuddy', 'claude'])
  assert.equal(selectHosts(''), INSTALL_HOSTS)
  assert.deepEqual(selectHosts('claude').map((host) => host.name), ['Claude Code'])
  assert.deepEqual(selectHosts('cursor').map((host) => host.name), ['Cursor'])
  assert.throws(() => selectHosts('vscode'), /cursor、codebuddy、workbuddy、claude 之一，收到「vscode」/)
})

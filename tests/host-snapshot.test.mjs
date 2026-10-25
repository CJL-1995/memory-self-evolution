// 宿主输出快照：锁住 Cursor、CodeBuddy、WorkBuddy 在每个 hook 事件下交给宿主的内容。
//
// tests/fixtures/host-snapshot.json 是在抽出宿主适配层之前的 main（4093074）上生成的。
// 重构、或者接入新的宿主之后，这份快照必须逐字不变：变了就说明这三端的行为被改动了。
// 确实要改这三端的行为时，用 UPDATE_HOST_SNAPSHOT=1 npm test 重新生成，并在评审里逐行核对差异。
//
// 每个组合是「--agent 的取值 × 输入用哪一端的字段」。other 是没登记的名字，空串是不带 --agent。
// 这两种不是正式支持的用法，一并锁住是为了证明重构没有改掉它们原来的结果。

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryHarness, memory } from './helpers/memory.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const FIXTURE = fileURLToPath(new URL('./fixtures/host-snapshot.json', import.meta.url))
const UPDATE = process.env.UPDATE_HOST_SNAPSHOT === '1'
const NOW = '2026-10-01T04:00:00.000Z'
const SECRET = 'ab'.repeat(32)

const AGENTS = ['cursor', 'codebuddy', 'workbuddy', 'other', '']
const CLAUDE_EVENTS = { start: 'SessionStart', prompt: 'UserPromptSubmit', stop: 'Stop' }
const FLAVORS = {
  cursor: { events: { start: 'sessionStart', prompt: 'beforeSubmitPrompt', stop: 'stop' }, ids: { conversation_id: 'conv-1', generation_id: 'gen-1' }, promptField: 'prompt', session: 'conv-1' },
  codebuddy: { events: CLAUDE_EVENTS, ids: { session_id: 'sess-1' }, promptField: 'user_prompt', session: 'sess-1' },
  workbuddy: { events: CLAUDE_EVENTS, ids: { session_id: 'sess-1' }, promptField: 'prompt', session: 'sess-1' },
}

const stamp = { lastSeen: NOW, firstSeen: NOW, createdAt: NOW }
const RULES = [memory('r1', { text: '回答一律使用中文。', ...stamp }), memory('r2', { text: '改完代码不要自动提交。', ...stamp })]
const PROPOSALS = {
  create: { text: '提交代码前先跑完整测试。', evidence: '以后提交前都先跑测试', category: 'rule', action: 'create', targetId: '', targetText: '', mergedText: '', score: null },
  reinforce: { text: '回答我的时候用中文。', evidence: '用中文', category: 'rule', action: 'reinforce', targetId: 'r1', targetText: '回答一律使用中文。', mergedText: '', score: 0.83 },
  merge: { text: '线上配置放在 config/prod.yaml。', evidence: '线上配置放在 config/prod.yaml', category: 'project', action: 'merge', targetId: 'p1', targetText: '灰度配置放在 config/gray.yaml。', mergedText: '灰度配置放在 config/gray.yaml，线上配置放在 config/prod.yaml。', score: 0.71 },
  replace: { text: '改完代码后自己提交。', evidence: '改完直接提交', category: 'rule', action: 'replace', targetId: 'r2', targetText: '改完代码不要自动提交。', mergedText: '', score: 0.66 },
  unsure: { text: '日志里要带上请求 ID。', evidence: '日志带请求 ID', category: 'rule', action: 'unsure', targetId: 'r2', targetText: '改完代码不要自动提交。', mergedText: '', score: 0.41 },
}

function sideJob(id, agent, sessionKey, proposal, extra = {}) {
  return {
    version: 1, id, status: 'ready', agent, sessionKey, generationKey: '', prompt: '用户原话',
    startedAt: '2026-09-30T00:00:00.000Z', finishedAt: '2026-09-30T00:00:05.000Z', prompted: false, proposal, reason: '', ...extra,
  }
}

// 输出里会带上仓库路径、临时目录和随机生成的记忆 id，换成占位符后才能逐字比较。
function normalize(value, home) {
  const text = JSON.stringify(value)
    .replaceAll(JSON.stringify(repo).slice(1, -1), '<REPO>')
    .replaceAll(JSON.stringify(home).slice(1, -1), '<HOME>')
    .replace(/mem-[a-z0-9]+-[a-z0-9]+/g, '<mem-id>')
  return JSON.parse(text)
}

// 每次调用是一个新的 hook 进程：新的夹具、同一个用户目录。
async function runHook(t, home, agent, payload, patch = {}, state = {}) {
  const h = await createMemoryHarness(t, { home, now: NOW, argv: agent ? ['hook', '--agent', agent] : ['hook'] })
  Object.assign(h.settings, { sideWaitMs: 0, ...patch })
  Object.assign(h.state, state)
  const running = h.load('bin/memory.mjs')
  for (let i = 0; i < 1000 && !h.stdin.listenerCount('end'); i++) await delay(1)
  h.stdin.emit('data', JSON.stringify(payload))
  h.stdin.emit('end')
  await running
  const out = JSON.parse(h.output.join(''))
  const spawned = h.state.spawns.map((args) => [path.basename(args[1][0]), args[1][1], path.basename(args[1][2])])
  return normalize({ out, spawned, errors: h.errors }, home)
}

async function newHome(t, { jobs = [], rules = RULES } = {}) {
  const base = await createMemoryHarness(t, { now: NOW })
  await base.seed('rule', rules)
  await fsp.writeFile(path.join(base.root, 'session-secret'), `${SECRET}\n`, { mode: 0o600 })
  if (jobs.length > 0) {
    await fsp.mkdir(path.join(base.root, 'side'), { recursive: true })
    for (const job of jobs) await fsp.writeFile(path.join(base.root, 'side', `${job.id}.json`), JSON.stringify(job))
  }
  return base
}

async function sideState(base) {
  const dir = path.join(base.root, 'side')
  const names = (await fsp.readdir(dir).catch(() => [])).sort()
  const out = {}
  for (const name of names) {
    const body = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))
    out[name] = name.startsWith('confirm-')
      ? body
      : { agent: body.agent, sessionKey: body.sessionKey, generationKey: body.generationKey, status: body.status, prompted: body.prompted, applied: Boolean(body.applied), reason: body.reason, prompt: body.prompt }
  }
  return normalize(out, base.home)
}

async function ruleState(base) {
  return normalize((await base.records()).map((mem) => ({ text: mem.text, category: mem.category, confidence: mem.confidence })), base.home)
}

// 用户在气泡里看到的那段话。Cursor 把它作为下一条输入送回，prompt hook 要据此把隐藏指令还给模型。
function bubbleOf(out) {
  if (!out) return ''
  if (out.followup_message) return out.followup_message
  return String(out.reason || '').split('\n\nMEMORY_CONFIRM_V1')[0]
}

// 没带 --agent 时由事件名决定按哪一端处理，待确认任务也要建在那一端名下。
function resolvedAgent(agent, flavorName) {
  return agent || (flavorName === 'cursor' ? 'cursor' : 'codebuddy')
}

function decoys(owner, session) {
  return [
    sideJob('s_other_agent', owner === 'cursor' ? 'codebuddy' : 'cursor', session, { ...PROPOSALS.create, text: '别的客户端的提案。' }),
    sideJob('s_other_session', owner, 'another-session', { ...PROPOSALS.create, text: '别的会话的提案。' }),
  ]
}

// settings 叠在每次调用的配置之下，用来验证某个配置打开后这几端的输出仍和快照相同。
async function combo(t, agent, flavorName, settings = {}) {
  const run = (home, payload, patch = {}, state = {}) => runHook(t, home, agent, payload, { ...settings, ...patch }, state)
  const flavor = FLAVORS[flavorName]
  const owner = resolvedAgent(agent, flavorName)
  const payload = (kind, prompt) => ({
    hook_event_name: flavor.events[kind], ...flavor.ids, ...(prompt === undefined ? {} : { [flavor.promptField]: prompt }),
  })
  const result = {}

  const ready = await newHome(t)
  result.sessionStart = await run(ready.home, payload('start'))
  result.prompt = await run(ready.home, payload('prompt', '以后回答我都用中文'), {}, { hits: ['r1'] })
  result.promptQuestionAnswer = await run(ready.home, payload('prompt', '<question_answer><answers>不落成</answers></question_answer>'))
  result.promptTooShort = await run(ready.home, payload('prompt', '好的'))
  result.promptSide = await sideState(ready)

  const noApi = await newHome(t)
  result.sessionStartNoApi = await run(noApi.home, payload('start'), { sideApiModel: '' })
  result.promptNoApi = await run(noApi.home, payload('prompt', '记住：以后回答我都用中文'), { sideApiModel: '' })
  result.promptNoApiSide = await sideState(noApi)

  const idle = await newHome(t)
  result.stopIdle = await run(idle.home, payload('stop'))

  const confirm = await newHome(t, {
    jobs: [
      sideJob('s_create', owner, flavor.session, PROPOSALS.create),
      sideJob('s_merge', owner, flavor.session, PROPOSALS.merge, { startedAt: '2026-09-30T00:01:00.000Z' }),
      ...decoys(owner, flavor.session),
    ],
  })
  result.stopConfirm = await run(confirm.home, payload('stop'), { confirm: true })
  result.stopConfirmSide = await sideState(confirm)
  result.stopConfirmNextPrompt = await run(confirm.home, payload('prompt', bubbleOf(result.stopConfirm.out)), { confirm: true })
  result.stopConfirmSideAfterPrompt = await sideState(confirm)
  result.stopConfirmAgain = await run(confirm.home, payload('stop'), { confirm: true })

  const direct = await newHome(t, {
    jobs: [
      sideJob('s_applied', owner, flavor.session, PROPOSALS.reinforce, { applied: true, notice: '强化了一条记忆：回答一律使用中文。，置信度 +0.1' }),
      sideJob('s_pending', owner, flavor.session, PROPOSALS.create, { startedAt: '2026-09-30T00:01:00.000Z' }),
      ...decoys(owner, flavor.session),
    ],
  })
  result.stopDirect = await run(direct.home, payload('stop'), { confirm: false })
  result.stopDirectSide = await sideState(direct)
  result.stopDirectRules = await ruleState(direct)
  result.stopDirectNextPrompt = await run(direct.home, payload('prompt', bubbleOf(result.stopDirect.out)), { confirm: false })
  result.stopDirectSideAfterPrompt = await sideState(direct)
  return result
}

async function functions(t) {
  const h = await createMemoryHarness(t, { now: NOW })
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = Object.entries(PROPOSALS).map(([name, proposal]) => ({ id: `s_${name}`, proposal }))
  const result = {}
  for (const agent of AGENTS) {
    result[agent || '(none)'] = {
      followup: side.buildFollowup(agent, jobs),
      stopResponse: side.buildStopResponse(agent, '用户看到的话', '给模型的指令'),
      stopResponseSameText: side.buildStopResponse(agent, '同一段话', '同一段话'),
      stopResponseEmpty: side.buildStopResponse(agent, '', '给模型的指令'),
      sessionIds: Object.fromEntries(Object.entries(FLAVORS).map(([name, flavor]) => [name, side.sessionIDFor(SECRET, agent, flavor.ids, '同一句话')])),
    }
  }
  return normalize(result, h.home)
}

const expected = UPDATE ? {} : JSON.parse(await fsp.readFile(FIXTURE, 'utf8'))
const actual = {}

function check(key, value) {
  actual[key] = value
  if (UPDATE) return
  assert.ok(key in expected, `快照里没有 ${key}，用 UPDATE_HOST_SNAPSHOT=1 npm test 生成`)
  assert.deepEqual(value, expected[key])
}

for (const agent of AGENTS) {
  for (const flavorName of Object.keys(FLAVORS)) {
    const key = `agent=${agent || '(none)'} input=${flavorName}`
    test(`宿主输出快照 ${key}`, async (t) => check(key, await combo(t, agent, flavorName)))
    // showRecall 只在 Claude Code 上展示召回清单，打开后这几端的输出必须和快照逐字相同。
    test(`宿主输出快照 ${key} showRecall=true`, { skip: UPDATE }, async (t) => {
      assert.deepEqual(await combo(t, agent, flavorName, { showRecall: true }), expected[key])
    })
  }
}

test('宿主输出快照 续轮文案、Stop 输出形状和 sessionID', async (t) => check('functions', await functions(t)))

test('宿主输出快照没有多余或缺失的条目', async () => {
  if (UPDATE) {
    await fsp.mkdir(path.dirname(FIXTURE), { recursive: true })
    await fsp.writeFile(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`)
    return
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
})

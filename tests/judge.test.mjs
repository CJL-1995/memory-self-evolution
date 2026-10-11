import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMemoryHarness, memory } from './helpers/memory.mjs'

const completion = content => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) })
const remembered = fields => completion(JSON.stringify({ remember: true, evidence: '用户原话', ...fields }))
const exists = file => fsp.access(file).then(() => true, () => false)

// 用假的旁路接口跑一次完整的后台判别，返回任务文件的最终内容。
async function sideHarness(t, { confirm = true } = {}) {
  const h = await createMemoryHarness(t)
  Object.assign(h.settings, { confirm, sideApiBase: 'https://side.invalid/v1', sideApiModel: 'judge-model' })
  await fsp.writeFile(path.join(h.root, 'side-secret.json'), JSON.stringify({ apiKey: 'test-key' }))
  const side = await h.load('lib/core/sidepath.mjs')
  const calls = []
  let sequence = 0
  async function run(prompt, respond) {
    h.state.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, body, auth: init.headers.Authorization })
      return respond(body)
    }
    const file = path.join(h.root, 'side', `s_job${++sequence}.json`)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({
      id: `s_job${sequence}`, status: 'running', agent: 'cursor', sessionKey: 'conversation-a', prompt,
      startedAt: new Date().toISOString(), prompted: false, proposal: null, reason: '',
    }))
    await side.runSideJob(file)
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  }
  return { h, side, calls, run }
}

test('parseRemember 只认 JSON，拒绝理由和普通陈述都不会被当成记忆', async t => {
  const h = await createMemoryHarness(t)
  const { parseRemember } = await h.load('lib/core/sidepath.mjs')
  for (const raw of [
    '这句话是临时提问，不需要写入长期记忆。',
    '该输入属于本次开发指令，不应沉淀。',
    '以后一律使用中文回答用户的问题。',
    '',
    '{"text":"缺少 remember 字段"}',
    '{"remember":true,"text":"  "}',
  ]) assert.equal(parseRemember(raw), null, raw)

  assert.equal(JSON.stringify(parseRemember('{"remember":false}')), '{"remember":false}')
  const rule = parseRemember('{"remember":true,"category":"rule","text":"以后一律使用中文回答。","evidence":"用中文"}')
  assert.equal(JSON.stringify(rule), '{"remember":true,"text":"以后一律使用中文回答。","evidence":"用中文","category":"rule"}')
  const fenced = parseRemember('```json\n{"remember":true,"category":" Project ","text":"灰度配置放在 config/gray.yaml。"}\n```')
  assert.equal(fenced.category, 'project')
  assert.equal(parseRemember('{"remember":true,"category":"fact","text":"某个事实。"}').category, '')
  assert.equal(parseRemember('{"remember":true,"text":"没给分组。"}').category, '')
})

test('判别模型没按 JSON 输出时按「不是记忆」处理，不写入，并留下原始输出', async t => {
  const { h, run } = await sideHarness(t, { confirm: false })
  const refusal = '这句话是临时提问，不需要写入长期记忆。'
  const job = await run('这个崩溃是不是空指针导致的', () => completion(refusal))
  assert.equal(job.status, 'none')
  assert.equal(job.reason, 'judge-failed')
  assert.equal(job.proposal, null)
  assert.equal(await exists(path.join(h.root, 'rule.jsonl')), false)
  assert.equal(await exists(path.join(h.root, 'project.jsonl')), false)
  assert.ok(h.errors.some(line => line.includes('旁路判断无法解析') && line.includes(refusal)))
})

test('分组以判别模型的判断为主，与字面信号不一致时采用模型的并记日志', async t => {
  const confirmed = await sideHarness(t)
  // 字面信号看到「接口」「返回」会判成 project，这句其实是在规定今后怎么写代码。
  const job = await confirmed.run('接口返回的错误必须打日志，以后都这样', () => remembered({ category: 'rule', text: '代码中接口返回错误时必须记录日志。' }))
  assert.equal(job.status, 'ready')
  assert.equal(job.proposal.action, 'create')
  assert.equal(job.proposal.category, 'rule')
  assert.ok(confirmed.h.errors.some(line => line.includes('分组判断不一致') && line.includes('采用判别模型的 rule') && line.includes('字面信号指向 project')))

  // 没有明确语气的事实，字面信号会默认归 rule；免确认模式下直接按模型的分组落盘。
  const direct = await sideHarness(t, { confirm: false })
  const written = await direct.run('记一下，实测下来 ncnn 比 ORT 快', () => remembered({ category: 'project', text: '实测结论：ncnn 的推理速度比 ORT 快。' }))
  assert.equal(written.applied, true)
  assert.equal((await direct.h.records('project'))[0].text, '实测结论：ncnn 的推理速度比 ORT 快。')
  assert.equal(await exists(path.join(direct.h.root, 'rule.jsonl')), false)
  assert.equal(direct.h.errors.some(line => line.includes('分组判断不一致')), false)
})

test('判别模型没给分组或给了无效值时退回字面信号', async t => {
  const { h, run } = await sideHarness(t)
  const missing = await run('记住：以后都用中文回答', () => remembered({ text: '以后一律使用中文回答用户的问题。' }))
  assert.equal(missing.proposal.category, 'rule')
  const invalid = await run('部署文档在这个链接', () => remembered({ category: 'fact', text: '部署文档链接为 https://example.com/wiki/deploy 。' }))
  assert.equal(invalid.proposal.category, 'project')
  assert.equal(h.errors.some(line => line.includes('分组判断不一致')), false)
})

test('请求带 JSON 模式；接口不认这个参数时去掉重试，同一进程内不再带', async t => {
  const answer = body => (body.messages[0].content.includes('判重器') ? completion('{"action":"create"}') : remembered({ category: 'rule', text: '这是一条新规则。' }))

  const supported = await sideHarness(t)
  await supported.h.seed('rule', [memory('old')])
  supported.h.state.hits = ['old']
  assert.equal((await supported.run('记住一条新规则', answer)).status, 'ready')
  assert.equal(supported.calls.length, 2)
  assert.ok(supported.calls.every(call => call.body.response_format?.type === 'json_object'))
  assert.equal(supported.calls[0].url, 'https://side.invalid/v1/chat/completions')
  assert.equal(supported.calls[0].auth, 'Bearer test-key')

  const rejecting = await sideHarness(t)
  await rejecting.h.seed('rule', [memory('old')])
  rejecting.h.state.hits = ['old']
  const job = await rejecting.run('记住一条新规则', body => (body.response_format
    ? { ok: false, status: 400, text: async () => '{"error":"unknown field response_format, key test-key"}' }
    : answer(body)))
  assert.equal(job.status, 'ready')
  assert.equal(job.proposal.text, '这是一条新规则。')
  // 第一次带参数被拒，第二次去掉后成功；随后的判重调用不再带。
  assert.deepEqual(rejecting.calls.map(call => Boolean(call.body.response_format)), [true, false, false])
  const retryLog = rejecting.h.errors.find(line => line.includes('去掉后重试'))
  assert.ok(retryLog.includes('400'))
  assert.equal(retryLog.includes('test-key'), false)
})

test('判别给出的正文太短或太长时不写入；合并正文不合要求时改按拿不准处理', async t => {
  const direct = await sideHarness(t, { confirm: false })
  for (const text of ['用中文', '长'.repeat(401)]) {
    const job = await direct.run('记住这一条很重要的约定', () => remembered({ category: 'rule', text }))
    assert.equal(job.status, 'none')
    assert.equal(job.reason, 'text-rejected')
  }
  assert.equal(await exists(path.join(direct.h.root, 'rule.jsonl')), false)
  assert.ok(direct.h.errors.some(line => line.includes('不合要求，不写入') && line.includes('不足 6 个字')))

  const confirmed = await sideHarness(t)
  await confirmed.h.seed('rule', [memory('old', { text: '原有的一条规则' })])
  confirmed.h.state.hits = ['old']
  const job = await confirmed.run('记住这一条很重要的约定', body => (body.messages[0].content.includes('判重器')
    ? completion(JSON.stringify({ action: 'merge', id: 'old', text: '长'.repeat(401) }))
    : remembered({ category: 'rule', text: '一条正常长度的新规则。' })))
  assert.equal(job.status, 'ready')
  assert.equal(job.proposal.action, 'unsure')
  assert.equal(job.proposal.mergedText, '')
  assert.equal(job.proposal.targetId, 'old')
})

test('发给判别模型的是预处理后的输入：代码块被去掉，密钥被抹掉，太长的不发', async t => {
  const h = await createMemoryHarness(t)
  const side = await h.load('lib/core/sidepath.mjs')
  const jobs = path.join(h.root, 'side')
  const start = (promptText, generation) => side.maybeStartSideJob({ agent: 'cursor', payload: { conversation_id: 'conversation-a', generation_id: generation }, promptText })
  const promptOf = async id => JSON.parse(await fsp.readFile(path.join(jobs, `${id}.json`), 'utf8')).prompt

  const withCode = await start('以后日志都按这个格式打：\n```js\nlogger.info({ err_code, msg })\nconst secret = "sk-abcdefghijklmnopqrstuvwx"\n```\n别再用 console.log 了', 'g1')
  assert.equal(await promptOf(withCode), '以后日志都按这个格式打：\n别再用 console.log 了')

  const withSecret = await start('记住测试环境的账号是 tester，密码 Passw0rd123，token 是 abc123def456', 'g2')
  assert.equal(await promptOf(withSecret), '记住测试环境的账号是 tester，密码 [已隐去]，token 是 [已隐去]')

  // 去掉代码后只剩几个字，或者去掉之后仍然很长，都不启动判别。
  assert.equal(await start('看下\n```\n' + 'x = 1\n'.repeat(50) + '```', 'g3'), undefined)
  assert.equal(await start('这是一大段粘贴进来的文档内容。'.repeat(40), 'g4'), undefined)
  assert.equal(h.state.spawns.length, 2)
  assert.equal((await fsp.readdir(jobs)).filter(name => name.endsWith('.json')).length, 2)
  assert.ok(h.errors.some(line => line.includes('旁路判别跳过') && line.includes('按粘贴内容处理')))
})

test('鉴权失败不属于参数不支持，不重试', async t => {
  const { calls, run } = await sideHarness(t)
  const job = await run('记住一条新规则', () => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
  assert.equal(calls.length, 1)
  assert.equal(job.status, 'none')
  assert.match(job.reason, /401/)
})

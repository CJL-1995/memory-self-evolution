// 安装与卸载快照：锁住 setup 和 uninstall 给 Cursor、CodeBuddy、WorkBuddy 写出的配置文件和打印的结果。
//
// tests/fixtures/install-snapshot.json 的期望值来自抽出宿主适配层之前的 main（4093074）：
// 用真实进程在几种假的用户目录上运行当时的 tools/setup.mjs 和 tools/uninstall.mjs，记下写出的文件和输出。
// 这里直接调用 tools/hosts 里各端的注册和移除函数，结果必须和那份记录逐字相同。
// 新接入的宿主不在这份快照里，给它另写用例。
// 确实要改这三端的安装行为时，用 UPDATE_HOST_SNAPSHOT=1 npm test 重新生成，并在评审里逐行核对差异。

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALL_HOSTS } from '../tools/hosts/index.mjs'
import { FIXTURES, buildFixtureHome, readClientFiles } from './helpers/install-fixtures.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/install-snapshot.json', import.meta.url))
const UPDATE = process.env.UPDATE_HOST_SNAPSHOT === '1'
const expected = UPDATE ? {} : JSON.parse(await fsp.readFile(FIXTURE, 'utf8'))
const actual = {}
// 快照里的 node 和仓库路径已经换成占位符，这里直接拿占位符当路径用。skill 用仓库里的真实文件。
const skillSource = fileURLToPath(new URL('../skills/memory-self-evolution-manage/SKILL.md', import.meta.url))
const ctx = { nodeBin: '<NODE>', hookScript: '<REPO>/bin/memory.mjs', mcpScript: '<REPO>/bin/memory-mcp.mjs', skillSource }
const SNAPSHOT_HOSTS = ['cursor', 'codebuddy', 'workbuddy']
const hosts = INSTALL_HOSTS.filter((host) => SNAPSHOT_HOSTS.includes(host.id))
const FIELDS = ['registered', 'registerError', 'afterRegister', 'removed', 'removeWarnings', 'afterRemove', 'removedOnly', 'removedOnlyWarnings', 'afterRemoveOnly']

async function withErrors(home, mark, run) {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  try {
    await run()
  } finally {
    console.error = original
  }
  return lines.map((line) => line.replaceAll(home, '<HOME>').split(mark)[0] + mark)
}

function removeAll(home) {
  const out = {}
  for (const host of hosts) out[host.name] = { hook: host.removeHooks(home), MCP: host.removeMcp(home), skill: host.removeSkill(home) }
  return out
}

test('安装侧登记的前三端就是快照锁住的三端，顺序不变', () => {
  assert.deepEqual(INSTALL_HOSTS.slice(0, 3).map((host) => [host.id, host.name]), [['cursor', 'Cursor'], ['codebuddy', 'codebuddy'], ['workbuddy', 'WorkBuddy']])
})

for (const name of Object.keys(FIXTURES)) {
  test(`安装与卸载快照 ${name}`, async (t) => {
    const got = actual[name] = {}
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), `memory-install-${name}-`))
    const bare = await fsp.mkdtemp(path.join(os.tmpdir(), `memory-uninstall-${name}-`))
    t.after(() => Promise.all([home, bare].map((dir) => fsp.rm(dir, { recursive: true, force: true }))))
    await buildFixtureHome(home, name)
    await buildFixtureHome(bare, name)

    // 安装脚本逐端注册，某一端的配置读不出来时在那里中断，后面的不再处理。
    const registered = {}
    const registerError = []
    for (const host of hosts) {
      try {
        registered[host.name] = host.register(home, ctx)
      } catch (error) {
        registerError.push(error.message.replaceAll(home, '<HOME>').split('失败：')[0] + '失败：')
        break
      }
    }
    Object.assign(got, { registered, registerError, afterRegister: await readClientFiles(home) })

    got.removeWarnings = await withErrors(home, '原因：', () => { got.removed = removeAll(home) })
    got.afterRemove = await readClientFiles(home)

    got.removedOnlyWarnings = await withErrors(bare, '原因：', () => { got.removedOnly = removeAll(bare) })
    got.afterRemoveOnly = await readClientFiles(bare)

    if (UPDATE) return
    for (const key of FIELDS) assert.deepEqual(got[key], expected[name][key], key)
  })
}

test('安装与卸载快照没有多余或缺失的条目', async () => {
  if (UPDATE) {
    const ordered = Object.fromEntries(Object.entries(actual).map(([name, got]) => [name, Object.fromEntries(FIELDS.map((key) => [key, got[key]]))]))
    await fsp.writeFile(FIXTURE, `${JSON.stringify(ordered, null, 1)}\n`)
    return
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
})

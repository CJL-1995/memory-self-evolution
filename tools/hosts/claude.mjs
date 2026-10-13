// Claude Code：hook 在 ~/.claude/settings.json，形状和 CodeBuddy 的一样。
// MCP 不能写文件：用户级的 MCP 存在 ~/.claude.json 里，那是 Claude Code 自己频繁改写的状态文件，
// 要通过 claude mcp add 注册。settings.json 里的 mcpServers 不生效。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MCP_NAME, fileHost, upsertGroupedHook } from './shared.mjs'

const ID = 'claude'
// 弹窗点选之后主模型要调用的那个工具。默认每次调用 MCP 工具都要用户批准，加了这条就只剩弹窗那一次点选。
export const ALLOW_RULE = `mcp__${MCP_NAME}__memory_resolve`

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function versionOrder(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

// 先找 PATH 里的 claude；没有就找桌面端自带的那个，它的路径里带版本号和一段哈希，取版本最新的。
export function findClaude(home, ctx = {}) {
  if (ctx.claudeBin) return ctx.claudeBin
  const pathEnv = ctx.pathEnv === undefined ? process.env.PATH || '' : ctx.pathEnv
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir && isFile(path.join(dir, 'claude'))) return path.join(dir, 'claude')
  }
  const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')
  let versions = []
  try {
    versions = fs.readdirSync(root).filter((name) => /^\d+(\.\d+)*$/.test(name)).sort(versionOrder).reverse()
  } catch {
    return ''
  }
  for (const version of versions) {
    for (const build of fs.readdirSync(path.join(root, version))) {
      const bin = path.join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')
      if (isFile(bin)) return bin
    }
  }
  return ''
}

function mcpAddArgs(ctx) {
  return ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', ctx.nodeBin, ctx.mcpScript, '--agent', ID]
}

const quote = (arg) => (/^[\w./:=-]+$/.test(arg) ? arg : `"${arg}"`)

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' })
  const detail = String(result.stderr || result.stdout || (result.error && result.error.message) || '').trim().split('\n')[0]
  return { ok: result.status === 0, detail }
}

function registerMcp(home, ctx) {
  const bin = findClaude(home, ctx)
  const manual = `claude ${mcpAddArgs(ctx).map(quote).join(' ')}`
  if (!bin) return `未注册：没有找到 claude 命令。装好后手动运行：${manual}`
  // 已经注册过时 add 会报重名，先移除再加，换了 node 或挪了仓库也能更新。
  const existed = run(bin, ['mcp', 'remove', '--scope', 'user', MCP_NAME]).ok
  const added = run(bin, mcpAddArgs(ctx))
  if (!added.ok) return `注册失败：${added.detail || '没有输出'}。可以手动运行：${manual}`
  return existed ? 'updated' : 'added'
}

function removeMcp(home, ctx) {
  if (!fs.existsSync(path.join(home, '.claude'))) return '客户端目录不存在，已跳过'
  const bin = findClaude(home, ctx)
  if (!bin) return `没有找到 claude 命令，已跳过。需要时手动运行：claude mcp remove --scope user ${MCP_NAME}`
  const removed = run(bin, ['mcp', 'remove', '--scope', 'user', MCP_NAME])
  return removed.ok ? `已删除 ${MCP_NAME}` : '未注册本插件 MCP，已跳过'
}

function hasAllowRule(data) {
  return Boolean(data && data.permissions && Array.isArray(data.permissions.allow) && data.permissions.allow.includes(ALLOW_RULE))
}

function readSettings(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  } catch {
    return null
  }
}

const base = fileHost({
  id: ID,
  name: 'Claude Code',
  dir: '.claude',
  hooksFile: 'settings.json',
  events: [
    { event: 'SessionStart', timeout: 10 },
    { event: 'UserPromptSubmit', timeout: 10 },
    { event: 'Stop', timeout: 20 },
  ],
  emptyHooksFile: () => ({ hooks: {} }),
  upsertHook: (list, command, timeout) => upsertGroupedHook(list, command, timeout, ID),
  // 免批准规则和 hook 在同一个 settings.json 里。只在用户安装时明确同意后才写。
  afterHooks(data, ctx) {
    if (hasAllowRule(data)) return '免批准规则 已存在'
    if (!ctx.allowResolve) return `免批准规则 未添加（需要时在 ~/.claude/settings.json 的 permissions.allow 里加 "${ALLOW_RULE}"）`
    if (!data.permissions || typeof data.permissions !== 'object') data.permissions = {}
    if (!Array.isArray(data.permissions.allow)) data.permissions.allow = []
    data.permissions.allow.push(ALLOW_RULE)
    return '免批准规则 已添加'
  },
  cleanup(data) {
    // 移除本插件的 hook 之后空掉的事件不留在用户的 settings.json 里。
    for (const [event, list] of Object.entries(data.hooks)) {
      if (Array.isArray(list) && list.length === 0) delete data.hooks[event]
    }
    if (!hasAllowRule(data)) return ''
    data.permissions.allow = data.permissions.allow.filter((rule) => rule !== ALLOW_RULE)
    if (data.permissions.allow.length === 0) delete data.permissions.allow
    if (Object.keys(data.permissions).length === 0) delete data.permissions
    return '已去掉免批准规则'
  },
  registerMcp,
  removeMcp,
})

export default {
  ...base,
  // 装了 Claude Code、还没有这条规则时，安装时问一次。
  questions(home) {
    if (!fs.existsSync(path.join(home, '.claude')) || hasAllowRule(readSettings(home))) return []
    return [{
      key: 'allowResolve',
      title: `Claude Code 默认每次调用 MCP 工具都要你批准。开着确认时，在记忆弹窗里点选之后还会再问一次是否允许调用 memory_resolve。
是否把这一个工具设为免批准（它只能处理你刚点选过的那条提案，改不了正文）：`,
      options: [
        { value: true, menu: '1) 设为免批准（直接回车）', aliases: ['1', 'y', 'yes', '是'] },
        { value: false, menu: '2) 不设，每次都问我', aliases: ['2', 'n', 'no', '否'] },
      ],
    }]
  },
}

// 安装与卸载共用的部分：读写配置文件、判定哪条 hook 是本插件的、注册和移除 MCP，
// 以及「hook 写在一个 JSON 文件里、MCP 写在同目录 mcp.json 里」这类客户端的通用流程。

import fs from 'node:fs'
import path from 'node:path'
import { isPluginHook, removePluginHookEvent } from '../../lib/core/hook-config.mjs'

export const MCP_NAME = 'memory-self-evolution'
// 整理记忆用的 skill，四端共用仓库里的同一份 SKILL.md，安装时复制到各端的 skill 目录。
export const SKILL_NAME = 'memory-self-evolution-manage'
// 插件改名之前注册的名字，安装和卸载时一并清掉。
const LEGACY_MCP_NAME = 'dsh-memory'

export { isPluginHook }

export function hookCommand(ctx, agent) {
  return `"${ctx.nodeBin}" "${ctx.hookScript}" hook --agent ${agent}`
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`读取 ${file} 失败：${error.message}`)
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

// 卸载时读配置：文件不存在或读不出来都返回 null，读不出来的原因打到 stderr。卸载不因为一个坏文件中断。
function readJsonOrSkip(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`读取 ${file} 失败，已跳过该文件。原因：${error.message}`)
    return null
  }
}

function registerMcpFile(file, agent, ctx) {
  const data = readJson(file, { mcpServers: {} })
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {}
  const existed = Boolean(data.mcpServers[MCP_NAME] || data.mcpServers[LEGACY_MCP_NAME])
  delete data.mcpServers[LEGACY_MCP_NAME]
  data.mcpServers[MCP_NAME] = {
    type: 'stdio',
    command: ctx.nodeBin,
    args: [ctx.mcpScript, '--agent', agent],
    description: '跨会话长期记忆：读取记忆、处理插件发起的记忆确认',
  }
  writeJson(file, data)
  return existed ? 'updated' : 'added'
}

function removeHooksFromList(list, agent) {
  if (!Array.isArray(list)) return 0
  let removed = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item && isPluginHook(item.command, agent)) {
      list.splice(i, 1)
      removed++
      continue
    }
    if (!item || !Array.isArray(item.hooks)) continue
    const before = item.hooks.length
    item.hooks = item.hooks.filter((hook) => !isPluginHook(hook && hook.command, agent))
    removed += before - item.hooks.length
    if (item.hooks.length === 0) list.splice(i, 1)
  }
  return removed
}

// 每个事件下是一列 { matcher, hooks: [...] } 的那种 hook 配置：在其中新增或更新本插件的那一条。
export function upsertGroupedHook(list, command, timeout, agent) {
  for (const group of list) {
    const hooks = Array.isArray(group && group.hooks) ? group.hooks : []
    const found = hooks.find((item) => isPluginHook(item && item.command, agent))
    if (!found) continue
    found.type = 'command'
    found.command = command
    found.timeout = timeout
    return 'updated'
  }
  list.push({
    matcher: '',
    hooks: [{ type: 'command', command, timeout }],
  })
  return 'added'
}

// 把 skill 复制到客户端的 skill 目录。ctx.skillSource 是仓库里 SKILL.md 的路径，没给时不装。
function installSkill(home, skillsDir, ctx) {
  if (!ctx.skillSource) return ''
  const dir = path.join(home, skillsDir, SKILL_NAME)
  const existed = fs.existsSync(path.join(dir, 'SKILL.md'))
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `SKILL.md.tmp.${process.pid}`)
  fs.copyFileSync(ctx.skillSource, tmp)
  fs.renameSync(tmp, path.join(dir, 'SKILL.md'))
  return existed ? 'updated' : 'added'
}

// spec 描述一个客户端的配置落在哪、长什么样：
//   id、name        --agent 的取值和打印用的名字
//   dir、hooksFile  用户目录下的客户端目录，以及其中放 hook 的文件
//   skillsDir       客户端读取个人 skill 的目录，相对用户目录
//   events          要注册的事件和各自的超时（秒）
//   emptyHooksFile  hook 文件不存在时的初始内容
//   upsertHook      在某个事件的列表里新增或更新本插件的那一条，返回 added 或 updated
// 下面几项可以不给：
//   legacyEvent     旧版本注册过、现在要清掉的事件
//   prepare         写入前补齐这类客户端要求的字段
//   afterHooks      hook 写好之后、落盘之前，在同一份配置里再做的事，返回一句说明
//   cleanup         卸载时移除 hook 之后在同一份配置里收尾，比如清掉 afterHooks 留下的东西；返回一句说明，没有可说的返回空串
//   registerMcp、removeMcp   MCP 不是写在同目录 mcp.json 里的客户端，自己给出注册和移除的办法
// 返回的对象是 setup 和 uninstall 用的全部入口。
export function fileHost(spec) {
  return {
    id: spec.id,
    name: spec.name,

    register(home, ctx) {
      const dir = path.join(home, spec.dir)
      if (!fs.existsSync(dir)) return '未安装，已跳过'
      const hooksFile = path.join(dir, spec.hooksFile)
      const data = readJson(hooksFile, spec.emptyHooksFile())
      if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {}
      if (spec.prepare) spec.prepare(data)
      const command = hookCommand(ctx, spec.id)
      const notes = []
      const removed = spec.legacyEvent ? removePluginHookEvent(data.hooks, spec.legacyEvent, spec.id) : 0
      if (removed > 0) notes.push(`${spec.legacyEvent} removed ${removed}`)
      for (const { event, timeout } of spec.events) {
        if (!Array.isArray(data.hooks[event])) data.hooks[event] = []
        notes.push(`${event} ${spec.upsertHook(data.hooks[event], command, timeout)}`)
      }
      const extra = spec.afterHooks ? spec.afterHooks(data, ctx) : ''
      writeJson(hooksFile, data)
      const mcp = spec.registerMcp ? spec.registerMcp(home, ctx) : registerMcpFile(path.join(dir, 'mcp.json'), spec.id, ctx)
      const skill = installSkill(home, spec.skillsDir, ctx)
      return `hooks ${notes.join(', ')}; mcp ${mcp}${skill ? `; skill ${skill}` : ''}${extra ? `; ${extra}` : ''}`
    },

    removeSkill(home) {
      if (!fs.existsSync(path.join(home, spec.dir))) return '客户端目录不存在，已跳过'
      const dir = path.join(home, spec.skillsDir, SKILL_NAME)
      if (!fs.existsSync(dir)) return '未安装本插件 skill，已跳过'
      fs.rmSync(dir, { recursive: true, force: true })
      return `已删除 ${SKILL_NAME}`
    },

    removeHooks(home) {
      const file = path.join(home, spec.dir, spec.hooksFile)
      if (!fs.existsSync(path.join(home, spec.dir))) return '客户端目录不存在，已跳过'
      const data = readJsonOrSkip(file)
      if (data == null) return 'hook 文件不存在，已跳过'
      if (!data.hooks || typeof data.hooks !== 'object') return '没有 hooks 字段，已跳过'
      let removed = 0
      for (const list of Object.values(data.hooks)) removed += removeHooksFromList(list, spec.id)
      const extra = spec.cleanup ? spec.cleanup(data) : ''
      if (removed === 0 && !extra) return '未注册本插件 hook，已跳过'
      writeJson(file, data)
      return `已删除 ${removed} 条 hook${extra ? `，${extra}` : ''}`
    },

    removeMcp(home, ctx = {}) {
      if (spec.removeMcp) return spec.removeMcp(home, ctx)
      const file = path.join(home, spec.dir, 'mcp.json')
      if (!fs.existsSync(path.join(home, spec.dir))) return '客户端目录不存在，已跳过'
      const data = readJsonOrSkip(file)
      if (data == null) return 'mcp.json 不存在，已跳过'
      if (!data.mcpServers || typeof data.mcpServers !== 'object') return '没有 mcpServers，已跳过'
      const names = [MCP_NAME, LEGACY_MCP_NAME].filter((name) => Object.hasOwn(data.mcpServers, name))
      if (names.length === 0) return '未注册本插件 MCP，已跳过'
      for (const name of names) delete data.mcpServers[name]
      writeJson(file, data)
      return `已删除 ${names.join(', ')}`
    },
  }
}

// 安装与卸载快照用的假用户目录。每种目录对应一种安装前的状态。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const stale = (agent) => `"/old/node" "/old/repo/bin/memory.mjs" hook --agent ${agent}`
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

export const CLIENT_DIRS = ['.cursor', '.codebuddy', '.workbuddy']

export const FIXTURES = {
  // 三个客户端都装了，但都还没有任何 hook 和 MCP 配置。
  fresh: {
    '.cursor/': null,
    '.codebuddy/': null,
    '.workbuddy/': null,
  },
  // 已经有别的工具的 hook 和 MCP，也有本插件旧路径下的注册，以及旧版本遗留的工具后 hook 和旧名字的 MCP。
  existing: {
    '.cursor/hooks.json': json({
      version: 1,
      hooks: {
        sessionStart: [{ command: 'other-tool start', timeout: 3 }, { command: stale('cursor'), timeout: 99 }],
        postToolUse: [{ command: stale('cursor'), timeout: 5 }, { command: 'other-tool after' }],
        stop: [{ command: 'other-tool stop' }],
      },
    }),
    '.cursor/mcp.json': json({ mcpServers: { other: { command: 'x' }, 'dsh-memory': { command: 'old' } } }),
    '.codebuddy/settings.json': json({
      theme: 'dark',
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'other start' }, { type: 'command', command: stale('codebuddy'), timeout: 1 }] }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: stale('codebuddy') }] }],
        Stop: 'not-an-array',
      },
    }),
    '.codebuddy/mcp.json': json({ mcpServers: { 'memory-self-evolution': { command: 'old', args: ['x'] } } }),
    '.workbuddy/settings.json': json({ hooks: null }),
    '.workbuddy/mcp.json': json({ mcpServers: 'broken' }),
  },
  // 只装了 Cursor，hooks.json 没有 version 字段。
  partial: {
    '.cursor/hooks.json': json({ hooks: {} }),
  },
  // 配置文件不是合法 JSON。
  corrupt: {
    '.cursor/': null,
    '.codebuddy/settings.json': '{ not json',
    '.codebuddy/mcp.json': '{ not json',
    '.workbuddy/': null,
  },
}

export async function buildFixtureHome(home, name) {
  await fsp.mkdir(home, { recursive: true })
  for (const [rel, content] of Object.entries(FIXTURES[name])) {
    const target = path.join(home, rel)
    if (content === null) {
      await fsp.mkdir(target, { recursive: true })
      continue
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content)
  }
}

const SKILL_SOURCE = fileURLToPath(new URL('../../skills/memory-self-evolution-manage/SKILL.md', import.meta.url))

// 三个客户端目录下所有文件的内容，路径相对用户目录，子目录也逐层列出。
// 和仓库里 SKILL.md 一样的文件只记一个占位：快照要锁的是装没装、装在哪，不是 skill 的措辞。
export async function readClientFiles(home) {
  const skill = await fsp.readFile(SKILL_SOURCE, 'utf8').catch(() => null)
  const out = {}
  async function walk(rel) {
    const names = await fsp.readdir(path.join(home, rel)).catch(() => null)
    if (names === null) return
    names.sort()
    out[`${rel}/`] = names
    for (const name of names) {
      const child = `${rel}/${name}`
      if ((await fsp.stat(path.join(home, child))).isDirectory()) {
        await walk(child)
        continue
      }
      const body = await fsp.readFile(path.join(home, child), 'utf8')
      out[child] = body === skill ? '（与仓库里的 SKILL.md 相同）' : body
    }
  }
  for (const dir of CLIENT_DIRS) await walk(dir)
  return out
}

// 安装与卸载快照用的假用户目录。每种目录对应一种安装前的状态。
import fsp from 'node:fs/promises'
import path from 'node:path'

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

// 三个客户端目录下所有文件的内容，路径相对用户目录。
export async function readClientFiles(home) {
  const out = {}
  for (const dir of CLIENT_DIRS) {
    const names = await fsp.readdir(path.join(home, dir)).catch(() => null)
    if (names === null) continue
    out[`${dir}/`] = names.sort()
    for (const name of names) out[`${dir}/${name}`] = await fsp.readFile(path.join(home, dir, name), 'utf8')
  }
  return out
}

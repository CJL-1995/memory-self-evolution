// Cursor：hook 在 ~/.cursor/hooks.json，每个事件下是一列 { command, timeout }。

import { fileHost, isPluginHook } from './shared.mjs'

export default fileHost({
  id: 'cursor',
  name: 'Cursor',
  dir: '.cursor',
  hooksFile: 'hooks.json',
  // 个人 skill 放在这里；~/.cursor/skills-cursor 是 Cursor 自带的，不能往里放。
  skillsDir: '.cursor/skills',
  events: [
    { event: 'sessionStart', timeout: 10 },
    { event: 'beforeSubmitPrompt', timeout: 5 },
    { event: 'stop', timeout: 20 },
  ],
  legacyEvent: 'postToolUse',
  emptyHooksFile: () => ({ version: 1, hooks: {} }),
  prepare(data) {
    if (data.version == null) data.version = 1
  },
  upsertHook(list, command, timeout) {
    const found = list.find((item) => isPluginHook(item && item.command, 'cursor'))
    if (found) {
      found.command = command
      found.timeout = timeout
      return 'updated'
    }
    list.push({ command, timeout })
    return 'added'
  },
})

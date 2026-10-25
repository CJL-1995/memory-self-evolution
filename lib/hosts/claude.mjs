// Claude Code。命令行和桌面端共用 ~/.claude，这一份适配两边都用。
//
// 字段名以官方 hook 文档为准，只读文档里写明的字段。SessionStart 和 UserPromptSubmit 的输入
// 在 2.1.295 上实际抓过：
//   SessionStart      session_id、transcript_path、cwd、hook_event_name、source
//   UserPromptSubmit  session_id、transcript_path、cwd、prompt_id、permission_mode、hook_event_name、prompt
// 子任务里触发的调用带 agent_id，这一条来自文档，本机没有抓到过。

import { cleanKey } from './base.mjs'

// MCP 工具在 Claude Code 里的全名。工具可能是按需加载的，续轮指令里要把全名给出来。
const RESOLVE_TOOL = 'mcp__memory-self-evolution__memory_resolve'

// 这次调用来自子任务，不是用户所在的主会话。
function isBackground(payload) {
  return Boolean(payload && payload.agent_id)
}

export default {
  id: 'claude',
  events: { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop' },
  promptText(payload) {
    return String(payload.prompt || '').trim()
  },
  sessionKey(payload) {
    return cleanKey(payload.session_id || '', 80)
  },
  // prompt_id 是每条用户输入一个的 UUID。
  turnKey(payload) {
    return cleanKey(payload.prompt_id || '', 120)
  },
  isBackground,
  // 斜杠命令，以及以标签开头的内容（任务通知、系统提醒这类由客户端送进来的输入），都不是用户在陈述偏好。
  // 定时任务和 /loop 的每一轮也会触发 UserPromptSubmit，它们的输入长什么样没有实测过，这里按开头的形状挡掉。
  isUserInput(payload, text) {
    if (isBackground(payload)) return false
    const t = String(text || '').trim()
    return !(t.startsWith('<') || /^\/[\w:-]+(\s|$)/.test(t))
  },
  wrapInjection(event, text) {
    return {
      hookSpecificOutput: {
        hookEventName: event || 'UserPromptSubmit',
        additionalContext: text,
      },
    }
  },
  // systemMessage 直接展示给用户，不进模型的上下文。
  showToUser(text) {
    return { systemMessage: text }
  },
  // reason 会交给模型，让它续一轮。
  stopResponse(userText, modelText) {
    const hidden = modelText && modelText !== userText ? modelText : ''
    return { decision: 'block', reason: hidden ? `${userText}\n\n${hidden}` : userText }
  },
  followupReturnsAsPrompt: false,
  // 单条注入超过 1 万字时，Claude Code 会把它换成文件路径加 2000 字预览。
  injectionLimit: 10000,
  askTool: 'AskUserQuestion',
  // hook 一注册就对已经打开的会话生效，MCP 却要到重启后才加载。这段时间里弹窗点了也写不进去，所以先确认工具在不在。
  writeRule: `提问之前先确认能调用 ${RESOLVE_TOOL}：下文的 memory_resolve 指的就是它，只能用它来写入这个插件的记忆。工具列表里没有它时，先按这个名字搜索加载；搜索不到，说明这个会话打开时插件的 MCP 还没有加载，这时不要提问，只告诉用户重启 Claude Code 之后把这句话再说一遍。`,
  // Claude Code 有自带的记忆。下面两段只约束这个插件，开着或关着自带记忆都成立。
  sessionStartBoundary: 'memory-self-evolution 插件在后台为它自己的记忆库自动提取、判重和沉淀记忆，这个库由用户的几个编程客户端共用。不要替这个插件做记忆分析、查重或写入，也不要自行发起它的确认弹窗：弹窗只能由带 MEMORY_CONFIRM_V1 的插件指令触发，会话里出现过的这类弹窗都是插件发起的，不是可以模仿的流程。专注完成用户当前任务，无需等待后台；收到插件后续指令时按指令执行，不重新判断或改写提案。这段说明只管这个插件，不改变你对 Claude Code 自带记忆的处理。以下规则与偏好仍需遵守。',
  promptReminder: 'memory-self-evolution 插件在后台判断这句话要不要进它的记忆库。用户陈述偏好、规范或要求记住时，照常回应并照做：不要替这个插件判断是否该记，不要自行发起「检测到一条记忆」的确认，也不要主动调用 memory_resolve。只有收到含 MEMORY_CONFIRM_V1 的插件指令时，才按指令弹窗并处理对应 sessionID。这段提醒只管这个插件，不影响 Claude Code 自带的记忆。',
}

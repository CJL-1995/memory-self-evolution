// CodeBuddy 与 WorkBuddy：PascalCase 事件名，注入用 hookSpecificOutput.additionalContext，
// 续轮用 decision: block。两端的协议相同，只是名字不同，旁路任务按名字隔离。

import { legacyInput } from './base.mjs'

function host(id) {
  return {
    id,
    ...legacyInput,
    events: { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop' },
    wrapInjection(event, text) {
      return {
        hookSpecificOutput: {
          hookEventName: event || 'UserPromptSubmit',
          additionalContext: text,
        },
      }
    },
    // CodeBuddy IDE 的 Stop 续轮只把 reason 交给模型，会丢弃 additionalContext，确认指令必须写进 reason。
    stopResponse(userText, modelText) {
      const hidden = modelText && modelText !== userText ? modelText : ''
      return { decision: 'block', reason: hidden ? `${userText}\n\n${hidden}` : userText }
    },
    followupReturnsAsPrompt: false,
    askTool: 'AskUserQuestion（CodeBuddy IDE 中为 ask_followup_question）',
    // update_memory 是这两端自带的记忆工具。
    writeRule: '只能调用 memory_resolve 工具来写入记忆，禁止调用 update_memory 工具来分析、更新记忆。',
  }
}

export const codebuddy = host('codebuddy')
export const workbuddy = host('workbuddy')

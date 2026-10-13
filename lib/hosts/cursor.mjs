// Cursor：camelCase 事件名，注入用 additional_context，续轮用 followup_message。

import { legacyInput } from './base.mjs'

export default {
  id: 'cursor',
  ...legacyInput,
  // 宿主的事件名归到哪一类：session-start、prompt、stop。
  events: { sessionStart: 'session-start', beforeSubmitPrompt: 'prompt', stop: 'stop' },
  wrapInjection(event, text) {
    return { additional_context: text }
  },
  // 续轮只带用户气泡里的那段话，会作为下一条输入回到 prompt hook。
  stopResponse(userText) {
    return { followup_message: userText }
  },
  // 续轮作为下一条输入回来时，给模型的指令要另存一份，下一轮再还给模型。
  followupReturnsAsPrompt: true,
  askTool: 'AskQuestion',
  writeRule: '只能调用 memory_resolve 工具来写入记忆。',
}

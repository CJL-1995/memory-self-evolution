// 现有三端共用的输入读法：字段名取并集，哪一端的输入都能读。
// 这是抽出适配层之前的行为，原样保留。新接入的宿主应当只读自己文档里写明的字段，
// 在自己的文件里覆盖这几个函数，不要往这里加字段。

// 会话 ID 和每轮 ID 要拿去拼文件名，只留字母、数字、下划线和连字符。
export function cleanKey(raw, max) {
  return String(raw).trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, max)
}

export const legacyInput = {
  // 用户这一轮的原话。CodeBuddy 给 user_prompt，Cursor 和 WorkBuddy 给 prompt。
  promptText(payload) {
    return String(payload.prompt || payload.user_prompt || '').trim()
  },
  // 稳定的会话 ID，旁路任务按它隔离。取不到时返回空串，调用方不启动判别。
  sessionKey(payload) {
    return cleanKey(payload.session_id || payload.conversation_id || payload.sessionId || payload.conversationId || '', 80)
  },
  // 这一轮输入的 ID，用来区分同一会话里内容相同的两次输入。宿主不提供时为空串。
  turnKey(payload) {
    return cleanKey(payload.generation_id || payload.generationId || payload.message_id || payload.messageId || '', 120)
  },
  // 这条输入是不是用户自己说的话，不是的不送去判别，也不召回。
  // CodeBuddy IDE 的点选答复以 <question_answer> 作为下一条输入送回，不能当作新记忆去判别。
  isUserInput(payload, text) {
    return !String(text || '').includes('<question_answer>')
  },
}

// 宿主注册表。各端在 hook 协议上的差异都收在这个目录里，一个宿主一个文件。
// lib/core 和 bin 只通过这里拿宿主对象，不按名字判断是哪一端。
//
// 接入新的客户端：在这个目录加一个文件，实现下面这些成员，再在 HOSTS 里登记一行。
//   id                     --agent 的取值，也是旁路任务里记的客户端名
//   events                 宿主的事件名 → session-start、prompt、stop
//   promptText(payload)    用户这一轮的原话
//   sessionKey(payload)    稳定的会话 ID
//   turnKey(payload)       这一轮输入的 ID，没有就返回空串
//   isUserInput(payload, text)   这条输入是不是用户自己说的话，不是的不判别、不召回
//   wrapInjection(event, text)   把注入文本包成宿主认的输出
//   stopResponse(userText, modelText)   回答结束后让主模型续一轮的输出
//   followupReturnsAsPrompt      续轮是否会作为下一条输入回到 prompt hook
//   askTool、writeRule           续轮指令里随宿主变的两处措辞
// 下面几个可以不写，不写就是现有三端的行为：
//   isBackground(payload)        这次调用是不是来自子任务。是的话不判别、不召回、不续轮
//   showToUser(text)             把一段话直接展示给用户、不交给模型时，要并进 hook 输出的字段。
//                                不写就不展示，showRecall 打开了也一样
//   injectionLimit               会话开始那次注入的字数上限
//   sessionStartBoundary、promptReminder   会话开始和每轮输入里说明插件职责的那段话

import cursor from './cursor.mjs'
import { codebuddy, workbuddy } from './codebuddy.mjs'
import claude from './claude.mjs'

// 顺序有意义：不带 --agent 时，共用同一套事件名的几端里取排在前面的。新的宿主加在末尾。
const HOSTS = [cursor, codebuddy, workbuddy, claude]
const BY_ID = new Map(HOSTS.map((host) => [host.id, host]))

// 各端的事件名互不重名，归类时不用先知道是哪一端。
const EVENT_KIND = Object.assign({}, ...HOSTS.map((host) => host.events))

export function eventKind(eventName) {
  return EVENT_KIND[eventName] || ''
}

// 没带 --agent 时按事件名判断是哪一端。几端共用同一套事件名时取先登记的那个，都不认识时按 Cursor。
export function agentForEvent(eventName) {
  const owner = HOSTS.find((host) => Object.hasOwn(host.events, eventName))
  return (owner || cursor).id
}

// 没登记的名字沿用抽出适配层之前的结果：注入按 Cursor 的格式，续轮和措辞按 CodeBuddy 的。
export function hostOf(agent) {
  const id = String(agent || '')
  return BY_ID.get(id) || { ...codebuddy, id, wrapInjection: cursor.wrapInjection }
}

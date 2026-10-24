---
name: memory-self-evolution-manage
description: 查看、删除、合并或改写 memory-self-evolution 插件里的长期记忆。用户要列出或查看全部记忆，或者要删掉、忘掉、合并、去重、改写、纠正某条记忆，而这条记忆出现在会话开始注入的「长期记忆」、每轮注入的「与本轮输入相关的长期记忆」里，或能用 memory_read 查到时使用。不用于新增记忆，也不用于客户端自带的记忆。
---

# memory-self-evolution 记忆整理

## 针对的插件

- 插件名是 memory-self-evolution。记忆库在 ~/.memory-self-evolution/，由 Cursor、CodeBuddy、WorkBuddy、Claude Code 四个客户端共用，在这里改了四端都生效。
- 怎么认出这个插件的记忆：
  1. 会话开始注入的「# 长期记忆（自动生成，请勿手动编辑）」下面列出的规则；
  2. 每轮注入的「# 与本轮输入相关的长期记忆（自动召回）」下面的规则和项目事实；
  3. memory_read 返回的条目，每条带 id；
  4. ~/.memory-self-evolution/memories.md 里列出的条目。
- 不属于这个插件的：客户端自带的记忆，包括 Claude Code 的 memory 目录和 CLAUDE.md、CodeBuddy 与 WorkBuddy 的 update_memory、Cursor 的 Memories 和 Rules。

## 能做的事

| 操作 | 调用 | 结果 |
|---|---|---|
| 查看全部记忆 | memory_list，open=true | 插件刷新并用默认程序打开 memories.md，返回两组条数和文件路径 |
| 查看某一条或某一类 | memory_read | 在对话里列出匹配的条目，带正文、置信度和 id |
| 删除一条 | memory_update，action=delete，id | 这条从插件里移除，召回和下一个会话的注入里都不再出现 |
| 合并两条 | memory_update，action=merge，id，id2，text | id 保留，正文换成 text 并重算向量；id2 被并掉；置信度取两条中较高的 |
| 改写一条 | memory_update，action=replace，id，text | 用 text 整条换掉原来的正文并重算向量，置信度不变 |

## 只允许调用的工具

- memory_list：看两组各有多少条；带 open=true 时打开 memories.md。
- memory_read：按组读出记忆和 id，用来找目标、在对话里列出某一类记忆。
- memory_update：执行删除、合并、改写。
- 当前客户端的提问工具：执行前让用户确认，或有多个候选时让用户选。Cursor 是 AskQuestion，CodeBuddy 与 WorkBuddy 是 AskUserQuestion（CodeBuddy IDE 中为 ask_followup_question），Claude Code 是 AskUserQuestion。

在 Claude Code 里这几个工具的名字带前缀，例如 mcp__memory-self-evolution__memory_update；在其它客户端里就是 memory_update。处理这些事时不调用以上之外的任何工具。

## 禁止事项

1. 不改客户端自带的记忆，不调用 update_memory，不改 CLAUDE.md、Claude Code 的 memory 目录、Cursor 的 Memories 和 Rules。
2. 不用文件工具、命令或脚本读写记忆库里的文件：rule.jsonl、project.jsonl、embeddings.jsonl、memories.md、trash.jsonl、side/ 目录。要看全部记忆，用 memory_list 打开 memories.md，不要自己用命令打开或读取它。
3. 不调用 memory_resolve，它只处理插件自己发起的确认弹窗；也不调用 memory_config。
4. 用户没有明确要求时，不删除、不合并、不改写。觉得两条重复或某条过时，可以告诉用户，由用户决定。
5. 不编造 id。id 只能来自 memory_read 的返回。
6. 一次调用只处理一条，合并是一对。用户要处理多条时，逐条确认、逐条调用。
7. 不用这个 skill 新增记忆。用户陈述新的偏好或要求记住时，插件会在后台判断，不调用 memory_update。
8. 合并和改写的正文必须是中文、自包含、6 到 400 个字，不写「这个」「上面说的」「原来是……现在改成……」。

## 理解用户的意思

1. 判断是哪种操作：
   - 查看全部：「列出记忆」「看看有哪些记忆」「我的记忆有哪些」「打开记忆」「list」。
   - 查看某一类：「看看关于多格式导出的记忆」「代理相关的记忆有哪些」。只在对话里列出匹配的条目，不打开文件。
   - 删除：「删掉」「去掉」「忘掉」「别再记」「这条没用了」「作废」。
   - 合并：「合并」「合成一条」「这几条是一回事」「重复了」「去重」。
   - 改写：「改成……」「更新为……」「纠正一下，应该是……」「这条不对」。
   - 不是整理记忆：陈述新的偏好或规范（「以后都……」），交给插件后台；要改的是代码或文档里的规则，不是记忆。
2. 找到目标：
   - 用户给的是描述（「代理节点那条」「多格式导出那几条」）时，用 memory_read 读 rule 和 project 两组，按描述找候选。
   - 用户给的是 memories.md 里的序号或 id 时，用 memory_read 核对这条的正文和 id。序号会随置信度变化，以 id 为准。
   - 正好一条：继续。
   - 多条：列出候选的正文和 id，让用户选。
   - 一条都没有：告诉用户插件里没找到，它可能在客户端自带的记忆里。不要转去改自带的记忆，问用户。
   - 用户说「刚才那条」「上面那条」：先从对话里找出它指的那条正文，再到 memory_read 的结果里核对 id。
3. 合并的正文：
   - 由用户给出。用户没有给时，先请用户给。
   - 用户请你代拟时，拟好给用户看，用户确认后的那一句才作为 text。
   - 选哪条作为 id（保留的那条）：选用户指明要保留的那条；用户没指明时选置信度更高的一条，并在确认时说明。
4. 改写的正文：以用户给出的新说法为准，写成自包含的一句；冲突的旧内容不保留。

## 流程

查看全部：
1. 调用 memory_list，open=true。
2. 告诉用户两组各有多少条，以及文件已打开、文件路径。
3. 打开失败时，把文件路径告诉用户，不要改用其它工具打开。

删除、合并、改写：
1. 判断操作类型，找到目标 id，必要时问用户。
2. 执行前把要做的事给用户看：操作、目标的正文和 id、执行后的结果（合并后的正文和置信度，或改写后的新正文），用提问工具让用户选「确认执行」或「取消」。
3. 用户确认后调用 memory_update，一次一条。
4. 把工具的返回原样告诉用户。
5. 提醒用户：本会话开始时已经注入的内容，要到下一个会话才会消失；每轮召回立即生效。
6. 工具报错（id 不存在、正文长度不合要求）时，把原因告诉用户，不要改用其它办法完成。

## 指向文档的记忆

有些记忆只是指向 ~/.memory-self-evolution/project-memory/ 里某篇文档的指针。删除、合并或改写这类记忆不会改动文档本身。用户也想处理文档时，告诉用户文档的路径，由用户决定。

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { CLOSE_COMMAND, FORK_COMMAND, fenced, forkLabel, MAX_QUESTION_LENGTH, parseRequest, questionWithReference, RUN_COMMAND } from './shared'
import { SIDE_MAX_OUTPUT_TOKENS } from './limits'
import { DEFAULT_TIMEOUT_MS, SideJobs, type SettledAnswer } from './server/jobs'
import { createAnswerOnlyGuard, identityOfFromContext } from './server/tool-guard'
import { readSettings } from './server/settings'
import { translate } from './locales'
import { hideInternalCommands } from './server/command-visibility'

export const name = 'michengai-btw'
export const inject = ['commands', 'subagents', 'tools']
export { Config } from './server/settings'

interface ActivationTask {
  parent: Agent
  prompt: readonly { type: string; text: string }[]
  agentOptions?: { maxTokens?: number }
  maxDepth?: number
}

/**
 * 发布版 DSH 0.2.2-rc.1 从 `spec.request` 读取任务，之后的主干读取 spec 顶层字段，
 * 而两者的版本号相同。同时提供两种写法，兼容范围内的宿主都能启动。
 */
function activationSpec<T extends object>(base: T, task: ActivationTask): T & ActivationTask & { request: ActivationTask } {
  return { ...base, ...task, request: task }
}

interface GuardedAgent {
  ctx?: {
    tools: {
      guard(guard: ReturnType<typeof createAnswerOnlyGuard>): () => void | Promise<void>
    }
  }
}

/** 宿主命令只负责接入与身份绑定，不创建 HTTP 或持久侧聊接口。 */
export function apply(ctx: Context, config?: unknown): void {
  ctx.effect(() => hideInternalCommands(ctx.commands))
  const labels = new Set<string>()
  // 配置每读一次都重新解包：设置面板改完立即对下一次旁问生效，不需要重载插件。
  const settingsNow = () => readSettings(config)
  // 保护挂在子代理自己的上下文上，随子代理释放，不借用宿主根 fiber。
  // dsh-tui 会拒绝插件激活期间的 root.effect / root.events。
  const protection = createAnswerOnlyGuard(labels, identityOfFromContext(ctx), () => settingsNow().allowedTools)
  const releasePluginGuard = ctx.tools.guard(protection)
  const childGuards = new WeakMap<object, () => void | Promise<void>>()
  const arm = (agent: GuardedAgent) => {
    // child 级 guard 只是纵深防御：确定性拦截已由 ownId 预登记承担（agent.id === childId），
    // 因此 agent.ctx 尚未就绪时静默跳过不影响拦截能力；不要往这里加唯一的必要限制。
    protection.own(agent)
    if (!agent.ctx || childGuards.has(agent)) return
    childGuards.set(agent, agent.ctx.tools.guard(protection))
  }
  const releaseChild = async (agent: object | undefined) => {
    if (!agent) return
    const release = childGuards.get(agent)
    childGuards.delete(agent)
    await release?.()
  }
  const stopWatch = ctx.on('session/event', (session, event) => protection.recognize(session, event))
  const activeLabels = new Map<string, number>()
  const retainLabel = (l: string) => {
    activeLabels.set(l, (activeLabels.get(l) ?? 0) + 1)
    labels.add(l)
  }
  const releaseLabel = (l: string) => {
    const count = (activeLabels.get(l) ?? 1) - 1
    if (count <= 0) {
      activeLabels.delete(l)
      labels.delete(l)
    } else {
      activeLabels.set(l, count)
    }
  }

  const jobs = new SideJobs(async request => {
    // 0.2.1-rc.1 起只有 startActivation；0.2.0-rc.1 与 0.2.0-rc.2 仍只有 start。
    const provider = ctx.subagents.getProvider('fork')
    const t = translate(request.locale)
    if (!provider?.inheritsParentContext) {
      throw new Error(t('error.provider'))
    }
    const label = t('agent.name')
    retainLabel(label)
    const settings = settingsNow()
    // 自定义提示词替换内置前缀；工具权限句始终追加，配置不能让模型误以为「什么都能调」。
    const permissions = settings.allowedTools.length === 0 ? '' : `\n\n${t('agent.toolsAllowed', { tools: settings.allowedTools.join(', ') })}`
    const prefix = settings.promptPrefix === '' ? t('agent.promptPrefix') : settings.promptPrefix
    const promptText = `${prefix}${permissions}\n\n${request.question}`
    const subagents = ctx.subagents as unknown as {
      startActivation?: (spec: ActivationTask & {
        provider: string
        label: string
        childId: ReturnType<typeof SessionId>
        request: ActivationTask
        signal: AbortSignal
        delivery: 'caller'
      }) => Promise<{ result: Promise<{ stopReason: string; output: readonly { type: string; text?: string }[] }>; dispose(): Promise<void> }>
      start?: (provider: string, options: {
        parent: Agent
        label: string
        signal: AbortSignal
        agentOptions?: { maxTokens?: number }
        prompt: readonly { type: string; text: string }[]
      }) => Promise<{ result: Promise<{ stopReason: string; output: readonly { type: string; text?: string }[] }>; localAgent?: object; dispose(): Promise<void> }>
    }
    const parentAgent = request.context as Agent | undefined
    const parentMaxTokens = parentAgent?.options?.maxTokens
    const maxTokens = typeof parentMaxTokens === 'number' && parentMaxTokens > 0
      ? Math.min(SIDE_MAX_OUTPUT_TOKENS, parentMaxTokens)
      : SIDE_MAX_OUTPUT_TOKENS
    if (typeof subagents.startActivation === 'function') {
      const childId = SessionId(globalThis.crypto.randomUUID())
      const releaseChildId = protection.ownId(childId)
      let childAgent: object | undefined
      try {
        const stopCreated = ctx.on('agent/created', ({ agent }) => {
          if (agent.id !== childId) return undefined
          childAgent = agent
          // 只挂执行期拦截，不改系统提示、不过滤工具定义：请求前缀与主会话逐字节一致，
          // 才能复用主会话的 prompt cache（与 Claude Code /btw 一致）。
          arm(agent as GuardedAgent)
          return undefined
        })
        let activation
        try {
          activation = await subagents.startActivation(activationSpec({
            provider: 'fork',
            label,
            childId,
            signal: request.signal,
            delivery: 'caller' as const,
          }, {
            parent: request.context as Agent,
            // 旁问只需一次性只读回答：收紧继承来的过大输出预算，避免长会话溢出；
            // 同时取 min 避免反向抬高小预算路由。
            agentOptions: { maxTokens },
            prompt: [{ type: 'text', text: promptText }],
          }))
        } finally {
          stopCreated()
        }
        // 结果落地即释放预登记 id：dispose 可能因 cleanup 超时未被调用，
        // 释放放在两处（此处与 dispose）保证 ownedIds 不会只增不减；重复释放无副作用。
        void activation.result.then(() => releaseChildId(), () => releaseChildId())
        return {
          result: activation.result,
          dispose: async () => {
            try { await activation.dispose() }
            finally {
              try { await releaseChild(childAgent) }
              finally { releaseChildId(); releaseLabel(label) }
            }
          },
        }
      } catch (error) {
        releaseChildId()
        releaseLabel(label)
        throw error
      }
    }
    if (typeof subagents.start !== 'function') {
      releaseLabel(label)
      throw new Error(t('error.provider'))
    }
    try {
      // 不传 persona / toolFilter，理由同上；工具由 AnswerOnlyGuard 在执行期拒绝。
      const run = await subagents.start('fork', {
        parent: request.context as Agent,
        label,
        signal: request.signal,
        agentOptions: { maxTokens },
        prompt: [{ type: 'text', text: promptText }],
      })
      if (run.localAgent) arm(run.localAgent)
      return {
        result: run.result,
        dispose: async () => {
          try { await run.dispose() }
          finally { await releaseChild(run.localAgent); releaseLabel(label) }
        },
      }
    } catch (error) { releaseLabel(label); throw error }
  }, DEFAULT_TIMEOUT_MS, {
    onError: error => ctx.logger.warn(error),
    onIdle: async () => { stopWatch(); await releasePluginGuard() },
  })
  ctx.effect(() => () => jobs.dispose())

  /**
   * 把旁问转为真正的后台子代理：继承主会话已完成的上下文和问答，拥有工具，结束后向
   * 主会话汇报。标签不在 `labels` 中，因此不受只答不做的保护，这是用户点击后的明确授权。
   */
  const startFork = async (parent: Agent, answered: SettledAnswer, signal: AbortSignal): Promise<string> => {
    const t = translate(answered.locale)
    const subagents = ctx.subagents as unknown as {
      getProvider(name: string): { inheritsParentContext?: boolean } | undefined
      resolveMaxDepth?: () => number | undefined
      startActivation?: (spec: ActivationTask & {
        provider: string
        label: string
        request: ActivationTask
        signal: AbortSignal
        delivery: 'parent'
      }) => Promise<{ name: string }>
    }
    if (!subagents.getProvider('fork')?.inheritsParentContext) throw new Error(t('error.provider'))
    if (typeof subagents.startActivation !== 'function') throw new Error(t('error.forkUnsupported'))
    const maxDepth = subagents.resolveMaxDepth?.()
    const started = await subagents.startActivation(activationSpec({
      provider: 'fork',
      label: forkLabel(answered.title),
      signal,
      delivery: 'parent' as const,
    }, {
      parent,
      prompt: [{ type: 'text', text: t('agent.forkPrompt', { question: fenced(answered.question), answer: fenced(answered.answer) }) }],
      ...maxDepth === undefined ? {} : { maxDepth },
    }))
    return started.name
  }

  ctx.effect(() => ctx.commands.register({
    name: 'btw',
    description: translate()('command.description'),
    input: { hint: translate()('command.hint') },
    recordInput: false,
    handler: invocation => {
      const question = invocation.rawInput.trim()
      if (!question) return { kind: 'error', text: translate()('error.empty') }
      if (question.length > MAX_QUESTION_LENGTH) return { kind: 'error', text: translate()('error.length') }
      return jobs.ask(invocation.agent.session.header.id, globalThis.crypto.randomUUID(), question, invocation.signal, invocation.agent)
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: RUN_COMMAND,
    description: translate()('command.internalRun'),
    recordInput: false,
    handler: invocation => {
      try {
        const request = parseRequest(invocation.rawInput)
        return jobs.ask(invocation.agent.session.header.id, request.id, questionWithReference(request.question, request.reference, request.locale), invocation.signal, invocation.agent, request.locale, request.question)
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : translate()('error.request') } }
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: FORK_COMMAND,
    description: translate()('command.internalFork'),
    recordInput: false,
    handler: async (invocation) => {
      const id = invocation.rawInput.trim()
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return { kind: 'error', text: translate()('error.id') }
      const scope = invocation.agent.session.header.id
      const answered = jobs.takeAnswer(scope, id)
      if (!answered) return { kind: 'error', text: translate()('error.forkGone') }
      try {
        return { kind: 'success', text: await startFork(invocation.agent, answered, invocation.signal) }
      } catch (error) {
        jobs.rememberAnswer(scope, id, answered)
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: CLOSE_COMMAND,
    description: translate()('command.internalClose'),
    recordInput: false,
    handler: invocation => {
      const id = invocation.rawInput.trim()
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return { kind: 'error', text: translate()('error.id') }
      return jobs.close(invocation.agent.session.header.id, id)
    },
  }))
}

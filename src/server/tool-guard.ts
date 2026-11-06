export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

export interface SessionIdentityHint {
  snapshotEvents?(): readonly SessionEventLike[]
}

export interface AgentIdentity {
  id?: string
  session?: {
    id?: string
    header?: { id?: string }
    snapshotEvents?(): readonly SessionEventLike[]
  } | object
}

export interface SubagentIdentityHint {
  readonly label?: string
}

export type IdentityOf = (session: object) => SubagentIdentityHint | null | undefined

export interface AnswerOnlyGuard {
  (execution: { agent?: AgentIdentity; name?: string; arguments?: unknown }): string | undefined
  own(agent: object): void
  ownId(id: string): () => void
  recognize(session: object, event: SessionEventLike): void
}

const DENY = 'BTW 仅允许文字回答，禁止执行任何工具。 / BTW allows text responses only; tool execution is strictly prohibited.'

/**
 * 白名单非空时的拒绝文案。
 *
 * 默认（白名单为空）保持 `DENY` 原文不变，既让既有提示语与测试断言逐字节稳定，
 * 也避免在什么都没配置时给出一段「允许了某些工具」的误导说明。
 */
function denyFor(allowed: readonly string[]): string {
  if (allowed.length === 0) return DENY
  const list = allowed.join(', ')
  return `BTW 仅允许文字回答与白名单工具（${list}），其余工具一律禁止。 / BTW allows text responses plus the whitelisted tools (${list}); every other tool call is rejected.`
}

/**
 * 工具白名单的读取函数。
 *
 * 用 getter 而不是快照：配置项在设置面板里是可写的，用户在面板里改完就应在下一次
 * 旁问里生效，不需要重载插件。返回空数组表示「不放行任何工具」。
 */
export type AllowedToolsOf = () => readonly string[]

/**
 * 旁问永远不能调用的工具，即使写进白名单也一样。发给父会话的消息会以 user 角色进入
 * 主会话并启动新一轮，模型可以被上下文中的注入文本诱导发送，因此不留这条通道。
 */
export const MESSAGE_TOOL = 'send_message'

function descriptorLabel(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('label' in data) || typeof data.label !== 'string') return undefined
  return data.label
}

/** 有 sessionProjections 时优先读 subagent；投影未返回合法标签时回退同步快照。0.2.0-rc.1 仍有 snapshotEvents。 */
function lastDescriptorLabel(session: object | undefined, identityOf?: IdentityOf): string | undefined {
  if (!session) return undefined
  if (identityOf) {
    const identity = identityOf(session)
    if (typeof identity?.label === 'string') return identity.label
  }
  const events = (session as SessionIdentityHint).snapshotEvents
  if (typeof events !== 'function') return undefined
  // 回退路径对每个「投影为 null」的会话都会执行（含主会话每次工具调用）：
  // 快照读取抛错时按既有 fail-open 语义放行，不让异常冒进工具执行链。
  try { return descriptorLabel(events().findLast(item => item.type === 'subagent/descriptor')?.data) }
  catch { return undefined }
}

/** 官方替换同步事件扫描：ctx.sessionProjections.snapshot(session, ['subagent']).values.subagent */
export function identityOfFromContext(ctx: { get(name: string): unknown }): IdentityOf | undefined {
  try {
    const projections = ctx.get('sessionProjections') as { snapshot?(session: object, keys: readonly ['subagent']): { values?: { subagent?: SubagentIdentityHint | null } } } | undefined
    const snapshot = projections?.snapshot
    if (typeof snapshot !== 'function') return undefined
    return session => {
      try { return snapshot(session, ['subagent']).values?.subagent ?? null }
      catch { return null }
    }
  } catch { return undefined }
}

/** 空白名单过滤继承工具；本保护额外拒绝 PTC 及子作用域自注册工具。 */
export function createAnswerOnlyGuard(labels: ReadonlySet<string>, identityOf?: IdentityOf, allowedTools: AllowedToolsOf = () => []): AnswerOnlyGuard {
  const allowedNow = (): string[] => {
    const names = allowedTools()
    if (!Array.isArray(names)) return []
    return names.filter(name => typeof name === 'string' && name.length > 0 && name !== MESSAGE_TOOL)
  }

  const owned = new WeakSet<object>()
  const ownedIds = new Set<string>()
  const claim = (value: object | undefined) => {
    if (value && typeof value === 'object') owned.add(value)
  }
  const claimAgent = (agent: object | undefined) => {
    if (!agent) return
    claim(agent)
    if (typeof agent === 'object' && 'session' in agent) {
      claim((agent as { session?: object }).session)
    }
  }
  const isOwnedId = (agent: AgentIdentity): boolean => {
    if (ownedIds.size === 0) return false
    if (typeof agent.id === 'string' && ownedIds.has(agent.id)) return true
    const session = agent.session as { id?: unknown; header?: { id?: unknown } } | undefined
    if (session && typeof session === 'object') {
      if (typeof session.id === 'string' && ownedIds.has(session.id)) return true
      if (typeof session.header?.id === 'string' && ownedIds.has(session.header.id)) return true
    }
    return false
  }

  const guard: AnswerOnlyGuard = ({ agent, name }) => {
    if (!agent) return undefined
    // 放行集合只有用户配置的白名单工具，其余一律拒绝。
    // 三条认领路径（预登记 id / 已认领对象 / 投影或快照 label）都必须返回 verdict。
    const allowed = allowedNow()
    const permitted = name !== undefined && allowed.includes(name)
    const verdict = permitted ? undefined : denyFor(allowed)
    if (isOwnedId(agent)) return verdict
    if (owned.has(agent) || (agent.session !== undefined && owned.has(agent.session))) return verdict
    const label = lastDescriptorLabel(agent.session, identityOf)
    if (!label || !labels.has(label)) return undefined
    claimAgent(agent)
    return verdict
  }
  guard.own = agent => { claimAgent(agent) }
  guard.ownId = id => {
    ownedIds.add(id)
    return () => { ownedIds.delete(id) }
  }
  guard.recognize = (session, event) => {
    if (event.type !== 'subagent/descriptor') return
    const label = descriptorLabel(event.data)
    if (label && labels.has(label)) claim(session)
  }
  return guard
}

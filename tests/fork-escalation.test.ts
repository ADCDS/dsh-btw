import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { translate } from '../src/locales'
import { CLOSE_COMMAND, FORK_COMMAND, forkLabel, RUN_COMMAND } from '../src/shared'

type Spec = {
  provider: string
  label: string
  childId?: string
  delivery: 'caller' | 'parent'
  parent: unknown
  prompt: readonly { type: string; text: string }[]
  agentOptions?: { maxTokens?: number }
  maxDepth?: number
  request: { parent: unknown; prompt: readonly { type: string; text: string }[] }
}
type Guard = (call: { agent: object; name: string; arguments: unknown }) => string | undefined

/** 真实 Cordis 与插件入口；只替换子代理运行时，模拟一次旁问和一次转入。 */
async function setup(startFork: (spec: Spec) => Promise<{ name: string }> = async () => ({ name: 'agent-1' })) {
  const ctx = new Context()
  const commands = new Map<string, CommandDefinition>()
  let guard: Guard | undefined
  ctx.provide('tools', { guard: (installed: Guard) => { guard ??= installed; return () => {} } })
  ctx.provide('commands', {
    list: () => [],
    register: (command: CommandDefinition) => { commands.set(command.name, command); return () => { commands.delete(command.name) } },
  })
  const startActivation = vi.fn(async (spec: Spec) => spec.delivery === 'parent'
    ? await startFork(spec)
    : {
      name: 'side',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '旁问答案' }] }),
      dispose: async () => {},
    })
  ctx.provide('subagents', {
    getProvider: () => ({ inheritsParentContext: true }),
    resolveMaxDepth: () => 2,
    startActivation,
  })
  const plugin = ctx.plugin(apply)
  await plugin.await()
  const parent = { session: { header: { id: 'main' } }, options: {} }
  const call = (name: string, rawInput: string) => commands.get(name)!.handler({
    agent: parent,
    rawInput,
    signal: new AbortController().signal,
  } as never)
  const ask = (id: string, question = '这个配置是什么意思', reference?: string) => call(RUN_COMMAND, JSON.stringify({ id, question, reference }))
  const forkSpecs = () => startActivation.mock.calls.map(args => args[0]).filter(spec => spec.delivery === 'parent')
  return { startActivation, parent, call, ask, forkSpecs, guard: () => guard! }
}

describe('把旁问转入后台子代理', () => {
  it('启动带工具的真实 fork，向主会话汇报，并带上问题和回答', async () => {
    const h = await setup()
    expect(await h.ask('request01')).toEqual({ kind: 'success', text: '旁问答案' })
    expect(await h.call(FORK_COMMAND, 'request01')).toEqual({ kind: 'success', text: 'agent-1' })
    const [spec] = h.forkSpecs()
    expect(spec).toMatchObject({ provider: 'fork', delivery: 'parent', label: 'btw: 这个配置是什么意思', maxDepth: 2 })
    expect(spec!.parent).toBe(h.parent)
    const prompt = spec!.prompt[0]!.text
    expect(prompt).toContain('这个配置是什么意思')
    expect(prompt).toContain('旁问答案')
    // 不沿用旁问的输出预算，也不预留 id：这是一个普通子代理。
    expect(spec!.agentOptions).toBeUndefined()
    expect(spec!.childId).toBeUndefined()
  })

  it('任务同时写在顶层和 request 中，发布版和主干宿主都能读取', async () => {
    const h = await setup()
    await h.ask('request01')
    await h.call(FORK_COMMAND, 'request01')
    const side = h.startActivation.mock.calls[0]![0]
    const fork = h.forkSpecs()[0]!
    for (const spec of [side, fork]) {
      expect(spec.parent).toBe(h.parent)
      expect(spec.request.parent).toBe(h.parent)
      expect(spec.request.prompt).toBe(spec.prompt)
    }
  })

  it('同一条旁问只能转入一次', async () => {
    const h = await setup()
    await h.ask('request01')
    expect((await h.call(FORK_COMMAND, 'request01'))?.kind).toBe('success')
    expect(await h.call(FORK_COMMAND, 'request01')).toEqual({ kind: 'error', text: translate()('error.forkGone') })
    expect(h.forkSpecs()).toHaveLength(1)
  })

  it('启动失败时报告原因，并可以重试', async () => {
    const start = vi.fn<(spec: Spec) => Promise<{ name: string }>>()
      .mockRejectedValueOnce(new Error('已达到子代理深度上限'))
      .mockResolvedValueOnce({ name: 'agent-2' })
    const h = await setup(start)
    await h.ask('request01')
    expect(await h.call(FORK_COMMAND, 'request01')).toEqual({ kind: 'error', text: '已达到子代理深度上限' })
    expect(await h.call(FORK_COMMAND, 'request01')).toEqual({ kind: 'success', text: 'agent-2' })
  })

  it('没有答案的旁问不能转入：未知、已关闭或标识非法', async () => {
    const h = await setup()
    expect(await h.call(FORK_COMMAND, 'unknown01')).toEqual({ kind: 'error', text: translate()('error.forkGone') })
    await h.ask('request01')
    await h.call(CLOSE_COMMAND, 'request01')
    expect(await h.call(FORK_COMMAND, 'request01')).toEqual({ kind: 'error', text: translate()('error.forkGone') })
    expect(await h.call(FORK_COMMAND, 'bad id')).toEqual({ kind: 'error', text: translate()('error.id') })
    expect(h.forkSpecs()).toHaveLength(0)
  })

  it('标签只用问题本身；引用原文仍进入提示词', async () => {
    const h = await setup()
    await h.ask('request01', '这段是什么意思', '选中的正文')
    await h.call(FORK_COMMAND, 'request01')
    const [spec] = h.forkSpecs()
    expect(spec!.label).toBe('btw: 这段是什么意思')
    expect(spec!.prompt[0]!.text).toContain('选中的正文')
  })

  it('问题中的占位符写法不会被当作模板展开', async () => {
    const h = await setup()
    await h.ask('request01', '{answer} 是什么')
    await h.call(FORK_COMMAND, 'request01')
    const prompt = h.forkSpecs()[0]!.prompt[0]!.text
    expect(prompt).toContain('{answer} 是什么')
    expect(prompt).not.toContain('{question}')
  })

  it('转入后的子代理可以用工具，旁问本身仍然只能回答', async () => {
    const h = await setup()
    const withLabel = (label: string) => ({
      session: { snapshotEvents: () => [{ type: 'subagent/descriptor', data: { label } }] },
    })
    const started = h.startActivation.mock.calls.length
    let observed: string | undefined
    const pending = h.ask('request01')
    observed = h.guard()({ agent: withLabel(translate()('agent.name')), name: 'write', arguments: {} })
    await pending
    expect(h.startActivation.mock.calls.length).toBeGreaterThan(started)
    expect(observed).toContain('禁止执行任何工具')
    await h.call(FORK_COMMAND, 'request01')
    expect(h.guard()({ agent: withLabel(h.forkSpecs()[0]!.label), name: 'write', arguments: {} })).toBeUndefined()
  })
})

describe('forkLabel', () => {
  it('折叠空白并截断过长的问题', () => {
    expect(forkLabel('  第一行\n  第二行  ')).toBe('btw: 第一行 第二行')
    const label = forkLabel('x'.repeat(200))
    expect(label.length).toBe(65)
    expect(label.endsWith('…')).toBe(true)
  })
})

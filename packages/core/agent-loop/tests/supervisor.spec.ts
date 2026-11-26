import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { SupervisorBudget, superviseTurn } from '../src/supervisor.ts'
import { textResponse } from './mock-adapter.ts'

const user = createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'Что такое JVM?' }],
})

describe('AI Control Supervisor', () => {
  it.each([
    ['DIRECT', 'direct', 'general_question'],
    ['DEEP', 'deep', 'complex_reasoning'],
    ['STANDARD', 'standard', 'standard_unspecified'],
    ['SOURCES', 'standard', 'needs_sources'],
    ['ACTION', 'standard', 'needs_action'],
    ['UNCLEAR', 'standard', 'ambiguous_input'],
    ['DIRECT with Bash', 'standard', 'invalid_output'],
  ])(
    'validates the route %s from a single tool-free Flash call',
    async (reply, route, reason) => {
      const stream = vi.fn(async function* (_options: GenerateOptions) { yield* textResponse(reply) })
      await expect(superviseTurn(stream, [user], undefined, new AbortController().signal)).resolves.toEqual({ route, reason })
      expect(stream).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off',
      }))
      expect(stream.mock.calls[0]?.[0].tools).toBeUndefined()
    },
  )

  it('falls back on provider error and propagates caller cancellation', async () => {
    const stream = vi.fn(() => { throw new Error('unavailable') })
    const controller = new AbortController()
    await expect(superviseTurn(stream, [user], undefined, controller.signal)).resolves.toEqual({ route: 'standard', reason: 'provider_error' })
    controller.abort()
    await expect(superviseTurn(stream, [user], undefined, controller.signal)).rejects.toThrow()
  })
})

describe('per-turn Supervisor budget', () => {
  const spend = { requests: 2, steps: 2, tools: 1 }

  it('waits for the initial decision only at a work boundary', async () => {
    const response = Promise.withResolvers<string>()
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(await response.promise)
    })
    budget.start([user], undefined)
    let admitted = false
    const admission = budget.allow(spend, '').then((value) => { admitted = value; return value })
    await Promise.resolve()
    expect(admitted).toBe(false)
    response.resolve('ACTION')
    await expect(admission).resolves.toBe(true)
    expect(budget.calls).toHaveLength(1)
    budget.close()
  })

  it.each([
    ['DEEP', 'needs_sources'],
    ['DIRECT', 'needs_sources'],
    ['DEEP', 'needs_action'],
    ['DIRECT', 'needs_reasoning'],
  ] as const)('admits %s with Worker continuation %s', async (classification, continuation) => {
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(classification)
    })
    budget.start([user], undefined)
    try {
      await expect(budget.allow({ ...spend, tools: 0 }, 'Palisade seat configurations', continuation)).resolves.toBe(true)
      await expect(budget.allow(spend, 'Proceed with the first tool')).resolves.toBe(true)
    } finally {
      budget.close()
    }
  })

  it('asks for clarification when ambiguity can change the searched result', async () => {
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse('UNCLEAR')
    })
    budget.start([user], undefined)
    await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(false)
    expect(budget.reason).toBe('ambiguous_input')
    budget.close()
  })

  it.each([
    ['FINISH', 'finish'],
    ['CLARIFY', 'clarify'],
    ['Keep searching', 'invalid_output'],
  ])('settles a review response %s with available results retained by the loop', async (review, reason) => {
    const responses = ['SOURCES', review]
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(responses.shift() ?? '')
    })
    budget.start([user], undefined)
    await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(true)
    budget.noteTools(1, 1)
    await expect(budget.allow({ ...spend, steps: 4 }, 'One source was available')).resolves.toBe(false)
    expect(budget.reason).toBe(reason)
    expect(budget.successfulTools).toBe(1)
    expect(budget.failedTools).toBe(1)
    budget.close()
  })

  it('reviews spent grants and reserves a tool-free answer at the hard limit', async () => {
    const replies = ['ACTION', 'EXTEND']
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      const reply = replies.shift()
      if (reply === undefined) throw new Error('Unexpected review')
      yield* textResponse(reply)
    })
    budget.start([user], undefined)
    await expect(budget.allow({ ...spend, tools: 2 }, '')).resolves.toBe(true)
    await expect(budget.allow({ ...spend, requests: 4, steps: 4, tools: 5 }, 'Found one source')).resolves.toBe(true)
    expect(budget.extensions).toBe(1)
    await expect(budget.allow({ ...spend, requests: 9 }, '')).resolves.toBe(false)
    expect(budget.final).toBe(true)
    expect(budget.reason).toBe('hard_limit')
    budget.close()
  })
})

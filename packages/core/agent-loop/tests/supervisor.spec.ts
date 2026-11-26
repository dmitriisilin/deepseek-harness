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

  it('allows bounded verification of a follow-up when the Worker can proceed with prior context', async () => {
    vi.stubEnv('AI_CONTROL_FIRST_EVIDENCE_GATE', '1')
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse('UNCLEAR')
    })
    try {
      budget.start([user], user)
      await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(true)
      expect(budget.final).toBe(false)
    } finally {
      budget.close()
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ['SELF_CONTAINED', false, false],
    ['DIRECT', false, true],
    ['SOURCES', true, true],
    ['UNCLEAR', false, false],
    ['invalid output', false, true],
  ])('selects first-answer checks for %s', async (label, sources, audit) => {
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(label)
    })
    try {
      budget.start([user], undefined)
      await expect(budget.firstAnswerChecks(true)).resolves.toEqual({ sources, audit, clarify: label === 'UNCLEAR' })
    } finally {
      budget.close()
    }
  })

  it('keeps a user-requested supplied-material boundary when the Worker asks for sources', async () => {
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse('SUPPLIED_ONLY')
    })
    try {
      budget.start([user], undefined)
      await expect(budget.firstAnswerChecks(true)).resolves.toEqual({ sources: false, audit: false, clarify: false })
      await expect(budget.allow(spend, 'Worker proposed an external lookup', 'needs_sources')).resolves.toBe(false)
      expect(budget.reason).toBe('supplied_only')
    } finally {
      budget.close()
    }
  })

  it('allows source verification after the draft identifies a material gap despite initial ambiguity', async () => {
    const responses = ['UNCLEAR', 'VERIFY']
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(responses.shift() ?? 'FINISH')
    })
    try {
      budget.start([user], undefined)
      await expect(budget.draftNeedsSources('A decisive external claim')).resolves.toBe(true)
      await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(true)
      expect(budget.final).toBe(false)
    } finally {
      budget.close()
    }
  })

  it.each([
    ['SOURCES', 'needs_sources'],
    ['ACTION', 'needs_action'],
    ['invalid output', 'needs_reasoning'],
    ['SELF_CONTAINED', undefined],
    ['UNCLEAR', undefined],
  ] as const)('recovers a malformed Worker continuation from %s', async (label, expected) => {
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(label)
    })
    try {
      budget.start([user], undefined)
      const continuation = await budget.recoverContinuation()
      expect(continuation).toBe(expected)
      if (continuation) {
        await expect(budget.allow({ requests: 2, steps: 2, tools: 0 }, '', continuation)).resolves.toBe(true)
        await expect(budget.allow({ requests: 3, steps: 3, tools: 1 }, '')).resolves.toBe(true)
        expect(budget.calls).toHaveLength(1)
      }
    } finally {
      budget.close()
    }
  })

  it('reserves room for an admitted source operation when classification is unavailable', async () => {
    vi.stubEnv('AI_CONTROL_FIRST_EVIDENCE_GATE', '1')
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse('invalid classification')
    })
    try {
      budget.start([user], undefined)
      await expect(budget.allow({ ...spend, tools: 0 }, '', 'needs_sources')).resolves.toBe(true)
      await expect(budget.allow({ requests: 3, steps: 3, tools: 3 }, 'Open evidence')).resolves.toBe(true)
      expect(budget.calls).toHaveLength(1)
    } finally {
      budget.close()
      vi.unstubAllEnvs()
    }
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

  it('gives the review structural next-operation evidence while keeping tool arguments local', async () => {
    vi.stubEnv('AI_CONTROL_PROGRESS_REVIEW', '1')
    const transport = vi.fn(async function* (options: GenerateOptions) {
      yield* textResponse(options.system?.includes('materially') ? 'FINISH' : 'SOURCES')
    })
    const budget = new SupervisorBudget(new AbortController().signal, transport)
    const done = { id: 'a', name: 'lookup', arguments: '{"query":"local-only-value"}' }
    const failed = { id: 'b', name: 'lookup', arguments: '{"query":"another-local-value"}' }
    try {
      budget.start([user], undefined)
      await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(true)
      budget.noteSuccessfulOperations([done, failed], new Set([done.id]))
      await expect(budget.allow({ ...spend, steps: 4 }, 'One result', undefined, [done, failed])).resolves.toBe(false)
      const request = JSON.stringify(transport.mock.calls[1]?.[0].messages)
      expect(request).toContain('repeatsSuccessfulOperation')
      const review = transport.mock.calls[1]?.[0].messages[0]?.content[0]
      expect(review?.type === 'text' && JSON.parse(review.text).sourceProgress).toEqual({ hasDiscovery: false, documentsRead: 0 })
      expect(review?.type === 'text' && JSON.parse(review.text).nextOperations).toEqual([
        { tool: 'lookup', repeatsSuccessfulOperation: true },
        { tool: 'lookup', repeatsSuccessfulOperation: false },
      ])
      expect(request).not.toContain('local-value')
      expect(request).not.toContain('local-only-value')
    } finally {
      budget.close()
      vi.unstubAllEnvs()
    }
  })

  it.each([
    { succeeded: true, foundSources: true },
    { succeeded: true, foundSources: false },
    { succeeded: false, foundSources: false },
  ])('reserves one source-reading batch after finding sources ($succeeded, $foundSources)', async ({ succeeded, foundSources }) => {
    vi.stubEnv('AI_CONTROL_PROGRESS_REVIEW', '1')
    const answers = ['SOURCES', 'FINISH', 'FINISH']
    const budget = new SupervisorBudget(new AbortController().signal, async function* () {
      yield* textResponse(answers.shift() ?? 'FINISH')
    })
    const search = { id: 'search', name: 'web_search', arguments: '{}' }
    const read = { id: 'read', name: 'web_fetch', arguments: '{}' }
    try {
      budget.start([user], undefined)
      await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(true)
      budget.noteSuccessfulOperations([search], new Set(succeeded ? [search.id] : []), foundSources)
      await expect(budget.allow({ requests: 4, steps: 4, tools: 3 }, '', undefined, [read])).resolves.toBe(foundSources)
      if (foundSources) {
        expect(budget.calls).toHaveLength(1)
        await expect(budget.allow({ requests: 5, steps: 5, tools: 4 }, '', undefined, [read])).resolves.toBe(false)
      }
      expect(budget.reason).toBe('finish')
    } finally {
      budget.close()
      vi.unstubAllEnvs()
    }
  })

  it('checks synthesis from read excerpts only while a bounded revision fits', async () => {
    vi.stubEnv('AI_CONTROL_SYNTHESIS_AUDIT', '1')
    const replies = ['SOURCES', 'REVISE: The excerpt limits this operation.']
    const transport = vi.fn(async function* (_options: GenerateOptions) {
      yield* textResponse(replies.shift() ?? 'ACCEPT')
    })
    const budget = new SupervisorBudget(new AbortController().signal, transport)
    try {
      budget.start([user], undefined)
      await expect(budget.allow(spend, '', 'needs_sources')).resolves.toBe(true)
      expect(budget.canAuditSynthesis(spend)).toBe(false)
      budget.noteDiscoveredSourceUrls(['https://example.com/reference#section'])
      budget.notePublicSourceExcerpt('https://local.example/resource', 'Undiscovered resource')
      budget.notePublicSourceExcerpt('https://example.com/reference', 'Documented conditions')
      budget.notePublicSourceExcerpt('https://example.com/reference#same-page', 'Repeated read')
      expect(budget.canAuditSynthesis({ ...spend, requests: 9 })).toBe(false)
      expect(budget.canAuditSynthesis(spend)).toBe(true)
      await expect(budget.synthesisRevisionAdvice('Universal statement')).resolves.toBe('The excerpt limits this operation.')
      const payload = transport.mock.calls[1]?.[0].messages[0]?.content[0]
      expect(payload?.type === 'text' && JSON.parse(payload.text).excerpts).toEqual([{ url: 'https://example.com/reference', excerpt: 'Documented conditions' }])
      await expect(budget.allow({ requests: 7, steps: 6, tools: 2 }, 'Another exploratory request')).resolves.toBe(false)
      expect(budget.reason).toBe('synthesis_reserved')
      expect(budget.canAuditSynthesis({ requests: 8, steps: 6, tools: 2 })).toBe(true)
    } finally {
      budget.close()
      vi.unstubAllEnvs()
    }
  })

  it('checks the beginning and conclusion of a long draft against relevant source sections', async () => {
    vi.stubEnv('AI_CONTROL_SYNTHESIS_AUDIT', '1')
    const transport = vi.fn(async function* (_options: GenerateOptions) { yield* textResponse('REVISE') })
    const budget = new SupervisorBudget(new AbortController().signal, transport)
    try {
      const url = 'https://example.com/reference'
      budget.noteDiscoveredSourceUrls([url])
      budget.notePublicSourceExcerpt(url, 'navigation '.repeat(1200) + 'Emergency actuator interlock requires disconnection.')
      await budget.synthesisRevisionAdvice(
        'Opening summary. ' + 'Background details. '.repeat(350) + 'The emergency actuator interlock can be used without disconnection.',
      )
      const payload = transport.mock.calls[0]?.[0].messages[0]?.content[0]
      const content = payload?.type === 'text' ? JSON.parse(payload.text) as { draft: string; excerpts: { url: string; excerpt: string }[] } : undefined
      expect(content?.draft).toContain('Opening summary.')
      expect(content?.draft).toContain('The emergency actuator interlock can be used without disconnection.')
      expect(content?.draft.length).toBeLessThan(5000)
      const excerpt = content?.excerpts[0]?.excerpt
      expect(excerpt).toContain('Emergency actuator interlock requires disconnection.')
      expect(excerpt?.length).toBeLessThan(3500)
    } finally {
      budget.close()
      vi.unstubAllEnvs()
    }
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

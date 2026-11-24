import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { superviseTurn } from '../src/supervisor.ts'
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

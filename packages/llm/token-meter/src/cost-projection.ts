import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type { ModelCost } from '@earendil-works/pi-ai'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { usageOf } from './usage-projection.ts'

// USD per million tokens, public list prices checked 2026-11-23.
const flash = { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0.30 }
const pro = { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 }
const deepseek = new Map([
  ['deepseek-flash', flash], ['deepseek-v4-flash', flash], ['deepseek-v4-flash-vision-exp', flash], ['deepseek-v4-pro', pro],
])
const claude = new Map([
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.50 }],
  ['claude-fable-5-2', { input: 8, output: 40, cacheRead: 0.20, cacheWrite: 10 }],
  ['claude-haiku-5-5', { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 }],
])

const routeSchema = z.object({ provider: z.string(), model: z.string() })
type Route = z.infer<typeof routeSchema>
type Rates = Pick<ModelCost, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
const catalogProviders = new Map<string, BuiltinProvider>(getBuiltinProviders().map(provider => [provider, provider]))

function ratesFor(route: Route, input: number): Rates | undefined {
  if (route.provider === 'deepseek' || route.provider === 'deepseek-official') {
    const rate = deepseek.get(route.model)
    if (rate !== undefined) return rate
  }
  if (route.provider === 'openai' && route.model === 'gpt-6.2-sol') {
    return input > 272_000
      ? { input: 4, output: 15, cacheRead: 0.20, cacheWrite: 5 }
      : { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.50 }
  }
  if (route.provider === 'anthropic') {
    if (route.model === 'claude-haiku-5-5' && input > 100_000) {
      return { input: 0.50, output: 2.50, cacheRead: 0.05, cacheWrite: 0.625 }
    }
    const rate = claude.get(route.model)
    if (rate !== undefined) return rate
  }
  const catalogProvider = catalogProviders.get(route.provider === 'deepseek-official' ? 'deepseek' : route.provider)
  if (catalogProvider === undefined) return undefined
  const rate = getBuiltinModels(catalogProvider).find(model => model.id === route.model)?.cost
  return rate !== undefined && [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].some(value => value > 0) ? rate : undefined
}

function estimate(usage: TokenUsage, route: Route | undefined): number | null {
  if (route === undefined) return null
  const reads = usage.cacheReadTokens ?? 0
  const writes = usage.cacheWriteTokens ?? 0
  const rate = ratesFor(route, usage.inputTokens + reads + writes)
  if (rate === undefined) return null
  return (usage.inputTokens * rate.input + usage.outputTokens * rate.output + reads * rate.cacheRead + writes * rate.cacheWrite) / 1e6
}

const viewSchema = z.object({
  estimatedUsd: z.number().nonnegative(),
  pricedRequests: z.number().int().nonnegative(),
  unpricedRequests: z.number().int().nonnegative(),
})
const stateSchema = viewSchema.extend({
  route: routeSchema.optional(),
  last: z.object({ turn: z.number(), step: z.number(), usd: z.number().nullable() }).optional(),
})
type State = z.infer<typeof stateSchema>

/** Replay the complete session, matching each usage sample to its request route. */
export const tokenCostProjectionDefinition = {
  key: 'tokenCost',
  stateVersion: 1,
  stateSchema,
  init: () => ({ estimatedUsd: 0, pricedRequests: 0, unpricedRequests: 0 }),
  apply(state, event) {
    if (event.type === 'request/context') {
      return { ...state, route: { provider: event.data.provider, model: event.data.model } }
    }
    if (event.type === 'llm/retry-started' && state.last?.turn === event.data.turn && state.last.step === event.data.step) {
      const { last: _settled, ...rest } = state
      return rest
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const usage = usageOf(event)
    if (usage === undefined) return state
    const { turn, step } = event.data
    const previous = state.last?.turn === turn && state.last.step === step ? state.last.usd : undefined
    const source = event.type === 'assistant/message' ? event.data.message.source : state.route
    const usd = estimate(usage, source)
    if (previous === usd) return state
    return {
      ...state,
      estimatedUsd: Math.max(0, state.estimatedUsd - (previous ?? 0) + (usd ?? 0)),
      pricedRequests: state.pricedRequests - Number(typeof previous === 'number') + Number(usd !== null),
      unpricedRequests: state.unpricedRequests - Number(previous === null) + Number(usd === null),
      last: { turn, step, usd },
    }
  },
  wire: {
    viewSchema,
    view: ({ estimatedUsd, pricedRequests, unpricedRequests }) => ({ estimatedUsd, pricedRequests, unpricedRequests }),
    summary: false,
  },
} satisfies ProjectionDefinition<'tokenCost', State>

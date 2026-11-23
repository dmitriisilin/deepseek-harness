/** Submit gates join per-Session plugin work before the composer freezes a draft. */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, vi } from 'vitest'
import { SubmitGateRegistry } from '../src/client/input/submit-gate.ts'

const session = SessionId('submit-gate')
const other = SessionId('submit-gate-other')

it('joins every gate bound to one Session and leaves other Sessions alone', async () => {
  const gates = new SubmitGateRegistry()
  const first = vi.fn(async () => {})
  const second = vi.fn(() => undefined)
  const unrelated = vi.fn(async () => {})
  gates.register(session, first)
  gates.register(session, second)
  gates.register(other, unrelated)

  await expect(gates.run(session)).resolves.toBeUndefined()
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  expect(unrelated).not.toHaveBeenCalled()
})

it('returns undefined without gates and after the disposer removes the last one', () => {
  const gates = new SubmitGateRegistry()
  expect(gates.run(session)).toBeUndefined()
  const dispose = gates.register(session, async () => {})
  expect(gates.run(session)).toBeInstanceOf(Promise)
  dispose()
  expect(gates.run(session)).toBeUndefined()
})

it('awaits pending work and surfaces a rejection to the caller', async () => {
  const gates = new SubmitGateRegistry()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  gates.register(session, () => pending)
  let settled = false
  const joined = gates.run(session)!.finally(() => { settled = true })
  expect(settled).toBe(false)
  release()
  await joined
  expect(settled).toBe(true)

  gates.register(session, async () => { throw new Error('stop failed') })
  await expect(gates.run(session)).rejects.toThrow('stop failed')
})

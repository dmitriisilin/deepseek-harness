import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

it('recognizes queued recordings concurrently and admits them in message order without repeating recognition', async () => {
  const wav = Buffer.from('524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000', 'hex')
  const pending = [Promise.withResolvers<{ text: string; inferenceSeconds: number }>(),
    Promise.withResolvers<{ text: string; inferenceSeconds: number }>()]
  const transcribe = vi.fn().mockReturnValueOnce(pending[0]!.promise).mockReturnValueOnce(pending[1]!.promise)
  const listeners = new Map<string, (event: unknown, next?: () => unknown) => unknown>()
  apply({
    on: (name: string, listener: (event: unknown, next?: () => unknown) => unknown) => listeners.set(name, listener),
    attachments: { async *readFileStream() { yield wav } },
    speechToText: { resolve: () => ({ provider: { info: { location: 'host-local' } } }), transcribe },
  } as unknown as Context)

  const agent = { session: { id: 'test-session' } }
  const messages = [1, 2].map(id => ({ content: [{ type: 'file', attachment: {
    name: `ai-center-voice-00000000-0000-0000-0000-00000000000${id}.wav`, bytes: wav.length,
  } }] }))
  for (const message of messages) listeners.get('agent/inbox/inserted')!({ agent, message })
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2))

  pending[1]!.resolve({ text: 'Second', inferenceSeconds: 1 })
  pending[0]!.resolve({ text: 'First', inferenceSeconds: 1 })
  const decision = await listeners.get('agent/pre-step')!(
    { agent, turn: 1, signal: new AbortController().signal },
    () => ({ kind: 'enter', messages }),
  )
  expect(decision).toMatchObject({ messages: [
    { content: [{ type: 'file' }, { text: '[Voice message transcript]\nFirst' }] },
    { content: [{ type: 'file' }, { text: '[Voice message transcript]\nSecond' }] },
  ] })
  expect(transcribe).toHaveBeenCalledTimes(2)
})

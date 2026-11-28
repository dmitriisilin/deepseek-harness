/** Transcribe marked composer recordings in the Host before model input is committed. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { decodeRecordedAudio, validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import { VOICE_FILENAME_PREFIX } from './voice-file.ts'

export const inject = ['attachments', 'speechToText', 'userQuestions']

const voiceFilename = new RegExp(`^${VOICE_FILENAME_PREFIX}[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.(wav|webm|mp4)$`, 'u')
const maxSeconds = 120
const maxBytes = 44 + maxSeconds * 32000

/**
 * Ask before acting on a speech transcript that conflates a comparison with an instruction.
 * @param ctx - Host context owning the question service.
 * @param agent - Agent whose composer should show the clarification.
 * @param transcript - Final text returned by the recognizer.
 * @param signal - Current Turn cancellation signal.
 * @returns clarified text, or undefined if the user skipped the question.
 */
async function clarifyTranscript(ctx: Context, agent: Agent, transcript: string, signal: AbortSignal): Promise<string | undefined> {
  const text = transcript.replace(/\bDeepSig(?=\s+(?:Flash|Pro)\b)/giu, 'DeepSeek')
  const ambiguousVerb = /(?:^|[.!?]\s+)(чем\s+)отключа(?:ется|ются)(?=\s)/iu
  if (!ambiguousVerb.test(text)) return text

  const compare = 'Сравнить'
  const disable = 'Узнать, как отключить'
  const { answers } = await ctx.userQuestions.ask({
    agent, signal,
    questions: [{
      id: 'voice-intent',
      header: 'Голосовое сообщение',
      question: 'Ты спрашиваешь, чем они отличаются, или как их отключить?',
      detail: text,
      options: [{ label: compare }, { label: disable }],
    }],
  })
  const answer = answers[0]
  if (answer?.custom?.trim()) return answer.custom.trim()
  if (answer?.selected.includes(compare)) return text.replace(ambiguousVerb, match => match.replace(/отключа/iu, 'отлича'))
  if (answer?.selected.includes(disable)) {
    return text.replace(ambiguousVerb, match => match.replace(/чем\s+отключа(?:ется|ются)/iu, 'как отключить'))
  }
  return undefined
}

type VoiceAttachment = Extract<UserMessage['content'][number], { type: 'file' }>['attachment']

async function recognize(ctx: Context, ref: VoiceAttachment, format: string, signal: AbortSignal) {
  let transcript: string | undefined
  const started = performance.now()
  let inferenceMs: number | undefined
  try {
    if (ref.bytes < 46 || ref.bytes > maxBytes) throw new Error('Voice recording has an invalid size')
    const audio = new Uint8Array(ref.bytes)
    let offset = 0
    for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
      audio.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (offset !== audio.length) throw new Error('Voice recording is incomplete')
    const wav = format === 'webm' || format === 'mp4'
      ? await decodeRecordedAudio(audio, format, maxSeconds, signal) : audio
    validateWave(wav, maxSeconds)
    const spec = ctx.speechToText.resolve({ audio: wav, providerId: 'whisper-local' as SpeechProviderId })
    if (spec.provider.info.location !== 'host-local') throw new Error('Voice provider must be local')
    const result = await ctx.speechToText.transcribe(spec, signal)
    inferenceMs = Math.round(result.inferenceSeconds * 1000)
    transcript = result.text.trim()
  } catch {
    signal.throwIfAborted()
  }
  const recognized = performance.now()
  return { transcript, started, recognized, inferenceMs }
}

async function awaitPrefetch(job: ReturnType<typeof recognize>, abort: AbortController, signal: AbortSignal) {
  const cancel = () => abort.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await job
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Preserve original attachments and append local transcripts to the admitted user messages. */
export function apply(ctx: Context): void {
  type Prefetch = { abort: AbortController; jobs: Map<number, ReturnType<typeof recognize>> }
  const prefetch = new WeakMap<UserMessage, Prefetch>()
  const byAgent = new WeakMap<Agent, Set<AbortController>>()
  let active = 0

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    const abort = new AbortController()
    const jobs = new Map<number, ReturnType<typeof recognize>>()
    for (const [index, block] of message.content.entries()) {
      if (active >= 3) break
      if (block.type !== 'file') continue
      const format = voiceFilename.exec(block.attachment.name)?.[1]
      if (!format) continue
      active++
      const job = recognize(ctx, block.attachment, format, abort.signal).finally(() => { active-- })
      void job.catch(() => {})
      jobs.set(index, job)
    }
    if (jobs.size === 0) return
    const running = byAgent.get(agent) ?? new Set()
    byAgent.set(agent, running)
    running.add(abort)
    prefetch.set(message, { abort, jobs })
    void Promise.allSettled(jobs.values()).then(() => running.delete(abort))
  })
  ctx.on('agent/inbox/discarded', ({ message }) => {
    prefetch.get(message)?.abort.abort()
    prefetch.delete(message)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const abort of byAgent.get(agent) ?? []) abort.abort()
  })
  ctx.on('agent/pre-step', async ({ agent, signal, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = []
    for (const message of decision.messages) {
      const content = []
      for (const [blockIndex, block] of message.content.entries()) {
        content.push(block)
        if (block.type !== 'file') continue
        const ref = block.attachment
        const format = voiceFilename.exec(ref.name)?.[1]
        if (!format) continue
        signal.throwIfAborted()
        const pending = prefetch.get(message)
        const job = pending?.jobs.get(blockIndex)
        const { transcript, started, recognized, inferenceMs } = await (
          pending && job ? awaitPrefetch(job, pending.abort, signal) : recognize(ctx, ref, format, signal)
        )
        signal.throwIfAborted()
        const clarificationStarted = performance.now()
        const clarified = transcript ? await clarifyTranscript(ctx, agent, transcript, signal) : transcript
        if (typeof process !== 'undefined' && (Reflect.get(process.env, 'AI_CONTROL_SUPERVISOR') === '1'
          || Reflect.get(process.env, 'AI_CONTROL_TURN_LOG') === '1')) {
          console.info(JSON.stringify({
            event: 'ai-control/stt', sessionId: agent.session.id, turn, format,
            durationMs: Math.round(recognized - started), inferenceMs,
            clarificationMs: Math.round(performance.now() - clarificationStarted),
            status: transcript === undefined ? 'failed' : transcript === '' ? 'empty'
              : clarified === undefined ? 'rejected' : clarified === transcript ? 'recognized' : 'adjusted',
          }))
        }
        if (transcript && clarified === undefined) return { kind: 'reject' }
        const text = clarified === undefined ? '[Voice message could not be transcribed.]'
          : clarified === '' ? '[Voice message contains no recognizable speech.]'
            : `[Voice message transcript]\n${clarified}`
        content.push({ type: 'text' as const, text })
      }
      messages.push(content.length === message.content.length ? message : { ...message, content })
    }
    return { ...decision, messages }
  })
}

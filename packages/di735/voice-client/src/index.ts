/** Transcribe marked composer recordings in the Host before model input is committed. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import { VOICE_FILENAME_PREFIX } from './voice-file.ts'

export const inject = ['attachments', 'speechToText', 'userQuestions']

const voiceFilename = new RegExp(`^${VOICE_FILENAME_PREFIX}[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.wav$`, 'u')
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

/** Preserve original attachments and append local transcripts to the admitted user messages. */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = []
    for (const message of decision.messages) {
      const content = []
      for (const block of message.content) {
        content.push(block)
        if (block.type !== 'file' || !voiceFilename.test(block.attachment.name)) continue
        const ref = block.attachment
        let transcript: string | undefined
        try {
          if (ref.bytes < 46 || ref.bytes > maxBytes) throw new Error('Voice recording has an invalid size')
          const audio = new Uint8Array(ref.bytes)
          let offset = 0
          for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
            audio.set(chunk, offset)
            offset += chunk.byteLength
          }
          if (offset !== audio.length) throw new Error('Voice recording is incomplete')
          validateWave(audio, maxSeconds)
          const spec = ctx.speechToText.resolve({ audio, providerId: 'whisper-local' as SpeechProviderId })
          if (spec.provider.info.location !== 'host-local') throw new Error('Voice provider must be local')
          transcript = (await ctx.speechToText.transcribe(spec, signal)).text.trim()
        } catch {
          signal.throwIfAborted()
        }
        const clarified = transcript ? await clarifyTranscript(ctx, agent, transcript, signal) : transcript
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

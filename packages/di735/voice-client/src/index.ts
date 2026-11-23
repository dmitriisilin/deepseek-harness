/** Transcribe marked composer recordings in the Host before model input is committed. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import { VOICE_FILENAME_PREFIX } from './voice-file.ts'

export const inject = ['attachments', 'speechToText']

const voiceFilename = new RegExp(`^${VOICE_FILENAME_PREFIX}[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.wav$`, 'u')
const maxSeconds = 120
const maxBytes = 44 + maxSeconds * 32000

/** Preserve original attachments and append local transcripts to the admitted user messages. */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = []
    for (const message of decision.messages) {
      const content = []
      for (const block of message.content) {
        content.push(block)
        if (block.type !== 'file' || !voiceFilename.test(block.attachment.name)) continue
        const ref = block.attachment
        let text = '[Voice message could not be transcribed.]'
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
          const transcript = (await ctx.speechToText.transcribe(spec, signal)).text.trim()
          text = transcript === '' ? '[Voice message contains no recognizable speech.]' : `[Voice message transcript]\n${transcript}`
        } catch {
          signal.throwIfAborted()
        }
        content.push({ type: 'text' as const, text })
      }
      messages.push(content.length === message.content.length ? message : { ...message, content })
    }
    return { ...decision, messages }
  })
}

/** Send from the installed voice bundle and inspect the message committed by the Host. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SpeechInput, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const packages = [
  { dir: 'di735/voice-bundle', enabled: true },
  { dir: 'di735/voice-client' },
  { dir: 'experimental/speech-to-text' },
  { dir: 'experimental/api-speech-to-text' },
].map(({ dir, ...entry }) => ({ ...entry, dir: fileURLToPath(new URL(`../../../packages/${dir}`, import.meta.url)) }))

it.skipIf(webSnapshotMode() === 'record').each([
  { mixed: false, ambiguous: false },
  { mixed: true, ambiguous: false },
  { mixed: false, ambiguous: true },
])('sends a recording through the Host ($mixed mixed, $ambiguous ambiguous)', async ({ mixed, ambiguous }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-send-voice-'))
  onTestFinished(async () => { await rm(scratch, { recursive: true, force: true }) })
  const overlay = join(scratch, 'speech.patch.yml')
  await writeFile(overlay, `
- id: speech-to-text
  config:
    defaultProvider: whisper-local
    recognitionHints: [DeepSeek, Opus]
- id: speech-to-text-sensevoice
  disabled: true
`)
  const scaffold = await launchWebScaffold({
    profile: { packages }, extraOverlayPath: overlay,
  })
  onTestFinished(async () => { await scaffold.close() })
  const recognize = vi.fn(async (input: SpeechInput) => {
    expect(input.recognitionHints).toEqual(mixed ? undefined : ['DeepSeek', 'Opus'])
    expect(Buffer.from(input.audio).subarray(0, 4).toString()).toBe('RIFF')
    const text = ambiguous ? 'Чем отключаются DeepSig Flash и DeepSig Pro?' : 'Recorded locally'
    return { text, audioSeconds: 1, inferenceSeconds: 0.1 }
  })
  await scaffold.ctx.plugin({ inject: ['speechToText'], apply(ctx) {
    ctx.effect(() => ctx.speechToText.register({
      info: {
        id: 'whisper-local' as SpeechProviderId, name: 'Test Whisper', location: 'host-local', languages: ['auto'],
        ...(mixed ? {} : { supportsRecognitionHints: true }),
      },
      transcribe: recognize,
    }))
  } })
  const committed: unknown[] = []
  let stepStarts = 0
  scaffold.ctx.on('session/event', (_session, event) => {
    if (event.type === 'step/start') stepStarts += 1
    if (event.type === 'user/message' && event.data.source.kind === 'user') committed.push(event.data.content)
  })

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  onTestFinished(async () => { await browser.close() })
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  if (mixed) {
    await page.locator('[data-composer-input]').fill('Please review')
    await page.locator('input[type="file"]:not([accept])').setInputFiles({
      name: 'ordinary.wav', mimeType: 'audio/wav', buffer: Buffer.from('ordinary attachment'),
    })
    await expect.poll(() => send.isEnabled()).toBe(true)
  } else {
    expect(await send.isDisabled()).toBe(true)
  }
  const record = page.getByRole('button', { name: 'Start recording', exact: true })
  if (!mixed && !ambiguous && process.env.AI_CONTROL_SCREENSHOTS) {
    await page.setViewportSize({ width: 360, height: 780 })
    await record.waitFor()
    await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'composer-controls-360-light.png'), animations: 'disabled' })
  }
  await record.click()
  await page.getByRole('button', { name: 'Stop and transcribe', exact: true }).waitFor()
  // The fake microphone needs an interval of capture before it can emit samples.
  await page.waitForTimeout(350)
  if (!mixed && !ambiguous && process.env.AI_CONTROL_SCREENSHOTS) {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'recording-412-light.png'), animations: 'disabled' })
  }
  await send.click()
  if (ambiguous) {
    const question = page.locator('[data-question-key]')
    await question.getByText('Ты спрашиваешь, чем они отличаются, или как их отключить?', { exact: true }).waitFor()
    expect(stepStarts).toBe(0)
    expect(committed).toHaveLength(0)
    if (process.env.AI_CONTROL_SCREENSHOTS) {
      await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'voice-intent-clarification.png') })
    }
    await question.getByRole('radio', { name: 'Сравнить', exact: true }).click()
    await question.getByRole('button', { name: 'Submit', exact: true }).click()
  }
  await expect.poll(() => committed.length).toBe(1)
  expect(recognize).toHaveBeenCalledOnce()
  const transcript = ambiguous ? 'Чем отличаются DeepSeek Flash и DeepSeek Pro?' : 'Recorded locally'
  const expected = [
    expect.objectContaining({ type: 'file', attachment: expect.objectContaining({ name: expect.stringMatching(/^ai-center-voice-.*\.wav$/u) }) }),
    { type: 'text', text: `[Voice message transcript]\n${transcript}` },
  ]
  if (mixed) expected.push(
    expect.objectContaining({ type: 'file', attachment: expect.objectContaining({ name: 'ordinary.wav' }) }),
    { type: 'text', text: 'Please review' },
  )
  expect(committed[0]).toEqual(expect.arrayContaining(expected))
  if (process.env.DSH_WEB_BRAND === 'ai-control-red') {
    const bubble = page.locator('[data-chat-flow-kind="user"] [class*="userRow"]').last()
    await bubble.getByText(transcript, { exact: !mixed }).first().waitFor()
    expect(await bubble.innerText()).not.toContain('[Voice message transcript]')
  }
})

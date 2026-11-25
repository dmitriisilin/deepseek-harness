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
  { mixed: false, ambiguous: false, interrupted: false, dictate: false },
  { mixed: false, ambiguous: false, interrupted: true, dictate: false },
  { mixed: true, ambiguous: false, interrupted: false, dictate: false },
  { mixed: false, ambiguous: true, interrupted: false, dictate: false },
  { mixed: false, ambiguous: false, interrupted: false, dictate: true },
])('sends a recording through the Host ($mixed mixed, $ambiguous ambiguous, $interrupted interrupted, $dictate dictation)', async ({ mixed, ambiguous, interrupted, dictate }) => {
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
  const checkStatus = !mixed && !ambiguous && !interrupted && !dictate
    && process.env.DSH_WEB_BRAND === 'ai-control-red'
  const recognition = Promise.withResolvers<undefined>()
  onTestFinished(() => { recognition.resolve(undefined) })
  const recognize = vi.fn(async (input: SpeechInput) => {
    expect(input.recognitionHints).toEqual(mixed ? undefined : ['DeepSeek', 'Opus'])
    expect(Buffer.from(input.audio).subarray(0, 4).toString()).toBe('RIFF')
    if (checkStatus) await recognition.promise
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
  if (checkStatus) await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: `${navigator.userAgent} Android` })
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-composer-input]')) {
        const root = document.documentElement
        root.dataset.composerFocusCount = String(Number(root.dataset.composerFocusCount ?? 0) + 1)
      }
    })
  })
  if (interrupted) await page.addInitScript(() => {
    const start = MediaRecorder.prototype.start
    MediaRecorder.prototype.start = function (timeslice) {
      document.addEventListener('voice-test-interrupt', () => { this.stop() }, { once: true })
      start.call(this, timeslice)
    }
    Object.defineProperty(navigator, 'wakeLock', { value: {
      request() {
        document.documentElement.dataset.voiceTestWakeLock = 'held'
        return Promise.resolve({ released: false, release() {
          document.documentElement.dataset.voiceTestWakeLock = 'released'
          return Promise.resolve()
        } })
      },
    } })
  })
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
  if (!mixed && !ambiguous && !interrupted && process.env.AI_CONTROL_SCREENSHOTS) {
    await page.setViewportSize({ width: 360, height: 780 })
    await record.waitFor()
    await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'composer-controls-360-light.png'), animations: 'disabled' })
  }
  const streaming = process.env.AI_CONTROL_STREAM_AUDIO === '1'
    && process.env.AI_CONTROL_COMPRESSED_AUDIO === '1' && !dictate
  if (streaming && ambiguous) await page.route('**/api/session/voiceChunk?*', route => route.fulfill({ status: 503 }))
  const firstChunk = streaming ? page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/session/voiceChunk') : undefined
  await record.click()
  await page.getByRole('button', { name: 'Stop and transcribe', exact: true }).waitFor()
  // The fake microphone needs an interval of capture before it can emit samples.
  if (firstChunk) expect((await firstChunk).status()).toBe(ambiguous ? 503 : 204)
  else await page.waitForTimeout(350)
  if (!mixed && !ambiguous && !interrupted && process.env.AI_CONTROL_SCREENSHOTS) {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'recording-412-light.png'), animations: 'disabled' })
  }
  if (interrupted) {
    await expect.poll(() => page.locator('html').getAttribute('data-voice-test-wake-lock')).toBe('held')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.locator('[data-voice-activity="recording"]').waitFor()
    await page.evaluate(() => document.dispatchEvent(new Event('voice-test-interrupt')))
    await page.getByText('Recording kept. Press Send to attach it.', { exact: true }).waitFor()
    await expect.poll(() => page.locator('html').getAttribute('data-voice-test-wake-lock')).toBe('released')
  }
  if (dictate) {
    await page.getByRole('button', { name: 'Stop and transcribe', exact: true }).click()
    await expect.poll(() => page.locator('[data-composer-input]').innerText()).toContain('Recorded locally')
    expect(recognize).toHaveBeenCalledOnce()
    expect(committed).toHaveLength(0)
    return
  }
  const voiceTiming = process.env.AI_CONTROL_VOICE_TIMING === '1'
    ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/voiceUploadTiming')
    : undefined
  const upload = streaming ? page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/api/session/uploadFileBinary'
      && url.searchParams.get('name')?.startsWith('ai-center-voice-') === true
  }) : undefined
  const checkSending = streaming && !mixed && !ambiguous && !interrupted
    && process.env.DSH_WEB_BRAND === 'ai-control-red'
  const finalization = Promise.withResolvers<undefined>()
  if (checkSending) await page.route('**/api/session/uploadFileBinary?*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('voiceChunks')) await finalization.promise
    await route.continue()
  })
  const focusBeforeSend = await page.locator('html').getAttribute('data-composer-focus-count')
  try {
    await send.click()
    if (checkSending) {
      await page.getByRole('status', { name: 'Sending voice message…' }).waitFor()
      expect(await page.getByText(/^ai-center-voice-/u).count()).toBe(0)
      if (process.env.AI_CONTROL_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'voice-sending-412-light.png') })
      }
    }
  } finally {
    finalization.resolve(undefined)
  }
  if (upload) {
    const request = await upload
    expect(new URL(request.url()).searchParams.has('voiceChunks')).toBe(!ambiguous)
    expect((request.postDataBuffer()?.byteLength ?? 0) > 0).toBe(ambiguous)
  }
  if (voiceTiming !== undefined) expect((await voiceTiming).status()).toBe(204)
  if (checkStatus) {
    try {
      await expect.poll(() => recognize.mock.calls.length).toBe(1)
      const status = page.locator('[data-transcribing-voice]')
      await status.getByRole('status').getByText('Transcribing voice').waitFor()
      expect(await status.getByRole('progressbar').count()).toBe(0)
      await expect.poll(() => status.locator('[data-running-time]').innerText()).toMatch(/[1-9]/u)
      if (process.env.AI_CONTROL_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.AI_CONTROL_SCREENSHOTS, 'voice-transcribing-412-light.png') })
      }
    } finally {
      recognition.resolve(undefined)
    }
  }
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
    expect.objectContaining({ type: 'file', attachment: expect.objectContaining({ name: expect.stringMatching(process.env.AI_CONTROL_COMPRESSED_AUDIO === '1' ? /^ai-center-voice-.*\.webm$/u : /^ai-center-voice-.*\.wav$/u) }) }),
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
    await page.locator('[data-message-attachments]').getByText('Voice message', { exact: true }).last().waitFor()
    expect(await page.getByText(/^ai-center-voice-/u).count()).toBe(0)
    expect(await page.locator('[data-voice-sending]').count()).toBe(0)
    expect(await page.locator('[data-transcribing-voice]').count()).toBe(0)
    if (checkStatus) expect(await page.locator('html').getAttribute('data-composer-focus-count')).toBe(focusBeforeSend)
  }
})

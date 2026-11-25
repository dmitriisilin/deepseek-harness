/** Click-to-record toolbar activity; transcripts remain in the original Session draft. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerSubmitGates, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranscriptionRequest } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type { SpeechPreparationOptions, SpeechProviderId, SpeechSelection, SpeechSelectionPatch, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceChunkUpload } from './chunk-upload.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { VOICE_FILENAME_PREFIX } from '../voice-file.ts'
import { audioBase64, type Recording } from './audio.ts'
import { failureText } from './failure-text.ts'
import type { MicrophoneDevice } from './microphone-device.ts'
import type { SpeechReadiness } from './readiness.ts'
import { Waveform } from './Waveform.tsx'
import { VoiceSetupDialog } from './VoiceSetupDialog.tsx'
import { NS } from './locales.ts'
import { Button, IconCloseOutlineRegular, IconStopFillRegular, IconMicrophoneOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './VoiceInput.module.css'

/** Host calls injected without exposing a Cordis Context to React. */
export interface VoiceInputActions {
  /** Open the voice bundle details without starting preparation. */
  openSettings: () => void
  registerSubmitGate?: (...args: Parameters<ComposerSubmitGates['register']>) => (() => void) | undefined
  /** @returns one microphone operation owned by the plugin lifecycle. */
  createRecording: () => Recording
  /** Remember the browser microphone used by previews and subsequent recordings. */
  selectMicrophone: (device: MicrophoneDevice) => void
  transcribe: (request: TranscriptionRequest, signal: AbortSignal) => Promise<RemoteResult<Transcript>>
  prepare: (providerId: SpeechProviderId, options?: SpeechPreparationOptions) => Promise<void>
  cancelPreparation: (providerId: SpeechProviderId) => Promise<void>
  configure: (patch: SpeechSelectionPatch) => Promise<void>
}

/** Entry-injected Host readiness and microphone operations. */
export interface VoiceInputInjected extends VoiceInputActions {
  hooks: {
    speechReadiness: HostObservable<SpeechReadiness>
    microphoneDevice: HostObservable<MicrophoneDevice>
    /** Whether the Plugins page navigation service is present; the setup dialog offers the details only while it is. */
    pluginNavigation: HostObservable<boolean>
  }
}

/** Composer-owned expansion and draft actions; preferences stay in plugin settings. */
export type VoiceInputProps = Pick<PropsRuntime<'conversation.input.activity'>, 'sessionId' | 'inputActions' | 'locked' | 'onActiveChange' | 'onSubmitReadyChange' | 'addFiles'>
  & PropsLocale<typeof NS> & InjectFace<VoiceInputInjected>

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'feedback'
interface ActiveRecording {
  readonly capture: Recording
  readonly abort: AbortController
  readonly span: TokenSpan
  readonly selection: SpeechSelection
  readonly maxDurationSeconds: number
  readonly maxAudioBytes: number
  readonly compressedAudio: boolean
  readonly recordingId: string
  readonly chunkUpload?: VoiceChunkUpload
  phase: 'requesting' | 'recording' | 'transcribing'
  timer?: ReturnType<typeof setTimeout> | undefined
}

async function disposeRecording(capture: Recording): Promise<void> {
  try { await capture.dispose() } catch (_error) {
    // Tracks stop before AudioContext.close(); a close failure must not hide the recording result.
  }
}

/** Render a compact microphone or an expanded capture, transcription, or retry row. */
export function VoiceInput({ sessionId, inputActions, locked, onActiveChange, onSubmitReadyChange, addFiles, registerSubmitGate,
  createRecording, transcribe, openSettings, useSpeechReadiness, usePluginNavigation, t }: VoiceInputProps) {
  const readiness = useSpeechReadiness(value => value), catalog = readiness.catalog
  const navigable = usePluginNavigation(present => present)
  const provider = catalog?.providers.find(item => item.id === catalog.selection.providerId)
  const usable = readiness.connected && (provider?.preparation.phase === 'ready' || provider?.preparation.phase === 'standby'
    || provider?.preparation.phase === 'waking')
  const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState(''), [pending, setPending] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  useEffect(() => { if (usable) setSetupOpen(false) }, [usable])
  const current = useRef<ActiveRecording>(), generation = useRef(0)
  const pendingFile = useRef<File>()
  const expanded = phase !== 'idle'
  useLayoutEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

  const cancel = (): void => {
    generation.current++
    pendingFile.current = undefined
    const active = current.current
    current.current = undefined
    if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    setPending(''); setMessage(''); setPhase('idle'); setSetupOpen(false)
  }
  useEffect(() => {
    setPending(''); setMessage(''); setPhase('idle'); setSetupOpen(false)
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && current.current) { event.preventDefault(); cancel() }
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      generation.current++
      pendingFile.current = undefined
      const active = current.current
      current.current = undefined
      if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    }
  }, [sessionId])

  useEffect(() => {
    if (phase !== 'recording' || !navigator.wakeLock) return
    let active = true
    let requesting = false
    let lock: WakeLockSentinel | undefined
    const acquire = async (): Promise<void> => {
      if (!active || document.hidden || requesting || lock?.released === false) return
      requesting = true
      try {
        const granted = await navigator.wakeLock.request('screen')
        if (!active || document.hidden) await granted.release()
        else lock = granted
      } catch {
        // Recording continues when the browser declines a screen lock.
      } finally {
        requesting = false
      }
    }
    const visible = (): void => { void acquire() }
    document.addEventListener('visibilitychange', visible)
    void acquire()
    return () => {
      active = false
      document.removeEventListener('visibilitychange', visible)
      void lock?.release().catch(() => undefined)
    }
  }, [phase])

  const feedback = (text: string): void => { setMessage(text); setPhase('feedback') }
  const addPendingFile = (): void => {
    const file = pendingFile.current
    if (file === undefined || addFiles === undefined) throw new Error(t('empty'))
    const error = addFiles([file])
    if (error !== null) throw new Error(error)
    pendingFile.current = undefined
    setPhase('idle')
  }
  const finish = async (mode: 'dictate' | 'send' | 'recover' = 'dictate'): Promise<void> => {
    const active = current.current
    if (!active || active.phase !== 'recording') return
    const stoppedAt = performance.now()
    active.phase = 'transcribing'
    const run = generation.current
    clearTimeout(active.timer); setPhase('transcribing')
    try {
      const audio = await active.capture.stop(active.maxDurationSeconds, active.compressedAudio)
      const format = audio instanceof Blob ? (audio.type.startsWith('audio/webm') ? 'webm' : 'mp4') : undefined
      if (run !== generation.current) throw new DOMException('Recording cancelled', 'AbortError')
      if ((audio instanceof Blob ? audio.size : audio.byteLength) > active.maxAudioBytes) {
        if (mode === 'send') throw new Error(t('tooLarge'))
        feedback(t('tooLarge'))
        return
      }
      const wavReadyAt = performance.now()
      const chunkCount = mode !== 'dictate' && format !== undefined ? await active.chunkUpload?.finish() : undefined
      if (mode === 'dictate') active.chunkUpload?.cancel()
      if (run !== generation.current) throw new DOMException('Recording cancelled', 'AbortError')
      if (mode !== 'dictate' || (registerSubmitGate && addFiles)) {
        pendingFile.current = new File([audio], `${VOICE_FILENAME_PREFIX}${active.recordingId}.${format ?? 'wav'}`, { type: audio instanceof Blob ? audio.type : 'audio/wav' })
        performance.mark(`ai-control:voice:${pendingFile.current.name}`, {
          detail: { stoppedAt, wavReadyAt, chunkCount },
        })
      }
      if (mode === 'send') {
        addPendingFile()
        return
      }
      if (mode === 'recover') {
        feedback(t('recordingRecovered'))
        return
      }
      const bytes = audio instanceof Blob ? new Uint8Array(await audio.arrayBuffer()) : audio
      const result = await transcribe({
        audioBase64: audioBase64(bytes), ...active.selection, ...(format === undefined ? {} : { format }),
      }, active.abort.signal)
      if (run !== generation.current) return
      if (!result.ok) {
        feedback(pendingFile.current ? t('recordingRecovered') : t('failed', { message: result.error.message }))
        return
      }
      if (result.value.text === '') { feedback(pendingFile.current ? t('recordingRecovered') : t('empty')); return }
      pendingFile.current = undefined
      if (!inputActions.insertText(result.value.text, active.span)) { setPending(result.value.text); feedback(t('conflict')); return }
      setPhase('idle')
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) feedback(mode !== 'send' && pendingFile.current ? t('recordingRecovered') : failureText(failure, t))
      if (mode === 'send') throw failure
    } finally { if (run === generation.current) current.current = undefined }
  }
  useLayoutEffect(() => {
    if (!registerSubmitGate || !addFiles) return
    return registerSubmitGate(sessionId, () => {
      if (pendingFile.current && current.current?.phase !== 'transcribing') return Promise.resolve().then(addPendingFile)
      if (current.current?.phase === 'recording') return finish('send')
    })
  })
  const submitReady = registerSubmitGate !== undefined && addFiles !== undefined
    && (phase === 'recording' || (phase === 'feedback' && pendingFile.current !== undefined))
  useLayoutEffect(() => {
    onSubmitReadyChange?.(submitReady)
    return () => { onSubmitReadyChange?.(false) }
  }, [onSubmitReadyChange, submitReady])

  const start = async (): Promise<void> => {
    if (!catalog || !usable || locked || current.current) return
    pendingFile.current = undefined
    const run = ++generation.current
    const recordingId = randomUUID()
    const abort = new AbortController()
    const chunkUpload = catalog.streamAudio && registerSubmitGate && addFiles
      ? new VoiceChunkUpload(recordingId, abort.signal) : undefined
    const active: ActiveRecording = { capture: createRecording(), abort, recordingId,
      ...(chunkUpload === undefined ? {} : { chunkUpload }),
      span: inputActions.captureInsertion(), selection: catalog.selection,
      maxDurationSeconds: catalog.maxDurationSeconds, maxAudioBytes: catalog.maxAudioBytes, compressedAudio: catalog.compressedAudio === true, phase: 'requesting' }
    current.current = active
    setMessage(''); setPending(''); setPhase('requesting')
    try {
      await active.capture.start((failure) => {
        if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return
        if (active.phase === 'recording' && registerSubmitGate && addFiles) {
          void finish('recover')
          return
        }
        current.current = undefined
        clearTimeout(active.timer); active.abort.abort()
        void disposeRecording(active.capture)
        feedback(failureText(failure, t))
      }, active.compressedAudio, chunkUpload === undefined ? undefined : chunk => chunkUpload.append(chunk))
      if (run !== generation.current || current.current !== active) return
      active.phase = 'recording'
      setPhase('recording')
      active.timer = setTimeout(() => { void finish() }, active.maxDurationSeconds * 1000)
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) { current.current = undefined; feedback(failureText(failure, t)) }
    }
  }
  if (!expanded) return <>
    <Tooltip label={t('dictate')} disabled={!usable} side="top" portal>
      <span className={css.triggerAnchor}><Button className={css.trigger} size="sm" disabled={locked}
        aria-label={t(usable ? 'start' : 'setupPrompt.trigger')} aria-haspopup={usable ? undefined : 'dialog'}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { if (usable) void start(); else setSetupOpen(true) }}><IconMicrophoneOutlineRegular size={18} /></Button></span>
    </Tooltip>
    <VoiceSetupDialog open={setupOpen && !usable}
      needsInstallation={readiness.connected && provider?.location === 'host-local' && provider.preparation.phase === 'unprepared'}
      onDismiss={() => { setSetupOpen(false) }}
      onOpenDetails={navigable ? () => { setSetupOpen(false); openSettings() } : undefined} t={t} />
  </>
  return <div className={css.captureRow} data-voice-activity={phase}>
    <Button type="button" className={css.roundButton} size="sm" aria-label={t(pending ? 'discard' : 'cancel')}
      onClick={cancel}><IconCloseOutlineRegular size={14} /></Button>
    {phase === 'recording' ? <Waveform recording={current.current?.capture} label={t('recording')} />
      : <span className={css.activityMessage} role="status" title={pending || message}>
        {(phase === 'requesting' || phase === 'transcribing') && <StateDot state="ongoing" />}
        {phase === 'feedback' ? message : t(phase === 'requesting' ? 'requesting'
          : provider?.preparation.phase === 'waking' ? 'wakingShort' : 'transcribingShort')}</span>}
    {phase === 'recording' && <Button type="button" className={css.roundButton} size="sm" aria-label={t('stop')}
      onClick={() => { void finish() }}><IconStopFillRegular size={14} /></Button>}
    {phase === 'feedback' && (pending
      ? <Button className={css.inlineAction} size="sm" type="button" onClick={() => {
        if (inputActions.insertText(pending, inputActions.captureInsertion())) { setPending(''); setPhase('idle') }
      }}>{t('insert')}</Button>
      : pendingFile.current ? null : <Button className={css.roundButton} size="sm" type="button" aria-label={t('retryRecording')} disabled={!usable || locked}
        onClick={() => { void start() }}><IconMicrophoneOutlineRegular size={18} /></Button>)}
  </div>
}

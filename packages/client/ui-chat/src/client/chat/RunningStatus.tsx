/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useState } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  /** Freeze the shown duration while the Client cannot observe the Session. */
  readonly paused: boolean
  /** Keep the slot without showing or announcing the status: the Session stopped before its Turn closed. */
  readonly holding?: boolean
  readonly compact?: boolean
  readonly transcribing?: boolean
  readonly step?: number | undefined
  readonly stepStartedAt?: number | undefined
  readonly stepEndedAt?: number | undefined
  readonly t: ChatViewSlotProps['t']
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn start time, pause state, and localized copy.
 * @returns the blue running indicator; mount while the Session is running, or holding its slot hidden until the
 * Turn's actions row replaces it.
 */
export const RunningStatus = memo(function RunningStatus({
  startTime, paused, holding = false, compact = false, transcribing = false, step, stepStartedAt, stepEndedAt, t,
}: RunningStatusProps) {
  const [now, setNow] = useState(Date.now)
  const [mountedAt] = useState(Date.now)
  useEffect(() => {
    if ((!compact && startTime === undefined) || paused || holding) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime, paused, holding, compact])
  if (compact) {
    const stage = transcribing ? t('chat.transcribingVoice')
      : step === undefined ? t('chat.preparingAnswer') : t('chat.runningStep', { step })
    const duration = formatRunDuration(Math.max(now, stepEndedAt ?? 0) - (startTime ?? mountedAt), t).map(part => part.text).join('')
    const stepDuration = transcribing || stepStartedAt === undefined ? undefined
      : formatRunDuration((stepEndedAt ?? now) - stepStartedAt, t).map(part => part.text).join('')
    return (
      <div className={`${css.running} ${css.compactRunning}`} data-chat-running
        data-holding={holding ? '' : undefined} data-transcribing-voice={transcribing || undefined} aria-hidden={holding || undefined}>
        <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">
          {stage}
        </span>
        {holding ? null : <>
          <span data-running-step={transcribing ? undefined : step}>{stage}</span>
          <span className={css.runningTime} data-running-time>
            {' · '}{stepDuration ?? duration}
          </span>
          {stepDuration !== undefined && <span className={css.runningTime}>
            {' · '}{t('chat.runningTotal', { duration })}
          </span>}
        </>}
      </div>
    )
  }
  const label = startTime === undefined ? t('chat.deepDiving') : t('chat.deepDivingFor', {
    duration: formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join(''),
  })
  return (
    <div className={css.running} data-chat-running data-holding={holding ? '' : undefined} aria-hidden={holding || undefined}>
      {holding ? null : (
        <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{t('chat.deepDiving')}</span>
      )}
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        <RunningWhaleTail />
        <TextShimmer active={!holding} className={css.runningText}>{label}</TextShimmer>
      </span>
    </div>
  )
})

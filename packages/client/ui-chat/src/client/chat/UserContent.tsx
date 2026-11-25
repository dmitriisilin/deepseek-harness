/** Reusable user contents inside a caller-owned message row. */
import { Fragment } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { fileExtension, FileTypeIcon, fileSizeText, IconMicrophoneOutlineRegular, isVoiceRecordingName, JsonBlock, UserMessageBubble } from '@deepseek-ai/dsh-client-ui-primitives'
import { VoiceTranscriptionClock } from './RunningStatus.tsx'
import css from './MessageItem.module.css'

const EMPTY_LABELS: readonly string[] = []

/**
 * Render prepared text, ordered attachments, and references without message chrome.
 * The caller owns row identity, pending/echo state, time, and message actions.
 * @param props - prepared content, facts, authorized image loader, and framework Factory/locale seats.
 * @returns the content stack using the existing user-message layout.
 */
export function UserContent({ content, loadImage, facts, interactive = false, ellipsis = false, renderSlot, renderFactorySlot, t }:
FactoryComponentPropsOf<'conversation.chat.user.content'>) {
  const { text, attachments, extraBlocks, voiceSubmittedAt, referenceLabels = EMPTY_LABELS } = content
  const aiControl = typeof document !== 'undefined' && document.documentElement.dataset.aiControl === 'red'
  const regularAttachments = aiControl ? attachments.filter(attachment =>
    attachment.type !== 'file' || !isVoiceRecordingName(attachment.file.name)) : attachments
  const voice = regularAttachments.length < attachments.length
  const transcribing = voice && voiceSubmittedAt !== undefined
  const compactImages = regularAttachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const body = <>
    {text === '' ? voice && !transcribing ? t('file.voiceMessage') : null
      : renderFactorySlot('conversation.user.text', { text, facts, interactive, ellipsis })}
    {transcribing && <VoiceTranscriptionClock startTime={voiceSubmittedAt} t={t} />}
    {extraBlocks.map((block, index) => (
      <JsonBlock key={index} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />
    ))}
  </>
  const showBubble = voice || text !== '' || extraBlocks.length > 0
  return (
    <div className={css.userStack}>
      {regularAttachments.length > 0 && (
        <div className={css.attachmentRow} data-message-attachments>
          {regularAttachments.map((attachment, index) => attachment.type === 'image'
            ? (
              <Fragment key={`image:${index}`}>
                {renderSlot('conversation.chat.user.images', {
                  images: [attachment.image], loadImage, align: 'end', compact: compactImages,
                })}
              </Fragment>
            )
            : (
              <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                <span className={css.fileContent}>
                  <span className={css.fileName}>{attachment.file.name}</span>
                  <span className={css.fileMeta}>
                    {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                      .filter(Boolean).join(' ')}
                  </span>
                </span>
              </span>
            ))}
        </div>
      )}
      {showBubble && <UserMessageBubble className={voice ? css.voiceMessage : undefined}
        data-voice-message={voice || undefined} data-transcribing-voice={transcribing || undefined}
        data-message-bubble="" data-text-interaction-source="">
        {voice && <span className={css.voiceIcon} role={text ? 'img' : undefined}
          aria-label={text ? t('file.voiceMessage') : undefined} aria-hidden={!text || undefined}>
          <IconMicrophoneOutlineRegular size={18} aria-hidden />
        </span>}
        {voice ? <div className={css.voiceText}>{body}</div> : body}
      </UserMessageBubble>}
      {referenceLabels.length > 0 && (
        <div className={css.referenceSummary}>
          {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
        </div>
      )}
    </div>
  )
}

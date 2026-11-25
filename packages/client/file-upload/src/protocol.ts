/** Authenticated raw-byte route owned by the file-upload service. */
export const FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'

/**
 * Browser-relative form of {@link FILE_UPLOAD_PATH}; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */
export const FILE_UPLOAD_ROUTE = FILE_UPLOAD_PATH.slice(1)

/** Authenticated client timing report for completed composer voice uploads. */
export const VOICE_TIMING_PATH = '/api/session/voiceUploadTiming'
export const VOICE_TIMING_ROUTE = VOICE_TIMING_PATH.slice(1)
export const VOICE_TIMING_FILE = /^ai-center-voice-[0-9a-f-]{36}\.wav$/u

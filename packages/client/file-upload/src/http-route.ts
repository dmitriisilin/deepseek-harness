/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { VOICE_TIMING_FILE } from './protocol.ts'
import type { VoiceChunks } from './voice-chunks.ts'
import type { FileUploads } from './index.ts'
import type { FileUploadValue, ImageUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue | ImageUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Handle one authenticated raw-byte upload. A `mediaType` query parameter
 * stages the body as a prompt image; without it the body is stored verbatim.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation.
 */
export async function handleFileUploadHttp(service: FileUploads, request: Request, voiceChunks?: VoiceChunks): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const name = url.searchParams.get('name') ?? undefined
  const imageMediaType = url.searchParams.get('mediaType') ?? undefined
  const chunkCount = url.searchParams.get('voiceChunks')
  const streamed = chunkCount === null ? undefined : voiceChunks?.complete(
    name ?? '', Number(chunkCount), Number(url.searchParams.get('voiceBytes')),
  )
  if (chunkCount !== null && (streamed === undefined || imageMediaType !== undefined)) {
    return new Response(null, { status: 409 })
  }
  const upload = {
    sessionId: brandString<SessionId>(sessionId),
    data: streamed?.data ?? requestBodyChunks(request.body),
    signal: request.signal,
    ...(name === undefined ? {} : { name }),
  }
  let result: FileUploadHttpResult
  try {
    result = {
      ok: true,
      value: imageMediaType === undefined
        ? await service.uploadStream(upload)
        : await service.uploadImageStream({ ...upload, mediaType: imageMediaType }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  if (result.ok && streamed !== undefined) voiceChunks?.remove(streamed.id)
  return new Response(JSON.stringify({ ...result, ...(result.ok && name && VOICE_TIMING_FILE.test(name)
    && process.env.AI_CONTROL_VOICE_TIMING === '1' ? { voiceTimingEnabled: true } : {}) }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Log bounded client measurements without storing audio or transcript. */
export async function handleVoiceTiming(request: Request): Promise<Response> {
  const size = Number(request.headers.get('content-length'))
  if (!Number.isInteger(size) || size < 1 || size > 512) return new Response(null, { status: 400 })

  let data: unknown
  try { data = await request.json() } catch { return new Response(null, { status: 400 }) }
  if (typeof data !== 'object' || data === null) return new Response(null, { status: 400 })
  const recordingId = Reflect.get(data, 'recordingId')
  const preparationMs = Reflect.get(data, 'preparationMs')
  const uploadWaitMs = Reflect.get(data, 'uploadWaitMs')
  const uploadMs = Reflect.get(data, 'uploadMs')
  const streamed = Reflect.get(data, 'streamed') === true
  if (typeof recordingId !== 'string' || !VOICE_TIMING_FILE.test(recordingId)
    || ![preparationMs, uploadWaitMs, uploadMs].every(value => Number.isInteger(value) && value >= 0 && value <= 3600000)) {
    return new Response(null, { status: 400 })
  }
  console.info(JSON.stringify({ event: 'ai-control/voice-upload', recordingId, preparationMs, uploadWaitMs, uploadMs, streamed }))
  return new Response(null, { status: 204 })
}

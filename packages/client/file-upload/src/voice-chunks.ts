const maxRecordings = 16
const maxChunks = 256
const maxChunkBytes = 256 * 1024
const maxRecordingBytes = 4 * 1024 * 1024
const retentionMs = 5 * 60 * 1000
const recordingIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u

interface Recording {
  readonly chunks: Map<number, Uint8Array>
  readonly expiry: ReturnType<typeof setTimeout>
  bytes: number
}

/** Short-lived buffer for the authenticated composer upload route. */
export class VoiceChunks {
  private readonly recordings = new Map<string, Recording>()

  async append(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams
    const id = query.get('recordingId') ?? ''
    const index = Number(query.get('index') ?? NaN)
    const size = Number(request.headers.get('content-length'))
    if (!recordingIdPattern.test(id) || !Number.isInteger(index) || index < 0 || index >= maxChunks
      || !Number.isInteger(size) || size < 1 || size > maxChunkBytes || request.body === null) {
      return new Response(null, { status: 400 })
    }
    const reader = request.body.getReader()
    const bytes = new Uint8Array(size)
    let offset = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if (offset + part.value.length > bytes.length) {
          void reader.cancel().catch(() => undefined)
          return new Response(null, { status: 413 })
        }
        bytes.set(part.value, offset)
        offset += part.value.length
      }
    } finally {
      reader.releaseLock()
    }
    if (offset !== size) return new Response(null, { status: 400 })

    let recording = this.recordings.get(id)
    if (recording === undefined) {
      if (this.recordings.size >= maxRecordings) return new Response(null, { status: 429 })
      const expiry = setTimeout(() => this.remove(id), retentionMs)
      expiry.unref()
      recording = { chunks: new Map(), expiry, bytes: 0 }
      this.recordings.set(id, recording)
    }
    if (recording.chunks.has(index)) return new Response(null, { status: 409 })
    if (recording.bytes + size > maxRecordingBytes) return new Response(null, { status: 413 })
    recording.chunks.set(index, bytes)
    recording.bytes += size
    return new Response(null, { status: 204 })
  }

  complete(name: string, count: number, bytes: number): { id: string; data: AsyncIterable<Uint8Array> } | undefined {
    const id = /^ai-center-voice-([0-9a-f-]+)\.(?:webm|mp4)$/u.exec(name)?.[1]
    if (id === undefined || !Number.isInteger(count) || count < 1 || count > maxChunks) return
    const recording = this.recordings.get(id)
    if (recording?.chunks.size !== count || recording.bytes !== bytes) return
    const ordered: Uint8Array[] = []
    for (let index = 0; index < count; index++) {
      const chunk = recording.chunks.get(index)
      if (chunk === undefined) return
      ordered.push(chunk)
    }
    return { id, data: (async function* () { yield* ordered })() }
  }

  remove(id: string): void {
    clearTimeout(this.recordings.get(id)?.expiry)
    this.recordings.delete(id)
  }
}

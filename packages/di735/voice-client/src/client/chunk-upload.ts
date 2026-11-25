/** Upload byte ranges while MediaRecorder is still collecting the local fallback. */
export class VoiceChunkUpload {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private count = 0

  constructor(private readonly recordingId: string, private readonly signal: AbortSignal) {}

  append(chunk: Blob): void {
    if (this.controller.signal.aborted || this.signal.aborted) return
    if (this.pending.size >= 4 || this.count >= 256 || chunk.size > 256 * 1024) {
      this.cancel()
      return
    }
    const query = new URLSearchParams({ recordingId: this.recordingId, index: String(this.count++) })
    const request = fetch(new URL(`api/session/voiceChunk?${query}`, document.baseURI), {
      method: 'POST',
      body: chunk,
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.any([this.signal, this.controller.signal, AbortSignal.timeout(4000)]),
    }).then((response) => {
      if (response.status !== 204) this.cancel()
    }, () => { this.cancel() })
    this.pending.add(request)
    void request.then(() => this.pending.delete(request))
  }

  async finish(): Promise<number | undefined> {
    // A slow tunnel must not hold up the ordinary upload path.
    const timer = setTimeout(() => this.cancel(), 1200)
    try {
      await Promise.all(this.pending)
      return this.count > 0 && !this.controller.signal.aborted && !this.signal.aborted ? this.count : undefined
    } finally {
      clearTimeout(timer)
    }
  }

  cancel(): void {
    this.controller.abort()
  }
}

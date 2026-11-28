type MemoryEvent = { type?: string; data?: unknown }
type Block = { type?: string; text?: string }
type Message = { source?: { kind?: string }; content?: Block[] }
type EventData = Message & {
  turn?: number
  reason?: { kind?: string }
  message?: Message
}

/** Keep event offsets stable for adapters that persist a journal cursor. */
export function selectMemoryEvents<T extends MemoryEvent>(
  events: readonly T[], provider?: string, sessionId?: string,
): (T | MemoryEvent)[] {
  const keep = new Set<number>()
  let turnStart = 0
  let userMessages: number[] = []
  let lastAssistant: number | undefined
  let finalText: Block[] = []
  let intermediate = 0
  let reasoning = 0
  let toolEvents = 0

  for (const [index, event] of events.entries()) {
    const data = event.data as EventData | undefined
    if (event.type === 'turn/start') {
      turnStart = index
      userMessages = []
      lastAssistant = undefined
      finalText = []
      intermediate = 0
      reasoning = 0
      toolEvents = 0
    } else if (event.type === 'user/message' && data?.source?.kind === 'user'
      && data.content?.some(block => block.type === 'text' && block.text?.trim())) {
      userMessages.push(index)
    } else if (event.type === 'assistant/message') {
      if (finalText.length) intermediate++
      const blocks = data?.message?.content ?? []
      reasoning += blocks.filter(block => block.type === 'reasoning').length
      lastAssistant = index
      finalText = blocks.filter(block => block.type === 'text' && block.text?.trim())
      if (blocks.some(block => block.type === 'tool-call')) {
        if (finalText.length) intermediate++
        finalText = []
      }
    } else if (event.type === 'tool/call' || event.type === 'tool/result') {
      toolEvents++
    } else if (event.type === 'turn/end') {
      const accepted = data?.reason?.kind === 'completed' && userMessages.length > 0
        && lastAssistant !== undefined && finalText.length > 0
      if (accepted && lastAssistant !== undefined) {
        for (const offset of userMessages) keep.add(offset)
        keep.add(lastAssistant)
      }
      if (provider && index === events.length - 1) {
        const chars = (message: Message | undefined) => (message?.content ?? [])
          .filter(block => block.type === 'text').reduce((total, block) => total + (block.text?.length ?? 0), 0)
        console.info(JSON.stringify({
          event: 'ai-control/memory-capture', provider, sessionId, turn: data?.turn, outcome: data?.reason?.kind,
          selectedUser: accepted ? userMessages.length : 0,
          selectedAssistant: accepted ? 1 : 0,
          userChars: accepted ? userMessages.reduce((total, offset) => total + chars(events[offset]?.data as Message), 0) : 0,
          assistantChars: accepted ? finalText.reduce((total, block) => total + (block.text?.length ?? 0), 0) : 0,
          droppedIntermediateAssistant: intermediate, droppedReasoningBlocks: reasoning, droppedToolEvents: toolEvents,
          journalEvents: index - turnStart + 1,
        }))
      }
    }
  }
  return events.map((event, index) => keep.has(index) ? event : {})
}

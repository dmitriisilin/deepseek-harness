/**
 * Submit-barrier registry: plugin-owned work that must settle before the
 * composer freezes one draft. Gates are Session-scoped because each composer
 * owns its own draft and recording, while the service itself is app-scoped.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerSubmitGate, ComposerSubmitGates } from '../contract/input.ts'

/** App-scoped map of per-Session submit gates. */
export class SubmitGateRegistry implements ComposerSubmitGates {
  private readonly gates = new Map<SessionId, Set<ComposerSubmitGate>>()

  /**
   * @param sessionId - target Session identity.
   * @param gate - callback returning pending work, or undefined when nothing blocks.
   * @returns disposer removing the gate from that Session.
   */
  register(sessionId: SessionId, gate: ComposerSubmitGate): () => void {
    let registered = this.gates.get(sessionId)
    if (registered === undefined) {
      registered = new Set()
      this.gates.set(sessionId, registered)
    }
    const owner = registered
    owner.add(gate)
    return () => {
      owner.delete(gate)
      if (owner.size === 0 && this.gates.get(sessionId) === owner) this.gates.delete(sessionId)
    }
  }

  /**
   * Run every gate bound to one Session, in registration order.
   * @param sessionId - target Session identity.
   * @returns pending work joined into one promise, or undefined when no gate blocks.
   */
  run(sessionId: SessionId): Promise<unknown> | undefined {
    const registered = this.gates.get(sessionId)
    if (registered === undefined || registered.size === 0) return undefined
    const pending = [...registered].map(gate => gate()).filter(work => work !== undefined)
    return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined)
  }
}

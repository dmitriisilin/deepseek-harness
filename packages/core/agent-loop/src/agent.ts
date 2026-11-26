/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  ModelSelection,
  ModelSelectionProjectionState,
  InboxTarget,
  InboxState,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { AgentModel, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  ReasoningEffortId,
  createAssistantMessage,
  createDeveloperMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, ToolCallRecovery } from '@deepseek-ai/dsh-session'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { ToolActivationError, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { ReactLoopInbox } from './inbox.ts'
import { RuntimeContextProjection } from './runtime-context.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { SystemPromptProjection } from './runtime-context.ts'
import { SupervisorBudget, continuationReason } from './supervisor.ts'

/** Projected facts consumed by this driver; registration stays with the factory. */
interface LoopProjections {
  /** Current model selection, including pending changes. */
  readonly modelSelection: () => ModelSelectionProjectionState
  /** Current queued and claimed input. */
  readonly inbox: () => InboxState
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

interface TurnDiagnostics {
  started: number
  workerMs?: number
  continuation?: string
  supervisor?: {
    calls: Omit<SupervisorBudget['calls'][number], 'started'>[]
    extensions: number
    sourceOpeningReserved: boolean
    sourceProposalReserved: boolean
    sourceDocumentsRead: number
    successfulTools: number
    failedTools: number
    reason?: string | undefined
  }
  firstTextMs?: number
  finalAnswerFirstTextMs?: number
  effort?: string
  firstWorkerEffort?: string
  preparationMs?: number
  requests: number
  tools: number
  toolBatchMs: number
}

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
    selection: Readonly<ModelSelection>
    /** Admission shared by the step's declarations and dispatch; the turn disposes it after the step. */
    toolSet: ResolvedToolSet
  }

const continuationTool = {
  name: 'request_continuation',
  description: 'Request the next step when a useful answer requires sources, an action, or deeper reasoning.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: ['needs_sources', 'needs_action', 'needs_reasoning'] },
    },
    required: ['reason'],
    additionalProperties: false,
  },
}
const firstResponseHint = [
  'Answer briefly and directly when you have enough information.',
  'If a reliable answer requires information you do not have, use the appropriate tool, then answer from its results.',
  'Ask a focused question only when an important ambiguity prevents useful progress.',
].join(' ')

const quickPrompt = [
  'On this first pass, answer directly if you can give a useful answer immediately.',
  'If the user explicitly requests current sources, an action, or genuinely deeper reasoning,',
  'call request_continuation with the appropriate reason instead of giving a preliminary answer.',
  'Inspect the project when the facts are absent from the available context. Answer from deployment context when it suffices.',
  'For project files or configuration use needs_action. For public documentation use needs_sources.',
  'For product comparisons that vary by version, market, or year, use needs_sources when evidence is missing.',
  'Invoke the declared function through the tool interface. Never print tool syntax in your answer.',
].join(' ')

const neutralQuickPrompt = [
  'Give a concise direct answer when the information already available supports the main conclusion.',
  'Check every intermediate claim you include against its inputs. Leave out assertions that do not help answer the request.',
  'If the user asks you to use only supplied material, preserve its distinctions and conditions and keep the answer within that material.',
  'When the stated premises support different conclusions, explain the implications under each. Choose one only if there is evidence that resolves the conflict.',
  'Before answering, ask whether a missing or unverified assumption could materially change that conclusion.',
  'If you can resolve that gap using another operation, call request_continuation with the appropriate reason.',
  'If progress depends on something only the user can supply, ask one focused question or give a clearly conditional answer.',
  'Invoke the declared function through the tool interface. Never print tool syntax in your answer.',
].join(' ')

const evidenceResponsePrompt = [
  'Separate what the available evidence supports from assumptions and unresolved points.',
  'A successful lookup does not establish a claim unless its result supports that claim.',
  'If results are empty, conflicting, or inaccessible, state the remaining uncertainty and give useful conditional guidance.',
  'Attach the relevant source to each decisive external claim when a source is available.',
  'Keep claims within the scope of what you verified, including in the opening summary and recommendations.',
  'Preserve each source’s operating conditions and exceptions. An instruction valid under one condition does not establish that it is valid under a different condition.',
  'If the sources cover only part of the question, answer that part concretely and identify the minimum information needed to resolve the rest.',
].join(' ')

const claimEvidencePrompt = [
  'For each decisive claim, establish what the evidence actually says and the conditions under which it applies before composing the answer.',
  'Use an inspected passage for a definitive claim. Treat search summaries and unread links as leads.',
  'If a source describes one case and the user asks about a wider set, answer for the documented case and leave the rest open.',
  'If you cannot point to support for a recommendation, make it conditional or omit it. Keep the same scope in the opening and conclusion.',
].join(' ')

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * Read the cause `cancel()` passed when aborting a loop-owned signal, copying
 * only the fields `turn/end` records. The live reason stays the caller's
 * object, and Node's fetch assigns a `stack` onto it that `Session.append`
 * would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this loop owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly model: AgentModel
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Surface generation at attachment or the preceding built request. */
  private requestSurfaceGeneration: number
  private readonly runtimeContext: RuntimeContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  private readonly systemPrompt: SystemPromptProjection
  /** Identities fully frozen by this loop; weak references do not retain replaced history. */
  private readonly frozenMessages = new WeakSet<Message>()

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    projections: LoopProjections,
    lastTurn: number,
    private readonly lifetimeSignal: AbortSignal,
  ) {
    this.requestSurfaceGeneration = session.surface.contentGeneration
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.model = new AgentModel(projections.modelSelection, session, options)
    this.inbox = new ReactLoopInbox(projections.inbox, session, this.dispatch)
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.systemPrompt = new SystemPromptProjection(session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    try {
      if (!options.keepInbox) this.inbox.clear()
    } finally {
      // Queue persistence must not prevent cancellation of admitted work.
      if (this.phase.kind !== 'idle') {
        if (!options.keepInbox) this.phase.wakeRequested = false
        this.phase.abort.abort(cause)
      }
    }
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.lifetimeSignal.aborted) return
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(
    target: InboxTarget,
    position: { turn: number; step: number },
    supervisor?: SupervisorBudget,
  ): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const selection = this.model.current()
    if (selection === undefined) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`)
    }
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
    try {
      const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet })
      signal.throwIfAborted()
      const decision = await this.dispatch.waterfall(
        'agent/pre-step', { messages: claimed, ...position, signal, modelSelection: selection },
        (): Promise<PreStepDecision> => {
          const sections = renderContextSections(assembly)
          const context = this.runtimeContext.project(sections)
          return Promise.resolve<PreStepDecision>({
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
          })
        },
      )
      signal.throwIfAborted()
      if (decision.kind === 'reject') {
        toolSet.dispose()
        return decision
      }
      const final = supervisor?.final === true
      if (final || supervisor?.continuation === 'needs_sources') {
        const admitted = (name: string) => !final && (name === 'web_search' || name === 'web_fetch')
        const restricted: ResolvedToolSet = {
          dispose: () => toolSet.dispose(),
          view: scope => new Map([...toolSet.view(scope)].filter(([name]) => admitted(name))),
        }
        const tools = assembly.tools.filter(tool => admitted(tool.name))
        return {
          ...decision, assembly: { ...assembly, tools }, selection, toolSet: restricted,
          ...final ? { startsRequestSeries: true } : {},
        }
      }
      return { ...decision, assembly, selection, toolSet }
    } catch (error: unknown) {
      toolSet.dispose()
      throw error
    }
  }

  /** Whether the assembled tool schemas differ from the logged request header's. */
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    const baseline = this.session.requestHeader()
    if (baseline === undefined) return false
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    const diagnostics: TurnDiagnostics | undefined = typeof process !== 'undefined'
      && (process.env.AI_CONTROL_SUPERVISOR === '1' || process.env.AI_CONTROL_TURN_LOG === '1')
      ? { started: performance.now(), requests: 0, tools: 0, toolBatchMs: 0 }
      : undefined
    const supervisor = diagnostics && process.env.AI_CONTROL_SUPERVISOR === '1' ? new SupervisorBudget(signal) : undefined
    let target: InboxTarget = 'next-turn'
    let progress = ''
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        if (step > 1 && !turnEnds && supervisor && diagnostics && !supervisor.final) {
          await supervisor.allow({
            requests: diagnostics.requests + 1, steps: step, tools: diagnostics.tools,
          }, progress)
        }
        const decision = await this.preStep(target, { turn, step }, supervisor)
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        try {
          if (turnEnds && decision.messages.length === 0) break
          // A removed waking message or an enter decision rewritten to empty
          // still owns the initial turn boundary, but it spends no model call.
          if (phase.step === 0 && decision.messages.length === 0) {
            turnEnds = { kind: 'completed' }
            return false
          }
          signal.throwIfAborted()
          if (diagnostics && diagnostics.preparationMs === undefined) {
            diagnostics.preparationMs = Math.round(performance.now() - diagnostics.started)
          }
          this.session.append('step/start', { turn, step })
          phase.step = step
          const toolRecovery = new ToolCallRecovery()
          const stopRecovery = this.ctx.on('session/event', (session, event) => {
            if (session === this.session) toolRecovery.observe(event)
          })
          try {
            // max-tokens is sticky: once any step hits the ceiling, later steps
            // that complete normally must not downgrade the turn outcome.
            if (step === 1 && supervisor) {
              const previous = this.session.deriveMessages().findLast(
                (message): message is UserMessage => message.role === 'user' && 'source' in message && message.source.kind === 'user',
              )
              supervisor.start(decision.messages, previous)
            }
            const stepEnd = await this.step(decision, diagnostics, supervisor, (text) => { progress = text })
            // max-tokens stays sticky: a later completed step must not
            // downgrade the turn outcome.
            if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
          } catch (error: unknown) {
            try {
              for (const event of toolRecovery.results()) {
                this.session.append('tool/result', event.data, {
                  surfaceOp: 'append',
                  ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
                })
              }
            } catch (recoveryError: unknown) {
              throw new AggregateError([error, recoveryError], 'Step failed and its pending tool results could not be recorded', { cause: error })
            }
            throw error
          } finally {
            stopRecovery()
            this.session.append('step/end', { turn, step })
          }
        } finally {
          // Admission closes once the step's tool batch settles or no step opens.
          decision.toolSet.dispose()
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, a tool
      // activation failure keeps its code, and anything else flattens to
      // `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: error instanceof ToolActivationError ? error.code : 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      supervisor?.close()
      if (diagnostics) {
        if (supervisor) diagnostics.supervisor = {
          calls: supervisor.calls.map(({ started: _started, ...call }) => call),
          extensions: supervisor.extensions,
          sourceOpeningReserved: supervisor.sourceOpeningReserved,
          sourceProposalReserved: supervisor.sourceProposalReserved,
          sourceDocumentsRead: supervisor.sourceDocumentsRead,
          successfulTools: supervisor.successfulTools,
          failedTools: supervisor.failedTools,
          reason: supervisor.reason ?? turnEnds?.kind,
        }
        const { started, ...metrics } = diagnostics
        console.info(JSON.stringify({
          event: 'ai-control/turn', sessionId: this.session.id, turn, status: turnEnds?.kind,
          policyVersion: supervisor ? 7 : process.env.AI_CONTROL_FIRST_RESPONSE_HINT === '1' ? 8 : 2,
          ...supervisor ? { supervisorVariant: {
            firstEffort: process.env.AI_CONTROL_FIRST_EFFORT === 'selected' ? 'selected' : 'reduced',
            neutralGuidance: process.env.AI_CONTROL_FIRST_GUIDANCE === 'neutral',
            evidenceGate: process.env.AI_CONTROL_FIRST_EVIDENCE_GATE === '1',
            claimEvidence: process.env.AI_CONTROL_CLAIM_EVIDENCE === '1',
            finalReadsOnly: process.env.AI_CONTROL_FINAL_READS_ONLY === '1',
            sourceReadGuidance: process.env.AI_CONTROL_SOURCE_READ_GUIDANCE === '1',
            draftReview: process.env.AI_CONTROL_DRAFT_REVIEW === '1',
            progressReview: process.env.AI_CONTROL_PROGRESS_REVIEW === '1',
            auditCounterexample: process.env.AI_CONTROL_AUDIT_COUNTEREXAMPLE === '1',
            synthesisAudit: process.env.AI_CONTROL_SYNTHESIS_AUDIT === '1',
            suppliedAudit: process.env.AI_CONTROL_SUPPLIED_AUDIT === '1',
          } } : {},
          steps: phase.step, durationMs: Math.round(performance.now() - started), ...metrics,
        }))
      }
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(
    decision: Extract<PreparedStep, { kind: 'enter' }>,
    diagnostics: TurnDiagnostics | undefined,
    supervisor: SupervisorBudget | undefined,
    setProgress: (text: string) => void,
  ): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    const { assembly } = decision
    const final = supervisor?.final === true
    const quick = supervisor !== undefined && step === 1
      && ['deepseek-flash', 'claude-opus-5-5'].includes(decision.selection.model)
    const hintEnabled = !supervisor && process.env.AI_CONTROL_FIRST_RESPONSE_HINT === '1'
    const hintOnly = step === 1 && hintEnabled
    const evidencePolicy = supervisor !== undefined && process.env.AI_CONTROL_FIRST_EVIDENCE_GATE === '1'
    const evidenceGate = quick && evidencePolicy
    const draftReview = evidenceGate && process.env.AI_CONTROL_DRAFT_REVIEW === '1'
    const light = quick && process.env.AI_CONTROL_FIRST_EFFORT !== 'selected'
    const deploymentContext = supervisor ? process.env.AI_CONTROL_DEPLOYMENT_CONTEXT?.trim().slice(0, 2000) : undefined
    const renderedPrompt = [
      renderPrompt(assembly),
      deploymentContext && `AI Control deployment context. Use only for questions about this deployment: ${deploymentContext}`,
      quick && (process.env.AI_CONTROL_FIRST_GUIDANCE === 'neutral' ? neutralQuickPrompt : quickPrompt),
      hintOnly && firstResponseHint,
      !final && supervisor?.continuation === 'needs_sources' && supervisor.hasUnopenedSourceLeads
        && process.env.AI_CONTROL_SOURCE_READ_GUIDANCE === '1'
        && 'Search found leads, but no source document has been read. If a lead could resolve a material claim, open it now. Only search again if the existing leads cannot resolve that claim.',
      evidencePolicy && supervisor.continuation === 'needs_sources'
        && (process.env.AI_CONTROL_CLAIM_EVIDENCE === '1' ? claimEvidencePrompt : evidenceResponsePrompt),
    ].filter(Boolean).join('\n\n')
    const tools = quick ? [continuationTool] : assembly.tools
    let firstAttempt = true
    let provisionalSynthesis: ReturnType<typeof createAssistantMessage> | undefined
    const auditSynthesis = evidencePolicy && supervisor.canAuditSynthesis({
      requests: (diagnostics?.requests ?? 0) + 2, steps: step, tools: diagnostics?.tools ?? 0,
    })
    const warnUnrevised = (message: ReturnType<typeof createAssistantMessage>) => createAssistantMessage({
      source: { provider: message.source.provider, model: message.source.model },
      content: [{ type: 'text', text: 'The source check flagged this answer, and the attempted correction did not complete.' }, ...message.content],
    })
    while (true) {
      const { config, preparedCall } = await this.prepareRequest(turn, step, decision.selection, signal, light && !provisionalSynthesis)
      const currentContext = this.loopCtx.systemPrompt.refreshContext(assembly, {
        ...assembleContextFor(this, signal), modelSelection: decision.selection,
      })
      const sections = renderContextSections(currentContext)
      const context = this.runtimeContext.project(sections)
      signal.throwIfAborted()
      const startsRequestSeries = firstAttempt
        && (quick || hintOnly || (step === 2 && (hintEnabled || supervisor !== undefined)) || decision.startsRequestSeries === true)
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === 'in-history',
        startsSeries: startsRequestSeries
          || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
          || (preparedCall?.toolUpdate === undefined && this.toolsChanged(tools)),
      })
      for (const { message, intent } of commits) {
        this.session.append('system/message', { turn, step, message }, intent)
      }
      let contextAdmitted = false
      if (firstAttempt) {
        for (const message of decision.messages) {
          if (message.source.kind === 'runtime-context') {
            if (context !== undefined && !contextAdmitted) {
              this.session.append('user/message', context, { surfaceOp: 'append' })
              contextAdmitted = true
            }
          } else {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
        }
      }
      if (firstAttempt && final) {
        let advice = 'Give the useful answer first, then brief supporting evidence. State what is missing or unverified.'
        if (supervisor?.reason === 'supplied_only') {
          advice = 'Use only the material supplied by the user. Identify limits or ambiguities within it without adding external facts.'
        } else if (supervisor?.reason === 'clarify' || supervisor?.reason === 'ambiguous_input') {
          advice = 'Lead with the decisive missing detail and ask one concise question about it.'
            + ' State any useful partial conclusion with its conditions. Leave the main conclusion open when it depends on the missing detail.'
        } else if (evidencePolicy && supervisor?.continuation === 'needs_sources') {
          advice = 'Lead with the best supported conclusion and the scope that makes it true. Cite the evidence for decisive claims.'
            + ' If sources disagree or do not cover the requested case, distinguish the documented cases and state what remains unresolved.'
        }
        const noSourceText = supervisor?.continuation === 'needs_sources' && supervisor.sourceDocumentsRead === 0
          && process.env.AI_CONTROL_FINAL_READS_ONLY === '1'
        const instruction = [
          'This is the final response. No tools are available. Never print commands as tool calls or invent inspection results.',
          advice,
          noSourceText
            ? 'No source document was successfully read in this turn. Identify any external conclusion that remains unverified.'
            : '',
        ].filter(Boolean).join(' ')
        this.session.append('user/message', createUserMessage({
          source: { kind: 'runtime-context', form: 'instructions' }, content: [{ type: 'text', text: instruction }],
        }), { surfaceOp: 'append' })
      }
      if (context !== undefined && !contextAdmitted) {
        this.session.append('user/message', context, { surfaceOp: 'append' })
      }
      firstAttempt = false
      const request = this.buildRequest(
        config, preparedCall, provisionalSynthesis ? [] : tools, { turn, step },
        startsRequestSeries || provisionalSynthesis !== undefined, signal,
        light ? decision.selection.reasoningEffort ?? null : undefined,
        (final || provisionalSynthesis !== undefined) && supervisor?.continuation === 'needs_sources'
          && process.env.AI_CONTROL_FINAL_READS_ONLY === '1',
      )
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      let started = false
      const controlBlocks = new Set<number>()
      let sourceCheck: boolean | undefined
      let clarify = false
      let auditDraft = draftReview
      let auditSupplied = false
      let attemptFirstVisibleTextMs: number | undefined
      const workerStarted = performance.now()
      try {
        if (diagnostics) {
          diagnostics.requests += 1
          diagnostics.effort = request.reasoningEffort ?? 'adapter-default'
          diagnostics.firstWorkerEffort ??= diagnostics.effort
        }
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          if (quick && chunk.type === 'block-start' && chunk.blockType === 'tool-call') controlBlocks.add(chunk.index)
          const text = chunk.type === 'text-delta' ? chunk.text
            : chunk.type === 'block-end' && chunk.block.type === 'text' ? chunk.block.text : undefined
          if (evidenceGate && sourceCheck === undefined && text?.trim()) {
            const checks = await supervisor.firstAnswerChecks(draftReview)
            sourceCheck = checks.sources
            clarify = checks.clarify
            auditDraft = checks.audit
            auditSupplied = await supervisor.shouldAuditSuppliedAnswer()
          }
          const visible = !clarify && sourceCheck !== true && !((auditDraft || auditSynthesis || auditSupplied) && text !== undefined)
            && !('index' in chunk && controlBlocks.has(chunk.index))
          live.push(chunk, visible)
          if (visible && diagnostics && attemptFirstVisibleTextMs === undefined && text?.trim()) {
            attemptFirstVisibleTextMs = Math.round(performance.now() - diagnostics.started)
            diagnostics.firstTextMs ??= attemptFirstVisibleTextMs
          }
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (!started) throw error
        try {
          if (signal.aborted) {
            const content = clarify || sourceCheck || auditDraft || auditSynthesis || auditSupplied ? [] : live.interruptedBlocks()
            if (content.length > 0) {
              live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        throw error
      } finally {
        if (diagnostics) diagnostics.workerMs = (diagnostics.workerMs ?? 0) + Math.round(performance.now() - workerStarted)
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' && provisionalSynthesis) {
          signal.throwIfAborted()
          if (diagnostics && diagnostics.firstTextMs === undefined) {
            diagnostics.firstTextMs = Math.round(performance.now() - diagnostics.started)
          }
          const fallback = warnUnrevised(provisionalSynthesis)
          live.settle('assistant/message', () => this.session.append('assistant/message', {
            turn, step, message: fallback, stream: live.stream,
          }, { surfaceOp: 'append' }).seq)
          return { kind: 'completed' }
        }
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            throw LlmError.fromFailure(finish.failure)
          }
          if (final) throw LlmError.fromFailure(finish.failure)
          if (supervisor && diagnostics && !await supervisor.allow({
            requests: diagnostics.requests + 1, steps: step, tools: diagnostics.tools,
          }, 'The last model request failed before producing a usable response.')) return null
          continue
        }

        let message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        if (quick && !provisionalSynthesis && message.content.some(block => block.type === 'tool-call')) {
          live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq)
          const call = message.content.find(block => block.type === 'tool-call' && block.name === continuationTool.name)
          const requested = call?.type === 'tool-call' ? continuationReason(call.arguments) : undefined
          const reason = requested ?? (evidenceGate ? await supervisor.recoverContinuation() : undefined)
          setProgress(reason ? `Worker requested continuation: ${reason}` : 'Invalid continuation request')
          if (diagnostics) diagnostics.continuation = reason ?? 'invalid'
          if (reason === undefined) supervisor.finish('invalid_continuation')
          else if (diagnostics) await supervisor.allow({
            requests: diagnostics.requests + 1, steps: step + 1, tools: diagnostics.tools,
          }, `Worker requested continuation: ${reason}`, reason)
          return null
        }
        if (clarify && supervisor) {
          live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq)
          supervisor.finish('ambiguous_input')
          return null
        }
        const draft = auditDraft ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ') : ''
        if (supervisor && diagnostics && (sourceCheck || (draft.trim() && await supervisor.draftNeedsSources(draft)))) {
          live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq)
          diagnostics.continuation = 'needs_sources'
          const progress = 'Independent assessment found a material evidence gap in the first draft.'
          setProgress(progress)
          await supervisor.allow({ requests: diagnostics.requests + 1, steps: step + 1, tools: diagnostics.tools },
            progress, 'needs_sources')
          return null
        }
        const synthesis = (auditSynthesis || auditSupplied) && !provisionalSynthesis && !message.content.some(block => block.type === 'tool-call')
          ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').trim()
          : ''
        const revisionAdvice = synthesis && finish.kind !== 'max-tokens'
          ? await supervisor?.synthesisRevisionAdvice(synthesis, auditSupplied)
          : undefined
        if (revisionAdvice) {
          live.settle('assistant/attempt', () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq)
          provisionalSynthesis = message
          if (!final) supervisor?.finish('synthesis_revision')
          this.session.append('user/message', createUserMessage({
            source: { kind: 'runtime-context', form: 'instructions' },
            content: [{ type: 'text', text: [
              auditSupplied
                ? 'For this revision only, reconsider the answer using only the material supplied by the user.'
                : 'For this revision only, reconsider the final answer using the actual document excerpts.',
              'A provisional synthesis was flagged. Treat the following note as an unverified observation to check against the sources:',
              JSON.stringify(revisionAdvice),
              'Give a concise corrected answer. Keep the supported parts and remove recommendations that require unverified conditions.',
              'When the evidence cannot settle the user’s question, state exactly which fact is missing. Do not reverse an unsupported claim into an equally unsupported denial.',
              'Keep the same conditions in the opening, details, and final recommendation.',
            ].join(' ') }],
          }), { surfaceOp: 'append' })
          continue
        }
        if (provisionalSynthesis && !message.content.some(block => block.type === 'text' && block.text.trim())) {
          message = warnUnrevised(provisionalSynthesis)
        }
        if ((draft.trim() || synthesis || provisionalSynthesis) && diagnostics && diagnostics.firstTextMs === undefined) {
          diagnostics.firstTextMs = Math.round(performance.now() - diagnostics.started)
        }
        live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) {
          if (diagnostics && message.content.some(block => block.type === 'text' && block.text.trim())) {
            diagnostics.finalAnswerFirstTextMs = attemptFirstVisibleTextMs ?? Math.round(performance.now() - diagnostics.started)
          }
          return { kind: 'completed' }
        }
        const progress = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').slice(-1200)
        setProgress(`${progress} Tools requested: ${toolCalls.map(block => block.name).join(', ')}`)
        if (supervisor && diagnostics && (final || provisionalSynthesis || !await supervisor.allow({
          requests: diagnostics.requests + 1, steps: step + 1, tools: diagnostics.tools + toolCalls.length,
        }, progress, undefined, toolCalls))) {
          for (const block of toolCalls) {
            const seq = this.session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments }).seq
            this.session.append('tool/result', {
              turn, step,
              message: createToolResultMessage({
                callId: block.id, isError: true, content: [{ type: 'text', text: 'Turn budget does not permit this tool call.' }],
              }),
            }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
          }
          return final || provisionalSynthesis ? { kind: 'completed' } : null
        }
        const toolsStarted = performance.now()
        if (diagnostics) diagnostics.tools += toolCalls.length
        const maxParallelToolCalls = this.loopCtx.agentLoop.config.maxParallelToolCalls.get()
        try {
          const result = await this.loopCtx.tools.execute({
            calls: toolCalls, signal, agent: this, log: { turn, step },
            maxParallelToolCalls, toolSet: decision.toolSet,
          })
          for (const context of result.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          if (supervisor) {
            const failed = result.results.filter(item => item.result.isError).length
            supervisor.noteTools(result.results.length - failed, failed)
            const searchIds = new Set(toolCalls.filter(call => call.name === 'web_search').map(call => call.id))
            const discoveredUrls = result.results.flatMap(({ callId, result: outcome }) => {
              if (outcome.isError || !searchIds.has(callId)) return []
              const meta = outcome.meta as { sources?: { url?: unknown }[] } | undefined
              if (!Array.isArray(meta?.sources)) return []
              return meta.sources.flatMap(source => typeof source?.url === 'string' ? [source.url] : [])
            })
            supervisor.noteDiscoveredSourceUrls(discoveredUrls)
            if (supervisor.continuation === 'needs_sources') {
              const fetchIds = new Set(toolCalls.filter(call => call.name === 'web_fetch').map(call => call.id))
              for (const { callId, result: outcome } of result.results) {
                if (outcome.isError || !fetchIds.has(callId)) continue
                const meta = outcome.meta as { url?: unknown; statusCode?: unknown } | undefined
                if (typeof meta?.url !== 'string' || typeof meta.statusCode !== 'number' || meta.statusCode < 200 || meta.statusCode >= 300) continue
                supervisor.notePublicSourceExcerpt(meta.url, outcome.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
              }
            }
            supervisor.noteSuccessfulOperations(toolCalls, new Set(result.results.flatMap(item =>
              item.result.isError ? [] : [item.callId],
            )), discoveredUrls.length > 0)
            setProgress(`${progress} Tool outcomes: ${result.results.length - failed} succeeded, ${failed} failed.`)
          }
          return result.concluded ? { kind: 'completed' } : null
        } catch (error: unknown) {
          if (!(error instanceof ToolBatchExecutionError)) throw error
          for (const context of error.partial.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          throw error.cause
        } finally {
          if (diagnostics) diagnostics.toolBatchMs += Math.round(performance.now() - toolsStarted)
        }
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /** Resolve request config for the step's selection and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    selection: Readonly<ModelSelection>,
    signal: AbortSignal,
    light = false,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance seeds output controls from its options until it logs its
    // own header; later steps re-resolve marked defaults.
    const maxTokens = this.options.maxTokens
    const persisted: Partial<LlmCallConfig> = this.requestHeaderLogged
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
      ? requestProposal(session.requestHeader()!)
      : maxTokens === undefined ? {} : { maxTokens }
    const { provider: _provider, model: _model, reasoningEffort: _effort, ...controls } = persisted
    const seedConfig = deepFreeze(structuredClone({ ...controls, ...selection }))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model) {
      throw new Error(`agent "${this.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`)
    }
    if (proposedConfig.reasoningEffort !== selection.reasoningEffort) {
      throw new Error(`agent "${this.id}": agent/request proposed reasoning effort "${proposedConfig.reasoningEffort ?? 'adapter default'}" after step preparation fixed "${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      let effective = proposedConfig
      if (light) {
        const info = await this.loopCtx.llm.resolveModelInfo(selection.provider, selection.model, signal)
        const effort = ['off', 'low'].find(value => info.reasoning?.efforts.some(item => item.id === value))
        if (effort !== undefined) effective = { ...proposedConfig, reasoningEffort: ReasoningEffortId(effort) }
      }
      preparedCall = await this.loopCtx.llm.prepareCall(effective, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Log the resolved envelope and derive a frozen request from the admitted surface. */
  private buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    position: { turn: number; step: number },
    startsRequestSeries: boolean,
    signal: AbortSignal,
    selectedReasoningEffort?: LlmCallConfig['reasoningEffort'] | null,
    omitSearchLeads = false,
  ): GenerateOptions {
    const { session } = this
    const surfaceGeneration = session.surface.contentGeneration
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    const choice = selectedReasoningEffort === undefined ? {} : { selectedReasoningEffort }
    let headerSeq: SessionSeq | undefined
    if (!this.requestHeaderLogged) {
      // Compaction during the first resumed pre-step must still mark a new series.
      headerSeq = this.session.append('request/header', {
        header,
        ...choice,
        reason: baseline === undefined ? 'initial' : 'resume',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      headerSeq = this.session.append('request/header', {
        header,
        ...choice,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
    } else if (startsSeries) {
      this.session.append('request/header', { header, ...choice, reason: 'series' })
    }
    if (baseline !== undefined && headerSeq !== undefined) {
      const previousNames = new Set(baseline.tools?.map(tool => tool.name))
      const currentNames = new Set(tools.map(tool => tool.name))
      const additions = tools.filter(tool => !previousNames.has(tool.name))
        .map(tool => ({ type: 'tool-addition' as const, toolName: tool.name }))
      const removals = (baseline.tools ?? []).filter(tool => !currentNames.has(tool.name))
        .map(tool => ({ type: 'tool-removal' as const, toolName: tool.name }))
      if (additions.length > 0 || removals.length > 0) {
        session.append('developer/message', {
          ...position,
          message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
          ...additions.length > 0 ? { headerSeq } : {},
        }, { surfaceOp: 'append' })
      }
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    deepFreeze(header)
    const history = session.deriveMessages()
    const currentTurnStart = history.findLastIndex(message => message.role === 'user' && message.source.kind === 'user')
    const searchCalls = omitSearchLeads && currentTurnStart >= 0
      ? new Set(history.slice(currentTurnStart + 1).flatMap(message => message.role === 'assistant'
        ? message.content.flatMap(block => block.type === 'tool-call' && block.name === 'web_search' ? [block.id] : [])
        : []))
      : undefined
    const boundaryMessages = searchCalls ? history.map((message, index) => index > currentTurnStart && message.role === 'tool' && searchCalls.has(message.toolCallId)
      ? createToolResultMessage({
        callId: message.toolCallId,
        isError: message.isError === true,
        content: [{ type: 'text', text: 'Search discovery only. Use the documents read separately as evidence for conclusions.' }],
      })
      : message) : history
    for (const message of boundaryMessages) {
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    Object.freeze(boundaryMessages)
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      toolHistory: session.toolHistory(),
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return request
  }
}

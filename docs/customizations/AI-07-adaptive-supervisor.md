# AI-07. Adaptive Supervisor

The staging experiment is enabled by setting `AI_CONTROL_SUPERVISOR=1` in the service environment. Remove the variable and restart the service to restore the original routing. The experiment runs only on the official DeepSeek Flash route.

After the pre-step hooks admit the input (including speech recognition and clarification), a separate Flash request classifies the turn. It receives up to 3,000 characters of current text and 900 characters of the previous user turn. Attachment bytes, tool schemas and tool output are excluded. The request has a 2.5 second deadline and no tools. Invalid or unavailable classification falls back to the existing loop. Logs record the route, reason code and duration without conversation text.

Direct and deep routes suppress tool exposure and execution admission for the Worker step. Direct uses Flash with thinking disabled for that step. Deep preserves the selected effort. Standard runs the existing loop and its permissions. The same Session and streaming path handle all routes.

## Baselines

1. Ambiguous voice question about Flash and Pro. 355 s total, about 21 s preparation, 35 model steps, 49 calls including 47 Bash. Use the clarified text to compare route decisions and keep the original ambiguity as a separate voice regression.
2. Two voice turns in one chat on official Flash. Keep the second turn in the same chat so that its referent is preserved.

| Turn | Original input | Server time | Before first step | Steps | Tool calls |
|---|---|---:|---:|---:|---:|
| 1 | «Можно ли в России оформить страховку на машину с помятыми дверками?» | 43.6 s | 18.6 s | 2 | 1 |
| 2 | «Можно ли ее поставить на учет в таком состоянии? Можно ли поставить на учет?» | 35.2 s | 11.4 s | 2 | 1 |

Both tool calls were `web_search` (one call per turn). Total for the two turns is 78.9 s, excluding the interval between them. The first visible text timestamps are unavailable. Compare identical WAVs in order for a voice replay. The isolated text replay below covers only the first question.

The experiment covers initial routing. Automatic capability promotion, catalog lookup, renewable budgets and asynchronous review remain separate implementation stages.

## Flash staging replay

Two isolated Chrome profiles submitted the insurance question as text on 24 November 2026. One run per configuration, using the same Flash route. Server time is measured from `turn/start` to `turn/end`.

| Configuration | Server time | Worker steps | Tool calls |
|---|---:|---:|---:|
| Existing loop | 58.0 s | 4 | 5 |
| Initial Supervisor | 6.3 s | 1 | 0 |

The Supervisor call took 1.1 s. The first visible text mentioning ОСАГО appeared about 3.2 s after submit. The baseline browser probe missed the matching text, so only server time is compared. This sample excludes transcription and does not estimate typical or tail latency.


## Staging diagnostics

The supervisor flag enables the journal. Use `AI_CONTROL_TURN_LOG=1` on an experiment profile to collect the same turn timings with the supervisor disabled.

- `ai-control/turn` is emitted at the end of a turn. It carries the session ID and turn number, policy version, status, route and reason when classified, supervisor duration, preparation time, effective request effort, step count, model request attempts, requested tool count and elapsed tool batch time. Preparation includes recognition and classification where applicable. Tool batch time is elapsed wall time, including waiting within the batch.
- `firstTextMs` measures from server turn start to the first nonempty streamed text delta. It does not measure rendering in Chrome. An interrupted turn or a turn with no text may omit it.
- `ai-control/stt` is emitted once per completed voice processing attempt and can be joined by session ID and turn number. It shows recognition wall time, reported inference time when available, time spent in postprocessing including any clarification, and the outcome.
- The classifier chooses a fixed reason code. Its reason is a model prediction. Provider errors, deadlines and invalid output have separate deterministic codes and use the standard route.

These records omit transcript text, file names, prompts, tool arguments and provider error bodies.


## Review before rebase

The loop integration lives in `packages/core/agent-loop`. Compare upstream support for per-turn tool admission, temporary effort and correlated diagnostics. Replace the fork code when upstream can classify admitted text after voice clarification, retain the selected provider, suppress tool admission on direct turns and preserve the normal loop on fallback. Check both voice baselines and the text replay with the new implementation.

The follow-on design adds explicit capability requests, renewable per-turn budgets, evidence checks and checkpoint reviews. A budget limits work until the next review. It does not grant permissions. The current release classifies the initial turn and records measurements.

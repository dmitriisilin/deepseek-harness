# AI-07. Adaptive Supervisor

Set `AI_CONTROL_SUPERVISOR=1` on the AI Control service and supply `DEEP_SEEK_Supervisor` through its environment. The controller uses official DeepSeek Flash with reasoning disabled. It applies to both Flash and Opus Worker turns. Set `AI_CONTROL_TURN_LOG=1` independently to measure the original loop.

## Baselines

1. Ambiguous voice question about Flash and Pro. 355 s total, about 21 s preparation, 35 model steps, 49 calls including 47 Bash. Use the clarified text to compare route decisions and keep the original ambiguity as a separate voice regression.
2. Two voice turns in one chat on official Flash. Keep the second turn in the same chat so that its referent is preserved.

| Turn | Original input | Server time | Before first step | Steps | Tool calls |
|---|---|---:|---:|---:|---:|
| 1 | «Можно ли в России оформить страховку на машину с помятыми дверками?» | 43.6 s | 18.6 s | 2 | 1 |
| 2 | «Можно ли ее поставить на учет в таком состоянии? Можно ли поставить на учет?» | 35.2 s | 11.4 s | 2 | 1 |

Both tool calls were `web_search` (one call per turn). Total for the two turns is 78.9 s, excluding the interval between them. The first visible text timestamps are unavailable. Compare identical WAVs in order for a voice replay. The isolated text replay below covers only the first question.

The original voice baselines predate adaptive budgets.

## Flash staging replay

Two isolated Chrome profiles submitted the insurance question as text on 24 November 2026. One run per configuration, using the same Flash route. Server time is measured from `turn/start` to `turn/end`.

| Configuration | Server time | Worker steps | Tool calls |
|---|---:|---:|---:|
| Existing loop | 58.0 s | 4 | 5 |
| Initial Supervisor | 6.3 s | 1 | 0 |

The Supervisor call took 1.1 s. The first visible text mentioning ОСАГО appeared about 3.2 s after submit. The baseline browser probe missed the matching text, so only server time is compared. This sample excludes transcription and does not estimate typical or tail latency.


## Staging diagnostics

The supervisor flag enables the journal. Use `AI_CONTROL_TURN_LOG=1` on an experiment profile to collect the same turn timings with the supervisor disabled.

- `ai-control/turn` is emitted at the end of a turn. It carries the session ID and turn number, policy version, status, individual Supervisor call timings, decisions and token usage, preparation time, effective request effort, step count, model request attempts, requested tool count and elapsed tool batch time. Preparation includes recognition. Classification starts after preparation. Tool batch time is elapsed wall time, including waiting within the batch.
- `firstTextMs` measures from server turn start to the first nonempty streamed text delta. It does not measure rendering in Chrome. An interrupted turn or a turn with no text may omit it.
- `ai-control/stt` is emitted once per completed voice processing attempt and can be joined by session ID and turn number. It shows recognition wall time, reported inference time when available, time spent in postprocessing including any clarification, and the outcome.
- The classifier chooses a fixed reason code. Its reason is a model prediction. Provider errors, deadlines and invalid output have separate deterministic codes and use the standard route.

These records omit transcript text, file names, prompts, tool arguments and provider error bodies.


## Review before rebase

The loop integration lives in `packages/core/agent-loop`. Compare upstream support for per-turn tool admission, temporary effort and correlated diagnostics. Replace the fork code when upstream can classify admitted text after voice clarification, retain the selected provider, suppress tool admission on direct turns and preserve the normal loop on fallback. Check both voice baselines and the text replay with the new implementation.

Recheck the admission points for retries, tool batches and subsequent requests when rebasing. Keep the service credential and the selected Worker model independent.

## Контракт параллельного цикла

После принятия пользовательского ввода, включая расшифровку, первый запрос выбранной модели и классификация Supervisor запускаются независимо. Первый запрос видит только служебное продолжение. Фактические вызовы инструментов ждут допуска по бюджету и проходят штатные разрешения. Готовый ответ без инструментов завершает ход сразу, отменяя незавершённую классификацию.

Supervisor использует отдельный ключ `DEEP_SEEK_Supervisor`. Выбранная модель Worker сохраняется. Решение Supervisor действует на следующие действия цикла, поскольку уже отправленный запрос изменить нельзя.

Бюджет учитывает фактические попытки Worker, открытые шаги и число запрошенных инструментов в партии. Время пишется в журнал для сравнения. При достижении мягкой границы выполняется ограниченная переоценка. Supervisor получает исходную задачу, краткий видимый прогресс и счётчики. Продление даёт ограниченную порцию работы в пределах жёсткого лимита. При отказе Supervisor, недостатке данных или исчерпании лимита цикл резервирует один запрос без инструментов для ответа по имеющимся данным или уточнения. Отмена хода прерывает Worker и Supervisor.

Обычный бюджет допускает до 3 запросов, 3 шагов и 4 инструментов. Запасной бюджет допускает до 2 запросов, 2 шагов и 2 инструментов. Жёсткий предел исследовательской части — 8 запросов, 7 шагов и 12 инструментов. Возможны два ограниченных продления. Уже отправленный запрос выполняется со штатными ограничениями модели. Таймаут каждого обращения к Supervisor — 2,5 секунды.

## Parallel Supervisor replay

Text replay in isolated Chrome profiles with the red service configuration. Each row is a single observation. The two vehicle questions share a chat. Times are server-side seconds from turn start. The previous Flash policy provides the baseline for three questions.

| Worker | Question | First text before → after | Total before → after | Steps before → after | Tools before → after |
|---|---|---:|---:|---:|---:|
| Flash | 15 × 7 | — → 2.486 | — → 2.930 | — → 1 | — → 0 |
| Flash | Flash vs Pro | 31.605 → 25.363 | 34.990 → 29.963 | 5 → 4 | 7 → 4 |
| Flash | Insurance with dented doors | 2.938 → 17.152 | 6.284 → 21.563 | 1 → 2 | 0 → 0 |
| Flash | Registration follow-up | 2.277 → 14.159 | 5.944 → 18.039 | 1 → 1 | 0 → 0 |
| Opus | 15 × 7 | — → 2.583 | — → 2.718 | — → 1 | — → 0 |
| Opus | Flash vs Pro | — → 11.710 | — → 13.198 | — → 2 | — → 0 |
| Opus | Insurance with dented doors | — → 7.002 | — → 13.816 | — → 1 | — → 0 |
| Opus | Registration follow-up | — → 9.170 | — → 15.650 | — → 1 | — → 0 |

Both Workers returned 105, distinguished compulsory and voluntary insurance, and carried the vehicle context into the registration follow-up. Flash gave a comparison with claims based on its available evidence. Opus explicitly noted that it had not verified the model comparison from current sources. The replay checked relevance and continuity. It did not independently fact-check the provider or legal claims.

The Flash model comparison hit a checkpoint. The review response failed validation, and the reserved synthesis request completed. Tests separately exercise valid bounded extensions. Flash retained the selected high reasoning effort in the initial request. The old policy disabled reasoning for direct turns and paid the classifier latency upfront. The timing regressions show that a parallel start alone does not recover the old direct-route latency.

The Supervisor completed in 1.0–1.8 s per observed call. Usage is available per call under `supervisor.calls`; it is logged separately from the Worker. Each insurance turn was sent as text, so this table excludes speech recognition.

## Short first request

Flash and Opus start at the lowest advertised effort (off, then low) without a Supervisor request deadline. The first request exposes one service-only function, `request_continuation`, with a reason for sources, an action, or deeper reasoning. The harness consumes this signal before execution and logs the reason without presenting a tool row or including the call in future model messages. An admitted continuation restores the selected effort and the normal declaration and permission checks. A denied continuation uses the reserved answer or clarification request. The Supervisor still starts in parallel, using its dedicated credential.

A first Chrome replay with this policy used the same two vehicle questions. On Flash, first text / total was 1.53 / 5.17 s for insurance and 1.34 / 5.09 s for registration. On Opus it was 3.09 / 8.60 s and 3.22 / 8.86 s. All four turns used one Worker request and zero tools. The explicit request for official DeepSeek API documentation continued to real tools on both models. Flash ran two tools in 16.34 s total; Opus ran one in 16.68 s. These are single runs. A regression test separately verifies that the continuation restores the selected effort.

A quick chat can have an empty working directory. Set `AI_CONTROL_DEPLOYMENT_CONTEXT` in the service environment to provide a short inventory of enabled integrations for questions about its own deployment. Use only non-secret facts intended for the chat model. The inventory is supplied with the system prompt and is not a billing balance or plan lookup. Questions about a specific project's actual setup are classified as requiring inspection when the deployment context is insufficient.

## Admission after the Palisade incident

The first Worker and classifier start concurrently. Classification estimates the initial grant. A valid continuation requests a capability. DIRECT and DEEP are classification labels and cannot veto a valid capability request. UNCLEAR still opens a clarification response. Actual dispatch continues to require a declared tool, a budget grant, and the existing permission policy.

The work budget is checked between operations. Policy 7 measures elapsed time for diagnostics only. User cancellation remains a distinct outcome.

The Palisade baseline on the green Dima instance took 22.459 s, with two Worker requests and zero executed tools. The first Worker requested `needs_sources`. The classifier returned DEEP, the second Worker ran without tools, and the reserved 20-second deadline produced `UNKNOWN`. The regression fixture reproduces the admission failure independently of model sampling.

Source continuation opens only `web_search` and `web_fetch` from the normal scoped tool set. Its initial grant is still bounded and can be reviewed. A hard boundary is rechecked after waiting for classification or review. The review receives counts of successful and failed tool outcomes as well as the available progress summary. Decisions from the dedicated model are requested as JSON and validated against the allowed decision vocabulary.

Policy 5 reserved a 35-second deadline for final synthesis. Policy 6 removes that deadline, the 12-second initial Worker deadline and the Supervisor output cap. Final synthesis uses the selected effort. The provider and explicit user cancellation still control their own failure or cancellation.

## Palisade regression replay

Same recorded question on Flash, replayed as text in three fresh Chrome sessions in an isolated red profile. Timings are seconds from the server turn start. The baseline voice turn took 0.101 s to prepare, so the comparison is primarily about the agent loop. “First text” includes preliminary visible text when present.

| Scenario | Policy | First text | Total | Steps | Tools attempted / succeeded | Result |
|---|---|---:|---:|---:|---:|---|
| Palisade, original incident | 4 | 1.58 | 22.46 | 2 | 0 / 0 | Terminal timeout, no answer |
| Palisade, replay 1 | 5 | 31.81 | 41.06 | 3 | 1 / 1 | Answer with sources and qualification |
| Palisade, replay 2 | 5 | 25.80 | 33.48 | 4 | 1 / 1 | Answer with sources |
| Palisade, replay 3 | 5 | 31.29 | 36.49 | 4 | 1 / 1 | Answer with sources |
| Arithmetic | 5 | 1.58 | 1.62 | 1 | 0 / 0 | 105 |
| AI Control API inventory | 5 | 1.21 | 2.71 | 1 | 0 / 0 | Used the red deployment inventory |
| Insurance | 5 | 1.25 | 4.40 | 1 | 0 / 0 | Differentiated insurance types |
| Registration follow-up | 5 | 1.15 | 4.24 | 1 | 0 / 0 | Used vehicle context from first turn |
| Three-box arithmetic | 5 | 1.01 | 2.34 | 1 | 0 / 0 | Solved using the provided numbers |
| Ambiguous Palisade option | 5 | 17.42 | 21.06 | 4 | 1 / 1 | Asked which option the user meant, after an avoidable lookup |
| Request for official DeepSeek documentation | 5 | 12.73 | 15.44 | 4 | 2 / 2 | Responded after using web tools |

Palisade responses distinguished the seven- and eight-seat layouts, with conclusions scoped to available sources. The replay does not independently certify fit with a particular child seat or market configuration. The fix restores a useful response at the cost of longer completion than the old failing run. The latency to useful text in this case and the unnecessary search on an ambiguous follow-up remain optimization work. The initial DEEP and DIRECT decisions both occurred in successful source replays.

The broad agent-loop, web-tool, and Chat UI run had 824 passing tests. Six existing Chat UI failures matched the same six failures at the previous green release in a focused baseline run. A focused permission test passed both the normal admission and denial branches. An isolated Chrome copy of the interrupted Palisade attempt showed both the saved partial answer and the retry guidance, without displaying UNKNOWN or the internal continuation call.

## Lightweight first-response experiment

Set `AI_CONTROL_FIRST_RESPONSE_HINT=1` and `AI_CONTROL_SUPERVISOR=0` in an isolated profile. Keep `AI_CONTROL_TURN_LOG=1` for measurements. Only the first request gets the brief answer, tool use, and clarification guidance. All normal tools, model settings, and approval checks stay available from the first request. The next request restores the regular prompt. The experiment does not call the Supervisor or impose its request, step, tool, or elapsed-time budgets.

In an isolated Chrome replay on Flash with the same normal model settings, the Palisade question with the hint gave first text at 141.54 s and completed at 149.49 s (11 steps, 18 tool calls). It distinguished generations and included links. The no-hint control was still exploring when the test observer closed at 125.40 s (6 steps, 10 tool calls). Therefore this comparison provides no estimate of the speedup. The earlier budgeted policy had three completed runs in 33.48–41.06 s, with different permissions and starting effort. The hint alone did not reliably prevent extended exploration.

In the same hint-only replay the two vehicle follow-ups took 60.54 and 63.10 s (5 and 4 steps). The no-hint replay of that pair in a separate isolated session took 45.33 and 25.80 s (3 and 2 steps). These are observations from individual samples, not a latency distribution.

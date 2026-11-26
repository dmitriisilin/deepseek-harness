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

## Quality-first evaluation

Evaluate distinct changes separately. The first-request trial changes effort selection only. A separate review trial changes how the loop judges whether another operation would resolve an important gap. Holdout questions are chosen before policy changes and used for the final comparison. Production prompts must not mention the benchmark questions.

Score answers before inspecting timings. Check the decisive factual claims, coverage of the original question, preservation of prior-turn context, source support and material qualifications. A decisive factual error fails the scenario even when the answer is short, fast or includes links. Record first useful text separately from the first streamed fragment wherever the sample allows it. Admit additional operations by count and purpose. Never cancel a running Worker operation to meet a latency target.

The independent evidence check is a separate experiment. When it detects that a conclusion depends on missing external facts, it withholds the first draft and admits a scoped verification step. It drains the first request without cancellation. A direct answer is released after the classifier has cleared the check or failed within its own deadline. The initial classifier and the budget review do not receive the draft or raw tool arguments. The review experiment supplies only the names of proposed tools and whether the same operation already succeeded, alongside the existing progress summary and result counts.

The frozen validation set is [AI-07-quality-holdout.json](AI-07-quality-holdout.json). It covers trivial output, two-turn revision, conflicting premises, asynchronous code diagnosis and primary-source verification. It is evaluation input only.

An additional trial audits the actual draft when the request classifier alone clears it. This adds one bounded Supervisor call for a direct draft, and the accepted answer appears on settlement. The audit uses the clipped current question, preceding user turn when present, and draft, sent to the existing dedicated Supervisor endpoint and excluded from turn diagnostics. A verification decision hides the draft and opens the ordinary scoped source path. An unavailable audit releases the Worker answer. A Worker continuation goes through its ordinary admission without a draft audit. This is an opt-in comparison until the measured quality and latency justify changing the default.

### Experimental controls

The comparisons used independent switches for first effort (`AI_CONTROL_FIRST_EFFORT=selected`), neutral first guidance (`AI_CONTROL_FIRST_GUIDANCE=neutral`), progress-aware review (`AI_CONTROL_PROGRESS_REVIEW=1`), independent classification of missing evidence (`AI_CONTROL_FIRST_EVIDENCE_GATE=1`) and audit of a completed direct draft (`AI_CONTROL_DRAFT_REVIEW=1`). The experiments ran with identical tool permissions. None of these switches changes the green services.

When a known follow-up has prior context and the Worker proposes a route for verification, the evidence policy allows bounded work despite an ambiguous initial label. If the classifier is unavailable and the Worker explicitly requested sources, the fallback grant leaves space for one bounded tool batch and a response. A failed, timed-out or invalid audit alone cannot prevent a direct answer. These rules concern admission, and add no Worker deadlines.

### Chrome replay observations

Flash in isolated red profiles. Each cell gives first text / completion in seconds and model requests / executed tools. Timings describe individual runs. For a buffered draft, first text is recorded when the accepted answer becomes visible.

| Regression | Policy 7 baseline | Evidence gate and draft audit, repeated | Quality finding |
|---|---|---|---|
| Palisade seating | 27.75 / 32.97 · 4 / 1 | 82.40 / 89.37 · 4 / 1 | Both generalize beyond the verified configuration. A source lookup does not make the recommendation reliable. |
| Insurance | 1.21 / 5.11 · 1 / 0 | 24.66 / 30.06 · 4 / 1 | The baseline mixed liability and property coverage. The audit run distinguished them. The extra time and tool use do not establish a consistent gain across the other cases. |
| Registration follow-up | 1.13 / 4.49 · 1 / 0 | 25.54 / 28.30 · 3 / 0 | The baseline included an overbroad statement about vehicle condition. The audit run requested evidence but executed no source lookup on this repetition. |

Preserving the selected effort alone took 61.2, 28.2, and 20.4 seconds respectively and did not resolve the factual mistakes. The progress review alone took 72.8 seconds on Palisade and still permitted an overbroad conclusion. Neutral first guidance alone took about 47 seconds for Palisade and did not yield source lookups for the two vehicle follow-ups. None of these samples justifies a rollout.

Reference checks for scoring include the [Hyundai recall and its affected configurations](https://owners.hyundaiusa.com/us/en/resources/general-information/recall-296-information-and-implementation), the [prosecutor's explanation of the registration rule change](https://epp.genproc.gov.ru/ru/proc_glskfoyufo/activity/legal-education/explain/social-rights/e2098512/) and the [Python language reference on dictionaries](https://docs.python.org/3/reference/datamodel.html#dictionaries).

### Held-out Chrome replay

After passing the previous user turn to the draft audit, the two-turn calculation completed with 64 and 63 on both providers, with one Worker request and zero tools for each turn. Before that fix the audit sent the follow-up to a verification step despite the answer being computable from the supplied numbers.

| Held-out question | Flash baseline first text / total | Flash with gate, draft audit and progress review | Source and content check |
|---|---:|---:|---|
| Simple percentage | 1.44 / 1.58 s | 2.54 / 2.55 s | Both returned 30. |
| Box count | 0.95 / 1.32 s | 2.23 / 2.24 s | Both returned 64. |
| Box count follow-up | 0.71 / 0.97 s | 2.06 / 2.07 s | Both applied the change to one box and returned 63. |
| Conflicting units | 1.24 / 4.04 s | 4.51 / 4.52 s | Both computed 12 and 288 under separate premises. |
| Asynchronous JavaScript | 1.39 / 3.57 s | 4.34 / 4.35 s | Both identified the missing await and described the ordered fix. |
| Python dictionary order | 21.35 / 24.57 s | 22.86 / 25.82 s | Both distinguished Python 3.7 from CPython 3.6 and ran two source operations. |

This holdout gives no evidence for auditing every short draft. On Flash the median over the three arithmetic turns went from 0.95 to 2.23 s before first text. The draft audit should remain an experimental setting until a narrower admission policy demonstrates useful quality gains without a systematic penalty on simple turns.

### Selective audit and source admission

The initial classifier may mark a task self-contained when its answer can be derived entirely from the supplied material. That label permits ordinary streamed text without a second Supervisor call. The first-text medians for the three Flash arithmetic turns were 0.95 s on baseline, 2.23 s with universal draft audit and 1.49 s with selective audit. All three modes retained the expected answers. The selective Opus replay also preserved those answers in one request per turn and completed the Python reference question in 19.90 s with two executed source operations.

The selective Flash replay answered the Python question correctly but requested three parallel document reads after the classifier returned invalid output. The fallback allowed two tools and the review declined the batch, so none of its cited documents was read. The source fallback now admits up to three tools in its first batch. With progress review enabled, a discovery search that returns source links can also reserve one batch of up to two previously unread documents before final synthesis, within the existing hard limits. Failed and empty search outcomes do not qualify. The normal execution permission check still applies. Turn diagnostics record the active experimental switches and whether the reserve was used.

In a repeated Flash regression the reserve admitted the first reads after discovery. Palisade executed three source operations in five requests and took 84.65 s (first text at 76.04 s). The answer identified market differences, but treated the ability to leave a child restraint installed as permission to move a seat with a child still in it. That is a material quality failure. The insurance and registration turns took 7.06 and 4.49 s with no executed tools. Registration was incorrectly classified as self-contained because the preceding user message identified the vehicle, even though it did not supply the registration rules. It repeated an outdated insurance requirement. These runs separate the source-admission gain from unresolved claim accuracy.

### Deterministic transition coverage

| Boundary | Expected result | Coverage |
|---|---|---|
| Initial classification unavailable | Use the bounded fallback. An explicitly requested source batch can execute before synthesis. | Supervisor classification and source-fallback tests, loop provider retry test |
| Source discovery empty or failed | A tool result without source links cannot open the dedicated reading reserve. | Supervisor source-reserve parameterized cases |
| Conflicting supplied data | Preserve both premises and report the result for each. | Frozen Chrome conflicting-units question on Flash and Opus |
| Repeated tool call | Identify an exact repeat without sending the arguments to the Supervisor. The reserve applies only to unread targets. | Supervisor structural next-operation test |
| Permission denied | Normal tool permission checks apply after budget admission, and denial is reflected in the result without executing the tool. | Loop continuation permission test |
| User cancels while models are running | Both active branches receive the cancellation signal. | Loop dual cancellation test |
| Work grant spent | An active Worker request can finish. A tool-free synthesis call may use the available results without a Supervisor-imposed deadline. | Supervisor hard-limit test and loop in-flight Worker and synthesis test |

After tightening the classifier, a further Flash Palisade replay used the reserved batch and executed three source operations in five requests (66.82 s first text, 76.55 s total). The answer still made a universal claim about the seat mechanism despite covering only specific vehicles. Prompt wording and more source reads are insufficient evidence of reliable synthesis. The quality gate for selecting a rollout candidate remains open.

### Deployment context regression

With no deployment inventory supplied, Flash explicitly marked billing and provider details unknown and asked for a deployment manifest. That isolated red turn completed in 6.55 s (first text 4.51 s, two requests, zero executed tools). With a test inventory containing only model, transcription and ingress providers, Flash reported those three dependencies and kept billing plans, credits and subscription requirements unknown. It took 3.51 s in one request with no tools. The second test uses a fixture, so it confirms that the prompt honors supplied inventory and does not demonstrate which services the installed profile requires.

The next Flash registration replay requested continuation with malformed arguments. The legacy path went directly to final synthesis (37.31 s, first text 31.68 s, two requests, zero executed tools). The experimental policy now recovers a bounded continuation once. The initial classifier can supply a source or action route, or the Worker can proceed with a limited normal step if classification failed. A direct or unresolved ambiguous classification still closes the first-pass control request. Permissions apply to any operation selected after recovery.

Progress review distinguishes discovered links from distinct documents actually read. It gets only these counts and operation names, with no source contents or arguments. When a decisive claim still depends on an unread document, the review can grant an additional relevant operation up to the hard limit. The final synthesis instruction asks for the conditions of the conclusion up front as well as the supporting evidence.

An opt-in synthesis audit (`AI_CONTROL_SYNTHESIS_AUDIT=1`) checks the tool-free final answer against up to three bounded excerpts. A document qualifies only when its final HTTPS URL exactly matches a discovery result, with no credentials or query string. The audit runs via the dedicated Supervisor key, does not write source excerpts to diagnostics, and may request one tool-free revision within the hard request and step limits. The draft stays hidden while it is checked. Audit failure releases the draft. A revision provider error or empty revision falls back to the provisional answer with an explicit unverified-answer warning. The revised text is also buffered until it can be settled. User cancellation remains authoritative.

The first isolated Palisade trial of the audit, before tightening source eligibility, executed eight source operations and finished in 81.62 s. The audit accepted the draft. That observation does not yet measure revision quality or justify rollout.

The URL-restricted Palisade audit trial also accepted its draft (six requests, seven source operations, 80.04 s first text, 80.07 s total). It reported the documented tilting variant and distinguished the prior generation, but some advice still generalized across configurations and cited secondary material for an operational recommendation. Treat this as mixed, not a robust improvement. The audit remains off by default.

### Second blind holdout

Four turns tested revision-specific conditions, an update in the same conversation, combining rates with different denominators, and a log with distinct build and test outcomes. Both configurations passed two of four under the prewritten rubric. The default made an unsupported cross-revision recommendation and confused build and test records. The experimental configuration preserved both scope distinctions, but wrote that 40 out of 50 was 60% despite arriving at the correct combined 65%. It also opened an unnecessary tool on the log question. First-text and total pairs (seconds) were 2.07/2.83, 1.18/1.69, 1.50/2.15 and 0.93/1.42 on the default, and 3.02/3.03, 0.96/1.25, 0.89/1.70 and 1.44/26.56 on the experimental configuration. The candidate improves some distinctions and introduces a factual error, so this comparison does not support enabling it by default.

A subsequent unseen set checked weighted rates, a two-turn data-schema question, and explicit verification against Git's primary documentation. Flash and Opus both gave the correct 62% and preserved the follow-up's distinction between queueing and completion. In the first schema answer both made at least one stronger claim about the underlying state than the supplied record proves. Opus opened both Git manual pages (two tools, 16.05 s total). Flash completed in 8.55 s, provided known links, and explicitly reported it did not open them. Its first Worker attempted a tool not declared for that step. The experimental recovery now treats the attempt solely as a signal to consult the Supervisor at the boundary. Only a fresh operation from the next Worker request can reach the regular permission check.

The supplied-material route honors an explicit user scope on the same boundary. If the initial classifier detects this scope, a proposed continuation moves to tool-free synthesis with an instruction to preserve the supplied facts and conditions.

In the Flash repeat after recovery, both Git manual pages returned HTTP 200. The turn completed in 17.64 s, with first text at 14.24 s, four Worker requests and two executed reads. The earlier 8.55 s Flash answer omitted the requested verification. This is a before/after change in task completion, as well as a latency increase. The first classifier also selected a different route in the repeat, so the live comparison alone cannot isolate the recovery change. The deterministic loop test verifies that the original undeclared call never dispatches and a fresh admitted call can run.

### Candidate selection protocol

The final comparison uses reduced first effort, neutral first guidance, the evidence gate with selective draft audit, and progress-aware review. The separate synthesis audit stays disabled because the trials did not establish that it reliably caught important errors. The same options run on Flash and Opus in isolated profiles. The comparison preserves the historical baseline and treats every replay as a separate observation, including unsuccessful ones.

Score the content before opening turn metrics. For the vehicle questions, the answer must distinguish supported configurations, preserve the conditions stated in the documents, and distinguish an installed restraint from an occupied restraint. For regulatory claims, confirm the effective rule, preserve material exceptions and distinguish the second question's scope from the first. For the fixtures, check all reported calculations and intermediate claims, distinguish lack of evidence from evidence of absence, and preserve the previous user turn's relevant facts. For explicit source verification, an executed read and a link supporting the conclusion are both required. A material factual or scope error fails that observation even if the main recommendation or number happens to be useful.

The first scored Flash observation on the published candidate failed Palisade. It made a blanket claim about all configurations and extended a restraint-installation observation to a general operating recommendation without establishing the configuration or conditions. This was scored before inspecting its latency. First text arrived at 65.27 s and the turn completed at 74.08 s after five Worker requests and four actual source operations. The candidate has not met the quality gate for promotion.

The single broad test run on `69db25dad9` finished with 853 passing and six failing tests across 34 files. All six failures were in the chat UI file and matched the failure names recorded against the pre-experiment baseline. The agent loop and web tool suites passed. The pre-push type checks passed all five gates with one worker.

The candidate's first Flash insurance turn correctly distinguished liability coverage from vehicle coverage, but cited the superseded 431-P regulation as the current rule. It failed the prewritten effective-rule check. The [published 837-P regulation](https://www.cbr.ru/queries/xsltblock/file/158093/-1/2506) supersedes it from October 2024. The turn took 50.61 s with first text at 44.60 s, five Worker requests and four source operations. This is another example where the success count alone is insufficient.

A frozen replay reused the same provisional Palisade answer and qualifying public document from the URL-restricted audit trial. The revised excerpt selection and affirmative support requirement changed the verdict from ACCEPT to REVISE. The Supervisor audit itself took 0.98 s. This is evidence for detecting the error without another search. It does not show that the next Worker revision is correct. The two audit changes were evaluated together here.

On the same Flash replay, the registration follow-up applied the changed insurance rule and described diagnostic-card requirements as unverified. The conflicting-units holdout correctly computed both totals but then selected one input with no evidence that resolved the conflict. It failed the supplied-premise check. The asynchronous code answer identified the missing await and gave an ordered sequential fix. The optional parallel example also changes the callback argument list, so the sequential fix is the reliable minimal answer.

| Flash replay on `69db25dad9` | First text / total, s | Requests / steps / tools | Result |
|---|---:|---:|---|
| Registration follow-up | 55.24 / 60.70 | 5 / 5 / 3 | Corrected the obsolete insurance requirement and marked the unresolved inspection requirement. |
| Percentage | 1.92 / 2.02 | 1 / 1 / 0 | Pass. |
| Box count and follow-up | 1.31 / 1.74, 1.24 / 1.42 | 1 / 1 / 0 each | Pass on both turns. |
| Conflicting units | 1.06 / 3.55 | 1 / 1 / 0 | Fail. Correct calculations, unsupported choice between inputs. |
| Async diagnosis | 4.05 / 4.06 | 1 / 1 / 0 | Correct cause and sequential fix. |
| Python source verification | 26.35 / 29.84 | 4 / 4 / 2 | Correct version distinction with source reads. |
| Instruction revisions and follow-up | 1.31 / 2.18, 1.42 / 1.42 | 1 / 1 / 0 each | Pass on both turns. |
| Weighted rates | 1.31 / 1.91 | 1 / 1 / 0 | Correct combined and intermediate values. |
| Build and test log | 7.53 / 8.20 | 2 / 2 / 0 | Correct distinction. No external operation executed. |

| Opus replay on `69db25dad9` | First text / total, s | Requests / steps / tools | Result |
|---|---:|---:|---|
| Palisade | 31.45 / 42.94 | 5 / 5 / 3 | More careful than Flash about the incomplete manual read. It did not carry the no-occupant condition into a table covering two occupied restraints, so the operational guidance fails the scope check. |
| Percentage | 1.55 / 2.13 | 1 / 1 / 0 | Pass. |
| Box count and follow-up | 1.13 / 1.41, 0.86 / 1.27 | 1 / 1 / 0 each | Pass on both turns. |
| Python source verification | 22.79 / 26.79 | 4 / 4 / 3 | Pass. Distinguished the language contract and implementation and reported the truncated read. |

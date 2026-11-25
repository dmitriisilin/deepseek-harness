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

После принятия пользовательского ввода, включая расшифровку, первый запрос выбранной модели и классификация Supervisor запускаются независимо. Первый запрос получает ограничение выходных токенов до классификации. Декларации инструментов можно передать модели сразу. Фактические вызовы инструментов ждут допуска по бюджету и проходят штатные разрешения. Готовый ответ без инструментов завершает ход сразу, отменяя незавершённую классификацию.

Supervisor использует отдельный ключ `DEEP_SEEK_Supervisor`. Выбранная модель Worker сохраняется. Решение Supervisor действует на следующие действия цикла, поскольку уже отправленный запрос изменить нельзя.

Бюджет учитывает фактические попытки Worker, открытые шаги, число запрошенных инструментов в партии и время. При достижении мягкой границы выполняется ограниченная переоценка. Supervisor получает исходную задачу, краткий видимый прогресс и счётчики. Продление даёт ограниченную порцию работы в пределах жёсткого лимита. При отказе Supervisor, недостатке данных или исчерпании лимита цикл резервирует один запрос без инструментов для ответа по имеющимся данным или уточнения. Отмена хода прерывает Worker и Supervisor.

Обычный бюджет допускает до 3 запросов, 3 шагов, 4 инструментов и 25 секунд. Запасной бюджет допускает до 2 запросов, 2 шагов, 2 инструментов и 15 секунд. Жёсткий предел исследовательской части — 8 запросов, 7 шагов, 12 инструментов и 90 секунд. Возможны два ограниченных продления. Для финального запроса отдельно отведено до 20 секунд. Таймаут каждого обращения к Supervisor — 2,5 секунды.

# Adaptive Supervisor

The staging experiment is enabled by setting `AI_CONTROL_SUPERVISOR=1` in the service environment. Remove the variable and restart the service to restore the original routing. The experiment runs only on the official DeepSeek Flash route.

After the pre-step hooks admit the input (including speech recognition and clarification), a separate Flash request classifies the turn. It receives up to 3,000 characters of current text and 900 characters of the previous user turn. Attachment bytes, tool schemas and tool output are excluded. The request has a 2.5 second deadline and no tools. Invalid or unavailable classification falls back to the existing loop. Logs record route, outcome and duration without conversation text.

Direct and deep routes suppress tool exposure and execution admission for the Worker step. Direct uses Flash with thinking disabled for that step. Deep preserves the selected effort. Standard runs the existing loop and its permissions. The same Session and streaming path handle all routes.

## Baselines

1. Ambiguous voice question about Flash and Pro. 355 s total, about 21 s preparation, 35 model steps, 49 calls including 47 Bash. Use the clarified text to compare route decisions and keep the original ambiguity as a separate voice regression.
2. «Можно ли в России оформить страховку на машину с помятыми дверками?» on official Flash. Production-like red staging baseline: 43.6 s from turn start to end, 18.6 s before step one, 10.5 s to call web_search, 7.6 s for the search (three internal requests), 6.9 s for the second model step. The first visible text timestamp is unavailable. Compare text against text and voice against voice, recording time to first visible text, completion time, model steps and search calls.

The experiment covers initial routing. Automatic capability promotion, catalog lookup, renewable budgets and asynchronous review remain separate implementation stages.

## Flash staging replay

Two isolated Chrome profiles submitted the insurance question as text on 24 November 2026. One run per configuration, using the same Flash route. Server time is measured from `turn/start` to `turn/end`.

| Configuration | Server time | Worker steps | Tool calls |
|---|---:|---:|---:|
| Existing loop | 58.0 s | 4 | 5 |
| Initial Supervisor | 6.3 s | 1 | 0 |

The Supervisor call took 1.1 s. The first visible text mentioning ОСАГО appeared about 3.2 s after submit. The baseline browser probe missed the matching text, so only server time is compared. This sample excludes transcription and does not estimate typical or tail latency.

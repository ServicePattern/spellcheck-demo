# Load test: loader architecture

Design for a load generator that sends the demo's real traffic shape to an LLM served by vLLM on a rented vast.ai GPU. Written 2026-11-10. The core (change `load-generator`: scripts, agent, run, report, the `llm` and `fake` targets) is built; see [As built](#as-built-change-load-generator). The `server` target, the vLLM metrics, the probe and the cost figures are still plans.

## Goal

Answer one question per model and GPU: **how many agents typing at once can one instance serve before the answers stop arriving in time?**

The loader simulates agents, not requests. Each simulated agent types a message, pauses, sends the two requests the assistant would send, and either waits for the answers or resumes typing and aborts them.

## What already exists

From the sibling project `../SpellCheckingPrototype`, used as is:

| Asset | Where | Use in the load test |
|---|---|---|
| vast.ai scripts | `deploy/vastai/` (`search`, `start`, `tunnel`, `check`, `status`, `destroy`) | Rent the GPU, serve the model on vLLM v0.31.0, open the SSH tunnel to `127.0.0.1:8000`, check it, stop billing. `start.sh --max-seqs N` sets vLLM's cap on concurrent sequences |
| Synthetic support chats | `eval/completion/sources/support-en.txt` (43 conversations, 137 agent turns) and `support-ar.txt` (55 conversations, 173 agent turns) | The text the simulated agents type, and the conversation each request carries. Synthetic, so it may go to a rented machine |
| Tester telemetry | `telemetry/events.jsonl` (27 sessions) | Source of the default typing numbers below |
| Model choice and latency notes | `docs/LLM-SELECTION.md`, `docs/VASTAI-GPU.md` | Which model to load (the candidate that passes the gate is `google/gemma-4-26B-A4B-it`, 385–405 ms p50 for a single user on an RTX PRO 6000 WS at $1.43/h) |

From this project, imported by the loader:

| Asset | Where | Use |
|---|---|---|
| User message builders and answer parsers | `src/assistant/llm.ts` | The requests are byte-for-byte what the assistant sends; the parsers give the format-error rate under load |
| Upstream client with the prompts | `server/openai-chat-client.ts` | Direct calls to vLLM with the real system messages and examples |
| Context blocks | `src/app/lib/presets.ts` | Canned responses and knowledge base around the conversation, so the prompt has its real size |
| Node resolve hook pattern | `tools/eval/` | Running TypeScript that imports `src/` without a build |

## Topology

```mermaid
flowchart LR
  subgraph Mac
    L[Loader<br/>tools/load]
    S[Demo server<br/>server/index.ts]
    T[SSH tunnel<br/>127.0.0.1:8000]
  end
  subgraph vast.ai instance
    V[vLLM<br/>loopback :8000]
    G[(GPU)]
  end
  L -->|target llm| T
  L -->|target server| S --> T
  T --> V --> G
  L -.->|poll /metrics| T
```

Two targets, one flag:

- **`--target llm`** calls vLLM directly through the tunnel. It measures the model and the GPU.
- **`--target server`** calls the demo server's `/api/autocorrection` and `/api/autocompletion` with Basic auth. It measures the whole path and shows what the server adds, including the upstream calls it does not cancel (finding 1 in `server-architecture-and-review.md`).

Settings for vLLM as this project's LLM: `LLM_URL=http://127.0.0.1:8000/v1/chat/completions`, `MODEL=<Hugging Face id>`, `LLM_API_KEY=` any non-empty value.

## Components

```mermaid
flowchart TD
  C[Chat scripts<br/>chats.ts] --> A
  M[Typing model<br/>typing-model.ts] --> A
  P[Load profile<br/>run.ts] -->|starts N agents per stage| A[Virtual agent<br/>agent.ts]
  A -->|draft, caret, context| B[Message builders<br/>src/assistant/llm.ts]
  B --> X[Target client<br/>targets.ts]
  X -->|answer, abort, timeout, error| R[Recorder<br/>recorder.ts]
  K[vLLM metrics sampler<br/>vllm-metrics.ts] --> R
  R --> O[Report<br/>report.ts]
```

Planned files, all under `tools/load/`:

| File | Responsibility |
|---|---|
| `run.ts` | Command line, the stages, starting and stopping agents, the final report |
| `chats.ts` | Reads the chat sources into scripts: for each agent turn, the text to type and the conversation before it. The English file labels turns `Customer:` and `Agent:`, the Arabic file `العميل:` and `الموظف:`; conversations are separated by `---` |
| `typing-model.ts` | The numbers that drive an agent, drawn from a seeded random generator so a run can be repeated |
| `agent.ts` | One simulated agent: the loop below |
| `targets.ts` | Two `LLMClient`s: the upstream client for vLLM, and an HTTP client for the demo server |
| `vllm-metrics.ts` | Polls vLLM's `/metrics` every 2 s: requests running and waiting, token counters |
| `recorder.ts` | One line per request in `runs/<time>/requests.jsonl` |
| `report.ts` | Per-stage figures, as `report.md` and `report.json` |

Pure parts (`chats.ts`, `typing-model.ts`, `report.ts`) get `*.spec.ts` files next to them, run in Node like the assistant's tests.

### The virtual agent

It follows the assistant's own rules (`src/assistant/check-while-typing.ts`), so the request pattern is the real one.

```mermaid
stateDiagram-v2
  [*] --> Waiting: start, random offset
  Waiting --> Typing: customer turn read
  Typing --> Paused: burst typed
  Paused --> Typing: pause under 1 s, no request
  Paused --> Requesting: 1 s debounce passed
  Requesting --> Typing: typing resumes, abort what is still running
  Requesting --> Accepting: completion arrived and is accepted
  Accepting --> Paused: draft jumps ahead
  Typing --> Waiting: message finished and sent
```

- **Typing** adds the next few words of the script to the draft, with typos inserted at a set rate so the spell check has something to report. The loader has its own small seeded typo injector: the sibling's `eval/inject.ts` depends on its Hunspell pipeline and is not reused.
- **Requesting** sends spell check and auto-completion in parallel under one abort controller, with the assistant's 20 s timeout. A share of rounds send spell check only, standing in for edits in the middle of the text.
- **Resume** happens when the pause ends. Any request still running is aborted, as the assistant does on the next keystroke.
- **Accepting** a completion moves the draft ahead by the completion's length and starts a new debounce, as Tab does in the page.
- **Waiting** is the time between messages: the customer's reply and reading it.

#### The agent against the assistant's rules

Each rule of `src/assistant/check-while-typing.ts` (and the timeout in `src/assistant/llm.ts`), as built in `tools/load/agent.ts`:

| Rule in the assistant | In the agent |
|---|---|
| The debounce restarts on every input, so a round starts `debounceMs` after the last keystroke | Followed: a round starts `--debounce-ms` after the end of a burst; a shorter pause sends nothing |
| Spell check and auto-completion go out together under one `AbortController` | Followed: one controller per round, both requests sent at the same moment |
| An input aborts the running request (`abortRunningRequest` on text change) | Followed: resuming typing at the pause end aborts what is still running, and so does accepting a completion |
| Each request is ended after `LLM_TIMEOUT_MS` (20 s) | Followed: `--timeout-ms`, ended as `timeout` |
| Auto-completion is asked only when the rest of the caret line is blank | Followed: with the caret at the end of the draft both are sent; a spell check only round puts the caret at an earlier word end and sends spell check alone |
| An empty field sends nothing | Followed by construction: a round always follows a burst, so the draft is never empty |
| Accepting a completion (Tab) inserts text, which is an input: a new debounce and a new round | Followed: the draft moves ahead and a new pause starts; the inserted words are the script's, not the model's |
| `isCaretOnNewLine` adds a line to the auto-completion message | Left out: drafts are one line, so it is always false |
| Typing the letters of the shown completion keeps it and sends no new request | Left out: a completion is accepted whole or not at all |
| Auto-correction changes the text without a new request | Left out: the draft keeps its typos, so spell check answers are a little longer than in real use |
| Undo and redo send no new request | Left out: no undo or redo |
| Deleting only trailing spaces sends no new request | Left out: the agent never deletes |
| Escape clears the debounce and aborts the running request | Left out: no Escape |
| An input method still composing blocks auto-completion | Left out: no input methods |
| Spell check or auto-completion can be switched off | Left out: both are always on |
| Answers are dropped when the text or the caret moved while waiting | No effect on load: the request has already been served |

### Assumed defaults

Every number is a flag. The loader prints the gaps it actually produced so they can be compared with real data later.

| Setting | Default | Basis |
|---|---|---|
| Debounce | 1000 ms | `DEBOUNCE_MS` in this project |
| Request timeout | 20 s | `LLM_TIMEOUT_MS` in this project |
| Typing speed | 40 words per minute, ±25% per agent | Assumed |
| Burst length | Median 3 words | Assumed, tuned so the gap between rounds lands near the telemetry figure |
| Pause after a burst | Median 1.8 s, long tail | Assumed |
| Gap between request rounds (result, not input) | Median about 6 s | Telemetry: median 5.7 s, quartiles 2.8 s and 15.3 s between completions in a session. That prototype triggers differently, so this is a rough guide |
| Completion accepted | 26% of those shown | Telemetry: 85 accepted of 329 shown |
| Spell check only rounds | 10% | Assumed |
| Typos | 1 per 15 words | Assumed |
| Time between messages | Median 20 s | Assumed |
| Language mix | Half English, half Arabic | Assumed |

### Load profile

Agents are the unit of load, in steps:

```
--agents 10,25,50,100,150 --stage 180
```

- Each stage adds agents up to its level and holds for the stage time.
- New agents start at random offsets so they do not pause in step.
- The first 30 s of each stage is warm-up and left out of the figures.
- Every stage runs to its end. There is no early stop.

### What is recorded

Per request: stage, agent, kind, language, outcome, latency, the time the agent gave it before resuming, prompt and answer size, and whether the answer parsed.

Outcomes: `answered`, `unreadable`, `aborted`, `timeout`, `failed`, `cut` (defined under [As built](#as-built-change-load-generator)). Planned with `vllm-metrics`: a context-length rejection from vLLM is reported apart from other errors (the start script serves an 8,192-token context).

Per 2 s sample from vLLM: requests running, requests waiting, prompt and generation token counters. The exact metric names are to be confirmed against v0.31.0.

A small probe request (one output token) every 10 s gives the network and tunnel round trip, so model time can be told from distance to the host.

### Report

One row per stage:

| Figure | Meaning |
|---|---|
| Agents, rounds per second, requests in flight (mean, max) | The load actually applied |
| **Useful answer rate**, per kind | Share of requests answered before the agent resumed typing. The headline figure |
| Latency p50, p95, p99, per kind | For answered requests |
| Aborted, timed out, failed, unreadable | Shares of all requests |
| vLLM queue (max waiting) and tokens per second | Whether the GPU is saturated |
| Network round trip | From the probe |

With `--price <$/h>` each row also gives the cost per agent-hour at that level.

There is no pass rule and no verdict. The report gives the figures; where the knee is, is read from them by a person.

## As built (change `load-generator`)

### Command and flags

```sh
npm run load -- --agents <levels> [flags]
npm run load -- --target fake --agents 2,5 --stage 60 --warmup 10   # dry run: two minutes, no network, no key
```

Run flags:

| Flag | Default | Meaning |
|---|---|---|
| `--agents` | required | Agents per stage, one number or rising numbers: `2,5,10` |
| `--target` | `llm` | `llm`: the server's upstream client (`server/openai-chat-client.ts`) with `LLM_URL`, `MODEL`, `LLM_API_KEY` from `.env` or the environment, sending exactly what the server sends. `fake`: built in, one seeded fake per agent, no network |
| `--stage` | 180 | Seconds per stage |
| `--warmup` | 30 | Seconds at the start of each stage left out of the figures; 0 or more, less than `--stage` |
| `--seed` | 1 | Seed of all draws |
| `--chats` | `../SpellCheckingPrototype/eval/completion/sources` | Chat sources folder |
| `--max-requests` | none | Stop once this many requests have been sent |
| `--out` | `tools/load/runs` | Where run folders are made |
| `--trace` | off | Also write `trace.jsonl` with each user message and raw answer |
| `--model`, `--url` | from the environment | Override `MODEL` and `LLM_URL` |
| `--fake-latency-ms` | 600 | Median latency of the fake target (log-normal, spread 0.5) |

Typing flags (assumed, listed in every report): `--debounce-ms 1000`, `--timeout-ms 20000`, `--wpm 40`, `--burst-words 3`, `--pause-ms 1800`, `--accept-share 0.26`, `--spell-check-only-share 0.1`, `--typo-every 15`, `--between-messages-ms 20000`, `--arabic-share 0.5`. A negative value must be written `--pause-ms=-5` to reach the range check; Node's parser reads `-5` alone as a flag and stops with an error naming it.

Spreads, fixed in `typing-model.ts`: speed ±25% per agent (uniform), words per burst log-normal 0.5 (rounded, at least 1), pause 0.7, time between messages 0.6. Each new agent starts after a delay drawn over the warm-up (at most 30 s).

### Outcomes

Decided from the agent's own signals, never from error text:

| Outcome | Meaning |
|---|---|
| `answered` | The answer arrived before the agent resumed and before the timeout, and parsed |
| `unreadable` | It arrived in time and did not parse |
| `aborted` | The agent resumed typing, or accepted a completion, first |
| `timeout` | No answer within `--timeout-ms` |
| `failed` | The target returned an error or the connection failed; the reason is recorded |
| `cut` | The run ended (stage end, request cap, Ctrl-C) while it was running |

Latency is from sending to the outcome; allowed time is from sending to the moment the agent resumed (or accepted). Both requests of a round share one send time.

### What the simulation leaves out

- The draft keeps its typos: no auto-correction, so spell check answers are a little longer than in real use.
- A completion is accepted whole (as Tab) or not at all; the accepted words are the script's, not the model's.
- No undo, redo, Escape, deletions, input methods, or drafts over several lines (`isCaretOnNewLine` is always false); both features are always on.
- Pauses are drawn in advance: an agent never waits for a suggestion.
- The fake target reports about one word in fifteen of four or more letters as a mistake, not the actual typos, and its completions come from a short fixed list per language.

The rule-by-rule comparison with `check-while-typing.ts` is under [The agent against the assistant's rules](#the-agent-against-the-assistants-rules).

### Typing produced by the defaults

On the virtual clock, 20 agents for 30 minutes on the real chat sources (seeds 1 to 3): gap between one agent's rounds p25 5.4 s, p50 8.6–9.1 s, p75 16–17 s; allowed time p50 0.85 s; 62–63% of the time on a message. The telemetry gap was 2.8 s, 5.7 s and 15.3 s, from a prototype that triggers differently. Spreads alone bring the median to about 7 s at best while shortening the tail; `--burst-words 2` gives a median of 6.6 s. The defaults are left as the spec sets them.

### Trial against a hosted model (2026-11-10)

`npm run load -- --agents 3 --stage 180 --max-requests 300`, target `llm` with `gemini-3.5-flash-lite` through Gemini's OpenAI-compatible endpoint (`generativelanguage.googleapis.com`), seed 1, commit `7bc38ac`, every typing input at its default (assumed, not measured: `--debounce-ms 1000`, `--timeout-ms 20000`, `--wpm 40`, `--burst-words 3`, `--pause-ms 1800`, `--accept-share 0.26`, `--spell-check-only-share 0.1`, `--typo-every 15`, `--between-messages-ms 20000`, `--arabic-share 0.5`). The seed made agents 1 and 2 Arabic and agent 3 English.

| Stage | Agents | Requests | Rounds/s | Useful answers | Aborted | Timeout | Failed | Unreadable | p50 ms | p95 ms | p99 ms | Empty completions | In flight mean | In flight max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 3 | 65 | 0.22 | 53.8% | 46.2% | 0.0% | 0.0% | 0.0% | 718 | 912 | 1045 | 0.0% | 0.2 | 4 |

79 requests were sent (14 in warm-up); the cap was not reached. Typing produced: gap between rounds p25 4.3 s, p50 6.0 s, p75 12.9 s; allowed time p25 0.45 s, p50 0.82 s, p75 1.64 s.

What it showed about the loader, not about capacity:

- The endpoint takes the server's request form unchanged (`response_format: json_object`, temperature 0.2): no `failed` and no `unreadable` answer, so there were no reasons to read.
- Aborts come from the typing model, not from the model's speed. Every aborted request had under 1 s of allowed time (41 to 1002 ms), and answers took 0.7 to 1 s. With the default pause (median 1.8 s) the time a request gets is the pause less the 1 s debounce, median 0.8 s, so about half the requests cannot be useful even with an idle model. The useful answer rate under load should be read against this floor, and the pause input is the one most worth measuring.
- Spell check reported a mistake in 2 of 20 answered drafts: at one typo per 15 words most drafts at a round hold none yet. Answers were short (median 16 characters for spell check, 51 for auto-completion).
- No auto-completion came back empty, against 10% from the fake.
- Run folders hold no key; the commit and the clean tree were recorded.

## Running it

```sh
# in ../SpellCheckingPrototype
deploy/vastai/search.sh --min-gb 80
deploy/vastai/start.sh <offer-id> google/gemma-4-26B-A4B-it
deploy/vastai/tunnel.sh            # own terminal, kept open
deploy/vastai/check.sh

# in this project
npm run load -- --target llm --agents 10,25,50,100,150 --stage 180 --price 1.43
npm run load -- --target server --agents 10,25,50 --stage 180

# in ../SpellCheckingPrototype, always
deploy/vastai/destroy.sh
```

Runs land in `tools/load/runs/<time>/` (git-ignored).

**Trying the loader without a GPU.** Until an instance is rented, the loader runs against a hosted Gemini model through its OpenAI-compatible chat completions endpoint: `LLM_URL` set to that endpoint, `MODEL` to the Gemini model (the sibling project uses `gemini-3.5-flash-lite`), `LLM_API_KEY` to the Gemini key, all in the git-ignored `.env`. Keep it to a few agents, since a hosted model has rate limits. Such a run shows the loader works and says nothing about capacity. There are no vLLM metrics in it.

## Decisions

Taken on 2026-11-10:

- **No pass rule.** The measures in the report are the result. No verdict, no early stop.
- **Capacity runs use `google/gemma-4-26B-A4B-it`** on one 96 GB card.
- **The first changes are tried against Gemini**, as above.
- **The work goes through OpenSpec** on the branch `load-test-openspec` (`openspec/config.yaml` holds the context and the rules).

## Planned changes

Each row is one OpenSpec change. The first two need no rented GPU.

| # | Change | What it delivers | Needs |
|---|---|---|---|
| 1 | `load-generator` | The loader in `tools/load/` with the `llm` target: chat parser for both sources, seeded typing model and typo injector, virtual agent, recorder, per-stage report, spec files for the pure parts, `npm run load` | Gemini key, a few cents |
| 2 | `load-server-target` | The `server` target: the demo server's two routes with Basic auth, so the whole path can be loaded | Gemini key |
| 3 | `vllm-metrics` | The vLLM `/metrics` sampler, the network probe, context-length rejections reported apart, cost per agent-hour from `--price` | About 1 GPU hour to confirm the metric names |
| 4 | `first-capacity-run` | The stepped run on the chosen model, the check that aborts reach vLLM through the tunnel, the results written into `docs/` | 2–3 GPU hours, roughly $3–5 |
| 5 | `server-cost-fixes` | Two product changes, each measured before and after: cancel the upstream call when the browser disconnects, and cap the answer's tokens | GPU hours for the comparison runs |
| 6 | `capacity-variations` | Runs with one setting changed each: prefix cache, JSON mode, `--max-seqs` | GPU hours |

Possible later: replace the assumed typing numbers with sessions recorded from the demo's Debugger.

Changes 5 and 6 depend on what change 4 shows and may be reordered or dropped.

## Things the first runs should settle

- **Do aborts reach vLLM through the tunnel?** Closing the local connection should close the SSH channel and stop generation. The vLLM running count dropping right after a burst of aborts confirms it.
- **Prefix caching.** The system message and examples are the same for every request, and the context is the same for one agent across a message. Compare a run with vLLM's prefix cache on and off.
- **JSON mode cost.** This project sends `response_format: json_object`. Compare tokens per second with and without it.
- **No output cap.** This project sends no `max_tokens`. Under load a few long answers hold a slot each; a run with a cap shows how much that matters.
- **`--max-seqs`.** vLLM's default of 256 concurrent sequences may be above or below what the card serves well. Past the knee, try a lower cap and see whether queueing beats slow generation.

## Limits of this design

- **The typing model is assumed.** The capacity figure is only as good as the gap and pause numbers. Real figures from Agent Desktop, or recorded Debugger sessions from this demo, should replace them.
- **One language model, one instance.** No autoscaling, no failover, no second replica.
- **The loader runs on the Mac.** The tunnel is one SSH connection. That is enough for this volume (a few kilobytes per request), and the probe shows its share. A run from a second instance next to the GPU would remove it, at the cost of installing Node there.
- **Synthetic text only.** A vast.ai instance is someone else's machine; the loader reads only the synthetic chats and the presets.

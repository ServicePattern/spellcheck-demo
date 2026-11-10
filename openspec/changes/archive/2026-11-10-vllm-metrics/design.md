# Design

## Context

See `proposal.md` for the motivation and `docs/load-test-architecture.md` for the loader as built (the `llm`, `server` and `fake` targets, the report, the Gemini trials).

**Target of this change: vLLM directly and through the demo server.** The sampler and the probe always talk to the vLLM instance itself, reached at `LLM_URL` through the SSH tunnel (`deploy/vastai/tunnel.sh` maps `127.0.0.1:8000` to the instance's loopback `:8000`); the agents' requests go wherever `--target` says.

What exists:

- The sibling project serves `vllm/vllm-openai:v0.31.0` with `vllm serve <model> --host 127.0.0.1 --port 8000 --max-model-len 8192` (and `--max-num-seqs` when given). vLLM serves Prometheus text at `/metrics` on the same port as `/v1/chat/completions`, with no auth.
- The names of vLLM's metrics have changed across versions (for example `vllm:gpu_cache_usage_perc` became `vllm:kv_cache_usage_perc` with the V1 engine, and the prefix cache moved from a hit-rate gauge to query and hit counters). Nobody here has read v0.31.0's `/metrics` yet.
- `load-run.ts` runs the stages on an injected clock and knows the stage windows; `report.ts` computes figures as a pure function of records and facts.
- `server/openai-chat-client.ts` returns only answer text: no token usage per request.

## Goals / Non-Goals

**Goals:**

- Everything in this change is testable on the virtual clock with injected fetch functions, so `npm test` needs no GPU.
- The sampler survives v0.31.0 naming the metrics differently from what we expect: a missing metric becomes "not found" in the report, and the GPU task confirms or corrects the name table.

**Non-Goals:**

- Matching a metric sample or a probe to a particular agent request.
- Metrics from anything but vLLM (no GPU telemetry, no host metrics).

## Decisions

### 1. A small Prometheus text parser and a name table with fallbacks

`parsePrometheusText(text)` reads lines `name{labels} value [timestamp]`, skips `#` lines and blanks, and returns, per metric name, the list of series values. A table maps each value we want to an ordered list of candidate names; the first candidate present wins:

| Value | Candidates (first found wins) | Across series |
|---|---|---|
| Requests running | `vllm:num_requests_running` | sum |
| Requests waiting | `vllm:num_requests_waiting` | sum |
| Cache usage | `vllm:kv_cache_usage_perc`, `vllm:gpu_cache_usage_perc` | mean |
| Prompt tokens | `vllm:prompt_tokens_total` | sum |
| Generation tokens | `vllm:generation_tokens_total` | sum |
| Prefix cache queries | `vllm:prefix_cache_queries_total` | sum |
| Prefix cache hits | `vllm:prefix_cache_hits_total` | sum |

The GPU task saves v0.31.0's real `/metrics` output as a spec fixture and corrects the table if needed. The record stores which name was used for each value.

*Alternative:* a Prometheus client library. Rejected: a dependency (with its license to check) for thirty lines of parsing, and we only read.

### 2. The sampler and the probe are loops on the run's clock

Both are started by `load-run.ts` with the first stage and stopped by the run's stop signal, like agents. Each takes the clock, a stop signal, an injected text-fetching function (real: `fetch` with `AbortSignal.timeout`), and a callback for each record. The sampler sleeps 2 s between reads; the probe sends, waits for its answer or its 10 s timeout, then sleeps until its next 10 s slot. Real timeouts use `AbortSignal.timeout` only on the real clock path; on the virtual clock the injected fetch is a fake that sleeps on the clock, so whole runs with metrics and probes still finish in milliseconds and repeat.

`metrics.jsonl` and `probe.jsonl` are written as records arrive, like `requests.jsonl`.

### 3. The pre-flight read

Before the first stage, with `--vllm-metrics`, the loader reads the metrics once. A failed read, or one in which no value of the table is found, stops the run before any request, naming the URL and `--metrics-url`. The values not found are kept for the report. This turns "pointed at Gemini" or "tunnel not open" into a clear message rather than a run full of failed samples.

### 4. The probe is a minimal chat completion, outside the product's prompts

`POST LLM_URL` with `{ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, temperature: 0 }` and `Authorization: Bearer <key>`. No system message, no examples, no `response_format`: the point is the smallest request the endpoint accepts, so its time is network, tunnel, queueing and a tiny prefill. It goes to `LLM_URL` even with `--target server`, since the server only takes the product's two routes. Probes neither take a request permit nor appear in `requests.jsonl`.

*Alternative:* `GET /health` or `/v1/models`. Rejected: they skip vLLM's scheduler, so they would hide queueing, which is the part that grows with load.

### 5. Report figures are pure functions of the samples and probes

`computeReport` gets the samples and probes (empty when the flags are off) and computes the figures of the `load-report` deltas per stage, over the same window as the client figures (after the warm-up). Rates use the first and the last successful samples in the window and the seconds between them; a counter that went down makes the rate absent. The vLLM section and the probe columns are rendered only when their flag was on. Cost per agent-hour is `price / agents`; `--price` joins the assumed inputs, marked as set.

### 6. Context-length rejections by reason text

A `failed` record whose reason matches `/maximum context length/i` is a context-length rejection. vLLM's OpenAI server answers such a request with HTTP 400 and a message containing "maximum context length is 8192 tokens"; the `llm` target's client puts it in the reason (`HTTP 400: …`), and the server target passes it on inside its 502 reason. The GPU task sends one oversized request to confirm v0.31.0's wording and keeps it as a spec fixture.

## What is simulated, what is real

| Real | Simulated |
|---|---|
| vLLM's own metrics, read through the tunnel | The agents and their typing, as before |
| The probe: a real minimal request to the real endpoint | |
| Cost: the person's hourly price | |

Left out: per-request token counts, GPU utilization and memory, the instance's network apart from what the probe sees, vast.ai's storage and bandwidth charges (cost per agent-hour is the hourly price only).

## Loader limits that can affect a figure

- **One SSH tunnel carries everything:** agents' requests, the samples and the probes. The probe's round trip includes the tunnel's share and vLLM's queue; read it next to the waiting requests of the same stage before calling it network.
- **Sample timing:** a sample is taken every 2 s on the loader's clock; a read slower than that delays the next one, and the rates use the actual seconds between samples, not 2 s per sample.
- **One Node process** runs the agents, the sampler and the probe. At 50 agents the event loop was far from busy; at 150 the sampler's and probe's timing should be checked against their records.

## Effect on the system under test, and cost

No change to `src/`, `server/`, or how vLLM is started. The probe adds one request with one output token every 10 seconds, which takes a sequence slot for a fraction of a second; `/metrics` is read every 2 seconds. Both are stated in the report, so a capacity figure carries them.

Cost: about one hour of a rented GPU for the confirmation task (about $1.50 to $2.50 at $1.43/h with load time), started by a person and ended with destroy and a status check. Everything else runs against fakes.

## Risks / Trade-offs

- [v0.31.0's metric names differ from the table] → candidates with fallbacks, "not found" in the report, the pre-flight read, and the GPU task that saves the real output as a fixture and fixes the table.
- [The context-length error wording differs] → the GPU task captures it; until then the figure may read 0 while such requests still show as `failed` with their reason.
- [A forgotten rented instance keeps billing] → the GPU task ends with `deploy/vastai/destroy.sh` and `deploy/vastai/status.sh` showing no instance.
- [The probe competes with agents for a slot] → one tiny request every 10 s against tens per second at the loads that matter; the report says it ran.

## Open Questions

- The exact metric names and the context-length wording in vLLM v0.31.0, settled by the GPU task without changing specs or tasks.

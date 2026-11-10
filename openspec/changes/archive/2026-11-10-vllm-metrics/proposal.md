# Proposal

## Why

**Tooling.** The trials against Gemini showed the loader works up to 50 agents, and that a hosted endpoint tells us nothing about one GPU: it scales behind itself, and its latency even fell as load rose. The capacity question (how many agents typing at once one vLLM instance serves before answers stop arriving in time) needs the loader to see inside the instance: whether vLLM is queueing, how many tokens a second it produces, how full its cache is, how much of each latency is the network and SSH tunnel rather than the model, and what a level of load costs per agent-hour. None of that is in the client's record. This change adds it, so the first rented run (change `first-capacity-run`) can be read on its own.

It answers no capacity question itself.

## What Changes

- **vLLM metrics sampler** (`--vllm-metrics`): every 2 seconds the loader reads vLLM's Prometheus `/metrics` (by default on the same origin as `LLM_URL`, so through the SSH tunnel; `--metrics-url` overrides) and records requests running and waiting, the prompt and generation token counters, cache usage and the prefix cache counters, as vLLM v0.31.0 names them. Every sample goes to `metrics.jsonl` in the run folder. A metric the server does not expose is reported as not found, never as zero.
- **Network probe** (`--probe`): every 10 seconds the loader sends one tiny chat completion asking for a single output token straight to `LLM_URL`, bypassing the demo server, and records its round trip in `probe.jsonl`. Its time is mostly network, tunnel and queueing, which separates distance to the host from model time. Probes are not agents' requests and are in no client figure.
- **Context-length rejections apart**: a request the endpoint refuses because the prompt is longer than the served context shows as `failed` as before, and the report counts these separately from other failures.
- **Cost per agent-hour** (`--price <$/h>`): each stage also shows the hourly price divided by its agents. The price is the person's input, listed with the assumed inputs.
- **Report**: a vLLM section per stage (queue, tokens per second, cache, prefix cache hit rate), the probe's round trip per stage, context-length rejections, and cost per agent-hour.
- A fake `/metrics` endpoint and a fake chat endpoint in the specs, so all of it is checked without a GPU.
- **One short run on a rented GPU, started by a person,** to confirm the metric names against vLLM v0.31.0 and that the probe and sampler work through the tunnel; it ends with `deploy/vastai/destroy.sh` and a status check.

## Non-goals

- The capacity run itself, the knee, and any comparison of models or GPUs (change `first-capacity-run`).
- Reading token counts per request: the server's upstream client returns only the answer text, and this change touches no product code; tokens come from vLLM's counters per stage.
- Metrics from a hosted endpoint (Gemini has no `/metrics`); the probe works against any OpenAI-compatible endpoint.
- GPU-level metrics (utilization, memory, temperature) from the instance; vLLM's own counters only.
- Changing how vLLM is started (`deploy/vastai/` in the sibling project is used as is).
- Spreading the loader over several machines.

## Cost and dependencies

- **Rented GPU: about 1 hour, started by a person.** `google/gemma-4-26B-A4B-it` on one RTX PRO 6000 WS at about $1.43/h (the sibling project's choice), so roughly $1.50 to $2.50 with the model's load time; the run itself is a few agents for a few minutes. It ends with `deploy/vastai/destroy.sh` and `deploy/vastai/status.sh` showing no instance.
- **Hosted model:** none.
- **No new dependency.** The Prometheus text format is parsed by a small function of our own; Node built-ins only.

## Capabilities

### New Capabilities

- `load-vllm`: sampling vLLM's metrics during a run, the network probe, and what each records.

### Modified Capabilities

- `load-run`: new flags (`--vllm-metrics`, `--metrics-url`, `--probe`, `--price`), and the run folder holds the metric samples and the probe record.
- `load-report`: a vLLM section, the probe's round trip, context-length rejections and cost per agent-hour per stage.

## Impact

- **New:** `tools/load/vllm-metrics.ts` (Prometheus text parsing, the sampler), `tools/load/probe.ts`, and their specs.
- **Changed:** `tools/load/settings.ts` (the four flags), `tools/load/load-run.ts` (start and stop the sampler and the probe with the run, write their files), `tools/load/report.ts` (the new figures), `CLAUDE.md`, `docs/load-test-architecture.md`.
- **Read, not changed:** `server/openai-chat-client.ts` (the probe builds its own minimal request, outside the product's prompts), `../SpellCheckingPrototype/deploy/vastai/` (how vLLM is started and tunnelled).
- **System under test:** untouched. The probe adds one tiny request every 10 seconds, and the sampler one `/metrics` read every 2 seconds, both on the instance's loopback through the tunnel; the report states that they ran.

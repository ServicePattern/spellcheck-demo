# load-vllm Specification

## Purpose

Lets a run see inside the vLLM instance it loads and measure the distance to it: vLLM's queue, token rates and cache from its own metrics, and the round trip of a minimal request, recorded alongside the agents' requests.

## Requirements

### Requirement: vLLM's metrics are sampled during the run

With `--vllm-metrics`, the loader SHALL read vLLM's Prometheus metrics every 2 seconds from the start of the first stage to the end of the run, from `--metrics-url` or, by default, from `/metrics` on the origin of `LLM_URL` (as overridden by `--url`). Each sample SHALL record its time and these values, by vLLM v0.31.0's names, each one when the endpoint exposes it:

| Value | Meaning |
|---|---|
| Requests running | Requests vLLM is generating for at that moment |
| Requests waiting | Requests vLLM has accepted and not started |
| Cache usage | Share of the KV cache in use, 0 to 1 |
| Prompt tokens | Counter of prompt tokens processed since vLLM started |
| Generation tokens | Counter of tokens generated since vLLM started |
| Prefix cache queries, prefix cache hits | Counters of prompt tokens looked up in, and found in, the prefix cache |

A value whose metric the endpoint does not expose SHALL be recorded as absent and named in the report, never as zero. When a metric has several series (one per model or engine), the requests and the counters SHALL be summed across them and the cache usage averaged. A sample that cannot be read (connection refused, timeout of 1 second, HTTP error) SHALL be recorded as failed with its reason, and sampling goes on.

Before the first stage, the loader SHALL read the metrics once; if that read fails or finds none of the values above, it SHALL stop before sending any request and name `--metrics-url`.

#### Scenario: Samples through the tunnel

- **WHEN** `npm run load -- --agents 5 --stage 60 --vllm-metrics` is run with `LLM_URL=http://127.0.0.1:8000/v1/chat/completions`
- **THEN** about 30 samples are read from `http://127.0.0.1:8000/metrics` and written to `metrics.jsonl`, each with its time and the six kinds of value

#### Scenario: Metric not exposed

- **WHEN** the endpoint exposes no prefix cache counters
- **THEN** the samples hold no prefix cache values, and the report says the prefix cache metrics were not found

#### Scenario: Endpoint with no metrics

- **WHEN** `--vllm-metrics` is used with `LLM_URL` of a hosted endpoint that has no `/metrics`
- **THEN** the loader stops before sending any request, naming the URL it tried and `--metrics-url`

#### Scenario: A sample fails mid-run

- **WHEN** one read of `/metrics` times out during the second stage
- **THEN** that sample is recorded as failed with the reason, and the next sample is read 2 seconds later

### Requirement: A probe measures the round trip to the model

With `--probe`, the loader SHALL send every 10 seconds, from the start of the first stage to the end of the run, one chat completion straight to `LLM_URL` with `MODEL` and `LLM_API_KEY`: a one-word user message, no system message, and at most one output token. Each probe SHALL record its send time, its round trip in milliseconds, and its outcome (`answered`, or `failed` with the reason), in `probe.jsonl`. A probe that has not answered after 10 seconds is ended as `failed` with the reason `timeout`, so at most one probe runs at a time.

Probes SHALL NOT count against `--max-requests` and SHALL NOT appear in any client figure; the report shows them in their own figures.

#### Scenario: Probe through the server target

- **WHEN** `npm run load -- --target server --agents 3 --stage 60 --probe` is run
- **THEN** the agents' requests go through the demo server, and about 6 probes go straight to `LLM_URL`, each with its round trip in `probe.jsonl`

#### Scenario: Probe against a hosted model

- **WHEN** `--probe` is used with `LLM_URL` of a hosted OpenAI-compatible endpoint
- **THEN** the probes are sent there and answered, with no metrics read

#### Scenario: Probe outside the cap

- **WHEN** `--max-requests 50 --probe` is used
- **THEN** exactly 50 agents' requests are sent, and probes are sent in addition until the run ends

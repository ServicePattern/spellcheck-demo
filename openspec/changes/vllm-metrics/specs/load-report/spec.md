# Spec Delta

## ADDED Requirements

### Requirement: With vLLM metrics the report shows the instance per stage

For a run with `--vllm-metrics`, the report SHALL give per stage, over the samples taken in the stage after its warm-up that were read successfully:

| Figure | Definition |
|---|---|
| Samples | Number of samples read, and number failed |
| Running, mean and max | Mean and highest of the samples' requests running |
| Waiting, mean and max | Mean and highest of the samples' requests waiting |
| Cache usage, mean and max | Mean and highest of the samples' cache usage, as a percentage |
| Prompt tokens per second | Prompt tokens counter at the last sample less at the first, divided by the seconds between those two samples |
| Generation tokens per second | The same for the generation tokens counter |
| Prefix cache hit rate | Increase of the prefix cache hits counter divided by the increase of the queries counter between the first and the last sample |

A rate needs two successful samples in the window and a counter that did not decrease between them (a decrease means vLLM restarted, and the figure is absent). A figure whose metric was not found, or with too few samples, SHALL be shown as absent, and the report SHALL name the metrics not found. These are measured results, shown in a section of their own after the client tables. Runs without `--vllm-metrics` have no such section.

#### Scenario: Queue builds up

- **WHEN** in the third stage of `--agents 10,25,50 --stage 180 --vllm-metrics` the samples after warm-up have requests waiting of 0, 4, 12 and 8
- **THEN** that stage's waiting is mean 6 and max 12

#### Scenario: Tokens per second

- **WHEN** a stage's first sample after warm-up has a generation tokens counter of 120,000 and its last, 148 seconds later, of 150,000
- **THEN** the stage's generation tokens per second is 202.7

#### Scenario: Counter reset

- **WHEN** the generation tokens counter falls between the first and the last sample of a stage
- **THEN** the stage's generation tokens per second is absent

### Requirement: With the probe the report shows the round trip per stage

For a run with `--probe`, the report SHALL give per stage, over the probes sent in the stage after its warm-up: the number of probes, the number failed, and the round trip p50, p95 and max (nearest rank) of the answered ones. These sit next to the client's latency for the same stage, so the share of latency that is distance can be read.

#### Scenario: Probe round trip

- **WHEN** a stage's answered probes took 180, 190, 200, 210 and 950 ms
- **THEN** the stage's probe round trip is p50 200 ms, p95 950 ms, max 950 ms

#### Scenario: No probes answered

- **WHEN** every probe of a stage failed
- **THEN** the stage's probe round trip figures are absent, and the number failed is shown

### Requirement: Context-length rejections are counted apart

A `failed` request whose reason says the prompt exceeds the model's context length (vLLM's `maximum context length` error, passed on by the demo server for the `server` target) SHALL be counted in a figure of its own per stage: context-length rejections, divided by counted requests. It stays a `failed` request in every other figure.

#### Scenario: Context too long

- **WHEN** a stage has 200 counted requests, of which 6 failed, 2 of them with vLLM's error that the prompt exceeds the maximum context length of 8192 tokens
- **THEN** the stage's failed share is 3.0% and its context-length rejections 1.0%

### Requirement: With a price the report shows the cost per agent-hour

With `--price`, the report SHALL give per stage the cost per agent-hour: the price divided by the stage's agents, in dollars to three decimals. The price SHALL be listed with the assumed inputs, as set by the person, apart from the measured figures.

#### Scenario: Cost per agent-hour

- **WHEN** a run uses `--price 1.43 --agents 10,25,50`
- **THEN** its stages show $0.143, $0.057 and $0.029 per agent-hour, and the assumed inputs list `--price 1.43` as set

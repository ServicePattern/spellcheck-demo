# load-report Specification

## Purpose

Turns a run's request record into the figures a person reads to judge capacity, with every figure defined and the assumed inputs kept apart from what was measured.

## Requirements

### Requirement: Figures are computed per stage over counted requests

The report SHALL give its figures for each stage. A stage's counted requests are the requests sent in that stage after its warm-up, without those that ended as `cut`. Figures are given for all counted requests of the stage and separately per request kind (spell check, auto-completion) and per language (English, Arabic).

| Figure | Definition |
|---|---|
| Requests | Number of counted requests |
| Rounds per second | Request rounds started after warm-up, divided by the stage time less the warm-up |
| Useful answer rate | Counted requests with outcome `answered`, divided by counted requests |
| Aborted, timeout, failed, unreadable | Counted requests with that outcome, divided by counted requests |
| Latency p50, p95, p99 | Percentiles (nearest rank) of latency over counted requests with outcome `answered` or `unreadable` |
| Empty completions | Answered auto-completion requests whose completion was empty, divided by answered auto-completion requests |
| In flight, mean and max | Number of requests running at once, averaged over the stage time less the warm-up, and its highest value in that time |

A figure with nothing to divide by, or no latency to rank, SHALL be shown as absent, not as zero.

#### Scenario: Useful answer rate

- **WHEN** a stage of `--target fake --agents 5 --stage 120 --warmup 20` has 200 counted requests: 150 answered, 40 aborted, 6 timeout, 2 failed, 2 unreadable
- **THEN** its useful answer rate is 75.0%, aborted 20.0%, timeout 3.0%, failed 1.0%, unreadable 1.0%

#### Scenario: Warm-up and cut requests left out

- **WHEN** a stage has 30 requests sent in warm-up and 4 requests cut at the end of the run
- **THEN** none of the 34 is in any figure of the stage

#### Scenario: Latency percentiles

- **WHEN** a stage's answered and unreadable requests have latencies of 100, 200, 300, …, 1000 ms (ten requests)
- **THEN** p50 is 500 ms, p95 is 1000 ms and p99 is 1000 ms

#### Scenario: Per language

- **WHEN** a stage ran English and Arabic agents (`--arabic-share 0.5`)
- **THEN** the report has the stage's figures for English requests and for Arabic requests, as well as for all

#### Scenario: Nothing answered

- **WHEN** no counted request of a stage was answered or unreadable
- **THEN** the stage's latency percentiles are shown as absent

### Requirement: The report shows the typing the model produced

The report SHALL show, per stage, what the typing inputs actually produced, so the assumptions can be compared with real data: the gap between the starts of one agent's successive rounds (p25, p50, p75, over rounds started after warm-up), the allowed time of counted requests (p25, p50, p75), and the share of time agents spent on a message as opposed to between messages.

#### Scenario: Gaps between rounds

- **WHEN** a stage of `--target fake --agents 10 --stage 180` finishes with the default typing inputs
- **THEN** the report gives the p25, p50 and p75 of the gap between rounds for that stage

### Requirement: Assumed inputs are kept apart from measured results

The report SHALL list the assumed inputs (the typing settings and the language mix, with their values, marking those left at their defaults) in a section of their own, apart from the measured figures. It SHALL state the target, and for the `fake` target say that the latencies are the fake's own and mean nothing about any model.

#### Scenario: Assumed inputs section

- **WHEN** a run used `--wpm 55` and left the other typing inputs at their defaults
- **THEN** the report's assumed inputs list `--wpm 55` as set and the others as defaults, in a section separate from the stage figures

#### Scenario: Fake target

- **WHEN** a run used `--target fake`
- **THEN** the report says at its top that the answers and latencies came from the built-in fake

### Requirement: The report gives figures, not a verdict

The report SHALL NOT mark a stage or a run as passed or failed, and SHALL NOT name a capacity or a knee. It reports the figures of every stage that ran.

#### Scenario: Saturated stage

- **WHEN** a stage's useful answer rate is 12% and its timeouts are 40%
- **THEN** the report shows those figures like any other stage's, with no pass or fail mark

### Requirement: The report is written in two forms

The report SHALL be written as `report.md` for reading (one table of stages for all requests, one per request kind, one per language, then the typing produced, the assumed inputs and the run's facts) and as `report.json` holding the same figures and facts as data. The stage table for all requests SHALL also be printed when the run ends.

#### Scenario: Both files agree

- **WHEN** a run of `--target fake --agents 2,5 --stage 60` finishes
- **THEN** every figure in `report.md` is in `report.json` with the same value, for both stages

### Requirement: With the server target the report shows the upstream calls

For a run with `--target server`, the report SHALL give per stage, for all upstream calls and separately per request kind, these figures over the upstream calls read from the server's log whose start falls in the stage after its warm-up:

| Figure | Definition |
|---|---|
| Upstream calls | Number of those upstream calls |
| Upstream answered, upstream errors | Upstream calls that ended with an answer, or with an error, divided by upstream calls |
| Upstream latency p50, p95, p99 | Percentiles (nearest rank) of the upstream calls' durations |
| Unused upstream calls | Upstream calls less the counted client requests of the same stage and kind whose answer the client received (outcome `answered`, `unreadable` or `failed` with an HTTP status), divided by upstream calls; never below zero |
| Upstream time | Sum of the upstream calls' durations, in seconds |

Unused upstream calls are the calls the server finished for a client that had stopped waiting (outcome `aborted`, `timeout` or `cut`). A figure with nothing to divide by or rank SHALL be shown as absent. These figures are measured, and are shown in a section of their own after the client stage tables. Runs with another target have no such section.

#### Scenario: Aborted requests paid upstream

- **WHEN** a stage of `--target server --agents 3 --stage 180` has 60 counted requests, 32 received by the client and 28 aborted, and the server's log has 60 upstream calls starting in that stage after warm-up
- **THEN** the stage's unused upstream calls are 46.7%, and its upstream calls are 60

#### Scenario: Upstream and client latency side by side

- **WHEN** a stage's answered client requests have p50 latency 760 ms and its upstream calls p50 718 ms
- **THEN** the report shows both, the client figure in the stage table and the upstream figure in the upstream section, for the same stage

#### Scenario: Not a server run

- **WHEN** a run used `--target llm`
- **THEN** the report has no upstream section

#### Scenario: Requests without an upstream line

- **WHEN** 2 requests sent in a server run have no upstream line when the server is stopped
- **THEN** the report's run facts say that 2 requests had no upstream line

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

### Requirement: With GPU sampling the report shows the card per stage

For a run with `--gpu-ssh`, the report SHALL give per stage, over the GPU samples taken in the stage after its warm-up that were read successfully, and over all GPUs of the instance:

| Figure | Definition |
|---|---|
| Samples | Number of samples read, and number failed |
| Utilization, mean and max | Mean and highest of the utilization values, in percent |
| Memory used, max | Highest memory used, in GiB, and that as a share of the total |
| Power, mean and max | Mean and highest power draw, in watts |
| Temperature, max | Highest temperature, in degrees Celsius |

A figure with no value to compute from SHALL be shown as absent. These are measured results, in a section of their own after the client tables; the GPU's name and driver head the section. Runs without `--gpu-ssh` have no such section.

#### Scenario: Utilization rises with load

- **WHEN** in the fourth stage of `--agents 25,50,100,200,300 --stage 180 --gpu-ssh …` the samples after warm-up have utilization 40, 70, 95 and 75%
- **THEN** that stage's utilization is mean 70% and max 95%

#### Scenario: Memory as a share

- **WHEN** a stage's highest memory used is 88,000 MiB on a card of 97,887 MiB
- **THEN** the stage's memory used max is 85.9 GiB and 89.9%

#### Scenario: No GPU sampling

- **WHEN** a run did not use `--gpu-ssh`
- **THEN** the report has no GPU section

### Requirement: The report shows the loader's own delay per stage

On the real clock, the report SHALL give per stage the delay of the loader's event loop: p99 and max in milliseconds, measured over the stage after its warm-up. This shows whether the loader itself fell behind, which would delay requests, rounds and samples and make the figures of that stage unreliable. On the virtual clock the figures SHALL be absent.

#### Scenario: Loader keeping up

- **WHEN** a stage of 300 agents has an event loop delay p99 of 12 ms
- **THEN** the report shows 12 ms for that stage, next to its agents

#### Scenario: Virtual clock

- **WHEN** a run uses the virtual clock in a spec
- **THEN** the event loop delay figures are absent

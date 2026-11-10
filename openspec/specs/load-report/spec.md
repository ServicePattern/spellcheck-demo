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

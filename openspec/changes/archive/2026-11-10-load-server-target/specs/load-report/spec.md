# Spec Delta

## ADDED Requirements

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

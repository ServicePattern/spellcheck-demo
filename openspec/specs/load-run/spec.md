# load-run Specification

## Purpose

Runs a load test from one command: applies the simulated agents to a target in stages, records every request, and leaves a run folder that says exactly what was run.

## Requirements

### Requirement: One command starts a run

`npm run load -- --agents <levels> [flags]` SHALL start a run. `--agents` is required: one number or a comma-separated list of rising numbers, each a stage's count of agents. Other run flags:

| Flag | Default | Meaning |
|---|---|---|
| `--target` | `llm` | `llm`, `server` or `fake` |
| `--stage` | 180 | Seconds per stage |
| `--warmup` | 30 | Seconds at the start of each stage left out of the figures; less than `--stage` |
| `--seed` | 1 | Seed of the typing |
| `--chats` | `../SpellCheckingPrototype/eval/completion/sources` | Chat sources folder |
| `--max-requests` | none | Stop the run once this many requests have been sent |
| `--out` | `tools/load/runs` | Where run folders are made |
| `--trace` | off | Also record the text sent and the raw answers |
| `--model`, `--url` | from the environment | Override `MODEL` and `LLM_URL` |

#### Scenario: Smallest run

- **WHEN** `npm run load -- --target fake --agents 2 --stage 60` is run
- **THEN** one stage of 2 agents runs for 60 seconds, of which the first 30 are warm-up, and a run folder is written

#### Scenario: No agents given

- **WHEN** the command is run without `--agents`
- **THEN** it stops with a message showing the usage and sends nothing

#### Scenario: Levels not rising

- **WHEN** `--agents 10,5` is given
- **THEN** it stops with a message that the levels must rise and sends nothing

#### Scenario: Unknown target

- **WHEN** `--target vllm` is given
- **THEN** it stops with a message naming `llm`, `server` and `fake`, and sends nothing

### Requirement: Targets

With `--target llm` the loader SHALL send each request to the OpenAI-compatible chat completions endpoint at `LLM_URL`, with `MODEL` and `LLM_API_KEY`, read from the environment or the git-ignored `.env`, in the same form the demo server sends it.

With `--target server` the loader SHALL send each request to the demo server, which it starts for the run with the same LLM settings, through the server's routes as the page sends them (see the `load-server` capability).

With `--target fake` the loader SHALL answer each request itself, with no network call and no key: a well-formed answer for the request's kind after a delay (`--fake-latency-ms`, default 600, the median of a long-tailed spread drawn from the seed).

#### Scenario: Hosted model

- **WHEN** `.env` holds `LLM_URL` of a hosted OpenAI-compatible endpoint, its `MODEL` and `LLM_API_KEY`, and `npm run load -- --agents 3 --stage 180 --max-requests 300` is run
- **THEN** the requests go to that endpoint with the spell check or auto-completion system message and examples, and the answers are parsed as the assistant parses them

#### Scenario: Hosted model through the server

- **WHEN** `.env` holds the same settings and `npm run load -- --target server --agents 3 --stage 180 --max-requests 300` is run
- **THEN** the requests go to the server's routes, the server sends them on to that endpoint with the same system messages and examples, and the answers are parsed as the assistant parses them

#### Scenario: Missing settings

- **WHEN** `--target llm` or `--target server` is used and `LLM_API_KEY`, `MODEL` or `LLM_URL` is not set
- **THEN** the loader stops before sending any request and names what is missing

#### Scenario: Fake target without a key

- **WHEN** `npm run load -- --target fake --agents 5 --stage 60` is run with no `.env`
- **THEN** the run completes, and no request leaves the machine

### Requirement: Load rises in stages

Each stage SHALL run its count of agents for the stage time. Agents of earlier stages keep running; a new stage adds agents up to its count. Each new agent starts typing after its own delay, drawn from the seed and spread over the first part of the stage, so agents do not pause in step. Stages run to their end whatever the results: there is no early stop.

A request belongs to the stage in which it was sent. A request sent during a stage's warm-up is recorded and left out of the figures.

#### Scenario: Three stages

- **WHEN** `npm run load -- --target fake --agents 2,5,10 --stage 120 --warmup 20` is run
- **THEN** 2 agents run for 120 s, then 5 (the first 2 and 3 new), then 10, and the run lasts about 360 s

#### Scenario: Warm-up

- **WHEN** a request is sent 12 s into a stage with `--warmup 20`
- **THEN** its record is marked as warm-up and no figure counts it

#### Scenario: Poor results

- **WHEN** in the second of three stages most requests time out
- **THEN** the third stage still runs

### Requirement: Every request is recorded with its outcome

For every request sent, the run SHALL record: stage, agent, request kind (spell check or auto-completion), language, time sent, outcome, latency, allowed time, the sizes in characters of the user message and of the answer, and whether it was sent in warm-up. For an answered request it also records how many mistakes were reported or whether the completion was empty.

Outcome is exactly one of:

| Outcome | Meaning |
|---|---|
| `answered` | An answer arrived before the agent resumed and before the timeout, and it parsed |
| `unreadable` | An answer arrived in time and could not be parsed as the expected JSON |
| `aborted` | The agent resumed typing, or sent the message, before an answer arrived |
| `timeout` | No answer within the request timeout |
| `failed` | The target returned an error or the connection failed |
| `cut` | The run or the request cap ended while the request was running |

Latency is the time from sending to the outcome. Allowed time is the time from sending until the agent would resume typing.

The record SHALL hold no request or answer text unless `--trace` is set. The LLM key SHALL never be written to the run folder or printed.

#### Scenario: Answered spell check

- **WHEN** an English spell check request is answered after 850 ms with two mistakes, and the agent would have resumed after 1600 ms
- **THEN** its record has outcome `answered`, latency 850, allowed time 1600, language English, and 2 mistakes

#### Scenario: Unreadable answer

- **WHEN** an auto-completion answer arrives in time and is not valid JSON
- **THEN** its record has outcome `unreadable`

#### Scenario: Target error

- **WHEN** the endpoint answers a request with HTTP 429
- **THEN** its record has outcome `failed` and the reason, and the run goes on

#### Scenario: Records without text

- **WHEN** a run finishes without `--trace`
- **THEN** no line of the request record holds draft, context or answer text

#### Scenario: Trace

- **WHEN** a run uses `--trace`
- **THEN** a separate trace file in the run folder holds each request's user message and raw answer

### Requirement: A request cap stops a run

With `--max-requests N`, the run SHALL stop when N requests have been sent: no further request is sent, running requests are ended as `cut`, and the report is written for what was done, saying that the cap stopped the run.

#### Scenario: Cap reached

- **WHEN** `npm run load -- --agents 3 --stage 180 --max-requests 50` is run against a hosted model
- **THEN** exactly 50 requests are sent, the run ends early, and the report states it was stopped by the request cap

### Requirement: The run folder says what was run

Each run SHALL write a new folder under `--out`, named by its start time, holding the request record, the report in Markdown and JSON, and the run's facts: seed, every setting (assumed inputs included), target, model and the endpoint's host, chat sources with counts, the commit of the repository and whether it had uncommitted changes, start time and duration. With `--target server` the facts also hold the server's port, how the server ended (stopped by the loader, or exited on its own with its code), the number of requests sent with no upstream line, and every line the server printed that is not an upstream call line.

#### Scenario: Folder contents

- **WHEN** a run finishes
- **THEN** its folder holds `requests.jsonl`, `report.md` and `report.json`, and `report.json` holds the seed, settings, target, model, endpoint host, sources and commit

#### Scenario: Server facts

- **WHEN** a run with `--target server --agents 2 --stage 60` finishes
- **THEN** `report.json` also holds the server's port, that the loader stopped it, the count of requests with no upstream line, and the server's start-up line

#### Scenario: Server exits during a run

- **WHEN** the server process exits in the middle of the first stage
- **THEN** later requests end as `failed`, the run goes on to its end, and the report states that the server exited and with which code

#### Scenario: Interrupted run

- **WHEN** a run is interrupted from the keyboard during its second stage
- **THEN** running requests end as `cut`, and the folder still gets the request record and a report covering what ran, marked as interrupted

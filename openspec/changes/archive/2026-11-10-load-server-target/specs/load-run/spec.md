# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Two targets`
- TO: `### Requirement: Targets`

## MODIFIED Requirements

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

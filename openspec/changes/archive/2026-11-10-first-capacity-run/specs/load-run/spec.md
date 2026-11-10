# Spec Delta

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
| `--vllm-metrics` | off | Sample vLLM's metrics every 2 s (see the `load-vllm` capability) |
| `--metrics-url` | `/metrics` on the origin of `LLM_URL` | Where vLLM's metrics are read |
| `--probe` | off | Send a one-token probe straight to `LLM_URL` every 10 s |
| `--price` | none | Hourly price of the instance in dollars, for the cost per agent-hour |
| `--gpu-ssh` | none | `<user>@<host>:<port>` of the instance, to sample its GPU with `nvidia-smi` every 2 s (see the `load-gpu` capability) |

`--vllm-metrics`, `--metrics-url` and `--probe` need a target that reaches an LLM (`llm` or `server`); with `--target fake` the loader stops and names the flag. `--price` must be a positive number. `--gpu-ssh` must have the form `<user>@<host>:<port>` with a port from 1 to 65535, and is accepted with any target.

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

#### Scenario: Metrics with the fake target

- **WHEN** `--target fake --vllm-metrics` is given
- **THEN** it stops with a message that `--vllm-metrics` needs the `llm` or `server` target, and sends nothing

#### Scenario: Bad price

- **WHEN** `--price 0` or `--price abc` is given
- **THEN** it stops naming `--price` and sends nothing

#### Scenario: Bad GPU address

- **WHEN** `--gpu-ssh root@73.97.224.215` is given, with no port
- **THEN** it stops naming `--gpu-ssh` and the expected form, and sends nothing

### Requirement: The run folder says what was run

Each run SHALL write a new folder under `--out`, named by its start time, holding the request record, the report in Markdown and JSON, and the run's facts: seed, every setting (assumed inputs included), target, model and the endpoint's host, chat sources with counts, the commit of the repository and whether it had uncommitted changes, start time and duration. With `--target server` the facts also hold the server's port, how the server ended (stopped by the loader, or exited on its own with its code), the number of requests sent with no upstream line, and every line the server printed that is not an upstream call line. With `--vllm-metrics` the folder also holds `metrics.jsonl`, one line per sample, and the facts hold the metrics URL and the metrics not found. With `--probe` the folder also holds `probe.jsonl`, one line per probe. With `--gpu-ssh` the folder also holds `gpu.jsonl`, one line per GPU sample, and the facts hold the GPU's name, driver version and total memory, and when and why the GPU session ended if it ended early. None of these files holds the LLM key.

#### Scenario: Folder contents

- **WHEN** a run finishes
- **THEN** its folder holds `requests.jsonl`, `report.md` and `report.json`, and `report.json` holds the seed, settings, target, model, endpoint host, sources and commit

#### Scenario: Server facts

- **WHEN** a run with `--target server --agents 2 --stage 60` finishes
- **THEN** `report.json` also holds the server's port, that the loader stopped it, the count of requests with no upstream line, and the server's start-up line

#### Scenario: Metrics and probe files

- **WHEN** a run with `--agents 5 --stage 60 --vllm-metrics --probe` finishes against vLLM
- **THEN** its folder also holds `metrics.jsonl` and `probe.jsonl`, and `report.json` holds the metrics URL and the list of metrics not found (empty when all were found)

#### Scenario: Server exits during a run

- **WHEN** the server process exits in the middle of the first stage
- **THEN** later requests end as `failed`, the run goes on to its end, and the report states that the server exited and with which code

#### Scenario: Interrupted run

- **WHEN** a run is interrupted from the keyboard during its second stage
- **THEN** running requests end as `cut`, and the folder still gets the request record and a report covering what ran, marked as interrupted

#### Scenario: GPU facts

- **WHEN** a run with `--gpu-ssh` finishes
- **THEN** its folder also holds `gpu.jsonl`, and `report.json` holds the GPU's name, driver version and total memory

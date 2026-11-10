# Spec Delta

## ADDED Requirements

### Requirement: An abort check shows whether aborted requests stop in vLLM

`npm run load:abort-check` SHALL send 20 chat completions straight to `LLM_URL` (with `MODEL` and `LLM_API_KEY`, `--url` and `--model` over them), each asking for a long answer (at most 600 output tokens), and abort all of them 2 seconds after sending. It SHALL read vLLM's requests running (from `/metrics` on the origin of `LLM_URL`, or `--metrics-url`) just before sending, just before the abort, and 1 and 3 seconds after it, and print those four counts with the time of each reading. It SHALL say that the check is unclear when the count just before the abort is not at least 10 higher than before sending (the generations were not running, so the abort shows nothing); otherwise that aborts reach vLLM when the count 3 seconds after the abort is at most the count before sending, that they do not when it is still at least 10 higher, and that the check is unclear in between. It sends no other request and writes no file.

#### Scenario: Aborts reach vLLM

- **WHEN** the check runs against vLLM through the SSH tunnel and generation stops when a connection closes
- **THEN** it prints running counts such as 0, 20, 0 and 0, and says that aborts reach vLLM

#### Scenario: Aborts do not reach vLLM

- **WHEN** the check runs against an endpoint that keeps generating after the connection closes
- **THEN** it prints running counts such as 0, 20, 20 and 20, and says that aborts do not reach vLLM

#### Scenario: Generations already over

- **WHEN** the endpoint answers every generation within a second, so the running count just before the abort is 0
- **THEN** it prints running counts such as 0, 0, 0 and 0, and says the check is unclear

#### Scenario: No metrics

- **WHEN** the check runs against an endpoint without vLLM's metrics
- **THEN** it stops before sending anything, naming the URL it tried and `--metrics-url`

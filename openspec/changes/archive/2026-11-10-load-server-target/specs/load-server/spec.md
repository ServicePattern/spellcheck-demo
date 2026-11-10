# Spec Delta

## Purpose

Puts the demo server between the simulated agents and the LLM, so a run loads the whole path the page uses and shows the upstream calls the server makes, including those whose answers nobody receives.

## ADDED Requirements

### Requirement: The loader starts the server for the run and stops it after

With `--target server` the loader SHALL start the demo server itself, as the product runs it, on `127.0.0.1` at a free port, before sending any request, and stop it when the run ends. The server gets the LLM settings the `llm` target would use (`LLM_URL`, `MODEL`, `LLM_API_KEY`, and `--model`, `--url` over them) and Basic auth credentials made up for this run. The loader SHALL wait until the server says it is listening and answers as the server started for this run (its credentials accepted); if it exits, does not listen within 15 seconds, or another process answers on its port, the loader stops before sending any request and shows what the server printed.

#### Scenario: Server started and stopped

- **WHEN** `npm run load -- --target server --agents 2 --stage 60` is run with the LLM settings in `.env`
- **THEN** a server process listens on `127.0.0.1` before the first request, every request goes to it, and no server process is left running after the run

#### Scenario: Missing settings

- **WHEN** `--target server` is used and `LLM_API_KEY`, `MODEL` or `LLM_URL` is not set
- **THEN** the loader stops before starting the server and names what is missing

#### Scenario: Server fails to start

- **WHEN** the server exits during start-up, for example because its port was taken
- **THEN** the loader stops before sending any request, with the server's own output in the message

#### Scenario: Credentials stay in memory

- **WHEN** a server run finishes, with or without `--trace`
- **THEN** neither the made-up Basic auth credentials nor `LLM_API_KEY` appear in the run folder or in the loader's output

### Requirement: Requests go through the server's routes as the page sends them

With `--target server`, each spell check request SHALL be posted to `/api/autocorrection` and each auto-completion request to `/api/autocompletion`, with the body `{"userMessage": "..."}` built as for every target and the run's Basic auth header. The server's response SHALL be read as the page reads it: a 200 with a non-empty `answer` is the answer; any other status is an error `HTTP <status>`, followed by the body's `error` when it has one. Aborting a request closes its connection, as the page's abort does.

#### Scenario: English spell check through the server

- **WHEN** an English agent's round sends its spell check request and the server answers 200 with `{"answer": "{\"mistakes\": []}"}`
- **THEN** the request is posted to `/api/autocorrection` with the agent's user message, and it ends as `answered` with 0 mistakes

#### Scenario: Arabic auto-completion through the server

- **WHEN** an Arabic agent's round sends its auto-completion request
- **THEN** the request is posted to `/api/autocompletion` with the Arabic user message unchanged, `‸` included

#### Scenario: Upstream error

- **WHEN** the server answers 502 with `{"error": "HTTP 429: rate limited"}`
- **THEN** the request ends as `failed` with the reason `HTTP 502: HTTP 429: rate limited`

#### Scenario: Unreachable LLM

- **WHEN** the server was started with an `LLM_URL` nothing listens on, and `npm run load -- --target server --agents 1 --stage 10 --warmup 1 --wpm 400` is run
- **THEN** every request reaches the server, every request not cut at the end of the run ends as `failed` with an `HTTP 502` reason, the server's log has an upstream line for every request sent, and the run folder and report are written

### Requirement: The server's log is read into upstream calls

The loader SHALL read every line the server prints. A line of the form `<kind>: <outcome> in <n> ms` is an upstream call of that kind (`spell-check` or `auto-completion`) that ended when the line arrived, after `n` ms, as `answered` or as the error text given. The upstream call's start is the line's arrival less `n`. Other lines are kept as server output.

When the run ends, the loader SHALL wait for the server to print the line of every request it sent, at most the request timeout plus 5 seconds, before stopping it. The report says how many requests sent have no upstream line.

#### Scenario: Upstream call after an abort

- **WHEN** an agent resumes typing 800 ms after its auto-completion request was sent, and the upstream call answers after 1500 ms
- **THEN** the client record has outcome `aborted`, and an `auto-completion` upstream call of 1500 ms is read from the server's log about 700 ms later

#### Scenario: Upstream error line

- **WHEN** the server prints `spell-check: HTTP 429: rate limited in 210 ms`
- **THEN** one `spell-check` upstream call of 210 ms with the error `HTTP 429: rate limited` is read

#### Scenario: Waiting for the last lines

- **WHEN** a run ends with 3 requests still running upstream
- **THEN** the loader waits until the server has printed their 3 lines, or the wait has run out, and only then stops the server

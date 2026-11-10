# Design

## Context

See `proposal.md` for the motivation and `docs/load-test-architecture.md` for the loader as built by `load-generator`.

**Target of this change: the demo server**, with a hosted OpenAI-compatible model behind it for the trial. vLLM is not involved.

What the code gives us:

- `server/index.ts` starts at import: it reads `LLM_API_KEY`, `MODEL`, `LLM_URL`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` and `PORT` from the environment (and exits naming the first one missing), binds `127.0.0.1:$PORT`, prints `http://127.0.0.1:<port>, serving <dist>` once it listens, and prints `<kind>: <answered | error text> in <n> ms` when each upstream call ends. Without `--dev` it does not read `.env` and does not need `dist/` for the API routes.
- It passes only `AbortSignal.timeout(20000)` upstream: a client that closes its connection does not stop the upstream call (review finding 1).
- `src/app/lib/llm-client.ts` exports `API_ROUTES` and the page's `apiLLMClient`, which posts relative URLs (`api/autocorrection`) and relies on the browser for Basic auth, so Node cannot use it as is.
- The loader's `Target` (`tools/load/targets.ts`) is built synchronously and hands out one `LLMClient` per agent; `load-run.ts` runs the stages on an injected clock and writes the run folder.

## Goals / Non-Goals

**Goals:**

- One command runs loader → server → LLM, with nothing to start by hand and nothing left running.
- The upstream calls the server makes are counted from the server's own output, without touching `server/`.
- The client side of the server target is testable with no key and no network beyond `127.0.0.1`.

**Non-Goals:**

- Per-request matching of upstream calls to client requests (the server's lines carry no id).
- Running the server target on the virtual clock: a real process needs real time.

## Decisions

### 1. The loader spawns `server/index.ts` as the product runs it

`spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'])` with stdout and stderr piped, and an environment made of `PATH` plus exactly the six variables the server reads. `LLM_*` come from the same place as for the `llm` target (`--model` and `--url` win); `PORT` is a free port found by listening on port 0 and closing; `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are random per run (`crypto.randomBytes`) and live only in memory.

Ready means the start-up line `http://127.0.0.1:<port>` arrived **and** a probe with the run's credentials (`POST /api/autocorrection` with `{}`, which the server answers 400 without calling upstream) got 400. The probe is needed because the server prints its start-up line even when it cannot bind: Express 5 hands the listen error to the `app.listen` callback, which ignores it, and the process then exits with no message. Only the server started for this run knows the random credentials, so a 400 proves the port is ours. An exit, no line within 15 s, or a failed probe stops the run before any request, with the server's output in the message (that is how `requireEnv`'s message reaches the person).

Stopping: `SIGTERM`, then `SIGKILL` after 5 s. A `finally` around the run and a process `exit` hook make sure no server outlives the loader, Ctrl-C included.

*Alternatives:* a server already running (`--server-url`): two terminals, the person's credentials in `.env`, and no log to read; rejected by the person choosing the approach. Importing the Express app in-process: `index.ts` starts at import and exports nothing, and the server would share the loader's event loop, which skews the very latency we want to see.

### 2. The client mirrors the page's `apiLLMClient`, with a base URL and Basic auth

A new `LLMClient` posts `JSON.stringify({ userMessage })` to `http://127.0.0.1:<port>/` + `API_ROUTES[kind]` (imported, so a route rename breaks the loader loudly), with `Authorization: Basic …`, and maps the response exactly as `apiLLMClient` does: non-2xx → `HTTP <status>` plus `: <body.error>` when present; 2xx with a non-empty `answer` → the answer; otherwise `body.error` or `empty answer`; a thrown fetch → `<name>: <message>`. Its spec checks each branch against a small local HTTP stub.

The agent's outcome rules are unchanged: `failed` carries the reason, so a 502 shows the upstream reason the server passed on.

*Alternative:* change `apiLLMClient` to take a base URL and headers. Rejected: it is product code, and this change touches none.

### 3. Upstream calls are read from the server's lines, timed on the loader's clock

Each stdout line is matched against `^(spell-check|auto-completion): (.*) in (\d+) ms$` (greedy, so an error text containing " in " still parses). A match becomes an upstream call `{ kind, endedAtMs: clock.now(), durationMs, error? }` (`answered` means no error), with `startedAtMs = endedAtMs - durationMs`. Anything else, stderr included, is kept as server output for the run facts.

Pipe delivery adds a few milliseconds to `endedAtMs`; it only shifts which stage a call near a boundary falls in.

### 4. The run waits for the server's last lines

After the agents stop, `load-run.ts` asks the target to finish: wait until the server has printed as many upstream lines as requests were sent, or the request timeout plus 5 s has passed, then stop the server. The shortfall goes into the facts as requests with no upstream line. Because the server never cancels, cut and aborted requests do produce lines, usually within a second or two.

### 5. Targets may need starting and finishing

`createTarget` becomes async. `Target` gains an optional `finish(sentRequests)` and optional `facts()`; the `llm` and `fake` targets have neither, and their behaviour and specs are unchanged. `load-run.ts` creates the target before the run folder (so a server that fails to start leaves no folder), and calls `finish` in a `finally` before computing the report.

### 6. The report gets an upstream section computed from the calls

`computeReport` takes the upstream calls (empty for other targets) and adds per stage, for all and per kind: upstream calls, answered and error shares, latency p50/p95/p99 (nearest rank), unused share, and upstream time in seconds. A call belongs to the stage in which it started, and counts when its start is after the warm-up, the same window as the client figures. "Received by the client" = counted records with outcome `answered`, `unreadable`, or `failed` whose reason starts with `HTTP `. The section is rendered only when the target is `server`, as its own table after the client tables, and `report.json` holds the same figures.

## What is simulated, what is real

| Real | Simulated |
|---|---|
| The demo server process, its auth, routes, prompts, timeout and log | The agents and their typing, as before |
| The upstream LLM calls the server makes, including those it does not cancel | The browser: one Node process with a shared connection pool stands in for many browsers |

Left out: the browser's limit of six connections per origin and its own connection reuse, TLS and ngrok in front of the server, the page itself (`dist/` is not built or fetched), several server processes.

## Loader limits that can affect a figure

- **The server runs on the same machine as the loader.** At this change's scale (a few agents) both are idle most of the time; at larger scales they compete for CPU, and the server's added latency will include that. The run facts name the machine's load only implicitly; later capacity runs should watch for it.
- **Two 20 s timeouts race** (review finding 6): a call slower than 20 s ends either as a client `timeout` or as a `failed` 502 from the server, whichever fires first.
- **Log timing** comes over a pipe, a few milliseconds late (decision 3).

## Effect on the system under test, and cost

No change to `server/` or `src/`. The server is run as `npm run server` runs it, on `127.0.0.1`, only for the length of a run, with throwaway credentials.

Cost: every request sent through the server is billed upstream, aborted ones included. The trial (3 agents, 180 s, about 80 requests) stays at a few cents on `gemini-3.5-flash-lite`.

## Risks / Trade-offs

- [The server's log format is not a contract] → the parser is in one function with its own spec; a line that stops matching shows up as "requests with no upstream line" equal to all requests, which the report states, not as silent zeros.
- [An orphaned server process keeps a port and, with a real key, could keep calling upstream] → `finally`, the exit hook, and `SIGKILL` after 5 s; the spec checks the process is gone after a run.
- [The spec that starts the real server makes `npm test` spawn a process] → it uses an `LLM_URL` on a closed local port, a short run, and a fast typing speed, so it takes seconds and touches no network.
- [Credentials or the key leaking into the run folder] → credentials exist only in the child's environment and the client; the spec searches the run folder and the loader's output for both.

## Open Questions

- Whether the start-up wait of 15 s is enough on a cold machine. It can be raised without changing specs or tasks.

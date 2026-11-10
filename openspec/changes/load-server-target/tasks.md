# Tasks

## 1. Targets that start and finish

- [x] 1.1 Accept `server` in `--target` (`tools/load/settings.ts`, usage text); verify with `settings.spec.ts` that `--target server` parses and `--target vllm` stops naming `llm`, `server` and `fake`
- [x] 1.2 Make `createTarget` async and give `Target` an optional `finish(sentRequests)` and `facts()`; call them from `load-run.ts` (target created before the run folder, `finish` in a `finally`); verify the existing `targets.spec.ts` and `load-run.spec.ts` pass unchanged in behaviour

## 2. Server log and client

- [x] 2.1 Implement `parseServerLine` in `tools/load/server-target.ts`: `<kind>: <outcome> in <n> ms` → upstream call with kind, duration and error, anything else → server output; verify with `server-target.spec.ts` for `answered`, an error text containing " in ", the start-up line, and a malformed line
- [x] 2.2 Implement the server client: posts `{ userMessage }` to the base URL plus `API_ROUTES[kind]` with Basic auth, and maps the response as `apiLLMClient` does; verify against a local `node:http` stub: the route per kind, the auth header, the body (an Arabic user message with `‸` unchanged), 200 with an answer, 200 with an empty answer, 502 with `{ error }`, 401 with no body, an HTML 400, a closed port, and an abort closing the connection

## 3. Starting and stopping the server

- [x] 3.1 Implement starting the server: free port, random credentials, an environment of `PATH` plus the six variables, the wait for the start-up line (15 s), the stop with `SIGTERM` then `SIGKILL`, the exit hook; missing LLM settings named before spawning; verify with a spec that starts the real `server/index.ts` with `LLM_URL` on a closed local port, sees it listen, stops it and finds the process gone, and one where the port is already taken and the error shows the server's output
- [x] 3.2 Implement `finish`: wait until the server printed as many upstream lines as requests were sent, at most the request timeout plus 5 s, then stop it; record the port, how the server ended (stopped, or exited with its code), the count with no upstream line, and the other lines it printed; verify with a spec that a server killed mid-run is reported as exited with its code and later requests end as `failed`
- [x] 3.3 End-to-end without a key: `--target server --agents 1 --stage 10 --warmup 1 --wpm 400` against the real server with an unreachable `LLM_URL`, on the real clock; verify with `load-run.spec.ts` that every request not cut ends as `failed` with an `HTTP 502` reason, there is an upstream line for every request sent, the run folder is written, and neither the credentials nor the key appear in it or in the logged output

## 4. Report

- [x] 4.1 Add the upstream figures to `computeReport` as a pure function of the upstream calls and the records: per stage, all and per kind, upstream calls, answered and error shares, latency p50/p95/p99, unused share (never below zero), upstream time; verify with `report.spec.ts` for the 60 upstream / 32 received / 46.7% scenario, absent figures with no calls, and the warm-up window
- [x] 4.2 Render the upstream section in `report.md` after the client tables only for the server target, put the same figures and the server facts in `report.json`, and state the requests with no upstream line; verify with spec cases that an `llm` report has no upstream section and that every upstream figure in the Markdown matches the JSON

## 5. Documentation

- [x] 5.1 Document `--target server` in `CLAUDE.md` (the `npm run load` row and the `tools/load/` layout) and in `docs/load-test-architecture.md` (how the server is started, what the upstream section means, what the simulation leaves out, the loader's limits); verify the documented commands match the flags as built

## 6. Trial through the server (spends money: run by a person)

- [x] 6.1 **Costs a few cents; a person runs it.** With the Gemini settings in the git-ignored `.env`, run `npm run load -- --target server --agents 3 --stage 180 --max-requests 300`; verify the run folder is written, no server process is left (`pgrep -f server/index.ts` prints nothing), the upstream section is filled, and any `failed` reasons are read from the record
- [x] 6.2 Write the trial into `docs/load-test-architecture.md`: date, model, settings, the client and upstream stage tables, the unused upstream share next to the client's abort share, and what it showed about the loader and the server path (not capacity); verify the section names which inputs were assumed
- [x] 6.3 Run `npm run typecheck` and `npm test`; verify both pass. No instance was rented, so there is nothing to destroy

# Proposal

## Why

**Tooling.** The loader can load an LLM directly, but agents never call the LLM directly: their requests go through the demo server (`server/index.ts`), which adds Basic auth, the prompts, its own 20 s timeout, and one known cost. When the page aborts a request, the server lets the upstream call run to the end (finding 1 in `docs/server-architecture-and-review.md`). A load test that skips the server cannot show what the whole path costs, nor how many upstream calls are paid for and thrown away. This change makes the server a target, so later capacity runs can compare the model alone with the path agents actually use.

It answers no capacity question itself.

## What Changes

- A third target, `--target server`: the loader starts the demo server as a child process (`node server/index.ts`) on a free local port, with the LLM settings it would use for `--target llm` and Basic auth credentials it makes up for the run, waits until it listens, sends every request to `/api/autocorrection` or `/api/autocompletion` as the page does, and stops the server when the run ends.
- **Upstream calls from the server's own log.** The server already prints one line per request when its upstream call ends (`spell-check: answered in 718 ms`). The loader reads those lines and reports, per stage, how many upstream calls finished, their latency, and how many of them the client never used (it had aborted, timed out or been cut), next to the client figures.
- **Server facts in the run folder:** that the server target was used, the server's port, its exit, and lines it printed that are not request lines (errors at start-up, for example). The made-up credentials are never written.
- A spec that starts the real server with an unreachable `LLM_URL` and checks the whole client side (auth, routes, the 502 mapping, log capture, stopping the server) with no key and no network beyond `127.0.0.1`.
- One short trial through the server against Gemini, started by a person.
- `CLAUDE.md` and `docs/load-test-architecture.md` describe the target.

## Non-goals

- **Any change to `server/` or `src/`.** Fixing finding 1 (cancelling the upstream call) is change `server-cost-fixes`; this change measures the server as it is.
- A fake upstream LLM over HTTP for free end-to-end runs. The whole path is checked by the spec above (with a failing upstream) and by the Gemini trial.
- Matching each server log line to the client request it served: the server's lines carry no request id, so upstream figures are counts and percentiles per stage and kind, not per request.
- A server already running elsewhere (`--server-url`), several server processes, or loading the page itself.
- vLLM metrics, the network probe, cost per agent-hour (change `vllm-metrics`); any rented GPU.

## Cost and dependencies

- **No rented GPU.** Zero GPU hours.
- **Hosted model.** One trial through the server: 3 agents for 180 s, about 80 requests of roughly 3,500 input tokens, capped with `--max-requests`. Because the server does not cancel, every request is billed, aborted ones included: still a few cents on `gemini-3.5-flash-lite`. Started by a person.
- **No new dependency.** Node built-ins (`node:child_process`, `node:net`, `node:http` in specs) only.

## Capabilities

### New Capabilities

- `load-server`: starting and stopping the demo server for a run, sending requests through its routes as the page does, and reading its log into upstream calls.

### Modified Capabilities

- `load-run`: `--target` takes `server`; the "Two targets" requirement becomes "Targets" with the server target; the run folder also records the server's facts.
- `load-report`: with the server target, each stage also shows the upstream calls the server made and how many the client never used.

## Impact

- **New:** `tools/load/server-target.ts` (starting the server, the client for its routes, reading its log) and its spec.
- **Changed:** `tools/load/settings.ts` (`server` as a target), `tools/load/targets.ts`, `tools/load/load-run.ts` (start and stop the server around the stages, wait for its last log lines), `tools/load/report.ts` (upstream figures), `CLAUDE.md`, `docs/load-test-architecture.md`.
- **Read, not changed:** `server/index.ts` (its log line format and start-up line are now relied on), `src/app/lib/llm-client.ts` (`API_ROUTES` and the response mapping the loader mirrors).
- **System under test:** untouched. The server runs as the product runs it, on `127.0.0.1` only, for the length of a run.

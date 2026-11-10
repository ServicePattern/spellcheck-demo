# Proposal

## Why

Nothing can yet apply this demo's traffic to an LLM at more than one person's typing speed, so the capacity question (how many agents typing at once one instance serves before answers stop arriving in time) cannot be asked. Generic load tools miss what defines the traffic: two parallel requests after each pause, each with the full context, aborted when typing resumes.

This change is **tooling**: it builds the load generator and proves it works. It answers no capacity question itself; that starts with the first run on a rented GPU (change `first-capacity-run`).

## What Changes

- A load generator in `tools/load/`, run as `npm run load -- --agents <levels> [flags]`.
- **Chat scripts.** It reads the synthetic support chats of `../SpellCheckingPrototype` (English and Arabic) and turns every agent turn into a message to type, with the conversation before it.
- **Virtual agents.** Each one types its message in bursts with typos, pauses, sends the assistant's spell check and auto-completion requests after the debounce, aborts what is still running when typing resumes, accepts a share of the completions, and waits between messages. A seed fixes all of it.
- **Real requests.** Request text comes from the assistant's own message builders and the server's upstream client with its prompts, imported, not copied.
- **Two targets.** `llm`: any OpenAI-compatible chat completions endpoint, from `LLM_URL`, `MODEL` and `LLM_API_KEY`. `fake`: a built-in stand-in that answers after a set delay, with no network and no key.
- **Stepped load.** Agents are added in stages; each stage has a warm-up left out of the figures.
- **A record and a report per run.** One line per request, and per stage the useful answer rate, latency percentiles, aborts, timeouts, failures, unreadable answers, requests in flight, and the gaps between rounds the typing model actually produced. Figures only: no pass rule, no verdict, no early stop.
- **A request cap** (`--max-requests`) so a run against a hosted model cannot run away.
- `npm test` also runs the spec files under `tools/`.
- `CLAUDE.md` and `docs/load-test-architecture.md` describe the command.

## Non-goals

- The demo server as a target (change `load-server-target`).
- vLLM metrics, the network probe, cost per agent-hour (change `vllm-metrics`).
- Any run against a rented GPU, and any capacity figure.
- Any change to `src/` or `server/`.
- Simulating what the assistant does with an answer beyond accepting a completion: no auto-correction of the draft, no popover, no undo.
- Replacing the assumed typing numbers with measured ones.

## Cost and dependencies

- **No rented GPU.** Zero GPU hours.
- **Hosted model.** One short trial run against Gemini through its OpenAI-compatible endpoint: 3 agents for 3 minutes is about 200 requests of roughly 3,500 input tokens each, a few cents on a Flash-Lite model. Started by a person, capped with `--max-requests`.
- **No new dependency.** Node built-ins only; the test runner is the Playwright already in the project.

## Capabilities

### New Capabilities

- `load-scripts`: reading the synthetic chats into message scripts and building the LLM context each request carries.
- `load-agent`: the simulated agent: seeded typing with typos, pauses, request rounds, aborts, accepting completions, moving between messages.
- `load-run`: the command, its targets and stages, the per-request record, the run folder, the request cap.
- `load-report`: the figures of a run, how each is defined, and how assumed inputs are kept apart from measured results.

### Modified Capabilities

None. The project has no specs yet.

## Impact

- **New:** `tools/load/` (the loader and its spec files), `npm run load` in `package.json`, `tools/load/runs/` in `.gitignore`.
- **Changed:** `playwright.config.ts` so `npm test` finds spec files under `tools/` as well as `src/`; `tools/eval/spell-check.ts` to take its import resolve hook from a file shared with the loader; `CLAUDE.md` (command table, layout); `docs/load-test-architecture.md` (as built).
- **Read, not changed:** `src/assistant/llm.ts`, `server/openai-chat-client.ts` and its prompts, `src/app/lib/presets.ts`; in the sibling project `eval/completion/sources/support-en.txt` and `support-ar.txt`.
- **System under test:** untouched. The only load this change applies is the trial run against a hosted model.

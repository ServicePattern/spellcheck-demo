# Design

## Context

See `proposal.md` for the motivation and `docs/load-test-architecture.md` for the overall loader design across all planned changes. This change builds the core: scripts, agent, run, report, with the `llm` and `fake` targets.

What the code gives us to build on:

- `src/assistant/llm.ts` exports `buildSpellCheckMessage`, `buildAutoCompletionMessage`, `parseMistakes` and `parseAutoCompletion` as pure functions. Its only import is a type, so Node can load it directly.
- `server/openai-chat-client.ts` exports `createOpenAIChatClient(apiKey, model, url)`, an `LLMClient` that adds the system message and examples by request kind and never throws. It returns only the answer text: no token counts.
- `src/app/lib/presets.ts` holds each preset's LLM context as one string of blocks separated by blank lines, one of which starts with `Conversation:`.
- `tools/eval/spell-check.ts` shows the pattern: run by Node directly, flags with `parseArgs`, `.env` through `--env-file-if-exists`, a resolve hook that adds `.ts` to extensionless imports.
- `playwright.config.ts` has `testDir: 'src'`, so a spec file under `tools/` is not run today.
- The chat sources use `Customer:` / `Agent:` in English and `العميل:` / `الموظف:` in Arabic, `---` between conversations, `#` for comments.

**Target of this change:** an OpenAI-compatible endpoint called directly (a hosted Gemini model for the trial) and the built-in fake. Neither vLLM nor the demo server is involved yet.

## Goals / Non-Goals

**Goals:**

- A whole run can be tested in milliseconds and gives the same record every time.
- The agent's request behavior can be checked against `src/assistant/check-while-typing.ts` rule by rule.
- The report can be computed from the request record alone.

**Non-Goals:**

- Token counts, server-side metrics, cost figures (change `vllm-metrics`).
- Spreading the loader over several processes or machines.
- Tuning the typing inputs to real data.

## Decisions

### 1. Everything time-related goes through an injected clock

Agents, the fake target and the stage scheduler take a clock (`now()`, `sleep(ms, signal)`). A real run uses the real clock. Tests use a virtual clock: sleeps are queued by wake time, and a driver wakes the earliest one, lets pending promises settle, and repeats.

With the fake target on the virtual clock, a three-stage run of ten agents finishes in well under a second and writes the same record for the same seed. That is what makes the agent's timing rules testable (a 2600 ms pause sends at exactly 1000 ms and aborts at exactly 2600 ms).

*Alternative:* real timers with shortened durations in tests. Rejected: slow, and timing assertions become flaky ranges.

### 2. One agent is one async loop

An agent is a function that loops over its message scripts: burst, pause, optional round, resume; then send and wait. It is given its clock, its `LLMClient`, its random streams and a `record(request)` callback, and a stop signal. It holds no global state, so N agents are N calls.

A round creates one `AbortController`. The agent races the round's requests against the end of its pause; when the pause wins, it aborts the controller. The request timeout is a second signal per request.

**Outcome is decided by the loader, not read from the error text.** The agent knows which of its signals fired first (resume, timeout, stop), so `aborted`, `timeout` and `cut` are exact; `failed` is an error with none of them fired.

### 3. Seeded random streams, one per agent and purpose

A small seeded generator (mulberry32) with streams derived from `(seed, agent number, purpose)`: script order, typing, typos, rounds, accepting. Separate streams mean a change in one decision (an accepted completion shortens the message) does not shift the typos of later messages, and adding agents never changes the earlier ones.

Durations are drawn log-normally from their median (pause, time between messages, fake latency), which gives the long tail without more flags. The spread of each is a constant in the typing model, not a flag; the report shows what the model produced, which is the check that matters. Words per burst are a rounded log-normal, at least 1.

### 4. Typos by a small injector of our own

One edit per chosen word: swap two neighbouring letters, drop a letter, or double a letter. Works on any script's letters, skips words with digits or under four letters. The sibling project's injector is not used: it needs its Hunspell pipeline and its taxonomy is for measuring spell checkers, which is not our purpose.

*Left out by the simulation:* the draft keeps its typos. In the page, a sure mistake is auto-corrected and stops being reported; here it is reported in every later round of the message. Spell check answers are therefore a little longer than in real use, which errs on the side of more load.

### 5. The LLM context is the preset with its conversation swapped

Split the preset's context on blank lines, replace the block that starts with `Conversation:` by the script's turns, join again. The other blocks give the request its real size (about 4 KB in English). If the block is missing, stop with an error: a silent fallback would send requests of the wrong size.

### 6. The `llm` target is the server's upstream client, unchanged

`createOpenAIChatClient` is the `llm` target as is. The loader therefore sends exactly what the demo server sends: same prompts, temperature 0.2, JSON response format, no output cap. Anything we want different (an output cap, extra body fields) is a product change to measure, not a loader option.

The `fake` target is another `LLMClient`: it sleeps on the clock for a drawn latency, honours the abort signal, and returns a well-formed answer for the kind (a mistakes list sized to the typos in the draft, or a short completion; a small share of empty completions).

### 7. The report is a pure function of the record and the run's facts

`requests.jsonl` is written as requests end. The report takes the records plus the facts (settings, stages, times) and returns the figures; writing Markdown and JSON are two renderings of that one result. In-flight counts come from the records' send times and latencies, not from sampling during the run.

This keeps the report testable with hand-made records, and means a later change can add figures without rerunning anything.

### 8. Loader modules import with `.ts` extensions; the resolve hook is shared

The loader's own files import each other with `.ts`, as `server/` does. The eval's resolve hook moves to one shared file under `tools/` that both entry points call, so an extensionless runtime import appearing in `src/assistant/` later does not break the loader. This touches `tools/eval/spell-check.ts` (tooling, not product).

### 9. `npm test` covers `tools/`

`playwright.config.ts` gets `testDir: '.'` with `testMatch` for `src/**/*.spec.ts` and `tools/**/*.spec.ts`. The loader's specs run in Node like those of `src/assistant/`. First task: a trivial spec under `tools/load/` proves Playwright picks it up and resolves `.ts` imports.

### 10. Files

| File | Holds |
|---|---|
| `tools/load/run.ts` | Entry: flags, settings check, stages, cap, interrupt, writing the run folder |
| `tools/load/settings.ts` | The settings with defaults, parsing and validation |
| `tools/load/chats.ts` | Chat sources → conversations → message scripts |
| `tools/load/context.ts` | Preset + conversation so far → LLM context |
| `tools/load/random.ts` | Seeded generator, streams, log-normal draw |
| `tools/load/typing-model.ts` | Bursts, pauses, speeds, round and accept draws |
| `tools/load/typos.ts` | The typo injector |
| `tools/load/clock.ts` | Real and virtual clock |
| `tools/load/targets.ts` | The `llm` and `fake` `LLMClient`s |
| `tools/load/agent.ts` | The agent loop |
| `tools/load/recorder.ts` | Request records, `requests.jsonl`, trace |
| `tools/load/report.ts` | Figures, `report.md`, `report.json` |

Each pure file has its `<file>.spec.ts` next to it. Code follows `CLAUDE.md`'s conventions.

## What is simulated, what is real

| Real | Simulated |
|---|---|
| The user messages (assistant's builders) | When requests are sent (typing model) |
| The system messages and examples (server's client) | What the agent types (chat scripts, typos) |
| The HTTP request to the endpoint, the abort | Accepting a completion (a draw; the draft takes script words) |
| Parsing the answers (assistant's parsers) | The time between messages |

Left out: auto-correction changing the draft, the popover, undo and redo, Escape, input methods, multi-line drafts (the caret is never on a new line), edits other than the spell-check-only rounds, and any link between an answer arriving and the agent's next pause (a real agent may wait for a suggestion; here pauses are drawn in advance).

## Risks / Trade-offs

- **The typing inputs are assumed** → every report lists them apart from the results and shows the gaps the model produced; real numbers replace them in a later change.
- **A hosted model rate-limits or rejects a field** (Gemini's OpenAI-compatible endpoint with `response_format` and `temperature`) → such requests show as `failed` with the reason; the trial is small and capped. If the endpoint rejects the request form outright, the trial uses another hosted OpenAI-compatible model; the loader does not change.
- **One Node process** → at this change's scale (a handful of agents) timers and sockets are far from any limit. The limit matters from `first-capacity-run` on, where in-flight counts and timer lag should be watched.
- **Virtual clock subtleties** (a promise that settles outside the clock stalls the driver) → only the clock, never a real timer, is used in agents and the fake; the whole-run spec would hang visibly, with Playwright's timeout as the backstop.
- **The fake target hides real failure modes** → it exists to test the loader, and the report says so at its top.
- **Reading files outside the repository** (`../SpellCheckingPrototype`) → the path is a flag, a missing folder is a clear error, and the report names the files read.

## Effect on the system under test, and cost

None on `src/` or `server/`. The only load applied is the Gemini trial: about 200 requests, a few cents, started by a person with `--max-requests`.

## Open Questions

- The spreads of the log-normal draws (pause, time between messages) are first guesses. They can be adjusted after looking at the produced gaps in the first reports without changing specs or tasks.
- Whether the Gemini endpoint accepts the request form unchanged is settled by the trial run itself.

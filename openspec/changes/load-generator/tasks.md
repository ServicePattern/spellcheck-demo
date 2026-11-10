# Tasks

## 1. Scaffolding

- [x] 1.1 Set `playwright.config.ts` to `testDir: '.'` with `testMatch` for `src/**/*.spec.ts` and `tools/**/*.spec.ts`; verify `npm test` still runs the 42 existing tests and they pass
- [x] 1.2 Move the import resolve hook from `tools/eval/spell-check.ts` into a shared file under `tools/` and call it from the eval; verify `node tools/eval/spell-check.ts` without settings still prints its "Set LLM_API_KEY…" message (the imports resolve)
- [x] 1.3 Add `tools/load/random.ts` (seeded generator, streams by seed, agent and purpose, log-normal draw from a median) with `random.spec.ts`; verify the spec passes under `npm test`, which also proves specs under `tools/` are found and `.ts` imports resolve
- [x] 1.4 Add the `load` script to `package.json` and `tools/load/runs/` to `.gitignore`; verify `git status` ignores a file made in that folder

## 2. Chat scripts and context

- [x] 2.1 Implement `tools/load/chats.ts`: sources folder → conversations → message scripts, with the English and Arabic labels, `---`, comments, and the errors for an unrecognized line and a missing folder; verify with `chats.spec.ts` covering every scenario of the load-scripts spec's first two requirements (English, Arabic, Arabic with Latin text, comments, bad line, missing folder, conversation so far)
- [x] 2.2 Add a spec that reads the real sources at the default path and checks 137 English and 173 Arabic agent turns, skipped with a clear message when the sibling project is not there; verify it passes locally
- [x] 2.3 Implement `tools/load/context.ts`: preset with its `Conversation:` block replaced, custom dictionary from the preset, error when the block is missing; verify with `context.spec.ts` for the English and the Arabic preset that every other block is unchanged

## 3. Typing model and typos

- [x] 3.1 Implement `tools/load/settings.ts`: every flag of the load-agent and load-run specs with its default, parsing, and validation (shares in 0–1, positive durations and counts, rising `--agents`, `--warmup` below `--stage`); verify with `settings.spec.ts` for defaults, each kind of bad value, and the named flag in each error
- [x] 3.2 Implement `tools/load/typos.ts`: swap, drop or double one letter in words of four or more letters without digits, English and Arabic; verify with `typos.spec.ts` (English word, Arabic word, `SI-48213` untouched, short word untouched, same seed gives the same variant)
- [x] 3.3 Implement `tools/load/typing-model.ts`: per-agent speed within ±25%, words per burst, pause, time between messages, spell-check-only and accept draws, the agent's language; verify with `typing-model.spec.ts` that draws repeat for a seed, differ across seeds, agents 1 and 2 are the same whether 2 or 5 agents exist, and medians over many draws land near the settings

## 4. Clock and targets

- [x] 4.1 Implement `tools/load/clock.ts`: the real clock and the virtual clock with its driver, both with abortable sleep; verify with `clock.spec.ts` that virtual sleeps wake in time order, an aborted sleep rejects at once, and a virtual hour passes in milliseconds
- [x] 4.2 Implement `tools/load/targets.ts`: the `llm` target from `createOpenAIChatClient` with the check for `LLM_API_KEY`, `MODEL`, `LLM_URL`, and the `fake` target (latency drawn from the seed on the clock, honours abort, well-formed answer per kind, some empty completions); verify with `targets.spec.ts` that the fake's answers parse with `parseMistakes` and `parseAutoCompletion`, an aborted fake request ends at the abort time, and missing settings are named

## 5. Agent

- [x] 5.1 Implement the typing part of `tools/load/agent.ts`: bursts of whole words with typos kept for the message, burst time from characters and speed, short pauses without requests; verify with `agent.spec.ts` on the virtual clock (the `Thank you. I` burst, a 700 ms pause sends nothing)
- [x] 5.2 Implement request rounds: both requests at the debounce with the caret at the end, the spell-check-only round with the caret at an earlier word boundary, user messages from the assistant's builders with the script's context and custom dictionary; verify with spec cases for a 2600 ms pause (sent at 1000 ms), an English spell check message and an Arabic auto-completion message ending in the draft with `‸`
- [x] 5.3 Implement outcomes: abort on resume, the request timeout, `failed`, `unreadable`, `cut` on stop, each decided from the agent's own signals, with latency and allowed time; verify with spec cases for answer in time, answer too late, one of two in time, timeout in a long pause, a failing client, an unparseable answer
- [x] 5.4 Implement accepting a completion (draft moves ahead by the completion's word count, at most to the end, then a new pause) and the message cycle (last pause, send, time between messages, next turn with the conversation so far, next conversation of the agent's language); verify with spec cases for an accepted completion, an empty one, one longer than the rest, the next turn's context, an Arabic agent taking only Arabic conversations
- [x] 5.5 Compare the agent's rules with `src/assistant/check-while-typing.ts` (debounce start, both requests under one abort, abort on input, the auto-completion condition) and note in `docs/load-test-architecture.md` any rule the agent does not follow; verify the note lists each rule as followed or left out

## 6. Record and report

- [x] 6.1 Implement `tools/load/recorder.ts`: one line per request in `requests.jsonl` with the fields of the load-run spec, no text, and the separate trace file with `--trace`; verify with `recorder.spec.ts` that a record has every field, holds no draft or answer text, and the trace holds both
- [x] 6.2 Implement the figures in `tools/load/report.ts` as a pure function of records and run facts: counted requests, rounds per second, useful answer rate, outcome shares, nearest-rank percentiles, empty completions, in flight mean and max, per stage, kind and language, absent values where nothing can be computed; verify with `report.spec.ts` using hand-made records for every scenario of the load-report spec's first requirement
- [x] 6.3 Add the typing produced (gaps between rounds, allowed time, share of time on a message), the assumed inputs section with set and default values, the fake target notice, and the run's facts; verify with spec cases for `--wpm 55` shown as set and the fake notice at the top
- [x] 6.4 Render `report.md` and `report.json` from the same result and print the all-requests stage table; verify with a spec that every figure in the Markdown is in the JSON with the same value and that no stage carries a pass or fail mark

## 7. The run

- [ ] 7.1 Implement `tools/load/run.ts`: flags to settings, reading the scripts, stages that add agents with their start delays, warm-up marking, the run folder with facts (seed, settings, target, model, endpoint host, sources with counts, commit and uncommitted state, start and duration), never the key; verify with `run.spec.ts` on the virtual clock and the fake target that `--agents 2,5,10 --stage 120 --warmup 20` runs three stages of 2, 5 and 10 agents and writes the three files
- [ ] 7.2 Implement the request cap and the keyboard interrupt: no further requests, running ones end as `cut`, the report is written and says why the run ended; verify with spec cases for `--max-requests 50` (exactly 50 sent) and an interrupt in the second stage
- [ ] 7.3 Add the repeatability spec: two virtual-clock runs with `--target fake --agents 3 --stage 60 --seed 7` write identical `requests.jsonl`, and a run with `--seed 8` differs; verify it passes
- [ ] 7.4 Dry run in real time against the fake target: `npm run load -- --target fake --agents 2,5 --stage 60 --warmup 10`; verify it takes about two minutes, sends nothing over the network, and the report's gap between rounds has a median within a few seconds of the 6 s the defaults aim at (adjust the draws' spreads if far off, and rerun the specs)
- [ ] 7.5 Document the command: the `npm run load` row and the `tools/load/` layout in `CLAUDE.md`, and in `docs/load-test-architecture.md` the flags as built, the outcomes, and what the simulation leaves out; verify the documented dry-run command runs as written

## 8. Trial against a hosted model (spends money: run by a person)

- [ ] 8.1 **Costs a few cents; a person runs it.** Put the Gemini settings in the git-ignored `.env` (`LLM_API_KEY`, `MODEL`, `LLM_URL` of its OpenAI-compatible chat completions endpoint), then `npm run load -- --agents 3 --stage 180 --max-requests 300`; verify the run folder is written, most counted requests are `answered` or `aborted`, and any `failed` or `unreadable` share has its reasons read from the record
- [ ] 8.2 Write the trial's outcome into `docs/load-test-architecture.md`: the date, the model, the settings, the stage table, and what it showed about the loader (not about capacity); verify the section names which inputs were assumed
- [ ] 8.3 Run `npm run typecheck` and `npm test`; verify both pass. No instance was rented in this change, so there is nothing to destroy

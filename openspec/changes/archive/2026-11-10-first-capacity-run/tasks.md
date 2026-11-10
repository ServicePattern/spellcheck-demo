# Tasks

## 1. GPU sampling

- [x] 1.1 Add `--gpu-ssh` to `tools/load/settings.ts` and the usage text: `<user>@<host>:<port>`, port 1 to 65535, any target; verify with `settings.spec.ts` for a good value, no port, a port of 0 and of 70000, each error naming `--gpu-ssh` and the form
- [x] 1.2 Implement `parseGpuLine` and the GPU facts parser in `tools/load/gpu.ts`: index, utilization, memory used and total, power, temperature; `[N/A]` leaves a value absent; a wrong field count is a failed reading with its text; verify with `gpu.spec.ts` on lines copied from `nvidia-smi`'s CSV output, an `[N/A]` power, a short line, and a name line with a comma-free GPU name
- [x] 1.3 Implement the GPU session: the injected command (default the `ssh` invocation of the design), the check before the run with its 15 s limit, the long session read line by line on the run's clock, its end recorded with when and why, the stop with `SIGTERM` then `SIGKILL`, the exit hook; verify with spec cases using a local `node -e` stand-in: readings arrive and are timed, a stand-in that exits early is recorded as ended with its reason, a failing check names `--gpu-ssh` and the error, and no process is left after stop

## 2. Run and report

- [x] 2.1 Start the GPU check before the run and the session with the first stage from `load-run.ts`, write `gpu.jsonl`, and put the GPU's name, driver, total memory and any early end in the facts; verify with `load-run.spec.ts` on the virtual clock with the stand-in: the file is written, the facts hold the GPU, a failing check leaves no run folder
- [x] 2.2 Add the event loop delay meter: created by `run.ts` on the real clock, reset at the end of each stage's warm-up and read at its end, carried in the stage plans; verify with a spec that a run with a meter whose values are given reports them per stage, and a run without one has them absent
- [x] 2.3 Add the GPU figures and the loader figures to `report.ts` (samples read and failed, utilization mean and max, memory used max in GiB and as a share, power mean and max, temperature max; event loop delay p99 and max) and render the GPU section and the loader table; verify with `report.spec.ts` for the 70% mean and 95% max scenario, 85.9 GiB and 89.9%, absent figures, no GPU section without `--gpu-ssh`, and every new figure in the Markdown matching the JSON

## 3. Abort check

- [x] 3.1 Implement the verdict rule as a pure function and the command `tools/load/abort-check.ts` with the `load:abort-check` script: 20 long generations straight to `LLM_URL`, the four running counts, abort at 2 s, the printed counts and verdict, the metrics check first; verify with `abort-check.spec.ts`: the verdict for 0/20/0/0, 0/20/20/20, 0/20/12/8 and 0/0/0/0 (generations already over), the request body (`max_tokens: 600`), and the whole command against a local stub that stops generation on close and one that does not

## 4. Dry run without a GPU

- [x] 4.1 Dry run in real time against local fakes: the scratchpad fake vLLM from `vllm-metrics`, extended to count open connections as running, and a local stand-in for `--gpu-ssh`'s command; run `npm run load -- --agents 25,50 --stage 60 --warmup 10 --vllm-metrics --probe --price 1.5` with the stand-in, and `npm run load:abort-check` against the fake; verify the run folder holds `gpu.jsonl`, the report has the GPU section and the loader table, the event loop delay is shown per stage, and the abort check prints its counts and verdict, all with nothing leaving the machine

## 5. Documentation

- [x] 5.1 Document `--gpu-ssh`, the GPU and loader figures and `npm run load:abort-check` in `CLAUDE.md` and `docs/load-test-architecture.md`, and write the run plan for the rented session there (the order of design decision 6, the commands, the 3-hour cap); verify the documented commands match the flags as built

## 6. The capacity run on a rented GPU (spends money: run by a person)

- [x] 6.1 **Spends money from here; a person runs it.** In `../SpellCheckingPrototype`: `deploy/vastai/status.sh` (renew the CLI's 2FA with `uvx vastai==1.8.3 tfa send-email` and `tfa login` if it is refused), `deploy/vastai/search.sh --min-gb 80`, then `deploy/vastai/start.sh <offer> google/gemma-4-26B-A4B-it` on an RTX PRO 6000 WS, `deploy/vastai/tunnel.sh` (kept open), `deploy/vastai/check.sh`, and `uvx vastai==1.8.3 ssh-url <instance>` for `--gpu-ssh`; verify `check.sh` reports the model ready and note the instance's price and the time of renting
- [x] 6.2 **Same session.** With `LLM_URL=http://127.0.0.1:8000/v1/chat/completions`, `MODEL=google/gemma-4-26B-A4B-it` and any non-empty `LLM_API_KEY`, run `npm run load -- --agents 25,50,100,200,300 --stage 180 --warmup 30 --vllm-metrics --probe --gpu-ssh <user@host:port> --price <$/h>`; verify the run completes all five stages, `gpu.jsonl`, `metrics.jsonl` and `probe.jsonl` are written, and the event loop delay of each stage is noted
- [x] 6.3 **Same session.** Run `npm run load:abort-check`; verify it prints the four counts and a verdict, and note them
- [x] 6.4 **Same person, at once, and in any case before 3 hours from renting.** `deploy/vastai/destroy.sh`, then `deploy/vastai/status.sh`; verify it lists no instance, and note the money spent
- [x] 6.5 Write the capacity results into `docs/load-test-architecture.md`: date, card, model, vLLM version, price, the stage tables (client, vLLM, probe, GPU, loader, cost), the abort check's counts and verdict, the money spent, which inputs were assumed, and the stage where the useful answer rate and the queue change, as read from the figures by the person; verify the section keeps the figures apart from that reading and names the assumed inputs
- [x] 6.6 Run `npm run typecheck` and `npm test`; verify both pass, and confirm once more with `deploy/vastai/status.sh` that no instance is running

# Tasks

## 1. Flags

- [x] 1.1 Add `--vllm-metrics`, `--metrics-url`, `--probe` and `--price` to `tools/load/settings.ts` and the usage text, with the checks: the first three only with `--target llm` or `server`, `--price` a positive number; verify with `settings.spec.ts` for the defaults, `--target fake --vllm-metrics`, `--price 0` and `--price abc`, each error naming its flag

## 2. Metrics

- [x] 2.1 Implement `parsePrometheusText` and the name table with candidates in `tools/load/vllm-metrics.ts`: series values per name, sums for requests and counters, the mean for cache usage, absent values, the name used; verify with `vllm-metrics.spec.ts` on a hand-written vLLM-style text (comments, labels, two engines, a metric missing, the older cache name)
- [x] 2.2 Implement the sampler on the clock with an injected fetch: a read every 2 s from the first stage to the run's end, a 1 s timeout, failed samples recorded with their reason, the pre-flight read with its errors; verify with spec cases on the virtual clock: about 30 samples in 60 s, a failed read in the middle, a pre-flight against an endpoint with no metrics naming `--metrics-url`, and the default URL from `LLM_URL` and `--url`

## 3. Probe

- [x] 3.1 Implement the probe in `tools/load/probe.ts`: the minimal chat completion to `LLM_URL` with the key, every 10 s, one at a time, the 10 s timeout, answered or failed with the reason; verify with `probe.spec.ts` against a local `node:http` stub: the body (one user message, `max_tokens: 1`, no system message), the auth header, about 6 probes in 60 s on the virtual clock with a fake fetch, a slow answer ended as `timeout`, an HTTP 500 as failed

## 4. Run

- [x] 4.1 Start the pre-flight read, the sampler and the probe from `load-run.ts` with the first stage, stop them with the run, write `metrics.jsonl` and `probe.jsonl`, keep probes outside `--max-requests`, and put the metrics URL and the metrics not found in the facts; verify with `load-run.spec.ts` on the virtual clock with a fake `/metrics` and a fake probe fetch: both files written, `--max-requests 50 --probe` sends exactly 50 agents' requests plus probes, and no key in the folder

## 5. Report

- [x] 5.1 Add the vLLM figures per stage as a pure function of the samples (samples read and failed, running, waiting, cache usage mean and max, prompt and generation tokens per second, prefix cache hit rate, metrics not found); verify with `report.spec.ts` for the waiting mean 6 and max 12 scenario, 202.7 tokens per second, a counter reset giving an absent rate, and too few samples
- [x] 5.2 Add the probe figures per stage (probes, failed, round trip p50, p95, max), context-length rejections by reason, and cost per agent-hour with `--price` among the assumed inputs; verify with spec cases for the 200/950/950 ms probe scenario, all probes failed, the 3.0% failed and 1.0% context-length scenario, and $0.143, $0.057, $0.029 per agent-hour
- [x] 5.3 Render the vLLM section and the probe figures in `report.md` only when their flags were on, with the same figures in `report.json`; verify with spec cases that a run without the flags has neither, and that every new figure in the Markdown matches the JSON

## 6. Dry run without a GPU

- [x] 6.1 Dry run in real time against local fakes: a small script in the scratchpad (not in the repository) serving a vLLM-style `/metrics` and an OpenAI-style chat completion on `127.0.0.1`, then `npm run load -- --agents 2 --stage 60 --warmup 10 --vllm-metrics --probe --price 1.43` with `LLM_URL` pointing at it; verify the run folder holds `metrics.jsonl` and `probe.jsonl`, the report shows the vLLM section, the probe and the cost, and nothing leaves the machine

## 7. Documentation

- [x] 7.1 Document the flags and the new report sections in `CLAUDE.md` (the `npm run load` row, the `tools/load/` layout) and `docs/load-test-architecture.md` (the name table, the probe, what the figures mean and their limits); verify the documented commands match the flags as built

## 8. Confirmation on a rented GPU (spends money: run by a person)

- [x] 8.1 **Costs about $1.50 to $2.50; a person runs it.** In `../SpellCheckingPrototype`: `deploy/vastai/search.sh`, `deploy/vastai/start.sh <offer> google/gemma-4-26B-A4B-it`, `deploy/vastai/tunnel.sh` (kept open), `deploy/vastai/check.sh`; set `LLM_URL=http://127.0.0.1:8000/v1/chat/completions`, `MODEL=google/gemma-4-26B-A4B-it` and any non-empty `LLM_API_KEY` for the run; save `curl -s http://127.0.0.1:8000/metrics` to `tools/load/fixtures/vllm-0.31.0-metrics.txt`; send one request over 8,192 tokens and save the error body to `tools/load/fixtures/vllm-0.31.0-context-length.json`; verify both files exist and hold no key or token
- [x] 8.2 **Same instance, same person.** Run `npm run load -- --agents 3 --stage 120 --warmup 20 --vllm-metrics --probe --price <the instance's $/h> --max-requests 200`; verify no value in the report is "not found" that v0.31.0 exposes, the samples show running requests rising with the agents' rounds, and the probes are answered
- [x] 8.3 **Same person, at once.** `deploy/vastai/destroy.sh`, then `deploy/vastai/status.sh`; verify it lists no instance and note the money spent it shows
- [x] 8.4 Correct the name table and the context-length pattern from the fixtures if they differ, and add spec cases that parse both fixtures; verify `vllm-metrics.spec.ts` and `report.spec.ts` pass on them
- [x] 8.5 Write the confirmation into `docs/load-test-architecture.md`: the date, GPU, model, price, the metric names found, the context-length wording, the short run's figures and the money spent, and what it showed about the loader (not capacity); verify the section names the assumed inputs
- [x] 8.6 Run `npm run typecheck` and `npm test`; verify both pass. Confirm again with `deploy/vastai/status.sh` that no instance is running

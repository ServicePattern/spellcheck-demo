# Proposal

## Why

**Capacity question: how many agents typing at once can one RTX PRO 6000 WS serving `google/gemma-4-26B-A4B-it` on vLLM v0.31.0 serve before answers stop arriving in time?** The loader can now load vLLM directly, see its queue, cache and token rates, and measure the distance to it. The confirmation run showed the card nearly idle at 3 agents (0.1 requests running on average, 6.7 generated tokens per second, no queue), so nothing yet says where it saturates.

Two things are missing to read a saturated run with confidence. vLLM's counters do not say how busy the GPU itself is (compute, memory, power), and at hundreds of agents the loader's own Node process might fall behind and distort the timings it measures. This change adds both, checks whether aborted requests stop in vLLM through the SSH tunnel, and then runs the stepped load on a rented card.

## What Changes

- **GPU sampling over SSH** (`--gpu-ssh user@host:port`): during a run the loader keeps one SSH session to the instance running `nvidia-smi` every 2 seconds, and records per GPU the compute utilization, memory used and total, power draw and temperature in `gpu.jsonl`. It uses the sibling project's vast.ai known-hosts file and the SSH key already set up for the instance; nothing is installed on the instance. A first reading before the run checks the session works and names the GPU.
- **Loader health per stage:** the delay of the loader's own event loop (p99 and max) in each stage, so a figure measured while the loader was falling behind can be told apart.
- **Abort check** (`npm run load:abort-check`): sends 20 long generations straight to vLLM, aborts them all after 2 seconds, and reads vLLM's running count before, at the abort and 1 and 3 seconds after. It answers whether closing a connection on the Mac stops the generation on the instance through the tunnel.
- **Report:** a GPU section per stage (utilization mean and max, memory used max, power mean and max, temperature max) and the loader's event loop delay.
- **The capacity run, on a rented GPU, started by a person:** `--agents 25,50,100,200,300 --stage 180` straight to vLLM with the metrics, the probe, GPU sampling and the price; the abort check; then destroy and a status check. The results go into `docs/` as figures per stage, with the stage where the useful answer rate falls read from them by a person.

## Non-goals

- **The demo server as a target on the GPU.** The whole path was measured on Gemini; through the server on the GPU is for a later run.
- The comparisons listed under "Things the first runs should settle" other than the abort check: prefix cache on and off, JSON mode, an output cap, `--max-seqs` (change `capacity-variations`).
- Other models or cards; several instances; running the loader next to the GPU.
- Any change to `src/`, `server/`, or how the sibling project starts vLLM.
- A pass rule or verdict in the report: it keeps giving figures only.

## Cost and dependencies

- **Rented GPU: at most 3 hours, started by a person.** One RTX PRO 6000 WS (96 GB) at about $1.5/h on demand: model loading (about 10 minutes), the stepped run (5 stages × 180 s = 15 minutes), the abort check, a rerun if one fails, destroy. Expected about 1 to 1.5 hours, about $2 to $2.50; at most about $5. The session ends with `deploy/vastai/destroy.sh` and `deploy/vastai/status.sh` showing no instance.
- **Hosted model:** none.
- **No new dependency.** The loader runs the system's `ssh` and the instance's `nvidia-smi` (NVIDIA's tool, already in the vLLM image); Node built-ins only (`node:child_process`, `node:perf_hooks`).

## Capabilities

### New Capabilities

- `load-gpu`: sampling the GPU with `nvidia-smi` over SSH during a run, and what each sample records.

### Modified Capabilities

- `load-vllm`: adds the abort check.
- `load-run`: adds `--gpu-ssh`; the run folder holds `gpu.jsonl` and the GPU's name and driver.
- `load-report`: adds the GPU section and the loader's event loop delay per stage.

## Impact

- **New:** `tools/load/gpu.ts` (the SSH `nvidia-smi` session and parsing), `tools/load/abort-check.ts` (the command), their specs, the `load:abort-check` script in `package.json`.
- **Changed:** `tools/load/settings.ts`, `tools/load/load-run.ts`, `tools/load/run.ts` (event loop delay on the real clock), `tools/load/report.ts`, `CLAUDE.md`, `docs/load-test-architecture.md` (the capacity results).
- **Read, not changed:** `../SpellCheckingPrototype/deploy/vastai/` (renting, tunnel, the known-hosts file at `~/.config/vastai/known_hosts`).
- **System under test:** untouched in code. `nvidia-smi` every 2 s over one SSH session and the abort check's 20 generations are the only load added outside the agents; the report says when they ran.

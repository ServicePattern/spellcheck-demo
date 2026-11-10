# Design

## Context

See `proposal.md` for the question and `docs/load-test-architecture.md` for the loader as built, including the confirmation run of `vllm-metrics` (3 agents, card nearly idle).

**Target of this change: vLLM directly**, `google/gemma-4-26B-A4B-it` on vLLM v0.31.0 on one rented RTX PRO 6000 WS, through the SSH tunnel. The demo server is not loaded on the GPU in this change.

What exists:

- The sibling project rents and starts the instance (`deploy/vastai/start.sh`), opens the tunnel (`tunnel.sh`, `127.0.0.1:8000` to the instance's loopback), and destroys it (`destroy.sh`). It reaches the instance with the system `ssh`, batch mode, and its own known-hosts file `~/.config/vastai/known_hosts` (`lib.sh`, `ssh_opts`); the account's SSH key is already authorized on every instance. `uvx vastai==1.8.3 ssh-url <id>` prints the instance's `ssh://user@host:port`.
- The vLLM image ships `nvidia-smi`; nothing needs installing.
- The loader's sampler and probe already follow one pattern: a loop on the run's clock, started with the first stage, stopped with the run, writing a JSON-lines file, with a check before the run that stops it early.
- The confirmation run took 269 ms p50 per request at 3 agents; the Gemini runs showed the loader holding 50 agents, about 7.5 requests a second, in one process. At 300 agents expect roughly 45 requests a second, more than anything run so far.

## Goals / Non-Goals

**Goals:**

- GPU figures per stage, sampled on the same 2 s rhythm as vLLM's metrics, with no change on the instance.
- A figure that says whether the loader kept up in each stage.
- A plain yes or no on whether aborts stop generation in vLLM through the tunnel.

**Non-Goals:**

- Per-process GPU figures, GPU clocks, PCIe or network counters.
- Sampling the GPU in specs with a real `nvidia-smi`: specs use a stand-in command.

## Decisions

### 1. One long SSH session running `nvidia-smi -l 2`

The loader spawns `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=~/.config/vastai/known_hosts -o ConnectTimeout=10 -o ServerAliveInterval=30 -p <port> <user>@<host> nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu --format=csv,noheader,nounits -l 2` and reads its stdout line by line, like the server target reads the server's log. Each line is one GPU's reading, timed on the loader's clock when it arrives. `nvidia-smi` keeps the interval itself, so no SSH connection is opened per sample. Stopping the run kills the session (`SIGTERM`, then `SIGKILL`), and an exit hook covers Ctrl-C.

The check before the run is a separate short session: `nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader`, with a 15 s limit. Its failure stops the run with `--gpu-ssh` and the SSH error (stderr), before the run folder exists.

The command that wraps the remote command is injected (by default the `ssh` invocation above), so specs can replace it with a local `node -e` script printing `nvidia-smi`-shaped lines, an `[N/A]`, a bad line, or exiting early.

*Alternatives:* `nvitop` (installed by the sibling's start script): GPL-3.0 and meant for people, not parsing. One SSH connection per sample: 0.2 to 0.5 s of handshake every 2 s, more noise than signal. A Prometheus GPU exporter on the instance: an install on someone else's machine for what one command gives.

### 2. Readings parsed per line, figures over all GPUs

`parseGpuLine` splits on commas and trims; `[N/A]` or any non-number leaves that value absent; a line with the wrong number of fields is a failed reading with its text. The report takes all readings of all GPUs in the window: on one card that is simply the card. Memory share uses each reading's own total.

### 3. Event loop delay from `perf_hooks.monitorEventLoopDelay`

`run.ts` (the real clock) creates a histogram with a 10 ms resolution and passes a small meter to `runLoad`: reset when a stage's warm-up ends, read (p99 and max, in ms) when the stage ends. The stage plan carries the two numbers into the report. Specs on the virtual clock pass no meter, and the figures are absent.

*Alternative:* inferring lag from the sampler's late wake-ups. Rejected: indirect, and the histogram is built for this.

### 4. The abort check is its own small command

`tools/load/abort-check.ts`, run by `npm run load:abort-check` with `.env` loaded like the loader. It reads the metrics URL the same way as `--vllm-metrics` (and stops on the same check), sends 20 requests of `{ model, messages: [{ role: 'user', content: 'Write a long story …' }], max_tokens: 600, temperature: 0.7 }` under one `AbortController`, reads `vllm:num_requests_running` at the four moments, aborts at 2 s, and prints the counts and the verdict. The verdict rule is a pure function with its own spec; the whole command is tested against a local HTTP stub whose running count follows open connections, in one mode that stops on close and one that does not.

Long generations are needed because the product's requests finish in about 300 ms, before any abort could be seen.

### 5. Report sections

A GPU section after the vLLM section, headed by the GPU's name and driver, one row per stage with the figures of the `load-report` delta; and a small loader table (stage, agents, event loop delay p99 and max). Both are pure functions of the readings and the stage plans, like the other sections.

### 6. The capacity run is a person's session with a fixed order

Rent → tunnel → `check.sh` → `ssh-url` for `--gpu-ssh` → the stepped run → the abort check (after the run, so it does not disturb it) → destroy → status. The stepped run uses `--agents 25,50,100,200,300 --stage 180 --warmup 30 --vllm-metrics --probe --gpu-ssh … --price <$/h>`, with no request cap (the card is paid by the hour, not by the request). The session stops at 3 hours whatever is left.

## What is simulated, what is real

| Real | Simulated |
|---|---|
| The model, the card, vLLM's batching and queue, the tunnel | The agents and their typing (assumed inputs, as before) |
| GPU utilization, memory, power and temperature from `nvidia-smi` | |
| The abort check's 20 long generations | |

Left out: the demo server, the page, the browser; several cards or instances; real typing data; the prefix cache, JSON mode, output cap and `--max-seqs` comparisons.

## Loader limits that can affect a figure

- **One Node process, up to 300 agents** (about 45 requests a second). The event loop delay per stage says whether it kept up; a stage with a p99 above about 100 ms should be read with care, since rounds and aborts start late.
- **One SSH tunnel** carries every request, the metrics and the probes; the GPU session is a second SSH connection. The probe's round trip shows what the tunnel adds as load rises.
- **`nvidia-smi` utilization** is the share of time any kernel ran in the last period, not how full the card's compute units were: a busy-looking card can still have room. Read it with vLLM's running and waiting counts and tokens per second.

## Effect on the system under test, and cost

No code change to the system under test. During the run, `nvidia-smi` every 2 s on the instance (negligible), the probe every 10 s, and `/metrics` every 2 s; after the run, the abort check's 20 generations of at most 600 tokens.

Cost: one RTX PRO 6000 WS at about $1.5/h on demand, expected 1 to 1.5 hours (about $2 to $2.50), capped at 3 hours (about $5) by the person running it, ended with destroy and a status check.

## Risks / Trade-offs

- [The 2FA session of the vast.ai CLI expires (it did on 2026-11-10)] → the tasks start with a `status.sh` check, and the person renews it with `uvx vastai==1.8.3 tfa send-email` and `tfa login` before renting.
- [The card never saturates even at 300 agents] → the report still gives every figure; the doc says the knee lies above 300 and the next run's levels follow from the figures, not from a guess.
- [The loader saturates before the card] → the event loop delay shows it; the write-up says so and the figures of that stage are marked as not usable.
- [A forgotten instance keeps billing] → destroy and `status.sh` are tasks of their own, and the session has a 3-hour cap.
- [The SSH user or host changes between renting and running] → the address comes from `ssh-url` for the instance actually running, and the check before the run catches a wrong one.

## Open Questions

- Whether the knee lies between 25 and 300 agents. The run answers it; if it lies above, a later run raises the levels.

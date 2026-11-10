# Spec Delta

## Purpose

Shows how busy the rented GPU itself is during a run (compute, memory, power, temperature), read with `nvidia-smi` over SSH, so a capacity figure can be tied to the card and not only to vLLM's queue.

## ADDED Requirements

### Requirement: The GPU is sampled over SSH during the run

With `--gpu-ssh <user>@<host>:<port>`, the loader SHALL open one SSH session to the instance, without a password prompt (batch mode, the sibling project's vast.ai known-hosts file, new host keys accepted), running `nvidia-smi` every 2 seconds from the start of the first stage to the end of the run, and SHALL record each sample with its time and, per GPU, its index and these values:

| Value | Meaning |
|---|---|
| Utilization | Share of the last sampling period in which the GPU was computing, 0 to 100% |
| Memory used, memory total | GPU memory in MiB |
| Power draw | Watts |
| Temperature | Degrees Celsius |

The samples SHALL go to `gpu.jsonl` in the run folder. A line that cannot be read is recorded as failed with the text, and sampling goes on. If the session ends during the run, the loader records when and why, and the run goes on without GPU samples.

Before the first stage, the loader SHALL read the GPU's name, driver version and total memory once over the same kind of session; if that fails within 15 seconds, it SHALL stop before sending any request and name `--gpu-ssh` and the SSH error. Nothing is installed or changed on the instance.

#### Scenario: Samples during a run

- **WHEN** `npm run load -- --agents 25 --stage 180 --vllm-metrics --gpu-ssh root@73.97.224.215:16559` is run against the rented instance
- **THEN** about 90 GPU samples are written to `gpu.jsonl`, each with the utilization, memory used and total, power and temperature of GPU 0, and `report.json` names the GPU, for example `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`, and its driver

#### Scenario: Wrong address

- **WHEN** `--gpu-ssh` names a host or port where no SSH server answers
- **THEN** the loader stops before sending any request, naming `--gpu-ssh` and the SSH error, and no run folder is written

#### Scenario: Session drops

- **WHEN** the SSH session ends in the middle of the second stage
- **THEN** `gpu.jsonl` holds the samples up to then, the report states when the GPU session ended and why, and the agents' requests go on to the end of the run

#### Scenario: Malformed value

- **WHEN** `nvidia-smi` prints `[N/A]` for the power draw
- **THEN** that sample has no power value, and its other values are recorded

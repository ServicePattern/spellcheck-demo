# Spec Delta

## ADDED Requirements

### Requirement: With GPU sampling the report shows the card per stage

For a run with `--gpu-ssh`, the report SHALL give per stage, over the GPU samples taken in the stage after its warm-up that were read successfully, and over all GPUs of the instance:

| Figure | Definition |
|---|---|
| Samples | Number of samples read, and number failed |
| Utilization, mean and max | Mean and highest of the utilization values, in percent |
| Memory used, max | Highest memory used, in GiB, and that as a share of the total |
| Power, mean and max | Mean and highest power draw, in watts |
| Temperature, max | Highest temperature, in degrees Celsius |

A figure with no value to compute from SHALL be shown as absent. These are measured results, in a section of their own after the client tables; the GPU's name and driver head the section. Runs without `--gpu-ssh` have no such section.

#### Scenario: Utilization rises with load

- **WHEN** in the fourth stage of `--agents 25,50,100,200,300 --stage 180 --gpu-ssh …` the samples after warm-up have utilization 40, 70, 95 and 75%
- **THEN** that stage's utilization is mean 70% and max 95%

#### Scenario: Memory as a share

- **WHEN** a stage's highest memory used is 88,000 MiB on a card of 97,887 MiB
- **THEN** the stage's memory used max is 85.9 GiB and 89.9%

#### Scenario: No GPU sampling

- **WHEN** a run did not use `--gpu-ssh`
- **THEN** the report has no GPU section

### Requirement: The report shows the loader's own delay per stage

On the real clock, the report SHALL give per stage the delay of the loader's event loop: p99 and max in milliseconds, measured over the stage after its warm-up. This shows whether the loader itself fell behind, which would delay requests, rounds and samples and make the figures of that stage unreliable. On the virtual clock the figures SHALL be absent.

#### Scenario: Loader keeping up

- **WHEN** a stage of 300 agents has an event loop delay p99 of 12 ms
- **THEN** the report shows 12 ms for that stage, next to its agents

#### Scenario: Virtual clock

- **WHEN** a run uses the virtual clock in a spec
- **THEN** the event loop delay figures are absent

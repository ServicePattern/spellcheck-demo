# Spec Delta

## Purpose

Simulates one agent typing messages in the demo's message field, so that the requests reaching the LLM have the timing, content and aborts of the real assistant.

## ADDED Requirements

### Requirement: Typing is driven by assumed inputs that can be set

An agent's behavior SHALL be driven by these inputs, each with a flag and a default. They are assumptions, not measurements.

| Input | Flag | Default |
|---|---|---|
| Debounce before a request round | `--debounce-ms` | 1000 |
| Request timeout | `--timeout-ms` | 20000 |
| Typing speed, median across agents | `--wpm` | 40 words per minute (5 characters per word), each agent within ±25% |
| Words per burst, median | `--burst-words` | 3 |
| Pause after a burst, median | `--pause-ms` | 1800, long-tailed |
| Share of shown completions accepted | `--accept-share` | 0.26 |
| Share of rounds that send spell check only | `--spell-check-only-share` | 0.10 |
| Words per typo | `--typo-every` | 15 |
| Time between messages, median | `--between-messages-ms` | 20000, long-tailed |
| Share of agents writing Arabic | `--arabic-share` | 0.5 |

#### Scenario: Defaults

- **WHEN** a run is started with `--target fake --agents 2 --stage 60` and no other flag
- **THEN** the run uses every default above and its report lists them as assumed inputs

#### Scenario: Value out of range

- **WHEN** a share flag is given a value outside 0 to 1, or a duration or count flag a value that is not a positive number
- **THEN** the loader stops before sending any request and names the flag

### Requirement: A seed makes typing repeatable

For a given seed, settings and chat sources, every agent's sequence of message scripts, bursts, typos, pauses and accept decisions SHALL be the same in every run. An agent's sequence SHALL NOT depend on how many other agents run.

#### Scenario: Same seed, same typing

- **WHEN** two runs use `--target fake --agents 3 --stage 60 --seed 7` with the same settings
- **THEN** each agent sends the same drafts in the same order in both runs

#### Scenario: More agents do not change earlier agents

- **WHEN** one run uses `--agents 2` and another `--agents 5`, both `--target fake --stage 60 --seed 7`
- **THEN** agents 1 and 2 type the same drafts in both runs

#### Scenario: Different seed

- **WHEN** two runs differ only in `--seed`
- **THEN** the agents' drafts and pauses differ

### Requirement: The draft grows in bursts, with typos

An agent SHALL type its message in bursts of whole words, in the script's order. Typing a burst takes its length in characters at the agent's typing speed. The draft is everything typed so far in the current message.

Typos SHALL be inserted at the set rate, in English and Arabic words alike, by changing one word: two neighbouring letters swapped, one letter dropped, or one letter doubled. Only words of four or more letters with no digits are changed. A typo stays in the draft for the rest of the message.

#### Scenario: English burst

- **WHEN** the message is `Thank you. I can see the registration from March.` and the first burst is three words
- **THEN** the draft after the burst is `Thank you. I`, and the burst took 12 characters at the agent's speed

#### Scenario: English typo

- **WHEN** the word `registration` is picked for a typo
- **THEN** the draft holds a one-edit variant of it, such as `registartion`, and every later draft of this message holds the same variant

#### Scenario: Arabic typo

- **WHEN** the word `المستندات` is picked for a typo
- **THEN** the draft holds a variant with two neighbouring letters swapped, one letter dropped or one letter doubled, and the words around it are unchanged

#### Scenario: Reference number

- **WHEN** the message holds `SI-48213`
- **THEN** it is never changed by a typo

### Requirement: A request round follows a pause longer than the debounce

After each burst the agent pauses. If the pause is shorter than the debounce, the agent goes on typing and sends nothing. Otherwise it SHALL start a request round when the debounce has passed since the end of the burst, and resume typing when the pause ends.

A round sends a spell check request and an auto-completion request at the same moment, with the caret at the end of the draft. In the set share of rounds it SHALL send the spell check request alone, with the caret at an earlier word boundary of the draft, standing in for an edit in the middle of the text.

#### Scenario: Short pause

- **WHEN** the debounce is 1000 ms and the pause after a burst is 700 ms
- **THEN** no request is sent and the next burst starts 700 ms after the previous one ended

#### Scenario: Long pause

- **WHEN** the debounce is 1000 ms and the pause after a burst is 2600 ms
- **THEN** both requests are sent 1000 ms after the burst ended, and typing resumes 1600 ms after that

#### Scenario: Spell check only round

- **WHEN** a round is drawn as spell check only
- **THEN** one spell check request is sent with the caret inside the draft, and no auto-completion request is sent

### Requirement: Requests are the assistant's own

The user message of each request SHALL be built by the assistant's message builders from the draft, the caret, the script's LLM context and, for spell check, its custom dictionary. The system message and examples SHALL be those the demo server sends for that kind of request.

#### Scenario: English spell check request

- **WHEN** the draft is `Thank you. I can see the registartion` with the caret at its end
- **THEN** the spell check user message ends with `Draft:` followed by `Thank you. I can see the registartion‸`, preceded by the English LLM context and the custom dictionary list

#### Scenario: Arabic auto-completion request

- **WHEN** the draft is `وعليكم السلام، دعني أتحقق` with the caret at its end
- **THEN** the auto-completion user message holds the Arabic LLM context, `Draft:` followed by `وعليكم السلام، دعني أتحقق‸`, and the instruction to complete the draft at `‸` with one short sentence

#### Scenario: Same text as the page

- **WHEN** the same draft, caret, context and custom dictionary are given to the assistant in the demo page
- **THEN** the user messages it sends are identical to the loader's

### Requirement: Resuming typing aborts what is still running

When the pause ends, the agent SHALL abort every request of the round that has not answered, as the assistant does on the next keystroke. A request that has run for the request timeout SHALL be ended as a timeout.

#### Scenario: Answer in time

- **WHEN** a request is sent, the agent resumes 1600 ms later, and the answer arrives after 900 ms
- **THEN** the request ends as answered with a latency of 900 ms

#### Scenario: Answer too late

- **WHEN** a request is sent, the agent resumes 1600 ms later, and no answer has arrived by then
- **THEN** the request is aborted at 1600 ms and ends as aborted

#### Scenario: One of two answers in time

- **WHEN** in one round the spell check answers before the agent resumes and the auto-completion does not
- **THEN** the spell check ends as answered and the auto-completion as aborted

#### Scenario: Timeout in a long pause

- **WHEN** the request timeout is 20000 ms, the pause leaves 45000 ms, and no answer arrives
- **THEN** the request ends as a timeout at 20000 ms

### Requirement: A share of completions is accepted

When an auto-completion answer with a non-empty completion arrives before the agent resumes, the agent SHALL accept it in the set share of cases. Accepting moves the draft ahead in the script by as many words as the completion has, at most to the end of the message, with no typing time, and starts a new pause, so a new round follows if that pause outlasts the debounce. The draft always holds the script's words, never the model's.

#### Scenario: Accepted completion

- **WHEN** the draft is `You can update your` in the message `You can update your bank details online in a few steps.`, a completion of four words arrives in time, and it is accepted
- **THEN** the draft becomes `You can update your bank details online in`, and a new pause starts

#### Scenario: Empty completion

- **WHEN** the auto-completion answer holds an empty completion
- **THEN** nothing is accepted and the agent resumes typing when its pause ends

#### Scenario: Completion longer than the rest of the message

- **WHEN** two words of the message are left and a completion of six words is accepted
- **THEN** the draft becomes the whole message

### Requirement: Messages follow each other through the conversation

When the whole message is typed, the agent SHALL pause once more as after any burst (a round may follow), then send the message: requests still running are aborted, the agent waits the time between messages, and goes on to the next agent turn. After the last agent turn of a conversation it SHALL take another conversation of its language, in the order its seed gives. An agent writes one language for the whole run.

#### Scenario: Next turn of the same conversation

- **WHEN** an agent has sent the message of agent turn B and the conversation goes on with customer turn C and agent turn D
- **THEN** after the time between messages it starts typing D from an empty draft, and its requests carry A, B, C as the conversation so far, with B as written in the source

#### Scenario: Arabic agent

- **WHEN** an agent is drawn as Arabic
- **THEN** every conversation it takes is an Arabic one

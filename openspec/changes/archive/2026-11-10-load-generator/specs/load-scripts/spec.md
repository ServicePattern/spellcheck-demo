# Spec Delta

## Purpose

Turns the synthetic support chats into the material a load run needs: for every agent turn, the text a simulated agent types and the LLM context its requests carry.

## ADDED Requirements

### Requirement: Chat sources are read into conversations

The loader SHALL read every `.txt` file in the chat sources folder (`--chats`, by default `../SpellCheckingPrototype/eval/completion/sources`) into conversations of customer and agent turns.

- A line starting with `Customer:` or `العميل:` is a customer turn; a line starting with `Agent:` or `الموظف:` is an agent turn. The text of the turn is the rest of the line, trimmed.
- A line holding only `---` ends a conversation.
- Lines starting with `#` and empty lines are skipped.
- A conversation's language is Arabic when its turns use the Arabic labels, English otherwise.
- A conversation with no agent turn is dropped.

#### Scenario: English chat

- **WHEN** a source holds `Customer: Hi, I applied three weeks ago.` then `Agent: Hello, let me check the status.` then `Agent: Your application is being reviewed.` then `---`
- **THEN** one English conversation is read with one customer turn followed by two agent turns, each with its text without the label

#### Scenario: Arabic chat

- **WHEN** a source holds `العميل: السلام عليكم، قدمت طلب معاش التقاعد.` then `الموظف: وعليكم السلام، دعني أتحقق من حالة طلبك.` then `---`
- **THEN** one Arabic conversation is read with one customer turn and one agent turn, the text kept exactly, including its Arabic punctuation

#### Scenario: Arabic turn with Latin text

- **WHEN** an Arabic agent turn reads `الموظف: أرى أن طلبك رقم SI-48213 تم استلامه.`
- **THEN** the turn's text keeps `SI-48213` in place and the conversation is Arabic

#### Scenario: Comments and blank lines

- **WHEN** a source starts with lines beginning with `#` and has blank lines between conversations
- **THEN** those lines produce no turn and no conversation

#### Scenario: Unrecognized line

- **WHEN** a non-empty line is neither a comment, a separator nor a labelled turn
- **THEN** the loader stops before sending any request, naming the file and the line number

#### Scenario: Sources folder missing

- **WHEN** the chat sources folder does not exist or holds no `.txt` file
- **THEN** the loader stops before sending any request, naming the folder and the `--chats` flag

### Requirement: Every agent turn is a message script

For each agent turn the loader SHALL produce a message script: the turn's text as the message to type, and all turns before it in the same conversation as the conversation so far. Earlier agent turns appear in the conversation so far as written in the source, without typos.

#### Scenario: Second agent turn of an English conversation

- **WHEN** a conversation is customer turn A, agent turn B, customer turn C, agent turn D
- **THEN** the script for D has D's text as the message and A, B, C in order as the conversation so far

#### Scenario: First agent turn of an Arabic conversation

- **WHEN** an Arabic conversation starts with one customer turn followed by an agent turn
- **THEN** the script for that agent turn has the customer turn alone as the conversation so far

### Requirement: The LLM context has the demo's shape and size

The LLM context of a message script SHALL be the demo's preset for the script's language (the English preset for English, the Arabic preset for Arabic) with its `Conversation:` block replaced by the conversation so far, one line per turn as `Customer: <text>` or `Agent: <text>`. Every other block of the preset (agent, customer profile, case fields, canned responses, knowledge base) is kept unchanged. The preset's custom dictionary is the custom dictionary of the script's requests.

#### Scenario: English context

- **WHEN** an English script has the conversation so far `Customer: My employer says they registered me.`
- **THEN** its LLM context holds the English preset's canned responses and knowledge base unchanged, and its `Conversation:` block holds exactly that one line

#### Scenario: Arabic context

- **WHEN** an Arabic script has a customer turn `السلام عليكم، قدمت طلب معاش التقاعد.` before it
- **THEN** its LLM context is the Arabic preset with the `Conversation:` block holding `Customer: السلام عليكم، قدمت طلب معاش التقاعد.`, and its custom dictionary is the Arabic preset's

#### Scenario: Preset without a conversation block

- **WHEN** the preset for a language has no `Conversation:` block
- **THEN** the loader stops before sending any request and says which preset

### Requirement: Request text comes only from synthetic sources

The text the loader sends SHALL come only from the chat sources folder, the demo's presets, and the assistant's and the server's own message and prompt builders. The loader SHALL NOT read text to send from any other file, from telemetry, or from capture logs.

#### Scenario: Run names its sources

- **WHEN** a run starts with the default chat sources
- **THEN** the run's report names the chat source files read and the number of conversations and agent turns per language

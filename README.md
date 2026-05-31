# selfmod

A tiny **self-modifying CLI agent**. You clone it, run it, and then talk to it —
it can read and rewrite its own source code (`index.ts`) using built-in tools.

Built on [`luv-ai`](https://github.com/monarchwadia/luv) (canonical conversation
type + Anthropic morphism) and [Bun](https://bun.com).

## Quick start

```bash
# 1. Clone
git clone <this-repo-url> selfmod
cd selfmod

# 2. Install deps
bun install

# 3. Add your Anthropic API key
cp .env.example .env
$EDITOR .env          # set ANTHROPIC_API_KEY=sk-ant-...

# 4. Run it
bun start             # or: bun run index.ts
```

You'll get an interactive prompt:

```
selfmod — a self-modifying CLI agent (luv-ai + Bun)
model: claude-sonnet-4-6
Type a message. Ask me to change my own code. Ctrl-D or 'exit' to quit.

you › add a tool that tells the current time
```

The agent will read its own source, edit `index.ts`, and tell you to restart.
**Re-run `bun start`** to load the new version of itself.

## How it works

The agent starts with three simple tools:

| Tool         | What it does                                  |
| ------------ | --------------------------------------------- |
| `list_files` | List project files recursively                |
| `read_file`  | Read any file (so it can read its own source) |
| `write_file` | Overwrite/create any file (so it can edit itself) |

The loop is plain agentic tool-use:

1. Your message is appended to a `luv-ai` `Conversation`.
2. The conversation + tool specs are sent to Claude via `anthropicClient`.
3. If the reply contains `tool_call` blocks, each is executed and the results
   are fed back as `tool_result` blocks; the loop repeats.
4. When the model stops calling tools, its text is printed and you're prompted
   again.

Because `write_file` can target `index.ts`, the agent can extend itself — add
tools, change its system prompt, rewrite the loop. Restart to pick up changes.

## Configuration

Set in `.env` (Bun loads it automatically) or your shell:

| Variable            | Default              | Notes                          |
| ------------------- | -------------------- | ------------------------------ |
| `ANTHROPIC_API_KEY` | _(required)_         | Your Anthropic API key         |
| `MODEL`             | `claude-sonnet-4-6`  | Any Anthropic Messages model   |
| `MAX_TOKENS`        | `4096`               | Max output tokens per reply    |

## Caveats

- The agent can overwrite **any** file in the project, including itself. Work in
  a throwaway clone or use git so you can revert: `git diff`, `git checkout .`.
- There's no sandbox. Only run it where you're comfortable letting Claude write
  files in the project directory.

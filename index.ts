#!/usr/bin/env bun
/**
 * selfmod — a tiny CLI agent that can read and rewrite its own source code.
 *
 * Substrate: luv-ai (canonical conversation + Anthropic morphism).
 * Runtime:   Bun.
 *
 * The agent runs an interactive loop. You talk to it; it can call tools to
 * inspect and modify any file in this project — including this very file.
 * Re-run `bun start` after it edits itself to load the new version.
 *
 * The REPL is modal, vim-style:
 *   - NORMAL mode: the "other mode" — for commands (q to quit, etc.).
 *   - INSERT mode: the input mode — type a message and Enter to send it.
 * You start in NORMAL mode; press `i` to enter INSERT mode, and submit an
 * empty line (just Enter) in INSERT mode to drop back to NORMAL.
 */

import { anthropicClient } from "luv-ai/anthropic";
import type { Block, Conversation, Message } from "luv-ai";

// --- config -----------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL ?? "claude-opus-4-8";
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 4096);

if (!API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key, " +
      "or export ANTHROPIC_API_KEY in your shell.",
  );
  process.exit(1);
}

const client = anthropicClient({ api_key: API_KEY });

// --- tools ------------------------------------------------------------------
// Each tool is the Anthropic-native shape (name/description/input_schema) plus
// a `run` implementation. luv-ai passes `input_schema` through verbatim.

type Tool = {
  name: string;
  description: string;
  input_schema: unknown;
  run: (args: Record<string, any>) => Promise<string> | string;
};

const IGNORE = /(^|\/)(node_modules|\.git)(\/|$)/;

const TOOLS: Tool[] = [
  {
    name: "list_files",
    description:
      "List files in the project (recursively), so you can find your own " +
      "source and other files to read or edit.",
    input_schema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Directory to list, relative to project root. Defaults to '.'.",
        },
      },
    },
    run: async ({ dir = "." }) => {
      const glob = new Bun.Glob("**/*");
      const out: string[] = [];
      for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
        if (IGNORE.test(path)) continue;
        out.push(dir === "." ? path : `${dir}/${path}`);
      }
      return out.sort().join("\n") || "(no files)";
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file, relative to the project root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root." },
      },
      required: ["path"],
    },
    run: async ({ path }) => {
      const file = Bun.file(path);
      if (!(await file.exists())) return `ERROR: no such file: ${path}`;
      return await file.text();
    },
  },
  {
    name: "write_file",
    description:
      "Overwrite (or create) a file with new contents, relative to the project " +
      "root. Use this to modify your own source code in index.ts.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root." },
        contents: { type: "string", description: "The full new contents of the file." },
      },
      required: ["path", "contents"],
    },
    run: async ({ path, contents }) => {
      await Bun.write(path, contents);
      return `Wrote ${contents.length} bytes to ${path}.`;
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const TOOL_SPECS = TOOLS.map(({ name, description, input_schema }) => ({
  name,
  description,
  input_schema,
}));

// --- conversation helpers ---------------------------------------------------

const SYSTEM_PROMPT =
  "You are selfmod, a CLI coding agent that lives in a small Bun project and " +
  "can rewrite its own source code. Your main source file is `index.ts`. " +
  "When the user asks you to change your behavior or add a feature, edit the " +
  "relevant file with write_file. Read files before editing them. Keep the " +
  "code working — it must still run under Bun. Explain what you changed and " +
  "remind the user to re-run the agent to load the new version.";

let nodeCounter = 0;
const conv: Conversation = { spec_version: "1.0", nodes: [] };

function addMessage(message: Message): void {
  const parent_id = conv.nodes.length ? conv.nodes[conv.nodes.length - 1]!.id : null;
  conv.nodes.push({ id: `n${++nodeCounter}`, parent_id, message });
}

// luv-ai has no dedicated system role beyond the canonical "system" role; we
// seed the conversation with a system message.
addMessage({ role: "system", content: [{ kind: "text", text: SYSTEM_PROMPT }] });

// --- agent loop --------------------------------------------------------------

async function runTurn(userText: string): Promise<void> {
  addMessage({ role: "user", content: [{ kind: "text", text: userText }] });

  // Keep stepping while the model asks to use tools.
  while (true) {
    const reply = await client.send(conv, {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: TOOL_SPECS,
    });

    addMessage(reply.message);

    // Print any text the model produced.
    for (const block of reply.message.content) {
      if (block.kind === "text" && block.text.trim()) {
        console.log(`\n${block.text}\n`);
      }
    }

    const toolCalls = reply.message.content.filter(
      (b): b is Extract<Block, { kind: "tool_call" }> => b.kind === "tool_call",
    );
    if (toolCalls.length === 0) return; // model is done

    // Execute each tool call and feed results back.
    const results: Block[] = [];
    for (const call of toolCalls) {
      const tool = TOOL_BY_NAME.get(call.name);
      let text: string;
      if (!tool) {
        text = `ERROR: unknown tool '${call.name}'`;
      } else {
        try {
          const args = call.args ? JSON.parse(call.args) : {};
          console.log(`  · ${call.name}(${summarize(args)})`);
          text = String(await tool.run(args));
        } catch (err) {
          text = `ERROR running ${call.name}: ${(err as Error).message}`;
        }
      }
      results.push({ kind: "tool_result", call_id: call.id, text });
    }
    addMessage({ role: "user", content: results });
  }
}

function summarize(args: Record<string, any>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
    })
    .join(", ");
}

// --- modal REPL --------------------------------------------------------------
// Two modes, vim-style:
//   NORMAL — the "other mode": command keys, no message is sent.
//   INSERT — the input mode: type a line + Enter to send it to the agent.

type Mode = "NORMAL" | "INSERT";
let mode: Mode = "NORMAL";

const PROMPTS: Record<Mode, string> = {
  NORMAL: "[normal] ›",
  INSERT: "[insert] ›",
};

function printNormalHelp(): void {
  console.log(
    "NORMAL mode — commands:\n" +
      "  i    enter INSERT mode (start typing a message)\n" +
      "  :    enter INSERT mode too (alias)\n" +
      "  q    quit\n" +
      "  ?    show this help\n",
  );
}

console.log("selfmod — a self-modifying CLI agent (luv-ai + Bun)");
console.log(`model: ${MODEL}`);
console.log(
  "Modal REPL: starts in NORMAL mode. Press `i` to enter INSERT mode and type.\n" +
    "In INSERT mode, submit an empty line (just Enter) to return to NORMAL. `q` quits.\n",
);

loop: while (true) {
  const line = prompt(PROMPTS[mode]);
  if (line === null) break; // Ctrl-D

  if (mode === "NORMAL") {
    const cmd = line.trim();
    switch (cmd) {
      case "":
        continue;
      case "i":
      case ":":
      case "a":
        mode = "INSERT";
        continue;
      case "q":
      case "quit":
      case "exit":
        break loop;
      case "?":
      case "h":
        printNormalHelp();
        continue;
      default:
        console.log(`(NORMAL) unknown command '${cmd}'. Press i to type, ? for help, q to quit.`);
        continue;
    }
  }

  // INSERT mode
  if (line.trim() === "") {
    // empty line returns to NORMAL, like pressing Esc
    mode = "NORMAL";
    continue;
  }
  try {
    await runTurn(line);
  } catch (err) {
    console.error(`\n[error] ${(err as Error).message}\n`);
  }
}

console.log("\nbye.");

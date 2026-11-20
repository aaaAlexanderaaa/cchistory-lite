/**
 * Role: Human-first top-level CLI synopsis (~28 lines) and single-source per-command help
 * derived from `agent-contract.ts`.
 * Excludes CLI option parsing and command execution (owned by index.ts).
 */

import { buildAgentContract, type AgentCommandContract } from "./agent-contract.js";

export function renderLiteHelp(version: string, command?: string): string {
  if (command) return renderCommandHelp(version, command);
  return `CC History Lite ${version} — zero-store, read-only AI coding history browser

Common commands:
  cchistory-lite tui [--dir <path>] [--stats] [--since <window>]
      Open the full-screen terminal browser or jump straight to Statistics.
  cchistory-lite latest [sessions|turns] [N] [--dir <path>|--no-dir]
      Show recent sessions (with resume commands) or prompts.
  cchistory-lite search <query> [--dir <path>|--no-dir] [--prompts-only] [--group-by message]
      Search titles, user prompts, and assistant replies.
  cchistory-lite show session|turn|project|source <ref> [--full|--compact]
      Inspect one session, full prompt + assistant replies, or source diagnostics.
  cchistory-lite stats [--since today|7d|30d|week|month] [--by project,model,source,hour|day|session] [--quota <usd>]
      Machine-wide token, cost, cache-hit, and quota diagnostics (pass --dir . for one directory).
  cchistory-lite ls [projects|sessions|families|sources] [--limit <n>|--all]
  cchistory-lite tree [projects|project <ref>|session <ref>]
  cchistory-lite sources [--complete]
  cchistory-lite export --format jsonl|json|markdown [--out <file>|-]

Scope & agents:
  latest / search / ls / tree default to the current directory (--no-dir for whole machine).
  stats and tui default to whole machine (pass --dir . to scope to current directory).
  For AI agents & automation: cchistory-lite agent | agent skill | query | shell --json
  All flags for one command:  cchistory-lite help <command>  (or <command> --help)

Read-only against native history; never reads or creates ~/.cchistory (--store/--db rejected).
Memory adapts to available system capacity; optional ceiling: NODE_OPTIONS='--max-old-space-size=8192'
`;
}

function renderCommandHelp(version: string, command: string): string {
  const contract = buildAgentContract(version);
  const spec = contract.commands[command];
  if (!spec) {
    const known = Object.keys(contract.commands).sort().join(", ");
    return `Unknown Lite command: ${command}. Known commands: ${known}.\n`;
  }
  const lines = [
    `CC History Lite ${version}`,
    "",
    spec.summary,
    "",
    `Usage: ${spec.usage}`,
    "",
  ];
  if (spec.flags.length > 0) {
    lines.push("Flags:");
    for (const flag of spec.flags) {
      lines.push(`  ${formatCommandHelpFlag(flag)}`);
      lines.push(`      ${flag.summary}`);
    }
    lines.push("");
  }
  if (spec.notes) {
    lines.push(spec.notes, "");
  }
  lines.push(
    "Agents: run cchistory-lite agent for the machine-readable contract; agent skill and agent guide print the agent docs.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function formatCommandHelpFlag(flag: AgentCommandContract["flags"][number]): string {
  const extras = [
    flag.kind === "value" ? (flag.values?.join("|") ?? "<value>") : undefined,
    flag.repeatable ? "repeatable" : undefined,
    flag.default !== undefined ? `default ${String(flag.default)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return extras.length > 0 ? `${flag.name}  ${extras.join("; ")}` : flag.name;
}

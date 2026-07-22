let input = "";
for await (const chunk of process.stdin) input += chunk;

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("mock codex-cli 0.0.0");
  process.exit(0);
}

if (args.includes("RECURSION_PROBE")) {
  console.log(JSON.stringify({ error: "recursion probe should never run codex_exec" }));
  process.exit(1);
}

const outputFlagIndex = args.indexOf("-o");
const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : null;

const guardPresent = process.env.CODEX_CALLED_FROM_CLAUDE === "1";
const disablesDispatcher = args.some(
  (a) => a === "mcp_servers.claude_dispatcher.enabled=false",
);

const resultText = `mock codex advisor received ${input.length} prompt chars; recursion_guard_env=${guardPresent}; dispatcher_disabled_flag=${disablesDispatcher}; sandbox=${args.includes("read-only") ? "read-only" : "unknown"}`;

if (outputPath) {
  const fs = await import("node:fs");
  fs.writeFileSync(outputPath, resultText, "utf8");
}

console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: resultText } }));
process.exit(0);

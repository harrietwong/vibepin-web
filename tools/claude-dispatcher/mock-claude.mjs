let input = "";
for await (const chunk of process.stdin) input += chunk;

if (process.argv.includes("--version")) {
  console.log("mock Claude Code 0.0.0");
} else {
  console.log(
    JSON.stringify({
      result: `mock worker received ${input.length} prompt characters`,
      session_id: "mock-session",
    }),
  );
}


// Waits until the AI Assistant container answers on :4100 (any HTTP status = up).
const url = process.env.AIA_URL || "http://localhost:4100";
const until = Date.now() + 120_000;
process.stdout.write(`Waiting for AI Assistant on ${url} `);
while (Date.now() < until) {
  try {
    await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
    console.log("ready");
    process.exit(0);
  } catch {
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1500));
  }
}
console.error("\nAI Assistant did not start. Check: docker compose -f aia/docker-compose.yml logs ai-assistant");
process.exit(1);

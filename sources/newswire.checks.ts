import { createNewswire } from "./newswire";

async function main(): Promise<void> {
  let failures = 0;
  const ok = (name: string, cond: boolean, detail: string): void => {
    if (cond) process.stdout.write(`PASS ${name}\n`);
    else {
      failures += 1;
      process.stdout.write(`FAIL ${name} — ${detail}\n`);
    }
  };

  const logs: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const wire = createNewswire({
    feeds: [
      { url: "https://a.example/rss", outlet: "Alpha", region: "US" },
      { url: "https://b.example/rss", outlet: "Beta", region: "EU" },
      { url: "https://c.example/rss", outlet: "Gamma", region: "US" },
    ],
    concurrency: 2,
    timeoutMs: 15_000,
    log: (l) => logs.push(l),
    parseFeed: async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (url.includes("b.example")) throw new Error("ETIMEDOUT");
      return {
        items: [
          { title: `Story from ${url}`, link: `${url}/story-1`, isoDate: "2026-07-21T00:00:00Z" },
          { title: "link-less item" },
        ],
      };
    },
  });

  const index = await wire.buildIndex();
  ok("dead feed loses only its outlet (2 of 3 survive)",
    index.length === 2 && !index.some((i) => i.outlet === "Beta"), JSON.stringify(index));
  ok("outlet + region threaded onto every item",
    index.every((i) => (i.outlet === "Alpha" && i.region === "US") || (i.outlet === "Gamma" && i.region === "US")),
    JSON.stringify(index));
  ok("failure logged loudly with outlet and url",
    logs.some((l) => l.includes("Beta") && l.includes("b.example") && l.includes("ETIMEDOUT")), logs.join("|"));
  ok("link-less items dropped", index.every((i) => i.url.endsWith("/story-1")), JSON.stringify(index.map((i) => i.url)));
  ok("concurrency cap respected", maxInFlight <= 2, String(maxInFlight));

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write("newswire checks: all green\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`newswire.checks failed: ${String(err)}\n`);
  process.exit(1);
});

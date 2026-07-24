/**
 * run-news-desk.ts — operator-run: the full news desk on the local model.
 *
 *   FIRECRAWL_API_URL=… FIRECRAWL_API_KEY=… npx tsx examples/run-news-desk.ts
 *
 * Output: out/<slug>.md [DRAFT] + out/runs/<runId>/ provenance + covered.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createNewsDesk } from "../presets/news-desk";
import { createDatagod } from "../clients/datagod";
import { createOllamaLlm } from "../clients/ollama-llm";
import { createOllamaEmbedder } from "../clients/ollama-embedder";
import { createFirecrawlSearch } from "../clients/firecrawl-search";
import type { OutletFeed } from "../sources/newswire";
import type { BrandProfile, CoveredTopic, GeneratedPost, PublishResult, Sink } from "../ports";

/** PASSing set from examples/probe-feeds.ts — edit after each probe run. */
const FEEDS: OutletFeed[] = [
  // Probe run 2026-07-21: these 10 PASS end-to-end (probe 2: +ABC/Euronews/ToI; CBS+Sky antibot) (feed fetch + Firecrawl
  // scrape). Politico (feed 403), The Hill (antibot), AP (dead feed host) FAIL.
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", outlet: "BBC", region: "EU" },
  { url: "https://www.theguardian.com/world/rss", outlet: "The Guardian", region: "EU" },
  { url: "https://www.aljazeera.com/xml/rss/all.xml", outlet: "Al Jazeera", region: "MENA" },
  { url: "https://feeds.npr.org/1001/rss.xml", outlet: "NPR", region: "US" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", outlet: "CNBC", region: "US" },
  { url: "https://rss.dw.com/rdf/rss-en-all", outlet: "DW", region: "EU" },
  { url: "https://www.france24.com/en/rss", outlet: "France 24", region: "EU" },
  { url: "https://abcnews.go.com/abcnews/topstories", outlet: "ABC News", region: "US" },
  { url: "https://www.euronews.com/rss", outlet: "Euronews", region: "EU" },
  { url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", outlet: "Times of India", region: "Asia" },
];


/** The op-ed page: three invented AI columnists with DECIDED leans and full
 *  fictional biographies (birthplace, family, education, age) — the details
 *  that shape a worldview. Fictional by design; every bio renders with the
 *  AI-persona marker so no invented person reads as real. */
const COLUMNISTS = {
  left: {
    name: "Maya Ellison",
    bio: "b. 1996, Flint, Michigan (age 30). Black daughter of a GM line worker and UAW shop steward father and a public-school teacher mother. Watched the 2008 crash take her block's houses at twelve and Flint's water poisoned at eighteen. B.A. sociology, University of Michigan (still paying the loans); organizer through the 2018-2024 labor wave before turning columnist. Daily reads: ProPublica, The Guardian US, Labor Notes; The Dig in her ears; NPR out of habit, labor TikTok by instinct; lodestar writer: Barbara Ehrenreich. Voted: Sanders in the 2016 primary then Clinton with a clothespin, Biden 2020 while organizing anyway, Harris 2024 with ten thousand doors knocked. Hopes for America: a country where one union job buys a house the way her grandfather's did, healthcare that doesn't bankrupt, a livable climate for kids born in Flint — and billionaires paying at the rate the hardware store does.",
    method:
      "Follow the money downward: judge every policy and power move by what it does to workers, consumers, and the vulnerable — and name the concentrated interest served when it hurts them. Her generation's ledger: the 2008 crash, student debt, gig work, a heating planet — she reads every story against it.",
    priors:
      "Markets need strong rules; concentrated wealth buys concentrated power; government is the only counterweight ordinary people have; the costs of deregulation land on zip codes like the one she grew up in. Union household; the first crash she remembers took the neighbors' houses, the second took her twenties.",
    voice:
      "Direct, morally engaged, progressive. Millennial-cusp urgency, personal history close to the surface — Flint, the loans, the union hall. Scornful of 'both sides' framing when one side holds the leverage.",
  },
  right: {
    name: "Grant Colby",
    bio: "b. 1961, Amarillo, Texas (age 65). White son of a family hardware-store owner and a church organist; grandson of a WWII bomber crewman. Came of age in the Carter malaise and cast his first vote for Reagan. Texas A&M, Corps of Cadets '83; flew C-130s through Desert Storm; built and sold a regional logistics firm over two decades. Daily reads: the Wall Street Journal editorial page (a ritual since 1985), National Review, Defense News; AM talk radio on the long drives, Fox on in the office though he trusts the Journal more; lodestar writer: Thomas Sowell. Voted: Trump 2016 (held his nose at the tweets, liked the judges), Trump 2020, Trump 2024 without hesitation — his first ballot ever was Reagan '80. Hopes for America: a country his grandkids inherit stronger than he found it — energy-independent, feared by its enemies, Main Street breathing free of Washington — and the flag meaning what it meant on the flight line.",
    method:
      "Ask what strengthens the country and what weakens it: deterrence abroad, free enterprise at home, skepticism of every new government lever. He balanced the store's books under Carter-era interest rates, watched Reagan rebuild the military he then served in, and met payroll for 140 families — he reads every story against that arc.",
    priors:
      "Peace comes through strength; markets allocate better than agencies; regulation compounds until it strangles the shop on Main Street; American energy and industry are strategic assets. Faith, service, and the ledger — in that order.",
    voice:
      "Plainspoken, conservative, confident. A&M, the Cold War's end, and the flight line in every cadence; the certainty of a man who watched deterrence win once. Respects results over intentions; calls weakness what it is.",
  },
  center: {
    name: "Dana Whitfield",
    bio: "b. 1975, Columbus, Ohio (age 51). Daughter of a Korean immigrant ICU nurse and a white Ohio actuary — a split-ticket household in the ultimate swing state. B.A. economics, Ohio State; M.P.A., Princeton. Twenty years scoring bills as a congressional budget analyst before writing. Daily reads: The Economist cover to cover, the WSJ and NYT news pages with both editorial pages skipped on principle, Axios for Hill mechanics, CBO scores for pleasure; Planet Money in her ears; lodestar: Alice Rivlin. Voted: wrote in John Kasich in 2016, Biden 2020 because the institutions were on the ballot, and split her 2024 ticket on purpose — Harris for the White House, Republicans down-ballot, divided government as a feature. Hopes for America: a country that passes budgets on time, punishes both parties for fantasy arithmetic, and rebuilds the boring, trustworthy competence her parents' generation took for granted.",
    method:
      "Radical centrism, not mush: score the trade-offs, defend the institutions that make deals possible, and say plainly when BOTH camps are selling fantasy — then commit to the workable answer. She grew up translating between her parents' politics; she reads every story against both ledgers at once.",
    priors:
      "Compromise is a feature; institutions outlast movements; partisans on both ends misprice most crises; the boring fix usually wins. An immigrant mother's pragmatism, an actuary father's arithmetic.",
    voice:
      "Measured but decisive. Numerate, institutional, quietly savage about magical thinking from either flank. Always lands on a position.",
  },
} as const;

const brand: BrandProfile = {
  name: "The Wire Desk",
  publication: "The Wire Desk (example.com)",
  beat: "world news and geopolitics",
  bylines: [COLUMNISTS.left.name, COLUMNISTS.right.name, COLUMNISTS.center.name],
};

async function main(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = `out/runs/${runId}`;
  await mkdir(runDir, { recursive: true });
  let artifactN = 0;
  const recordArtifact = (label: string, content: string): void => {
    artifactN += 1;
    const file = `${runDir}/${String(artifactN).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.txt`;
    void writeFile(file, content);
  };
  // createNewsDesk's fact-check-audit try/catch is best-effort and log-only —
  // on failure it never calls recordArtifact, so a dead audit would otherwise
  // be invisible under out/runs/. Mirror that one log line into an artifact
  // here so silent audit death still shows up in provenance.
  const log = (l: string): void => {
    process.stdout.write(l + "\n");
    if (l.includes("fact-check audit failed")) recordArtifact("fact-check-audit FAILED", l);
  };

  const llm = createOllamaLlm({
    baseUrl: "http://localhost:11434",
    model: "gemma4:e4b",
    options: { numCtx: 32768, keepAlive: "30m" },
  });
  const embedder = createOllamaEmbedder({ host: "http://localhost:11434", model: "embeddinggemma" });
  const search = createFirecrawlSearch({
    apiKey: process.env.FIRECRAWL_API_KEY,
    apiUrl: process.env.FIRECRAWL_API_URL,
  });

  const sink: Sink = {
    async publish(post: GeneratedPost): Promise<PublishResult> {
      const path = `out/${post.slug}.md`;
      await writeFile(path, post.markdown);
      // Meta sidecar: the loop publishes every new md with the title/byline
      // recorded here (author-versions posts each carry their own persona
      // byline — the loop must not guess from filenames).
      await writeFile(
        `out/${post.slug}.meta.json`,
        JSON.stringify(
          {
            title: post.title,
            byline: post.byline ?? "",
            tags: post.tags ?? [],
            description: post.description ?? "",
            imageUrl: post.imageUrl ?? "",
            imageCredit: post.imageCredit ?? "",
            imageSource: post.imageSource ?? "",
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Published "${post.title}" → ${path} [DRAFT]\n`);
      let ledger: { title: string; slug: string; date: string }[] = [];
      try {
        ledger = JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        // first run
      }
      const gnHeadline = typeof post.telemetry?.topic === "string" ? post.telemetry.topic : post.title;
      // Ledger keyed to the GN headline — next-run dedup probes with raw GN
      // headlines, not the runTitle-rewritten one (final-review finding).
      ledger.push({ title: gnHeadline, slug: post.slug, date: new Date().toISOString() });
      await writeFile("out/covered.json", JSON.stringify(ledger, null, 2));
      return { url: path, status: "DRAFT" };
    },
  };

  const desk = createNewsDesk({
    llm,
    search,
    embedder,
    feeds: FEEDS,
    persona: COLUMNISTS.left,
    personas: [COLUMNISTS.right, COLUMNISTS.center],
    // Author-versions format (operator, 2026-07-23): three complete fused
    // columns per story under the source headline, capped — replaces the
    // retell+columns page. Cap 600 keeps the trio shorter than the old page.
    authorVersions: { wordCap: 600 },
    brand,
    sink,
    // Primary data (DataGod): active when the instance env is present.
    ...(process.env.DATAGOD_URL !== undefined && process.env.DATAGOD_API_KEY !== undefined
      ? { datagod: createDatagod({ apiUrl: process.env.DATAGOD_URL, apiKey: process.env.DATAGOD_API_KEY }) }
      : {}),
    knobs: {
      trendingLimit: 20, minSources: 3, pagesMax: 6,
      chunkChars: 24_000, maxChunksPerPage: 4, minContentChars: 400,
      matchThreshold: 0.62, coveredThreshold: 0.55, // 0.62→0.55 2026-07-21: three same-arc articles in four — clustering trigger hit,
      parallelCount: 4, parallelMinScore: 0.3, analysisAttempts: 3,
    },
    coveredTopics: async (): Promise<CoveredTopic[]> => {
      try {
        return JSON.parse(await readFile("out/covered.json", "utf8"));
      } catch {
        return [];
      }
    },
    log,
    recordArtifact,
  });

  const post = await desk.run();
  process.stdout.write(`Run complete: "${post.title}" (last of the author versions) — provenance: ${runDir}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`run-news-desk failed: ${String(err)}\n`);
  process.exit(1);
});

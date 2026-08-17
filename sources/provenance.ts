/**
 * provenance.ts — is this host a real newsroom, or something wearing one's name?
 *
 * The desk has two doors for sources: the curated outlet FEEDS (trustworthy by
 * construction) and the search HUNT, which fires when the feeds match fewer
 * than three outlets and admits pages from any host a web search returns.
 * Until 2026-08-16 the only filter on that door was the paywall blocklist —
 * and a paywall list is not a credibility list. Measured on the live archive:
 * 34% of 4,921 citations came from hosts no vetted-newsroom list recognises,
 * among them a WordPress site at telegraph.com styling itself "Telegraph
 * Online" (the Telegraph is telegraph.co.uk), NYT-scrapers, "news"
 * aggregators and content farms — and one of them ran as an article's LEAD
 * IMAGE. A paper whose whole claim is "every source linked" cannot link those.
 *
 * Three tiers, in the order the desk consults them:
 *
 *   1. DENY   — known impersonators, scrapers, aggregators, content farms,
 *               social platforms. Never a source, whatever the query.
 *   2. ALLOW  — real newsrooms, wires, public broadcasters, journals,
 *               institutions. Admitted freely.
 *   3. UNKNOWN — everything else. Admitted by the hunt ONLY when the story
 *               already holds at least one ALLOWed source, so an unknown host
 *               can corroborate a story but never carry one alone. The
 *               archive's long tail is 1,128 one-hit domains; some are real
 *               local papers and some are farms, and no list will settle it —
 *               so the rule limits their weight instead of guessing.
 *
 * Suffix-matched on the registrable host, so `edition.cnn.com` inherits
 * `cnn.com` and `news.google.com` inherits `google.com`. Keep both lists
 * short and specific; every entry earns its place with a reason.
 */

/** Hosts that are never a source. Impersonators are listed by the exact
 *  lookalike domain, so the real outlet stays allowed. */
export const DENY_HOSTS: readonly string[] = [
  // Impersonators / lookalikes of real papers (the real ones are in ALLOW).
  "telegraph.com", // WordPress "Telegraph Online"; The Telegraph is telegraph.co.uk
  // Scrapers and re-publishers of other outlets' copy.
  "dnyuz.com", "aivanet.com", "europesays.com", "biztoc.com", "inkl.com", "newsdive.net",
  "savedelete.com", "capwolf.com", "winzheng.com", "memesita.com", "prismnews.com", "dbriefme.com",
  "wavebrowsernews.com", "gadget-otaku.com", "americanalmanac.com", "ratednews.com", "politomix.com",
  "newsbytesapp.com", "thesiliconreview.com", "analyticsinsight.net", "krishnadoddi.com",
  "miragenews.com", "devdiscourse.com", "news.meaww.com", "meaww.com", "srnnews.com",
  // Aggregators: they point AT sources; cite the source, not the pointer.
  "newsbreak.com", "ground.news", "news.grabien.com", "grabien.com", "msn.com", "flipboard.com",
  "smartnews.com", "feedly.com", "muckrack.com", "allsides.com", "newsnow.co.uk", "yahoo.com",
  "finance.yahoo.com", "tech.yahoo.com", "news.yahoo.com", "aol.com",
  // Social platforms and video hosts: not reporting, whatever is on them.
  "youtube.com", "youtu.be", "x.com", "twitter.com", "reddit.com", "instagram.com", "facebook.com",
  "tiktok.com", "threads.net", "linkedin.com", "medium.com", "substack.com", "quora.com", "pinterest.com",
  // Search / reference-engine chrome.
  "google.com", "bing.com", "duckduckgo.com",
];

/** Real newsrooms, wires, public broadcasters, journals and institutions.
 *  Not exhaustive on purpose — UNKNOWN hosts still get in as corroboration.
 *  Suffix-matched, so a bare TLD-level entry covers all its subdomains. */
export const ALLOW_HOSTS: readonly string[] = [
  // Wires and global broadcasters
  "apnews.com", "reuters.com", "afp.com", "bbc.co.uk", "bbc.com", "aljazeera.com", "aljazeera.net",
  "dw.com", "france24.com", "euronews.com", "cnn.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com",
  "abcnews.com", "npr.org", "pbs.org", "voanews.com", "rferl.org", "cbc.ca", "ctvnews.ca", "globalnews.ca",
  "abc.net.au", "sbs.com.au", "rnz.co.nz", "nhk.or.jp", "yna.co.kr", "channelnewsasia.com",
  // Papers of record and majors, English
  "theguardian.com", "nytimes.com", "washingtonpost.com", "wsj.com", "ft.com", "economist.com",
  "bloomberg.com", "telegraph.co.uk", "thetimes.co.uk", "thetimes.com", "independent.co.uk",
  "latimes.com", "usatoday.com", "nypost.com", "chicagotribune.com", "bostonglobe.com",
  "sfchronicle.com", "seattletimes.com", "dallasnews.com", "miamiherald.com", "startribune.com",
  "ajc.com", "denverpost.com", "azcentral.com", "tampabay.com", "baltimoresun.com", "philly.com",
  "inquirer.com", "suntimes.com", "chicago.suntimes.com", "thestar.com", "theglobeandmail.com",
  "nationalpost.com", "smh.com.au", "theage.com.au", "afr.com", "irishtimes.com", "scotsman.com",
  "heraldscotland.com", "thenational.scot", "japantimes.co.jp", "koreaherald.com", "koreatimes.co.kr",
  "straitstimes.com", "scmp.com", "thehindu.com", "indianexpress.com", "hindustantimes.com",
  "timesofindia.indiatimes.com", "economictimes.indiatimes.com", "livemint.com", "dawn.com",
  "thedailystar.net", "gulfnews.com", "arabnews.com", "thenationalnews.com", "aawsat.com",
  "haaretz.com", "timesofisrael.com", "jpost.com", "iranintl.com", "businessday.co.za", "news24.com",
  "dailymaverick.co.za", "nation.africa", "theeastafrican.co.ke", "punchng.com", "premiumtimesng.com",
  // Non-English papers of record (the desk's own site: feeds)
  "lemonde.fr", "lefigaro.fr", "elpais.com", "elmundo.es", "spiegel.de", "sueddeutsche.de", "faz.net",
  "zeit.de", "corriere.it", "repubblica.it", "g1.globo.com", "globo.com", "folha.uol.com.br",
  "clarin.com", "lanacion.com.ar", "hurriyet.com.tr", "ynet.co.il", "asahi.com", "nos.nl", "derstandard.at",
  // US politics, business, tech, science press
  "politico.com", "thehill.com", "axios.com", "rollcall.com", "notus.org", "semafor.com", "puck.news",
  "theatlantic.com", "newyorker.com", "vox.com", "slate.com", "salon.com", "motherjones.com",
  "reason.com", "nationalreview.com", "thedailybeast.com", "newsweek.com", "time.com", "fortune.com",
  "forbes.com", "cnbc.com", "foxnews.com", "foxbusiness.com", "foxweather.com", "businessinsider.com",
  "marketwatch.com", "barrons.com", "investors.com", "morningstar.com", "fool.com", "benzinga.com",
  "investopedia.com", "bizjournals.com", "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com",
  "engadget.com", "cnet.com", "pcmag.com", "zdnet.com", "9to5mac.com", "9to5google.com", "macrumors.com",
  "appleinsider.com", "androidauthority.com", "androidcentral.com", "gsmarena.com", "notebookcheck.net",
  "tomshardware.com", "anandtech.com", "digitaltrends.com", "mashable.com", "gizmodo.com", "kotaku.com",
  "ign.com", "polygon.com", "eurogamer.net", "digitalfoundry.net", "thenextweb.com", "techradar.com",
  "wccftech.com", "spaceflightnow.com", "space.com", "nature.com", "science.org", "scientificamerican.com",
  "newscientist.com", "sciencenews.org", "sciencedaily.com", "sciencealert.com", "statnews.com",
  "medscape.com", "webmd.com", "psychologytoday.com", "theconversation.com", "propublica.org",
  "themarshallproject.org", "courthousenews.com", "lawfaremedia.org", "brennancenter.org", "scotusblog.com",
  "hudson.org", "brookings.edu", "cfr.org", "csis.org", "rand.org", "carnegieendowment.org", "chathamhouse.org",
  "people.com", "variety.com", "deadline.com", "hollywoodreporter.com", "rollingstone.com", "billboard.com",
  "huffpost.com", "today.com", "mediaite.com", "thegrio.com", "deseret.com", "gothamist.com", "civilbeat.org",
  "hoodline.com", "ibtimes.co.uk", "ibtimes.com", "weather.com", "accuweather.com",
  // Reference and institutions
  "wikipedia.org", "britannica.com", "merriam-webster.com", "un.org", "who.int", "imf.org", "worldbank.org",
  "nasa.gov", "noaa.gov", "cdc.gov", "nih.gov", "fda.gov", "justice.gov", "whitehouse.gov", "congress.gov",
  "senate.gov", "house.gov", "supremecourt.gov", "state.gov", "defense.gov", "europa.eu", "gov.uk",
  "parliament.uk", "canada.ca", "gov.au", "biorxiv.org", "medrxiv.org", "arxiv.org", "nintendo.com",
  "apple.com", "microsoft.com", "blog.google", "openai.com", "anthropic.com", "meta.com",
];

export type Provenance = "deny" | "allow" | "unknown";

/** Registrable-ish host: lowercase, no www./m./amp./edition. prefix. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^(www|m|amp|edition|mobile)\./, "");
}

function suffixMatch(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Where a host stands. Public-sector and academic TLDs are allowed outright:
 *  a .gov/.edu/.ac.uk/.mil/.int host is by definition not a content farm. */
export function provenanceOf(hostRaw: string): Provenance {
  const host = normalizeHost(hostRaw);
  if (host === "") return "deny";
  if (suffixMatch(host, DENY_HOSTS)) return "deny";
  if (suffixMatch(host, ALLOW_HOSTS)) return "allow";
  if (/\.(gov|edu|mil|int|ac\.uk|gov\.uk|gov\.au|gc\.ca|go\.jp|gov\.in|edu\.au)$/.test(host)) return "allow";
  return "unknown";
}

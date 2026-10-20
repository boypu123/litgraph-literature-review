// dsh-litgraph — host half.
//
// Responsibilities:
//   1. Multi-source literature search adapters (OpenAlex / Crossref / Semantic
//      Scholar / arXiv) with polite caching, timeouts and de-duplication.
//   2. Graph construction (citation + topic edges) and six-dimension scoring.
//   3. A deterministic, always-available structured review synthesizer, plus an
//      optional LLM-written review through the host `llm` service.
//   4. `/api/dsh-litgraph/*` routes for the Web GUI workspace.
//   5. Agent tools: litgraph_search / litgraph_map / litgraph_review.
//
// The module is dependency-free ESM so it can live anywhere on disk.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const name = "dsh-litgraph";
export const inject = ["webServer", "tools"];

const API_PREFIX = "/api/dsh-litgraph";
const VERSION = "0.2.0";
const STARTED_AT = new Date().toISOString();
let patchConfig = null;
const CONFIG_PATH = join(homedir(), ".dsh", "litgraph.json");
const USER_AGENT =
  "dsh-litgraph/0.1 (DeepSeek Harness literature plugin; +https://github.com/deepseek-ai)";
const HTTP_TIMEOUT_MS = 22_000;
const MAX_RESULTS = 60;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 16;
const ARCHIVE_DIR = ".literature-review";
const ARCHIVE_INDEX = "index.json";

/* ------------------------------------------------------------------ config */

const DEFAULT_CONFIG = {
  providers: ["openalex", "crossref", "semanticscholar", "arxiv"],
  yearFrom: null,
  yearTo: null,
  language: "zh",
  mailto: "",
  workspace: "",
  llm: {
    enabled: true,
    provider: "deepseek-official",
    model: "deepseek-flash",
    maxTokens: 3000,
    temperature: 0.3
  }
};

function normalizeConfig(raw) {
  const base = {
    ...DEFAULT_CONFIG,
    ...(raw && typeof raw === "object" ? raw : {}),
    llm: { ...DEFAULT_CONFIG.llm, ...(raw?.llm ?? {}) }
  };
  const providers = Array.isArray(base.providers)
    ? base.providers.filter((id) => PROVIDERS.includes(id))
    : [...DEFAULT_CONFIG.providers];
  return {
    ...base,
    providers: providers.length > 0 ? [...new Set(providers)] : [...DEFAULT_CONFIG.providers],
    language: base.language === "en" ? "en" : "zh",
    yearFrom: toYear(base.yearFrom),
    yearTo: toYear(base.yearTo),
    mailto: typeof base.mailto === "string" ? base.mailto.trim() : "",
    workspace: typeof base.workspace === "string" ? base.workspace.trim() : "",
    llm: {
      ...base.llm,
      provider: typeof base.llm.provider === "string" ? base.llm.provider.trim() : "",
      model: typeof base.llm.model === "string" ? base.llm.model.trim() : "",
      maxTokens: clampNumber(base.llm.maxTokens, 300, 6000, 3000),
      temperature: clampNumber(base.llm.temperature, 0, 1, 0.3)
    }
  };
}

let configCache = null;

async function loadConfig() {
  if (configCache) return configCache;
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    /* 补丁层 config 与 ~/.dsh/litgraph.json 合并：文件是用户改过的口径，优先。 */
    configCache = normalizeConfig({ ...(patchConfig ?? {}), ...JSON.parse(text) });
  } catch {
    configCache = normalizeConfig(patchConfig ?? null);
  }
  return configCache;
}

async function saveConfig(patch) {
  const current = await loadConfig();
  configCache = normalizeConfig({ ...current, ...patch });
  try {
    await mkdir(join(homedir(), ".dsh"), { recursive: true });
    await writeFile(CONFIG_PATH, `${JSON.stringify(configCache, null, 2)}\n`, "utf8");
    return { saved: true };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------- utils */

function toYear(value) {
  const year = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(year)) return null;
  const n = Math.trunc(year);
  return n >= 1500 && n <= 2200 ? n : null;
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value) {
  return stripHtml(value).replace(/\s+/g, " ").replace(/[.]$/, "").trim();
}

function normalizeKey(title) {
  return cleanTitle(title)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set(
  ("a an the and or of for to in on with without by from at as is are be been being this that these those " +
    "we our us it its their they them using use used based via toward towards between among into over under " +
    "study paper results show shows propose proposed approach method methods model models data new novel " +
    "can may might not no than then thus also more most less least such which what how why when where who " +
    "one two three first second third review survey analysis system systems framework frameworks")
    .split(/\s+/)
    .filter(Boolean)
);

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, application/atom+xml, text/html;q=0.9, */*;q=0.8",
        ...(init.headers ?? {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, { retries = 1, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, timeoutMs);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(350 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("request failed");
}

async function fetchText(url, { retries = 1, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, timeoutMs);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(350 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("request failed");
}

/* --------------------------------------------------------------- providers */

const PROVIDERS = ["openalex", "crossref", "semanticscholar", "arxiv"];

const TOP_VENUES = [
  "nature",
  "science",
  "cell",
  "neurips",
  "nips",
  "icml",
  "iclr",
  "acl",
  "emnlp",
  "naacl",
  "cvpr",
  "iccv",
  "eccv",
  "aaai",
  "ijcai",
  "jmlr",
  "tpami",
  "tkde",
  "sigir",
  "kdd",
  "www",
  "the lancet",
  "new england journal of medicine",
  "jama",
  "bmj",
  "plos medicine",
  "nature medicine",
  "science advances",
  "pnas",
  "physical review letters",
  "journal of the american chemical society",
  "angewandte chemie"
];

function venueTier(venue) {
  const text = String(venue ?? "").toLowerCase();
  if (!text) return 0;
  if (TOP_VENUES.some((entry) => text.includes(entry))) return 1;
  if (text.includes("arxiv") || text.includes("biorxiv") || text.includes("medrxiv")) return 0.35;
  return 0.55;
}

function reconstructAbstract(index) {
  if (!index || typeof index !== "object") return "";
  const slots = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < 4000) slots[position] = word;
    }
  }
  return slots.filter(Boolean).join(" ").trim();
}

function openAlexPaper(work) {
  const rawId = typeof work?.id === "string" ? work.id : "";
  const shortId = rawId.split("/").pop() || `${Math.random().toString(36).slice(2, 10)}`;
  const doi = String(work?.doi ?? "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const authors = Array.isArray(work?.authorships)
    ? work.authorships.map((entry) => entry?.author?.display_name).filter(Boolean).slice(0, 14)
    : [];
  return {
    id: `openalex:${shortId}`,
    source: "openalex",
    title: cleanTitle(work?.display_name ?? work?.title ?? ""),
    abstract: stripHtml(reconstructAbstract(work?.abstract_inverted_index)).slice(0, 2400),
    year: toYear(work?.publication_year),
    doi,
    url: doi ? `https://doi.org/${doi}` : rawId || "",
    venue: String(work?.primary_location?.source?.display_name ?? work?.host_venue?.display_name ?? ""),
    authors,
    citedBy: Number.isFinite(work?.cited_by_count) ? work.cited_by_count : 0,
    refs: Array.isArray(work?.referenced_works)
      ? work.referenced_works.map((entry) => `openalex:${String(entry).split("/").pop()}`).slice(0, 60)
      : [],
    topics: Array.isArray(work?.topics)
      ? work.topics.map((entry) => entry?.display_name).filter(Boolean).slice(0, 8)
      : [],
    keywords: Array.isArray(work?.keywords)
      ? work.keywords.map((entry) => entry?.display_name).filter(Boolean).slice(0, 10)
      : [],
    openAccess: Boolean(work?.open_access?.is_oa),
    type: String(work?.type ?? "")
  };
}

function crossrefPaper(item) {
  const doi = String(item?.DOI ?? "");
  const title = Array.isArray(item?.title) ? item.title[0] : item?.title;
  const container = Array.isArray(item?.["container-title"])
    ? item["container-title"][0]
    : item?.["container-title"];
  const authors = Array.isArray(item?.author)
    ? item.author
        .map((entry) => [entry?.given, entry?.family].filter(Boolean).join(" ").trim())
        .filter(Boolean)
        .slice(0, 14)
    : [];
  const issued = item?.issued?.["date-parts"]?.[0]?.[0];
  return {
    id: `crossref:${doi || normalizeKey(title).slice(0, 60)}`,
    source: "crossref",
    title: cleanTitle(title ?? ""),
    abstract: stripHtml(item?.abstract ?? "").slice(0, 2400),
    year: toYear(issued),
    doi,
    url: doi ? `https://doi.org/${doi}` : String(item?.URL ?? ""),
    venue: stripHtml(container ?? ""),
    authors,
    citedBy: Number.isFinite(item?.["is-referenced-by-count"]) ? item["is-referenced-by-count"] : 0,
    refs: [],
    topics: Array.isArray(item?.subject) ? item.subject.slice(0, 8) : [],
    keywords: [],
    openAccess: false,
    type: String(item?.type ?? "")
  };
}

function s2Paper(item) {
  const external = item?.externalIds ?? {};
  const doi = typeof external.DOI === "string" ? external.DOI : "";
  return {
    id: `s2:${item?.paperId ?? normalizeKey(item?.title ?? "").slice(0, 60)}`,
    source: "semanticscholar",
    title: cleanTitle(item?.title ?? ""),
    abstract: stripHtml(item?.abstract ?? "").slice(0, 2400),
    year: toYear(item?.year),
    doi,
    url: doi
      ? `https://doi.org/${doi}`
      : item?.paperId
        ? `https://www.semanticscholar.org/paper/${item.paperId}`
        : "",
    venue: String(item?.venue ?? ""),
    authors: Array.isArray(item?.authors)
      ? item.authors.map((entry) => entry?.name).filter(Boolean).slice(0, 14)
      : [],
    citedBy: Number.isFinite(item?.citationCount) ? item.citationCount : 0,
    refs: [],
    topics: Array.isArray(item?.fieldsOfStudy) ? item.fieldsOfStudy.filter(Boolean).slice(0, 8) : [],
    keywords: [],
    openAccess: Boolean(item?.openAccessPdf?.url),
    type: ""
  };
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function arxivEntries(xml) {
  const entries = String(xml ?? "").split(/<entry>/i).slice(1);
  return entries.map((chunk) => {
    const body = chunk.split(/<\/entry>/i)[0] ?? "";
    const tag = (name) => {
      const match = body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
      return match ? decodeXml(match[1]).replace(/\s+/g, " ").trim() : "";
    };
    const rawId = tag("id");
    const idMatch = rawId.match(/abs\/([^/]+?)(v\d+)?$/);
    const authors = [...body.matchAll(/<name>([\s\S]*?)<\/name>/gi)]
      .map((match) => decodeXml(match[1]).trim())
      .filter(Boolean)
      .slice(0, 14);
    const categories = [...body.matchAll(/<category[^>]*term="([^"]+)"/gi)]
      .map((match) => match[1])
      .slice(0, 8);
    const doiMatch = body.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
    return {
      id: `arxiv:${idMatch ? idMatch[1] : rawId}`,
      source: "arxiv",
      title: cleanTitle(tag("title")),
      abstract: stripHtml(tag("summary")).slice(0, 2400),
      year: toYear(tag("published").slice(0, 4)),
      doi: doiMatch ? decodeXml(doiMatch[1]).trim() : "",
      url: rawId || "",
      venue: "arXiv",
      authors,
      citedBy: 0,
      refs: [],
      topics: categories,
      keywords: [],
      openAccess: true,
      type: "preprint"
    };
  });
}

async function openAlexSearch({ query, limit, yearFrom, yearTo, mailto }) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    select:
      "id,doi,display_name,publication_year,abstract_inverted_index,authorships,primary_location,cited_by_count,referenced_works,topics,keywords,open_access,type"
  });
  if (yearFrom && yearTo) params.set("filter", `publication_year:${yearFrom}-${yearTo}`);
  else if (yearFrom) params.set("filter", `publication_year:>${yearFrom - 1}`);
  else if (yearTo) params.set("filter", `publication_year:<${yearTo + 1}`);
  if (mailto) params.set("mailto", mailto);
  const payload = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);
  return (Array.isArray(payload?.results) ? payload.results : []).map(openAlexPaper).filter((p) => p.title);
}

async function crossrefSearch({ query, limit, yearFrom, yearTo, mailto }) {
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: String(limit),
    select: "DOI,title,abstract,author,container-title,issued,is-referenced-by-count,URL,type,subject",
    sort: "relevance"
  });
  const filters = [];
  if (yearFrom) filters.push(`from-pub-date:${yearFrom}-01-01`);
  if (yearTo) filters.push(`until-pub-date:${yearTo}-12-31`);
  if (filters.length > 0) params.set("filter", filters.join(","));
  if (mailto) params.set("mailto", mailto);
  const payload = await fetchJson(`https://api.crossref.org/works?${params.toString()}`);
  const items = Array.isArray(payload?.message?.items) ? payload.message.items : [];
  return items.map(crossrefPaper).filter((p) => p.title);
}

async function s2Search({ query, limit, yearFrom, yearTo }) {
  const fields = "title,abstract,year,authors,venue,citationCount,externalIds,openAccessPdf,fieldsOfStudy,paperId";
  const params = new URLSearchParams({ query, limit: String(Math.min(limit, 100)), fields });
  if (yearFrom || yearTo) params.set("year", `${yearFrom ?? ""}-${yearTo ?? ""}`);
  const payload = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`, {
    retries: 2
  });
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items.map(s2Paper).filter((p) => p.title);
}

async function arxivSearch({ query, limit }) {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: "0",
    max_results: String(Math.min(limit, 50)),
    sortBy: "relevance"
  });
  const xml = await fetchText(`https://export.arxiv.org/api/query?${params.toString()}`);
  return arxivEntries(xml).filter((p) => p.title);
}

async function openAlexByIds(ids) {
  const clean = ids.filter((id) => id.startsWith("openalex:")).map((id) => id.slice("openalex:".length));
  if (clean.length === 0) return [];
  const params = new URLSearchParams({
    filter: `openalex:${clean.join("|")}`,
    per_page: String(Math.min(clean.length, 50)),
    select:
      "id,doi,display_name,publication_year,abstract_inverted_index,authorships,primary_location,cited_by_count,referenced_works,topics,keywords,open_access,type"
  });
  const payload = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);
  return (Array.isArray(payload?.results) ? payload.results : []).map(openAlexPaper).filter((p) => p.title);
}

async function openAlexRelated(openAlexId) {
  const shortId = String(openAlexId).replace(/^openalex:/, "");
  const params = new URLSearchParams({
    filter: `related_to:${shortId}`,
    per_page: "8",
    select:
      "id,doi,display_name,publication_year,abstract_inverted_index,authorships,primary_location,cited_by_count,referenced_works,topics,keywords,open_access,type"
  });
  const payload = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);
  return (Array.isArray(payload?.results) ? payload.results : []).map(openAlexPaper).filter((p) => p.title);
}

const SEARCHERS = {
  openalex: openAlexSearch,
  crossref: crossrefSearch,
  semanticscholar: s2Search,
  arxiv: arxivSearch
};

/* ------------------------------------------------------------ search merge */

function mergePaper(a, b) {
  const merged = { ...a };
  if (!merged.abstract && b.abstract) merged.abstract = b.abstract;
  if (!merged.doi && b.doi) merged.doi = b.doi;
  if (!merged.url && b.url) merged.url = b.url;
  if (!merged.venue && b.venue) merged.venue = b.venue;
  if (!merged.year && b.year) merged.year = b.year;
  if ((merged.citedBy ?? 0) < (b.citedBy ?? 0)) merged.citedBy = b.citedBy;
  if ((merged.authors?.length ?? 0) < (b.authors?.length ?? 0)) merged.authors = b.authors;
  merged.refs = [...new Set([...(merged.refs ?? []), ...(b.refs ?? [])])];
  merged.topics = [...new Set([...(merged.topics ?? []), ...(b.topics ?? [])])].slice(0, 8);
  merged.keywords = [...new Set([...(merged.keywords ?? []), ...(b.keywords ?? [])])].slice(0, 10);
  merged.openAccess = merged.openAccess || b.openAccess;
  merged.position = Math.min(
    Number.isFinite(merged.position) ? merged.position : 99,
    Number.isFinite(b.position) ? b.position : 99
  );
  merged.sources = [...new Set([...(merged.sources ?? [merged.source]), b.source])];
  return merged;
}

const searchCache = new Map();

function cacheKey(input) {
  return JSON.stringify({
    query: normalizeKey(input.query),
    providers: [...(input.providers ?? [])].sort(),
    yearFrom: input.yearFrom ?? null,
    yearTo: input.yearTo ?? null,
    limit: input.limit ?? 30,
    mode: input.mode ?? "balanced",
    snowball: Boolean(input.snowball)
  });
}

function readCache(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.payload;
}

function writeCache(key, payload) {
  if (searchCache.size >= CACHE_LIMIT) {
    const oldest = [...searchCache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (oldest) searchCache.delete(oldest[0]);
  }
  searchCache.set(key, { at: Date.now(), payload });
}

function limitForMode(mode, limit) {
  const base = clampNumber(limit, 5, MAX_RESULTS, 30);
  if (mode === "focused") return Math.min(base, 18);
  if (mode === "broad") return Math.min(MAX_RESULTS, Math.round(base * 1.6));
  return base;
}

async function runSearch(rawInput, options = {}) {
  const config = await loadConfig();
  const query = String(rawInput?.query ?? "").trim();
  if (query.length < 2) throw new Error("检索主题至少需要 2 个字符");

  const mode = ["focused", "balanced", "broad"].includes(rawInput?.mode) ? rawInput.mode : "balanced";
  const limit = limitForMode(mode, rawInput?.limit);
  const providers = (Array.isArray(rawInput?.providers) && rawInput.providers.length > 0
    ? rawInput.providers
    : config.providers
  ).filter((id) => PROVIDERS.includes(id));
  const yearFrom = toYear(rawInput?.yearFrom) ?? config.yearFrom;
  const yearTo = toYear(rawInput?.yearTo) ?? config.yearTo;
  const snowball = rawInput?.snowball !== false;

  const key = cacheKey({ query, providers, yearFrom, yearTo, limit, mode, snowball });
  const cached = readCache(key);
  if (cached && !options.force) return { ...cached, cached: true };

  const log = [];
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const started = Date.now();
      try {
        const found = (await SEARCHERS[provider]({ query, limit, yearFrom, yearTo, mailto: config.mailto }))
          .filter((paper) => paper.title)
          .map((paper, position) => ({ ...paper, position }));
        log.push({ provider, ok: true, found: found.length, ms: Date.now() - started });
        return { provider, found };
      } catch (error) {
        log.push({
          provider,
          ok: false,
          found: 0,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error)
        });
        return { provider, found: [] };
      }
    })
  );

  const collected = [];
  for (const entry of settled) {
    if (entry.status === "fulfilled") collected.push(...entry.value.found);
  }

  // De-duplicate by DOI first, then by normalized title.
  const byDoi = new Map();
  const byTitle = new Map();
  for (const paper of collected) {
    if (!paper.title) continue;
    const doiKey = paper.doi ? paper.doi.toLowerCase() : "";
    const titleKey = normalizeKey(paper.title);
    const existingKey = doiKey && byDoi.has(doiKey) ? byDoi.get(doiKey) : byTitle.get(titleKey);
    if (existingKey) {
      const index = byTitle.get(existingKey);
      if (index !== undefined) collected[index] = mergePaper(collected[index], paper);
      if (doiKey) byDoi.set(doiKey, existingKey);
      continue;
    }
    const index = collected.length;
    collected.push({ ...paper, sources: [paper.source] });
    byTitle.set(titleKey, index);
    if (doiKey) byDoi.set(doiKey, titleKey);
  }

  const deduped = [];
  const seen = new Set();
  for (const paper of collected) {
    const titleKey = normalizeKey(paper.title);
    if (!titleKey || seen.has(titleKey)) continue;
    seen.add(titleKey);
    deduped.push(paper);
  }

  let papers = deduped;

  // Depth lane: pull the references of the strongest hits back into the corpus.
  if (snowball && mode !== "focused") {
    const seedRefs = deduped
      .filter((paper) => (paper.refs?.length ?? 0) > 0)
      .sort((left, right) => (right.citedBy ?? 0) - (left.citedBy ?? 0))
      .slice(0, 3)
      .flatMap((paper) => paper.refs.slice(0, 12));
    const knownOpenAlex = new Set(papers.map((paper) => paper.id));
    const wanted = [...new Set(seedRefs)].filter((id) => id.startsWith("openalex:") && !knownOpenAlex.has(id));
    if (wanted.length > 0) {
      try {
        const extra = await openAlexByIds(wanted.slice(0, 24));
        log.push({ provider: "openalex:references", ok: true, found: extra.length, ms: 0 });
        papers = mergeCorpus(papers, extra);
      } catch (error) {
        log.push({
          provider: "openalex:references",
          ok: false,
          found: 0,
          ms: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // Lateral lane: related-work expansion around the top hit.
  if (snowball && mode === "broad") {
    const seed = papers.find((paper) => paper.id.startsWith("openalex:"));
    if (seed) {
      try {
        const extra = await openAlexRelated(seed.id);
        log.push({ provider: "openalex:related", ok: true, found: extra.length, ms: 0 });
        papers = mergeCorpus(papers, extra);
      } catch (error) {
        log.push({
          provider: "openalex:related",
          ok: false,
          found: 0,
          ms: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const scored = papers.map((paper, index) => scorePaper(paper, papers, index));
  scored.sort((left, right) => right.rank - left.rank);

  const payload = {
    query,
    mode,
    providers,
    limit,
    yearFrom,
    yearTo,
    generatedAt: new Date().toISOString(),
    papers: scored,
    log,
    stats: {
      fetched: collected.length,
      kept: scored.length,
      duplicatesRemoved: Math.max(0, collected.length - scored.length),
      withAbstract: scored.filter((paper) => (paper.abstract ?? "").length > 60).length,
      openAccess: scored.filter((paper) => paper.openAccess).length,
      yearMin: scored.reduce((min, paper) => (paper.year && (!min || paper.year < min) ? paper.year : min), null),
      yearMax: scored.reduce((max, paper) => (paper.year && (!max || paper.year > max) ? paper.year : max), null)
    }
  };
  writeCache(key, payload);
  return payload;
}

function mergeCorpus(papers, extra) {
  const byTitle = new Map(papers.map((paper) => [normalizeKey(paper.title), paper]));
  const out = [...papers];
  for (const paper of extra) {
    const key = normalizeKey(paper.title);
    if (!key) continue;
    const existing = byTitle.get(key);
    if (existing) {
      const index = out.indexOf(existing);
      if (index >= 0) out[index] = mergePaper(existing, paper);
      continue;
    }
    const fresh = { ...paper, sources: paper.sources ?? [paper.source] };
    out.push(fresh);
    byTitle.set(key, fresh);
  }
  return out;
}

/* ----------------------------------------------------------------- scoring */

const STAT_WORDS = [
  "significant",
  "p<",
  "p <",
  "confidence interval",
  "ablation",
  "baseline",
  "benchmark",
  "dataset",
  "sample size",
  "cohort",
  "randomized",
  "controlled trial",
  "replicated",
  "statistical"
];

const RESULT_WORDS = ["we find", "results show", "our results", "improv", "outperform", "achiev", "reveal", "demonstrat"];
const NOVELTY_WORDS = ["first", "novel", "new ", "unprecedented", "we introduce", "we propose"];
const REPRO_WORDS = ["code is available", "github", "data availability", "open-source", "open source", "we release", "reproduc"];

function countHits(text, words) {
  const haystack = String(text ?? "").toLowerCase();
  return words.reduce((total, word) => (haystack.includes(word) ? total + 1 : total), 0);
}

function scorePaper(paper, corpus, index) {
  const currentYear = new Date().getFullYear();
  const year = paper.year ?? currentYear;
  const age = Math.max(1, currentYear - year + 1);
  const citationsPerYear = (paper.citedBy ?? 0) / age;
  const bestRate = Math.max(
    1,
    ...corpus.map((entry) => (entry.citedBy ?? 0) / Math.max(1, currentYear - (entry.year ?? currentYear) + 1))
  );
  const abstract = paper.abstract ?? "";
  const text = `${paper.title} ${abstract} ${(paper.topics ?? []).join(" ")}`;

  const impact = clamp01(citationsPerYear / bestRate);
  const venue = clamp01(venueTier(paper.venue) + (paper.doi ? 0.1 : 0) + (paper.type === "article" ? 0.05 : 0));
  const rigor = clamp01(0.2 + countHits(text, STAT_WORDS) * 0.14 + Math.min(abstract.length / 1400, 1) * 0.3);
  const evidence = clamp01(0.15 + countHits(text, RESULT_WORDS) * 0.18 + (abstract.length > 400 ? 0.2 : 0));
  const recency = clamp01(1 - (currentYear - year) / 12);
  const novelty = clamp01(recency * 0.65 + countHits(text, NOVELTY_WORDS) * 0.12 + (paper.type === "preprint" ? 0.08 : 0));
  const reproducibility = clamp01(
    (paper.openAccess ? 0.45 : 0.1) + countHits(text, REPRO_WORDS) * 0.15 + (paper.source === "arxiv" ? 0.1 : 0)
  );

  const dimensions = { impact, venue, rigor, evidence, novelty, reproducibility };
  const weights = { impact: 0.22, venue: 0.16, rigor: 0.2, evidence: 0.16, novelty: 0.15, reproducibility: 0.11 };
  const composite = Object.entries(weights).reduce((total, [key, weight]) => total + dimensions[key] * weight, 0);
  // Search-engine position keeps on-topic-but-young work ahead of merely
  // famous off-topic papers inside the ranked list.
  const relevance = clamp01(1 - (Number.isFinite(paper.position) ? paper.position : 14) / 18);

  return {
    ...paper,
    sources: paper.sources && paper.sources.length > 0 ? paper.sources : [paper.source],
    relevance: Number(relevance.toFixed(3)),
    index: index + 1,
    key: `P${index + 1}`,
    scores: Object.fromEntries(
      Object.entries(dimensions).map(([key, value]) => [key, Number(value.toFixed(3))])
    ),
    composite: Number(composite.toFixed(3)),
    rank:
      composite * 0.82 +
      relevance * 0.18 +
      Math.min((paper.citedBy ?? 0) / 8000, 0.12)
  };
}

/* -------------------------------------------------------------------- graph */

function buildGraph(papers) {
  const nodes = papers.map((paper) => ({
    id: paper.id,
    key: paper.key,
    label: paper.title,
    short: paper.title.length > 74 ? `${paper.title.slice(0, 72)}…` : paper.title,
    year: paper.year,
    venue: paper.venue,
    citedBy: paper.citedBy,
    source: paper.source,
    sources: paper.sources ?? [paper.source],
    score: paper.composite,
    scores: paper.scores,
    doi: paper.doi,
    url: paper.url,
    authors: paper.authors?.slice(0, 4) ?? [],
    openAccess: paper.openAccess
  }));

  const topicSets = new Map(
    papers.map((paper) => [
      paper.id,
      new Set(
        [...(paper.topics ?? []), ...(paper.keywords ?? [])]
          .map((entry) => String(entry).toLowerCase().trim())
          .filter(Boolean)
      )
    ])
  );

  const edges = [];
  const byId = new Map(papers.map((paper) => [paper.id, paper]));
  for (let i = 0; i < papers.length; i += 1) {
    for (let j = i + 1; j < papers.length; j += 1) {
      const left = papers[i];
      const right = papers[j];
      const reasons = [];
      let weight = 0;

      const cites =
        (left.refs ?? []).includes(right.id) || (right.refs ?? []).includes(left.id);
      if (cites) {
        weight += 3;
        reasons.push("citation");
      }

      const topicOverlap = jaccard(topicSets.get(left.id) ?? new Set(), topicSets.get(right.id) ?? new Set());
      if (topicOverlap > 0.12) {
        weight += topicOverlap * 2.2;
        reasons.push("topic");
      }

      const keywordOverlap = jaccard(
        new Set(tokenize(`${left.title} ${(left.abstract ?? "").slice(0, 400)}`)),
        new Set(tokenize(`${right.title} ${(right.abstract ?? "").slice(0, 400)}`))
      );
      if (keywordOverlap > 0.1) {
        weight += keywordOverlap * 1.6;
        reasons.push("term");
      }

      if (left.authors?.[0] && left.authors[0] === right.authors?.[0]) {
        weight += 0.8;
        reasons.push("author");
      }

      if (weight >= 0.55) {
        edges.push({
          source: left.id,
          target: right.id,
          weight: Number(weight.toFixed(2)),
          reasons: [...new Set(reasons)]
        });
      }
    }
  }

  // Keep the backbone readable: strongest 6 edges per node.
  const perNode = new Map();
  edges.sort((left, right) => right.weight - left.weight);
  const kept = [];
  for (const edge of edges) {
    const sourceCount = perNode.get(edge.source) ?? 0;
    const targetCount = perNode.get(edge.target) ?? 0;
    if (sourceCount >= 6 || targetCount >= 6) continue;
    perNode.set(edge.source, sourceCount + 1);
    perNode.set(edge.target, targetCount + 1);
    kept.push(edge);
  }

  // Label propagation gives each node a cluster id used for colouring.
  const clusterOf = new Map(nodes.map((node) => [node.id, node.id]));
  const neighbours = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of kept) {
    neighbours.get(edge.source)?.push(edge.target);
    neighbours.get(edge.target)?.push(edge.source);
  }
  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    for (const node of nodes) {
      const counts = new Map();
      for (const neighbour of neighbours.get(node.id) ?? []) {
        const cluster = clusterOf.get(neighbour);
        counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      const winner = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
      if (winner && winner !== clusterOf.get(node.id)) {
        clusterOf.set(node.id, winner);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Label propagation gives each node a raw cluster id; singletons are then
  // folded into the most topically similar surviving cluster so the map keeps
  // a handful of readable groups instead of dozens of one-paper colours.
  const rawGroups = new Map();
  for (const node of nodes) {
    const raw = clusterOf.get(node.id);
    if (!rawGroups.has(raw)) rawGroups.set(raw, []);
    rawGroups.get(raw).push(node);
  }
  const groupTopics = (group) => {
    const set = new Set();
    for (const node of group) {
      for (const term of topicSets.get(node.id) ?? []) set.add(term);
      for (const term of tokenize(node.label)) set.add(term);
    }
    return set;
  };
  const finals = [];
  for (const group of [...rawGroups.values()].sort((left, right) => right.length - left.length)) {
    if (group.length >= 3 || finals.length === 0) {
      finals.push(group);
      continue;
    }
    const topics = groupTopics(group);
    let best = null;
    let bestScore = 0;
    for (const candidate of finals) {
      const score = jaccard(topics, groupTopics(candidate));
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best && bestScore >= 0.08) best.push(...group);
    else finals.push(group);
  }
  finals.forEach((group, index) => {
    for (const node of group) node.cluster = index;
  });

  const clusters = finals.map((group, index) => {
    const terms = new Map();
    for (const node of group) {
      for (const term of tokenize(node.label)) terms.set(term, (terms.get(term) ?? 0) + 1);
    }
    const label = [...terms.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([term]) => term)
      .join(" · ");
    return {
      id: index,
      label: label || `Cluster ${index + 1}`,
      size: group.length,
      members: group.map((node) => node.key),
      years: group.map((node) => node.year).filter(Boolean).sort((a, b) => a - b)
    };
  });

  const yearBuckets = new Map();
  for (const paper of papers) {
    const year = paper.year ?? 0;
    yearBuckets.set(year, (yearBuckets.get(year) ?? 0) + 1);
  }
  const timeline = [...yearBuckets.entries()]
    .filter(([year]) => year > 0)
    .sort((left, right) => left[0] - right[0])
    .map(([year, count]) => ({ year, count }));

  return {
    nodes,
    edges: kept,
    clusters,
    timeline,
    byId,
    metrics: {
      nodes: nodes.length,
      edges: kept.length,
      density: nodes.length > 1 ? Number(((2 * kept.length) / (nodes.length * (nodes.length - 1))).toFixed(3)) : 0,
      clusters: clusters.length
    }
  };
}

/* ------------------------------------------------------------ review writer */

function summarizeVenues(papers) {
  const counts = new Map();
  for (const paper of papers) {
    const venue = (paper.venue ?? "").trim();
    if (!venue) continue;
    counts.set(venue, (counts.get(venue) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
}

function summarizeAuthors(papers) {
  const counts = new Map();
  for (const paper of papers) {
    for (const author of paper.authors ?? []) counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function cite(paper) {
  const authors = paper.authors ?? [];
  const lead = authors.length === 0 ? "佚名" : authors.length > 2 ? `${authors[0]} 等` : authors.join(" & ");
  return `${lead} (${paper.year ?? "n.d."}), ${paper.venue || "未注明来源"}`;
}

function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return `${head}\n${divider}\n${body}`;
}

function deterministicReview(payload, language) {
  const papers = payload.papers ?? [];
  const graph = buildGraph(papers);
  const stats = payload.stats ?? {};
  const zh = language !== "en";
  const top = papers.slice(0, 6);
  const years = papers.map((paper) => paper.year).filter(Boolean).sort((a, b) => a - b);
  const span = years.length > 0 ? `${years[0]}–${years[years.length - 1]}` : "未知";
  const clusters = graph.clusters.filter((cluster) => cluster.size > 0);
  const openAccessRate = papers.length > 0 ? stats.openAccess / papers.length : 0;

  const consensus = top.filter((paper) => paper.scores.evidence >= 0.55);
  const contested = top.filter((paper) => paper.scores.evidence < 0.35);
  const recentThin = papers.filter((paper) => (paper.year ?? 0) >= new Date().getFullYear() - 1 && (paper.citedBy ?? 0) < 5);

  const lines = [];
  lines.push(`# 文献综述：${payload.query}`);
  lines.push("");
  lines.push(
    `> 自动生成于 ${new Date(payload.generatedAt ?? Date.now()).toLocaleString("zh-CN")} · 检索模式 ${payload.mode} · 语料 ${papers.length} 篇（${span}）· 数据源 ${payload.providers.join(" / ")}`
  );
  lines.push("");
  lines.push("## 1. 研究问题与检索方法");
  lines.push("");
  lines.push(
    `本综述围绕「**${payload.query}**」构建证据基础。检索覆盖 ${payload.providers.join("、")}，按相关度排序取回 ${stats.fetched ?? papers.length} 条记录，经 DOI 与标题归一化去重后保留 ${papers.length} 篇${stats.duplicatesRemoved ? `（去除重复 ${stats.duplicatesRemoved} 篇）` : ""}。`
  );
  lines.push("");
  lines.push(
    `- 时间范围：${payload.yearFrom ?? years[0] ?? "不限"} – ${payload.yearTo ?? years[years.length - 1] ?? "不限"}；实际分布 ${span}`
  );
  lines.push(`- 摘要可用率：${pct((stats.withAbstract ?? 0) / Math.max(1, papers.length))}；开放获取比例：${pct(openAccessRate)}`);
  lines.push(
    `- 检索通道：${(payload.log ?? [])
      .map((entry) => `${entry.provider}${entry.ok ? `(${entry.found})` : "✗"}`)
      .join("、")}`
  );
  lines.push(`- 图谱结构：${graph.metrics.nodes} 节点 / ${graph.metrics.edges} 边 / 密度 ${graph.metrics.density} / ${graph.metrics.clusters} 个主题簇`);
  lines.push("");

  lines.push("## 2. 语料概览");
  lines.push("");
  const venueRows = summarizeVenues(papers).map(([venue, count]) => [venue, String(count)]);
  lines.push(table(["来源期刊/会议", "命中篇数"], venueRows.length > 0 ? venueRows : [["（未记录）", "—"]]));
  lines.push("");
  const authorRows = summarizeAuthors(papers)
    .slice(0, 5)
    .map(([author, count]) => [author, String(count)]);
  if (authorRows.length > 0) {
    lines.push(table(["高频作者", "出现篇数"], authorRows));
    lines.push("");
  }
  lines.push(
    `引文影响力方面，最高被引作品为 **${papers[0]?.title ?? "—"}**（${papers[0]?.citedBy ?? 0} 次引用，${papers[0]?.year ?? "—"}），语料中 ${papers.filter((paper) => (paper.citedBy ?? 0) === 0).length} 篇尚无引用记录，提示其中包含大量新近发表或预印本工作。`
  );
  lines.push("");

  lines.push("## 3. 研究脉络与关键节点");
  lines.push("");
  const ordered = [...papers].filter((paper) => paper.year).sort((left, right) => left.year - right.year);
  const milestones = [];
  const cursorYears = [...new Set(ordered.map((paper) => paper.year))];
  for (const year of cursorYears) {
    const bucket = ordered.filter((paper) => paper.year === year);
    const best = bucket.sort((left, right) => right.composite - left.composite)[0];
    if (!best) continue;
    milestones.push(`- **${year}**：${best.title} — ${cite(best)}；六维综合分 ${best.composite.toFixed(2)}`);
  }
  lines.push(milestones.slice(-10).join("\n") || "- 语料未包含可解析的出版年份，无法重建时间线。");
  lines.push("");

  lines.push("## 4. 主题簇与子领域");
  lines.push("");
  if (clusters.length === 0) {
    lines.push("语料间未形成稳定的共被引/主题连通结构，建议扩大检索或补充同义词。");
  } else {
    const rankedClusters = [...clusters].sort((left, right) => right.size - left.size).slice(0, 6);
    for (const cluster of rankedClusters) {
      const members = papers.filter((paper) => cluster.members.includes(paper.key));
      const lead = members.sort((left, right) => right.composite - left.composite).slice(0, 3);
      lines.push(`### 簇 ${cluster.id + 1}：${cluster.label}（${cluster.size} 篇）`);
      lines.push("");
      lines.push(
        `时间跨度 ${cluster.years[0] ?? "—"}–${cluster.years[cluster.years.length - 1] ?? "—"}；代表工作：${lead
          .map((paper) => `**${paper.key}** ${paper.title}`)
          .join("；")}。`
      );
      lines.push("");
    }
  }

  lines.push("## 5. 方法对比矩阵");
  lines.push("");
  const methodRows = top.map((paper) => {
    const method = (paper.topics ?? []).slice(0, 2).join(" / ") || (paper.type || "未标注");
    return [
      paper.key,
      paper.title.length > 46 ? `${paper.title.slice(0, 44)}…` : paper.title,
      paper.year ? String(paper.year) : "—",
      method,
      paper.scores.rigor.toFixed(2),
      paper.scores.evidence.toFixed(2),
      paper.scores.reproducibility.toFixed(2)
    ];
  });
  lines.push(
    table(["#", "标题", "年份", "方法/主题", "严谨性", "证据强度", "可复现性"], methodRows.length > 0 ? methodRows : [["—", "—", "—", "—", "—", "—", "—"]])
  );
  lines.push("");

  lines.push("## 6. 六维质量评估");
  lines.push("");
  const dimensionLabel = {
    impact: "影响力",
    venue: "载体质量",
    rigor: "方法严谨性",
    evidence: "证据强度",
    novelty: "新颖度",
    reproducibility: "可复现性"
  };
  const averages = Object.keys(dimensionLabel).map((key) => {
    const mean = papers.reduce((total, paper) => total + (paper.scores?.[key] ?? 0), 0) / Math.max(1, papers.length);
    return [dimensionLabel[key], mean.toFixed(2), mean >= 0.6 ? "较好" : mean >= 0.4 ? "中等" : "偏弱"];
  });
  lines.push(table(["维度", "语料均值", "判读"], averages));
  lines.push("");
  lines.push(
    `评估采用可解释的启发式指标（引用速率、载体层级、统计/实验信号词、结果陈述密度、时效与新颖措辞、开放获取与代码数据声明），权重为 影响力 .22 / 载体 .16 / 严谨 .20 / 证据 .16 / 新颖 .15 / 可复现 .11。分数用于**排序与筛选**，不构成对研究质量的最终裁定。`
  );
  lines.push("");

  lines.push("## 7. 共识、分歧与争议");
  lines.push("");
  if (consensus.length > 0) {
    lines.push("**较稳固的结论**（证据信号充分且被多篇工作重复）：");
    for (const paper of consensus.slice(0, 4)) {
      lines.push(`- ${paper.key} ${paper.title}（${cite(paper)}）— 证据强度 ${paper.scores.evidence.toFixed(2)}`);
    }
  } else {
    lines.push("**较稳固的结论**：当前语料中缺乏同时具备强方法信号与结果陈述的工作，暂无法提炼稳定共识。");
  }
  lines.push("");
  if (contested.length > 0) {
    lines.push("**需要谨慎对待或存在分歧**（摘要信息不足、结论外推受限）：");
    for (const paper of contested.slice(0, 4)) {
      lines.push(`- ${paper.key} ${paper.title} — 摘要完整度不足，结论边界需回到原文核对`);
    }
  } else {
    lines.push("**需要谨慎对待或存在分歧**：未检出明显薄弱的条目。");
  }
  lines.push("");

  lines.push("## 8. 研究空白与机会");
  lines.push("");
  const gaps = [];
  const thinClusters = [...clusters].filter((cluster) => cluster.size <= 2);
  if (thinClusters.length > 0) {
    gaps.push(
      `主题簇 ${thinClusters.map((cluster) => `「${cluster.label}」`).slice(0, 3).join("、")} 仅有 1–2 篇支撑，可能是尚未充分开发的交叉方向。`
    );
  }
  const oldHighImpact = papers.filter((paper) => (paper.year ?? 9999) < new Date().getFullYear() - 5 && (paper.citedBy ?? 0) > 50);
  if (oldHighImpact.length > 0) {
    gaps.push(
      `高被引但已过时的经典（如 ${oldHighImpact.slice(0, 2).map((paper) => paper.key).join("、")}）缺少近年复现或更新，存在"结论老化"风险。`
    );
  }
  if (recentThin.length > 0) {
    gaps.push(`近两年有 ${recentThin.length} 篇新工作尚未积累引用，是追踪前沿的信号源，但可靠性有待时间检验。`);
  }
  if (openAccessRate < 0.4) {
    gaps.push(`开放获取比例仅 ${pct(openAccessRate)}，复现成本高；优先核对可获取全文的条目。`);
  }
  const noAbstract = papers.filter((paper) => (paper.abstract ?? "").length <= 60);
  if (noAbstract.length > 0) {
    gaps.push(`${noAbstract.length} 篇缺少可用摘要（${noAbstract.slice(0, 4).map((paper) => paper.key).join("、")}…），其判断仅基于题录信息。`);
  }
  lines.push(gaps.length > 0 ? gaps.map((gap) => `- ${gap}`).join("\n") : "- 未检出显著空白，建议换用更细粒度的子问题或跨领域术语继续挖掘。");
  lines.push("");

  lines.push("## 9. 推荐阅读路径");
  lines.push("");
  const path = [];
  const classic = [...papers].filter((paper) => (paper.citedBy ?? 0) > 0).sort((left, right) => (right.citedBy ?? 0) - (left.citedBy ?? 0))[0];
  if (classic) path.push(classic);
  const bridge = [...papers]
    .filter((paper) => !path.includes(paper))
    .sort((left, right) => right.composite - left.composite)[0];
  if (bridge) path.push(bridge);
  const frontier = [...papers]
    .filter((paper) => !path.includes(paper) && (paper.year ?? 0) >= new Date().getFullYear() - 2)
    .sort((left, right) => right.composite - left.composite)[0];
  if (frontier) path.push(frontier);
  const methodical = [...papers]
    .filter((paper) => !path.includes(paper))
    .sort((left, right) => right.scores.rigor - left.scores.rigor)[0];
  if (methodical) path.push(methodical);
  path.forEach((paper, index) => {
    lines.push(
      `${index + 1}. **${paper.key}** ${paper.title} — ${cite(paper)}${paper.doi ? `；doi:${paper.doi}` : ""}`
    );
  });
  if (path.length === 0) lines.push("1. 语料为空，无法给出阅读路径。");
  lines.push("");

  lines.push("## 10. 局限与可复现性附录");
  lines.push("");
  lines.push("- 检索仅覆盖开放元数据接口，未纳入订阅型数据库（Web of Science / Scopus）与灰色文献。");
  lines.push("- 排序与评分依赖题录与摘要，可能与全文结论存在偏差；引用计数受学科与年份强烈影响。");
  lines.push("- 本综述为**辅助性地图**，用于定位子领域与筛选精读条目，不替代逐篇精读与系统综述方法学。");
  lines.push("");
  lines.push("```text");
  lines.push(`query        = ${payload.query}`);
  lines.push(`mode         = ${payload.mode}  limit=${payload.limit ?? "—"}`);
  lines.push(`providers    = ${payload.providers.join(", ")}`);
  lines.push(`yearRange    = ${payload.yearFrom ?? "auto"} .. ${payload.yearTo ?? "auto"}`);
  lines.push(`generatedAt  = ${payload.generatedAt}`);
  for (const entry of payload.log ?? []) {
    lines.push(
      `adapter      = ${entry.provider}  ok=${entry.ok}  found=${entry.found}  ms=${entry.ms}${entry.error ? `  error=${entry.error}` : ""}`
    );
  }
  lines.push("```");
  lines.push("");

  return {
    markdown: lines.join("\n"),
    sections: lines.filter((line) => line.startsWith("## ")).map((line) => line.replace(/^## /, "")),
    graph,
    mode: "heuristic"
  };
}

const LLM_SYSTEM_ZH =
  "你是一位严谨的文献综述作者。你只使用给定证据，不臆造文献、DOI 或数字；引用论文一律用 [P#] 形式标注。输出为 Markdown，不含任何对话性开场白。";

const LLM_SYSTEM_EN =
  "You are a rigorous literature-review author. Use only the supplied evidence; never invent papers, DOIs, or numbers. Cite papers as [P#]. Output Markdown only, with no conversational preamble.";

function llmPrompt(payload, language) {
  const zh = language !== "en";
  const evidence = (payload.papers ?? []).slice(0, 26).map((paper) => ({
    id: paper.key,
    title: paper.title,
    year: paper.year,
    venue: paper.venue,
    authors: (paper.authors ?? []).slice(0, 3),
    doi: paper.doi,
    citedBy: paper.citedBy,
    abstract: (paper.abstract ?? "").slice(0, 700),
    scores: paper.scores
  }));
  const clusters = payload.graph?.clusters ?? [];
  if (zh) {
    return [
      `研究主题：${payload.query}`,
      `语料：共 ${payload.papers.length} 篇，年份 ${payload.stats?.yearMin ?? "?"}–${payload.stats?.yearMax ?? "?"}，开放获取 ${payload.stats?.openAccess ?? 0} 篇。`,
      `主题簇（自动聚类，供参考）：${clusters.map((cluster) => `${cluster.label}(${cluster.size})`).join("；")}`,
      "",
      "证据（JSON）：",
      "```json",
      JSON.stringify(evidence, null, 1),
      "```",
      "",
      "请写一份 1200–1800 字的中文文献综述，严格使用以下二级标题顺序：",
      "## 研究图景",
      "## 主要方法与证据",
      "## 争议与未解问题",
      "## 研究空白与可执行方向",
      "## 阅读建议",
      "要求：每段都要落到具体论文并标注 [P#]；区分“作者主张”与“证据支持”；对证据薄弱处明确标注不确定；不要复述题录清单。"
    ].join("\n");
  }
  return [
    `Research topic: ${payload.query}`,
    `Corpus: ${payload.papers.length} records, years ${payload.stats?.yearMin ?? "?"}–${payload.stats?.yearMax ?? "?"}, ${payload.stats?.openAccess ?? 0} open access.`,
    `Auto clusters: ${clusters.map((cluster) => `${cluster.label}(${cluster.size})`).join("; ")}`,
    "",
    "Evidence (JSON):",
    "```json",
    JSON.stringify(evidence, null, 1),
    "```",
    "",
    "Write a 900–1400 word literature review in English using exactly these H2 headings in order:",
    "## Research landscape",
    "## Methods and evidence",
    "## Disagreements and open questions",
    "## Gaps and actionable directions",
    "## Reading path",
    "Ground every paragraph in specific papers with [P#] citations; separate author claims from evidence; flag low-confidence areas explicitly; do not restate the bibliography."
  ].join("\n");
}

async function llmReview(ctx, payload, config, signal) {
  const llm = typeof ctx?.get === "function" ? ctx.get("llm") : ctx?.llm;
  if (!llm || typeof llm.stream !== "function") {
    return { ok: false, error: "宿主未提供 llm 服务" };
  }
  const { provider, model, maxTokens, temperature } = config.llm;
  if (!provider || !model) return { ok: false, error: "未配置综述模型（provider / model）" };
  const language = config.language;
  try {
    const chunks = llm.stream({
      provider,
      model,
      system: language === "en" ? LLM_SYSTEM_EN : LLM_SYSTEM_ZH,
      temperature,
      maxTokens,
      signal,
      messages: [{ role: "user", content: [{ type: "text", text: llmPrompt(payload, language) }] }]
    });
    let text = "";
    for await (const chunk of chunks) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    }
    const markdown = text.trim();
    if (markdown.length < 120) return { ok: false, error: "模型返回内容过短" };
    return { ok: true, markdown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function composeReview(ctx, payload, { useLlm = true, signal } = {}) {
  const config = await loadConfig();
  const graph = payload.graph ?? buildGraph(payload.papers ?? []);
  const heuristic = deterministicReview({ ...payload, graph }, config.language);
  if (!useLlm || !config.llm.enabled) {
    return { ...heuristic, graph, llm: { ok: false, error: "已关闭模型综述" } };
  }
  const result = await llmReview(ctx, { ...payload, graph }, config, signal);
  if (!result.ok) {
    return { ...heuristic, graph, llm: { ok: false, error: result.error } };
  }
  const header = `# ${config.language === "en" ? "Literature review" : "文献综述"}：${payload.query}\n\n> ${config.language === "en" ? "Written by" : "由"} ${config.llm.provider}/${config.llm.model} ${config.language === "en" ? "over" : "基于"} ${payload.papers.length} ${config.language === "en" ? "records" : "篇文献"} · ${new Date(payload.generatedAt ?? Date.now()).toLocaleString("zh-CN")}\n\n`;
  const footer = [
    "",
    "",
    "---",
    "",
    `### ${config.language === "en" ? "Appendix: retrieval log" : "附：检索与可复现性记录"}`,
    "",
    "```text",
    `query=${payload.query} mode=${payload.mode} providers=${payload.providers.join(",")} n=${payload.papers.length}`,
    `yearRange=${payload.yearFrom ?? "auto"}..${payload.yearTo ?? "auto"} generatedAt=${payload.generatedAt}`,
    ...(payload.log ?? []).map(
      (entry) => `adapter=${entry.provider} ok=${entry.ok} found=${entry.found}${entry.error ? ` error=${entry.error}` : ""}`
    ),
    "```",
    "",
    `> ${config.language === "en" ? "Generated by dsh-litgraph; verify every claim against the primary source before citing." : "由 dsh-litgraph 生成；引用前请回到原文核对每一项论断。"}`
  ].join("\n");
  return {
    markdown: header + result.markdown + footer,
    sections: (result.markdown.match(/^## .+$/gm) ?? []).map((line) => line.replace(/^## /, "")),
    graph: heuristic.graph,
    mode: "llm",
    llm: { ok: true, provider: config.llm.provider, model: config.llm.model }
  };
}

/* ------------------------------------------------------- workspace archives
 *
 * Reviews are stored inside the workspace the user is working in, so they are
 * readable by other agents, by `ls`, and by git — not trapped in plugin state:
 *
 *   <workspace>/.literature-review/            index.json
 *   <workspace>/.literature-review/001-slug/   meta.json papers.json graph.json review.md
 *
 * The numbering is stable and order-of-creation based, so `001`, `002`, ...
 * map onto "the first / second review of this workspace".
 */

function safeSegment(value, fallback = "review") {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function archiveRootFor(workspaceRoot) {
  return join(workspaceRoot, ARCHIVE_DIR);
}

/**
 * The workspace root is resolved, in order, from: an explicit call argument, the
 * plugin config, the first workspace known to the host registry, then the
 * process directory. Everything written later is confined below it.
 */
async function resolveWorkspaceRoot(ctx, explicit) {
  const config = await loadConfig();
  const direct = [explicit, config.workspace]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (direct.length > 0) return resolve(direct[0]);
  try {
    const registry = typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined;
    const list = typeof registry?.list === "function" ? registry.list() : [];
    const first = list.find((entry) => typeof entry?.path === "string" && entry.path.length > 0);
    if (first) return resolve(first.path);
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd();
}

function assertInside(base, target) {
  const rel = relative(base, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw new Error("archive path escapes the workspace");
}

async function readIndex(root) {
  try {
    const text = await readFile(join(root, ARCHIVE_INDEX), "utf8");
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.archives) ? parsed.archives : [];
    return list.filter((entry) => typeof entry?.id === "string");
  } catch {
    return [];
  }
}

async function writeIndex(root, archives) {
  await mkdir(root, { recursive: true });
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    archives: archives.map((entry) => ({ ...entry, path: join(root, entry.dir) }))
  };
  await writeFile(join(root, ARCHIVE_INDEX), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function nextArchiveId(archives, title) {
  const used = new Set(archives.map((entry) => entry.id));
  let index = archives.length + 1;
  let id = `${String(index).padStart(3, "0")}-${safeSegment(title)}`;
  while (used.has(id)) {
    index += 1;
    id = `${String(index).padStart(3, "0")}-${safeSegment(title)}`;
  }
  return { id, dir: id };
}

async function listArchives(ctx, workspace) {
  const workspaceRoot = await resolveWorkspaceRoot(ctx, workspace);
  const root = archiveRootFor(workspaceRoot);
  const archives = await readIndex(root);
  return {
    workspace: workspaceRoot,
    root,
    exists: archives.length > 0,
    archives: archives.map((entry) => ({
      id: entry.id,
      dir: entry.dir,
      path: join(root, entry.dir),
      title: entry.title ?? entry.id,
      query: entry.query ?? "",
      createdAt: entry.createdAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      paperCount: entry.paperCount ?? 0,
      edgeCount: entry.edgeCount ?? 0,
      clusterCount: entry.clusterCount ?? 0,
      reviewMode: entry.reviewMode ?? null
    }))
  };
}

async function createArchive(ctx, { workspace, title, query } = {}) {
  const workspaceRoot = await resolveWorkspaceRoot(ctx, workspace);
  const root = archiveRootFor(workspaceRoot);
  const archives = await readIndex(root);
  const cleanTitle = String(title ?? query ?? "").trim() || "文献综述";
  const { id, dir } = nextArchiveId(archives, cleanTitle);
  const now = new Date().toISOString();
  const entry = {
    id,
    dir,
    title: cleanTitle,
    query: String(query ?? "").trim(),
    createdAt: now,
    updatedAt: now,
    paperCount: 0,
    edgeCount: 0,
    clusterCount: 0,
    reviewMode: null
  };
  const target = assertInside(root, join(root, dir));
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "meta.json"),
    `${JSON.stringify({ ...entry, workspace: workspaceRoot }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(target, "review.md"),
    `# ${cleanTitle}\n\n> 该档案已创建，尚未生成综述。可在面板「综述」或对话中让插件填充内容。\n`,
    "utf8"
  );
  await writeIndex(root, [...archives, entry]);
  return { ...entry, path: target, workspace: workspaceRoot, root };
}

async function saveArchive(ctx, input = {}) {
  const workspaceRoot = await resolveWorkspaceRoot(ctx, input.workspace);
  const root = archiveRootFor(workspaceRoot);
  let archives = await readIndex(root);
  let entry = input.archiveId
    ? archives.find((item) => item.id === input.archiveId || item.dir === input.archiveId)
    : undefined;
  if (!entry) {
    const created = await createArchive(ctx, {
      workspace: workspaceRoot,
      title: input.title ?? input.query,
      query: input.query
    });
    archives = await readIndex(root);
    entry = archives.find((item) => item.id === created.id);
  }
  if (!entry) throw new Error("无法创建或定位文献综述档案");

  const payload = await runSearch(
    {
      query: input.query ?? entry.query,
      mode: input.mode,
      limit: input.limit,
      providers: input.providers,
      yearFrom: input.yearFrom,
      yearTo: input.yearTo,
      snowball: input.snowball
    },
    { force: input.force === true }
  );
  const graph = buildGraph(payload.papers);
  const markdown =
    typeof input.markdown === "string" && input.markdown.trim().length > 0
      ? input.markdown
      : (await composeReview(ctx, { ...payload, graph }, { useLlm: input.useLlm !== false })).markdown;

  const target = assertInside(root, join(root, entry.dir));
  await mkdir(target, { recursive: true });
  const generatedAt = new Date().toISOString();
  const meta = {
    id: entry.id,
    dir: entry.dir,
    title: entry.title,
    query: payload.query,
    createdAt: entry.createdAt ?? generatedAt,
    updatedAt: generatedAt,
    paperCount: payload.papers.length,
    edgeCount: graph.edges.length,
    clusterCount: graph.clusters.length,
    reviewMode: input.useLlm === false ? "heuristic" : "llm-or-heuristic",
    mode: payload.mode,
    providers: payload.providers,
    yearFrom: payload.yearFrom,
    yearTo: payload.yearTo,
    stats: payload.stats,
    workspace: workspaceRoot
  };
  await writeFile(join(target, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await writeFile(join(target, "review.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  await writeFile(
    join(target, "papers.json"),
    `${JSON.stringify(payload.papers.map(compactPaper), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(target, "graph.json"),
    `${JSON.stringify(
      {
        metrics: graph.metrics,
        clusters: graph.clusters,
        timeline: graph.timeline,
        nodes: graph.nodes,
        edges: graph.edges
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const rest = archives.filter((item) => item.id !== entry.id);
  const nextEntry = {
    id: entry.id,
    dir: entry.dir,
    title: entry.title,
    query: payload.query,
    createdAt: meta.createdAt,
    updatedAt: generatedAt,
    paperCount: meta.paperCount,
    edgeCount: meta.edgeCount,
    clusterCount: meta.clusterCount,
    reviewMode: meta.reviewMode
  };
  await writeIndex(root, [...rest, nextEntry].sort((a, b) => a.id.localeCompare(b.id)));
  return { ...meta, path: target, root };
}

async function readArchive(ctx, { workspace, archiveId } = {}) {
  const workspaceRoot = await resolveWorkspaceRoot(ctx, workspace);
  const root = archiveRootFor(workspaceRoot);
  const archives = await readIndex(root);
  const entry = archives.find((item) => item.id === archiveId || item.dir === archiveId);
  if (!entry) throw new Error(`工作区里没有档案 ${archiveId ?? "(未指定)"}`);
  const target = assertInside(root, join(root, entry.dir));
  let markdown = "";
  let meta = entry;
  try {
    markdown = await readFile(join(target, "review.md"), "utf8");
  } catch {
    markdown = "";
  }
  try {
    meta = JSON.parse(await readFile(join(target, "meta.json"), "utf8"));
  } catch {
    /* keep the index entry */
  }
  return { workspace: workspaceRoot, root, meta, path: target, markdown };
}

async function deleteArchive(ctx, { workspace, archiveId } = {}) {
  const workspaceRoot = await resolveWorkspaceRoot(ctx, workspace);
  const root = archiveRootFor(workspaceRoot);
  const archives = await readIndex(root);
  const entry = archives.find((item) => item.id === archiveId || item.dir === archiveId);
  if (!entry) throw new Error(`工作区里没有档案 ${archiveId ?? "(未指定)"}`);
  const target = assertInside(root, join(root, entry.dir));
  await rm(target, { recursive: true, force: true });
  await writeIndex(root, archives.filter((item) => item.id !== entry.id));
  return { removed: entry.id, workspace: workspaceRoot, root };
}

/* ------------------------------------------------------------------- routes */

const MAX_BODY_BYTES = 256 * 1024;

function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = req.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostUrl.hostname)) return false;
  if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function safeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function makeRoutes(ctx) {
  const guard = (req, res, method = "POST") => {
    if (req.method !== method || !isLoopback(req)) {
      writeJson(res, 403, { error: "forbidden: loopback-only" });
      return false;
    }
    return true;
  };

  return [
    {
      kind: "exact",
      path: `${API_PREFIX}/status`,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const config = await loadConfig();
        let workspace = "";
        let archiveRoot = "";
        try {
          const resolved = await resolveWorkspaceRoot(ctx, undefined);
          workspace = resolved;
          archiveRoot = archiveRootFor(resolved);
        } catch {
          /* resolution is best-effort for the status card */
        }
        writeJson(res, 200, {
          ready: true,
          version: VERSION,
          startedAt: STARTED_AT,
          providers: PROVIDERS,
          config,
          workspace,
          archiveRoot,
          llmProviders: (() => {
            try {
              const llm = typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm;
              return typeof llm?.listProviders === "function" ? llm.listProviders() : [];
            } catch {
              return [];
            }
          })()
        });
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/config`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        const result = await saveConfig(body ?? {});
        writeJson(res, 200, { ok: true, ...result, config: await loadConfig() });
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/search`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        try {
          const payload = await runSearch(body ?? {}, { force: body?.force === true });
          const graph = buildGraph(payload.papers);
          writeJson(res, 200, { ok: true, ...payload, graph });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/review`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        const controller = new AbortController();
        req.on("close", () => controller.abort());
        try {
          const payload = await runSearch(body ?? {}, { force: false });
          const graph = buildGraph(payload.papers);
          const review = await composeReview(ctx, { ...payload, graph }, {
            useLlm: body?.useLlm !== false,
            signal: controller.signal
          });
          writeJson(res, 200, {
            ok: true,
            query: payload.query,
            mode: review.mode,
            markdown: review.markdown,
            sections: review.sections,
            llm: review.llm,
            graph,
            stats: payload.stats,
            log: payload.log
          });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/workspaces`,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const rows = [];
        try {
          const registry = typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined;
          const list = typeof registry?.list === "function" ? registry.list() : [];
          for (const entry of Array.isArray(list) ? list : []) {
            if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
            rows.push({
              id: typeof entry.id === "string" ? entry.id : "",
              path: entry.path,
              title:
                (typeof entry.title === "string" && entry.title) ||
                (typeof entry.name === "string" && entry.name) ||
                entry.path.split(/[\\/]/).filter(Boolean).pop() ||
                entry.path
            });
          }
        } catch {
          /* registry absent: fall through with an empty list */
        }
        let current = "";
        try {
          current = await resolveWorkspaceRoot(ctx, undefined);
        } catch {
          current = "";
        }
        writeJson(res, 200, { ok: true, workspaces: rows, current, archiveDir: ARCHIVE_DIR });
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/archives`,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          const url = new URL(req.url ?? "", "http://127.0.0.1");
          const listing = await listArchives(ctx, url.searchParams.get("workspace") || undefined);
          writeJson(res, 200, { ok: true, ...listing });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/archives/create`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        try {
          const created = await createArchive(ctx, body ?? {});
          writeJson(res, 200, { ok: true, archive: created });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/archives/save`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        try {
          const archived = await saveArchive(ctx, body ?? {});
          writeJson(res, 200, { ok: true, archive: archived });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/archives/read`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        try {
          const archived = await readArchive(ctx, body ?? {});
          writeJson(res, 200, { ok: true, ...archived });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/archives/delete`,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          writeJson(res, 400, { ok: false, error: "请求体无效" });
          return;
        }
        try {
          const removed = await deleteArchive(ctx, body ?? {});
          writeJson(res, 200, { ok: true, ...removed });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: safeError(error) });
        }
      }
    }
  ];
}

/* -------------------------------------------------------------------- tools */

function textBlocks(value) {
  return [{ type: "text", text: value }];
}

function renderJson(_args, value) {
  return textBlocks(JSON.stringify(value, null, 2));
}

/**
 * Tool results must be lossless JSON: the harness rejects payloads holding
 * `undefined`, non-finite numbers, or functions. This walks a value and drops
 * or nulls exactly those, recursively.
 */
function lossless(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "string" || type === "boolean") return value;
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") return null;
  if (Array.isArray(value)) return value.map((entry) => lossless(entry));
  if (value instanceof Map) value = Object.fromEntries(value);
  if (type !== "object") return null;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = lossless(entry);
  }
  return out;
}

function compactPaper(paper) {
  return {
    key: paper.key,
    title: paper.title ?? "",
    year: Number.isFinite(paper.year) ? paper.year : null,
    venue: paper.venue ?? "",
    authors: Array.isArray(paper.authors) ? paper.authors.slice(0, 4) : [],
    doi: paper.doi ?? "",
    url: paper.url ?? "",
    citedBy: Number.isFinite(paper.citedBy) ? paper.citedBy : 0,
    composite: Number.isFinite(paper.composite) ? paper.composite : 0,
    relevance: Number.isFinite(paper.relevance) ? paper.relevance : 0,
    scores: paper.scores ?? {},
    sources: Array.isArray(paper.sources) ? paper.sources : [paper.source ?? ""],
    openAccess: Boolean(paper.openAccess),
    abstract: paper.abstract ? `${paper.abstract.slice(0, 320)}${paper.abstract.length > 320 ? "…" : ""}` : ""
  };
}

const SEARCH_PARAMS = {
  type: "object",
  properties: {
    query: { type: "string", description: "研究主题 / 关键词（建议 2–8 个词）。" },
    providers: {
      type: "array",
      items: { type: "string", enum: PROVIDERS },
      description: "数据源子集，默认使用插件配置。"
    },
    yearFrom: { type: "number", description: "最早出版年。" },
    yearTo: { type: "number", description: "最晚出版年。" },
    limit: { type: "number", description: "每源取回条数，默认 30，上限 60。" },
    mode: {
      type: "string",
      enum: ["focused", "balanced", "broad"],
      description: "focused=精选少量高相关文献；balanced=默认；broad=加宽并启用相关文献扩展。"
    },
    snowball: { type: "boolean", description: "是否启用引文滚雪球（参考文献回捞 / 相关文献扩展），默认开启。" }
  },
  required: ["query"],
  additionalProperties: false
};

function registerTools(ctx) {
  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: "litgraph_search",
      description:
        "跨源文献检索：并行查询 OpenAlex / Crossref / Semantic Scholar / arXiv，按 DOI 与标题去重，返回六维评分与排序结果。用于发现某个研究主题的代表性文献。",
      parameters: SEARCH_PARAMS,
      output: {
        schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            mode: { type: "string" },
            stats: { type: "object", additionalProperties: true },
            log: { type: "array", items: { type: "object", additionalProperties: true } },
            papers: { type: "array", items: { type: "object", additionalProperties: true } }
          },
          required: ["query", "papers"],
          additionalProperties: true
        },
        render: renderJson
      },
      execute: async (args) => {
        const payload = await runSearch(args ?? {}, { force: true });
        return lossless({
          query: payload.query,
          mode: payload.mode,
          providers: payload.providers,
          stats: payload.stats,
          log: payload.log,
          papers: payload.papers.map(compactPaper)
        });
      }
    })
  );

  disposers.push(
    ctx.tools.register({
      name: "litgraph_map",
      description:
        "构建文献知识图谱：节点为文献、边为引用/主题/术语/同作者关系，附带主题簇划分、年度分布与图指标。用于结构化一个领域的内部结构。",
      parameters: SEARCH_PARAMS,
      output: {
        schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            metrics: { type: "object", additionalProperties: true },
            clusters: { type: "array", items: { type: "object", additionalProperties: true } },
            timeline: { type: "array", items: { type: "object", additionalProperties: true } },
            nodes: { type: "array", items: { type: "object", additionalProperties: true } },
            edges: { type: "array", items: { type: "object", additionalProperties: true } }
          },
          required: ["query", "nodes", "edges"],
          additionalProperties: true
        },
        render: renderJson
      },
      execute: async (args) => {
        const payload = await runSearch(args ?? {}, { force: false });
        const graph = buildGraph(payload.papers);
        return lossless({
          query: payload.query,
          metrics: graph.metrics,
          clusters: graph.clusters,
          timeline: graph.timeline,
          nodes: graph.nodes.map((node) => ({
            key: node.key,
            id: node.id,
            label: node.short,
            year: node.year,
            venue: node.venue,
            citedBy: node.citedBy,
            cluster: node.cluster,
            score: node.score
          })),
          edges: graph.edges
        });
      }
    })
  );

  disposers.push(
    ctx.tools.register({
      name: "litgraph_review",
      description:
        "生成结构化文献综述（Markdown）：先检索去重，再输出研究图景、方法与证据、争议、研究空白与阅读路径。默认优先使用宿主 llm 撰写，模型不可用时回退到确定性启发式综述。",
      parameters: {
        ...SEARCH_PARAMS,
        properties: {
          ...SEARCH_PARAMS.properties,
          useLlm: {
            type: "boolean",
            description: "是否尝试用宿主模型撰写（默认 true；失败自动回退启发式综述）。"
          }
        }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            mode: { type: "string" },
            markdown: { type: "string" },
            sections: { type: "array", items: { type: "string" } },
            stats: { type: "object", additionalProperties: true }
          },
          required: ["query", "markdown"],
          additionalProperties: true
        },
        render: (_args, value) => textBlocks(String(value?.markdown ?? ""))
      },
      execute: async (args, execution) => {
        const payload = await runSearch(args ?? {}, { force: false });
        const graph = buildGraph(payload.papers);
        const review = await composeReview(
          ctx,
          { ...payload, graph },
          { useLlm: args?.useLlm !== false, signal: execution?.signal }
        );
        return lossless({
          query: payload.query,
          mode: review.mode,
          llm: review.llm,
          sections: review.sections,
          stats: payload.stats,
          markdown: review.markdown
        });
      }
    })
  );

  disposers.push(
    ctx.tools.register({
      name: "litgraph_archives",
      description:
        "列出当前工作区里的文献综述档案（存储于 <workspace>/.literature-review/，含 index.json 与 001-xxx/ 等子目录）。开始一个新的综述任务前先调用它：若已有档案，询问用户是要新建一份还是更新已有的一份。",
      parameters: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description: "可选：工作区绝对路径。省略时用插件配置的工作区，再退回到宿主已知的第一个工作区。"
          }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            root: { type: "string" },
            archives: { type: "array", items: { type: "object", additionalProperties: true } }
          },
          required: ["root", "archives"],
          additionalProperties: true
        },
        render: renderJson
      },
      execute: async (args) => lossless(await listArchives(ctx, args?.workspace))
    })
  );

  disposers.push(
    ctx.tools.register({
      name: "litgraph_archive_create",
      description:
        "在当前工作区新建一份空的文献综述档案（.literature-review/NNN-标题/）。只在用户明确要「新建一份」时使用；创建后用 litgraph_archive_save 填充内容。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "档案标题（中文/英文均可，会用于目录名与综述标题）。" },
          query: { type: "string", description: "该档案对应的研究主题，留空则等于 title。" },
          workspace: { type: "string", description: "可选：工作区绝对路径。" }
        },
        required: ["title"],
        additionalProperties: false
      },
      output: {
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            dir: { type: "string" },
            path: { type: "string" },
            title: { type: "string" }
          },
          required: ["id", "path"],
          additionalProperties: true
        },
        render: renderJson
      },
      execute: async (args) => lossless(await createArchive(ctx, args ?? {}))
    })
  );

  disposers.push(
    ctx.tools.register({
      name: "litgraph_archive_save",
      description:
        "检索 + 撰写 + 落盘一步完成：把某个主题的文献综述写进工作区档案（.literature-review/NNN-标题/ 下的 meta.json、papers.json、graph.json、review.md）。若给出 archiveId 则更新该档案，否则按 title/query 新建。写多个档案时目录自动编号。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "研究主题 / 关键词。" },
          archiveId: {
            type: "string",
            description: "要更新/覆盖的档案 id（来自 litgraph_archives，如 001-gnn-recommendation）。省略则新建。"
          },
          title: { type: "string", description: "档案标题，新建时使用；省略时用 query。" },
          workspace: { type: "string", description: "可选：工作区绝对路径。" },
          mode: {
            type: "string",
            enum: ["focused", "balanced", "broad"],
            description: "检索广度，默认 balanced。"
          },
          limit: { type: "number", description: "每源取回条数，默认 30，上限 60。" },
          yearFrom: { type: "number", description: "最早出版年。" },
          yearTo: { type: "number", description: "最晚出版年。" },
          snowball: { type: "boolean", description: "是否启用引文滚雪球，默认开启。" },
          useLlm: {
            type: "boolean",
            description: "是否用宿主模型撰写综述（默认 true，失败自动回退启发式）。"
          }
        },
        required: ["query"],
        additionalProperties: false
      },
      output: {
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            path: { type: "string" },
            title: { type: "string" },
            paperCount: { type: "number" },
            edgeCount: { type: "number" },
            clusterCount: { type: "number" }
          },
          required: ["id", "path"],
          additionalProperties: true
        },
        render: renderJson
      },
      execute: async (args, execution) => {
        const archived = await saveArchive(ctx, { ...(args ?? {}), force: true });
        return lossless({
          id: archived.id,
          dir: archived.dir,
          path: archived.path,
          title: archived.title,
          query: archived.query,
          workspace: archived.workspace,
          paperCount: archived.paperCount,
          edgeCount: archived.edgeCount,
          clusterCount: archived.clusterCount,
          reviewMode: archived.reviewMode,
          aborted: execution?.signal?.aborted === true
        });
      }
    })
  );

  disposers.push(
    ctx.tools.register({
      name: "litgraph_archive_read",
      description:
        "读取工作区里已保存的文献综述档案：返回 meta 与 review.md 全文（可截断）。用于回答「我之前那份 XX 综述怎么说的」或对比多份档案。",
      parameters: {
        type: "object",
        properties: {
          archiveId: { type: "string", description: "档案 id，如 001-gnn-recommendation。" },
          workspace: { type: "string", description: "可选：工作区绝对路径。" },
          maxChars: { type: "number", description: "返回正文的最大字符数，默认 12000。" }
        },
        required: ["archiveId"],
        additionalProperties: false
      },
      output: {
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            path: { type: "string" },
            title: { type: "string" },
            markdown: { type: "string" },
            truncated: { type: "boolean" }
          },
          required: ["markdown"],
          additionalProperties: true
        },
        render: (_args, value) => textBlocks(String(value?.markdown ?? ""))
      },
      execute: async (args) => {
        const archived = await readArchive(ctx, args ?? {});
        const limit = clampNumber(args?.maxChars, 500, 200_000, 12_000);
        const markdown = String(archived.markdown ?? "");
        const cut = markdown.slice(0, limit);
        return lossless({
          id: archived.meta?.id ?? args?.archiveId,
          title: archived.meta?.title ?? "",
          path: archived.path,
          workspace: archived.workspace,
          root: archived.root,
          meta: archived.meta,
          truncated: markdown.length > cut.length,
          markdown: cut
        });
      }
    })
  );

  return disposers;
}

/* -------------------------------------------------------------------- apply */

export function apply(ctx, rawConfig) {
  patchConfig = rawConfig && typeof rawConfig === "object" ? rawConfig : null;
  configCache = null;
  void loadConfig();

  ctx.effect(() => {
    const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* already gone */
        }
      }
    };
  }, "dsh-litgraph: routes");

  ctx.effect(() => {
    const disposers = registerTools(ctx);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* already gone */
        }
      }
    };
  }, "dsh-litgraph: tools");
}

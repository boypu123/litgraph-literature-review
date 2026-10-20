import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = [];
function log(...args) {
  const line = args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
  out.push(line);
  console.log(line);
}

const mod = await import(pathToFileURL(join(here, "lib/index.js")).href);

const routes = new Map();
const tools = new Map();

const ctx = {
  get: () => undefined,
  effect(factory) {
    const dispose = factory();
    return typeof dispose === "function" ? dispose : () => {};
  },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    }
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    }
  }
};

mod.apply(ctx, { providers: ["openalex", "crossref", "arxiv", "semanticscholar"] });
log("routes:", [...routes.keys()]);
log("tools:", [...tools.keys()]);

function makeReq(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { host: "127.0.0.1:53962", origin: "http://127.0.0.1:53962" };
  req.socket = { remoteAddress: "127.0.0.1" };
  setTimeout(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  }, 0);
  return req;
}

function callRoute(path, body) {
  const route = routes.get(path);
  return new Promise((resolve) => {
    const res = {
      status: 0,
      payload: null,
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        try {
          this.payload = JSON.parse(text);
        } catch {
          this.payload = text;
        }
        resolve(this.payload);
      }
    };
    const timer = setTimeout(() => resolve({ timedOut: true }), 90_000);
    route.handler(makeReq(body), res).finally(() => clearTimeout(timer));
  });
}

const query = process.argv[2] ?? "large language model agents cooperation";
const search = await callRoute("/api/dsh-litgraph/search", {
  query,
  limit: 12,
  mode: "balanced",
  providers: ["openalex", "crossref", "arxiv", "semanticscholar"]
});

log("search ok:", search.ok, "error:", search.error ?? "-");
if (search.ok) {
  log("stats:", search.stats);
  log("log:", search.log);
  log("papers:");
  for (const paper of search.papers.slice(0, 8)) {
    log(`  ${paper.key} [${paper.composite}] ${paper.year ?? "?"} ${paper.venue || "-"} :: ${paper.title.slice(0, 80)}`);
    log(`      scores=${JSON.stringify(paper.scores)} sources=${(paper.sources || []).join(",")}`);
  }
  log("graph metrics:", search.graph.metrics);
  log("clusters:", search.graph.clusters.map((cluster) => `${cluster.label}(${cluster.size})`));
  log("timeline:", search.graph.timeline);
  log("edges sample:", search.graph.edges.slice(0, 3));
}

const review = await callRoute("/api/dsh-litgraph/review", {
  query,
  limit: 12,
  mode: "balanced",
  providers: ["openalex", "crossref", "arxiv", "semanticscholar"]
});
log("review ok:", review.ok, "mode:", review.mode, "llm:", review.llm?.ok, review.llm?.error ?? "");
if (review.ok) {
  writeFileSync(join(here, "smoke-review.md"), review.markdown, "utf8");
  log("review chars:", review.markdown.length, "sections:", review.sections);
}

// Exercise the registered agent tool end-to-end.
if (tools.has("litgraph_map")) {
  const tool = tools.get("litgraph_map");
  const value = await tool.execute({ query, limit: 10, mode: "balanced" }, { signal: undefined });
  log("tool litgraph_map nodes:", value.nodes.length, "edges:", value.edges.length, "metrics:", value.metrics);
  const rendered = tool.output.render({}, value);
  log("tool render blocks:", rendered.length, "chars:", rendered[0].text.length);
}

writeFileSync(join(here, "smoke-result.txt"), out.join("\n"), "utf8");

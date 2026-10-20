import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lines = [];
const fields =
  "id,doi,display_name,publication_year,abstract_inverted_index,authorships,primary_location,host_venue,cited_by_count,referenced_works,topics,keywords,open_access,type";
const noHostVenue =
  "id,doi,display_name,publication_year,abstract_inverted_index,authorships,primary_location,cited_by_count,referenced_works,topics,keywords,open_access,type";

const candidates = [
  ["select-with-host_venue", `https://api.openalex.org/works?search=agent&per_page=2&select=${fields}`],
  ["select-no-host_venue", `https://api.openalex.org/works?search=agent&per_page=2&select=${noHostVenue}`],
  ["filter-publication_year-gt", `https://api.openalex.org/works?search=agent&per_page=2&filter=publication_year:%3E2022&select=${noHostVenue}`],
  ["filter-range", `https://api.openalex.org/works?search=agent&per_page=2&filter=publication_year:2020-2026&select=${noHostVenue}`],
  ["no-select", "https://api.openalex.org/works?search=agent&per_page=2"]
];

for (const [label, url] of candidates) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "dsh-litgraph-smoke/0.1" } });
    const text = await response.text();
    lines.push(`${label} -> ${response.status} :: ${text.slice(0, 220).replace(/\s+/g, " ")}`);
  } catch (error) {
    lines.push(`${label} -> THROW ${error.message}`);
  }
}

writeFileSync(join(here, "openalex-probe.txt"), lines.join("\n"), "utf8");
console.log(lines.join("\n"));

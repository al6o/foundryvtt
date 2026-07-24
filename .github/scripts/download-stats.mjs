#!/usr/bin/env node
/**
 * Collects GitHub release download counts for the module packages published in
 * this repository and writes a human-readable report plus Shields badge files.
 *
 * GitHub only counts downloads of release *assets* (the `<module-id>.zip` files);
 * clones, page views and auto-generated source archives are not counted. The
 * live counter also resets to 0 whenever an asset is re-uploaded (e.g. a release
 * republished with `gh release upload --clobber`). To keep a truthful lifetime
 * total we persist state in `.stats/downloads.json`: for every asset we remember
 * the last seen live count and a "carried" sum; when the live count drops below
 * what we saw before, we know it was re-uploaded and fold the previous peak into
 * the carried sum. Lifetime total = carried + current live count.
 *
 * Outputs:
 *   DOWNLOADS.md                     grouped report (module -> version -> counts)
 *   .stats/downloads.json            persisted per-asset state (do not edit by hand)
 *   .stats/badge-<module-id>.json    Shields "endpoint" payload per module
 *
 * Usage:
 *   node .github/scripts/download-stats.mjs           write the files
 *   node .github/scripts/download-stats.mjs --print    also print the report to stdout
 *
 * Auth: reads a token from GH_TOKEN or GITHUB_TOKEN. Repository is taken from
 * GITHUB_REPOSITORY (owner/repo) and falls back to al6o/foundryvtt.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATS_DIR = join(ROOT, ".stats");
const STATE_FILE = join(STATS_DIR, "downloads.json");
const REPORT_FILE = join(ROOT, "DOWNLOADS.md");

const REPO = process.env.GITHUB_REPOSITORY ?? "al6o/foundryvtt";
const TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
const PRINT = process.argv.includes("--print");

async function api(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "download-stats-script"
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

/* All releases, following pagination. */
async function allReleases() {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${REPO}/releases?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { updatedAt: null, assets: {} };
  }
}

/* module id + version from tag `<id>-v<version>`; fall back sensibly. */
function parseTag(tag, assetName) {
  const id = assetName.replace(/\.zip$/i, "");
  let version = tag;
  const marker = `${id}-v`;
  if (tag.startsWith(marker)) version = tag.slice(marker.length);
  else {
    const m = tag.match(/-v(.+)$/);
    if (m) version = m[1];
  }
  return { id, version };
}

const fmtDate = (iso) => (iso ? iso.slice(0, 10) : "—");
const cmpVersion = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return a < b ? 1 : a > b ? -1 : 0;
};

function main(releases, prevState) {
  const state = { updatedAt: new Date().toISOString(), assets: {} };
  const modules = new Map(); // id -> [{version, tag, live, total, updated}]

  for (const rel of releases) {
    for (const asset of rel.assets ?? []) {
      if (!asset.name.toLowerCase().endsWith(".zip")) continue; // only module packages
      const { id, version } = parseTag(rel.tag_name, asset.name);
      const key = `${rel.tag_name}/${asset.name}`;
      const live = asset.download_count ?? 0;

      const prev = prevState.assets[key] ?? { carried: 0, last: 0 };
      // A drop below the previously seen count means the asset was re-uploaded
      // and GitHub reset its live counter — fold the old peak into carried.
      const carried = live < prev.last ? prev.carried + prev.last : prev.carried;
      state.assets[key] = { carried, last: live };
      const total = carried + live;

      if (!modules.has(id)) modules.set(id, []);
      modules.get(id).push({ version, tag: rel.tag_name, live, total, updated: asset.updated_at });
    }
  }

  // Carry over assets we have seen before but that are missing now (deleted
  // release): keep their lifetime total from being lost.
  for (const [key, prev] of Object.entries(prevState.assets)) {
    if (!state.assets[key]) state.assets[key] = { carried: prev.carried + prev.last, last: 0 };
  }

  return { state, modules };
}

function renderReport(modules) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  const ids = [...modules.keys()].sort();
  let grand = 0;
  const lines = [];
  lines.push("# Download stats");
  lines.push("");
  lines.push(`_Last updated: ${now} UTC · auto-generated by \`.github/workflows/download-stats.yml\`_`);
  lines.push("");
  lines.push(
    "GitHub counts downloads of release **assets** only (the `<module>.zip` files) — " +
      "clones, page views and source archives are not counted. **Live** is the current " +
      "counter on GitHub (it resets to 0 when an asset is re-uploaded); **Total** is the " +
      "lifetime count this report preserves across such resets."
  );
  lines.push("");

  for (const id of ids) {
    const rows = modules.get(id).sort((a, b) => cmpVersion(a.version, b.version));
    const moduleTotal = rows.reduce((s, r) => s + r.total, 0);
    grand += moduleTotal;
    lines.push(`## ${id} — lifetime total: ${moduleTotal}`);
    lines.push("");
    lines.push("| Version | Live (GitHub) | Total | Asset updated |");
    lines.push("| --- | ---: | ---: | --- |");
    for (const r of rows) {
      lines.push(`| ${r.version} | ${r.live} | ${r.total} | ${fmtDate(r.updated)} |`);
    }
    lines.push("");
  }

  lines.push(`**Grand total across all modules: ${grand}**`);
  lines.push("");
  return lines.join("\n");
}

function renderBadge(id, moduleTotal) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      label: "downloads",
      message: String(moduleTotal),
      color: "blue"
    },
    null,
    0
  );
}

(async () => {
  const releases = await allReleases();
  const prevState = loadState();
  const { state, modules } = main(releases, prevState);

  mkdirSync(STATS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  for (const [id, rows] of modules) {
    const moduleTotal = rows.reduce((s, r) => s + r.total, 0);
    writeFileSync(join(STATS_DIR, `badge-${id}.json`), renderBadge(id, moduleTotal) + "\n");
  }

  const report = renderReport(modules);
  writeFileSync(REPORT_FILE, report);
  if (PRINT) process.stdout.write("\n" + report + "\n");
  console.error(`download-stats: ${modules.size} module(s), ${releases.length} release(s) → DOWNLOADS.md`);
})().catch((e) => {
  console.error(`download-stats failed: ${e.message}`);
  process.exit(1);
});

/**
 * =============================================================
 *  THE GATE \u2014 single-file Cloudflare Worker (browser deploy)
 * =============================================================
 *  How to deploy without a PC/terminal:
 *   1. Cloudflare Dashboard \u2192 D1 \u2192 create database `anime-db`,
 *      copy its Database ID.
 *   2. GitHub (browser) \u2192 new repo \u2192 add these files:
 *        - package.json
 *        - wrangler.toml (paste Database ID)
 *        - src/index.ts (THIS file)
 *   3. Cloudflare Dashboard \u2192 Workers & Pages \u2192 Create \u2192
 *      Import a repository \u2192 pick the repo \u2192 Save and Deploy.
 *   4. Worker \u2192 Settings \u2192 Variables and Secrets \u2192 add secrets:
 *        TMDB_API_KEY, STREAMTAPE_USER, STREAMTAPE_KEY,
 *        MIXDROP_KEY, UPLOADS_JSON (watchlists).
 * =============================================================
 */

import { Hono } from "hono";

// ---------------------------------------------------------------- types

interface Env {
  DB: D1Database;
  TMDB_API_KEY?: string;
  STREAMTAPE_USER?: string;
  STREAMTAPE_LOGIN?: string;
  STREAMTAPE_KEY?: string;
  MIXDROP_KEY?: string;
  MIXDROP_API_KEY?: string;
  MIXDROP_EMAIL?: string;
  ABYSS_API_KEY?: string;
  BYSE_API_KEY?: string;
  DOODSTREAM_API_KEY?: string;
  DOODSTREAM_PROXY?: string;
  UFOLOAD_LOGIN?: string;
  UFOLOAD_KEY?: string;
  UFOLOAD_API_KEY?: string;
  EARNVIDS_API_KEY?: string;
  UPLOADS_JSON?: string;
  SYNC_KEY?: string;
  ADDON_ID?: string;
  ADDON_NAME?: string;
  ADDON_DESCRIPTION?: string;
  ADDON_VERSION?: string;
  USER_AGENT?: string;
  CRON_ENABLED?: string;
}

type MediaType = "movie" | "series";

interface MediaRow {
  id: string;
  tmdb_id: number;
  type: MediaType;
  title: string;
  poster: string;
  backdrop: string;
  overview: string;
  rating: number;
  season: number | null;
  episode: number | null;
  category: string;
  streamtape_url: string;
  vidmoly_url: string;
  mixdrop_url: string;
  ufoload_url: string;
  abyss_url: string;
  byse_url: string;
  earnvids_url: string;
  doodstream_url: string;
  is_active: number;
}

// ------------------------------------------------------------- constants

const UA_DEFAULT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const HOST_HEADERS: Record<string, Record<string, string>> = {
  streamtape: { Referer: "https://streamtape.com/", Origin: "https://streamtape.com" },
  vidmoly: { Referer: "https://vidmoly.to/", Origin: "https://vidmoly.to" },
  mixdrop: { Referer: "https://mxdrop.click/", Origin: "https://mxdrop.click" },
  ufoload: { Referer: "https://ufoload.io/", Origin: "https://ufoload.io" },
  abyss: { Referer: "https://player.abyssplayer.com/", Origin: "https://player.abyssplayer.com" },
  byse: { Referer: "https://bysetayico.com/", Origin: "https://bysetayico.com" },
  doodstream: { Referer: "https://doodstream.com/", Origin: "https://doodstream.com" },
};

const HOST_FIELD: Record<string, keyof MediaRow> = {
  streamtape: "streamtape_url",
  vidmoly: "vidmoly_url",
  mixdrop: "mixdrop_url",
  ufoload: "ufoload_url",
  abyss: "abyss_url",
  byse: "byse_url",
  doodstream: "doodstream_url",
  earnvids: "earnvids_url",
};

const HOST_LABEL: Record<string, string> = {
  streamtape: "Streamtape",
  vidmoly: "Vidmoly",
  mixdrop: "MixDrop",
  ufoload: "UFOload",
  abyss: "Abyss",
  byse: "Byse",
  doodstream: "Doodstream",
  earnvids: "EarnVids",
};

// Hosts hidden from the stream output. Their video bytes live behind an
// encrypted embed (Abyss = Hydrax WS/AES-CTR, Byse = AES-GCM playback config +
// captcha clearance) \u2014 no direct .m3u8/.mp4 exists for server-side extraction,
// so native playback is impossible and everything would need the WebView +
// ads. Per owner decision the catalog serves ONLY native hosts
// (Streamtape/Vidmoly/UFOload/MixDrop) \u2014 100% native playback, zero ads.
const HIDDEN_HOSTS = new Set(["abyss", "byse"]);

const DDL_MAIN = `
  CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    tmdb_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    poster TEXT NOT NULL DEFAULT '',
    backdrop TEXT NOT NULL DEFAULT '',
    overview TEXT NOT NULL DEFAULT '',
    rating REAL NOT NULL DEFAULT 0,
    season INTEGER,
    episode INTEGER,
    category TEXT NOT NULL DEFAULT '',
    streamtape_url TEXT NOT NULL DEFAULT '',
    vidmoly_url TEXT NOT NULL DEFAULT '',
    mixdrop_url TEXT NOT NULL DEFAULT '',
    ufoload_url TEXT NOT NULL DEFAULT '',
    abyss_url TEXT NOT NULL DEFAULT '',
    byse_url TEXT NOT NULL DEFAULT '',
    earnvids_url TEXT NOT NULL DEFAULT '',
    doodstream_url TEXT NOT NULL DEFAULT '',
    is_title_only INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

const DDL_UPLOADS = `
  CREATE TABLE IF NOT EXISTS host_uploads (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 0,
    page_url TEXT NOT NULL DEFAULT '',
    direct_url TEXT NOT NULL DEFAULT '',
    last_checked TEXT NOT NULL DEFAULT (datetime('now')),
    is_valid INTEGER NOT NULL DEFAULT 1
  )`;

const DDL_SYNC = `
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;

const DDL_WATCHLIST = `
  CREATE TABLE IF NOT EXISTS watchlist (
    url TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT '',
    tmdb_id INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

const ALTER_COLUMNS: Array<[string, string]> = [
  ["media_items", "rating REAL NOT NULL DEFAULT 0"],
  ["media_items", "ufoload_url TEXT NOT NULL DEFAULT ''"],
  ["media_items", "created_at TEXT NOT NULL DEFAULT (datetime('now'))"],
  ["media_items", "updated_at TEXT NOT NULL DEFAULT (datetime('now'))"],
  ["media_items", "byse_url TEXT NOT NULL DEFAULT ''"],
  ["media_items", "earnvids_url TEXT NOT NULL DEFAULT ''"],
  ["media_items", "is_title_only INTEGER NOT NULL DEFAULT 0"],
  ["media_items", "doodstream_url TEXT NOT NULL DEFAULT ''"],
  ["media_items", "category TEXT NOT NULL DEFAULT ''"],
  ["watchlist", "media_type TEXT NOT NULL DEFAULT ''"],
  ["watchlist", "tmdb_id INTEGER NOT NULL DEFAULT 0"],
];

// ------------------------------------------------------------- helpers

function userAgent(env: Env): string {
  return env.USER_AGENT || UA_DEFAULT;
}

/** HTML escape (add page me user input render hota hai). */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function headersForHost(env: Env, host: string): Record<string, string> {
  return { ...(HOST_HEADERS[host] ?? {}), "User-Agent": userAgent(env) };
}

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { Accept: "*/*", ...headers } });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

async function fetchTextHeaders(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; text: string; headers: Headers }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { Accept: "*/*", ...headers } });
    return { ok: res.ok, status: res.status, text: await res.text(), headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonRetry(url: string, headers: Record<string, string> = {}, tries = 3): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  let last = { ok: false, status: 0, json: null as any, text: "" };
  for (let i = 0; i < tries; i++) {
    const r = await fetchJson(url, headers);
    if (r.status !== 429) return r;
    last = r;
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return last;
}

async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { Accept: "application/json", ...headers } });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function resolveUrl(base: string, part: string | null | undefined): string | null {
  if (!part) return null;
  if (/^https?:\/\//i.test(part)) return part;
  try { return new URL(part, base).href; } catch { return null; }
}

/**
 * Hosts like Abyss/Vidmoly expose the ORIGINAL uploaded filename in the
 * embed/player page <title>. We prefer that over any watchlist-provided
 * name so the TMDB match reflects what is actually on the host.
 */
async function extractPageTitle(url: string): Promise<string | null> {
  try {
    const origin = new URL(url).origin;
    const { ok, text } = await fetchText(url, { Referer: origin + "/", "User-Agent": UA_DEFAULT });
    if (!ok) return null;
    const m = text.match(/<title[^>]*>([\s\S]{3,300}?)<\/title>/i);
    if (!m) return null;
    const t = m[1].replace(/\s+/g, " ").trim();
    if (!t || /^(mixdrop|vidmoly|ufoload|abyss|player|watch|video)\b/i.test(t)) return null;
    return t;
  } catch {
    return null;
  }
}

// -------------------------------------------------------- D1 bootstrap

async function ensureSchema(db: D1Database): Promise<string[]> {
  const errors: string[] = [];
  const single = async (label: string, sql: string) => {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      errors.push(`${label}: ${String(e)}`);
    }
  };
  await single("create media_items", DDL_MAIN);
  await single("create host_uploads", DDL_UPLOADS);
  await single("create sync_state", DDL_SYNC);
  await single("create watchlist", DDL_WATCHLIST);
  // Guard ALTERs so the dashboard-created simple table upgrades in place.
  for (const [table, column] of ALTER_COLUMNS) {
    await single(`alter ${table} + ${column.split(" ")[0]}`, `ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
  return errors;
}

// ---------------------------------------------------------- filename + TMDB

function parseFilename(fileName: string) {
  const clean = fileName
    .replace(/\.[a-z0-9]+$/i, "")
    // release tags: bracket groups (release groups / audio labels), quality, codecs
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/_[^_]*_(?=\s|$)/g, " ")
    .replace(/\b(480p|720p|1080p|2160p|4k|WEB-?DL|WEB-?Rip|WEB|BluRay|BDRip|BRRip|HDRip|CAM|TS|REMUX|DVD|x26[45]|HEVC|H\.?26[45]|AVC|AAC\s?2\s?0|Multi\s?Audio|ESub|ESubs|Subbed|Dubbed|Dual|Multi|HDR10\+?|10bit|AnimeDubHindi|Anime\s?Dub\s?Hindi|HindiDub|PROPER|REPACK|AMZN|NF|DNP|UNCUT|CBFC|ORG|HDTC|HDTV|PDTV|HC-?ESubs?|JioHotstar)\b/gi, " ")
    .replace(/\b(Hindi|Tamil|Telugu|English|Malayalam|Kannada|Bengali|Polish|Spanish|French|Russian|Arabic|Korean|Japanese|Chinese|Portuguese|Italian|German|Turkish|Indonesian|Thai|Vietnamese)(?:[-\s]+(?:Hindi|Tamil|Telugu|English|Malayalam|Kannada|Bengali|Polish|Spanish|French|Russian|Arabic|Korean|Japanese|Chinese|Portuguese|Italian|German|Turkish|Indonesian|Thai|Vietnamese))*[-\s]?/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = { tmdbId: null as number | null, season: null as number | null, episode: null as number | null, title: null as string | null, year: null as number | null };
  const ym = clean.match(/\((19\d{2}|20\d{2})\)|(?:\s|^)(19\d{2}|20\d{2})(?:\s|$)/);
  if (ym) out.year = parseInt(ym[1] || ym[2], 10);
  const tmdbMatch = clean.match(/tmdb[_\s]?(\d+)(?:[_\s\-]?[Ss](\d+)[_\s\-]?[Ee](\d+))?/);
  if (tmdbMatch) {
    out.tmdbId = parseInt(tmdbMatch[1], 10);
    if (tmdbMatch[2] != null && tmdbMatch[3] != null) {
      out.season = parseInt(tmdbMatch[2], 10);
      out.episode = parseInt(tmdbMatch[3], 10);
    }
    return out;
  }
  const sxx = clean.match(/(\d+)[_\s\-]?[Ee][_\s\-]?(\d+)/);
  if (sxx) {
    out.season = parseInt(sxx[1], 10);
    out.episode = parseInt(sxx[2], 10);
  }
  const title = clean
    .replace(/[Ss]\d+[_\s\-]?[Ee]\d+/i, "")
    .replace(/\(\d{4}\)|\.?19\d{2}|\.?20\d{2}/g, "")
    .replace(/\.?1080p|\.?720p|\.?4k|\.?WEB-?DL|\.?BluRay|\.?x26[45]|\.?HEVC|\.?AAC|\.?H\.?264|\.?H\.?265|\.?AVC|\.?MP4|\.?MKV|\.?ESubs?|\.?HDTC|\.?JioHotstar|\.?HC-?ESubs?/gi, " ")
    .replace(/(?:Hindi|Tamil|Telugu|English|Malayalam|Kannada|Bengali)(?:[-\s]+(?:Hindi|Tamil|Telugu|English|Malayalam|Kannada|Bengali))*/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  out.title = title || null;
  return out;
}

const LANG_WORDS = "Hindi|Tamil|Telugu|English|Malayalam|Kannada|Bengali|Polish|Spanish|French|Russian|Arabic|Korean|Japanese|Chinese|Portuguese|Italian|German|Turkish|Indonesian|Thai|Vietnamese|Multi";
const stripLangTags = (s: string) =>
  s.replace(new RegExp(`\\b(?:${LANG_WORDS})(?:[-\\s]+(?:${LANG_WORDS}))*\\b`, "gi"), " ")
   .replace(/\s+/g, " ").trim();

/** Title match + fuzzy typo tolerance (Ranabaali/Ranabali, Cisza Nocna/Night Silence etc). */
function titleMatches(query: string, name: string, queryYear?: number | null, resultYear?: number | null): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const qs = norm(query), ns = norm(name);
  const q = qs.split(" ").filter((w) => w.length > 2);
  const na = ns.split(" ").filter((w) => w.length > 2);
  const n = new Set(na);
  if (!q.length) return false;
  // year clash (2+ different) → reject wrong movie
  if (queryYear && resultYear && Math.abs(queryYear - resultYear) > 2) return false;
  const shared = q.filter((w) => n.has(w)).length;
  if (shared >= 2) {
    const idx = q.map((w) => na.indexOf(w));
    if (idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]))) return true;
  }
  if (shared >= 1 && queryYear && resultYear && queryYear === resultYear) return true;
  if (q.length === 1 && shared === 1) return true;
  // fuzzy: single-token edit distance <= 1 for longer words, or substring
  const fuzzy = (a: string, b: string) => {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const lev = (x: string, y: string) => {
      const dp = Array.from({ length: y.length + 1 }, (_, i) => i);
      for (let i = 1; i <= x.length; i++) {
        let prev = dp[0]; dp[0] = i;
        for (let j = 1; j <= y.length; j++) {
          const t = dp[j];
          dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
          prev = t;
        }
      }
      return dp[y.length];
    };
    return lev(a, b) <= 1;
  };
  if (q.length === 1 && na.length === 1 && fuzzy(q[0], na[0])) return true;
  if (q.length === na.length && q.every((w, i) => fuzzy(w, na[i]))) return true;
  return false;
}

async function tmdbMatch(env: Env, parsed: ReturnType<typeof parseFilename>) {
  const key = env.TMDB_API_KEY;
  if (!key) return null;

  const detail = async (mediaType: "movie" | "tv", id: number) => {
    const { ok, json } = await fetchJsonRetry(`https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${key}&language=en-US`);
    if (!ok || !json) return null;
    return {
      tmdbId: id,
      type: (mediaType === "movie" ? "movie" : "series") as MediaType,
      title: (json.title ?? json.name ?? "Unknown") as string,
      poster: json.poster_path ? `https://image.tmdb.org/t/p/w500${json.poster_path}` : "",
      backdrop: json.backdrop_path ? `https://image.tmdb.org/t/p/w1280${json.backdrop_path}` : "",
      overview: (json.overview ?? "") as string,
      rating: typeof json.vote_average === "number" ? json.vote_average : 0,
      genres: ((json.genres || []) as any[]).map((g: any) => String(g.name || "")).filter(Boolean),
      originCountry: String(json.origin_country?.[0] || json.production_countries?.[0]?.iso_3166_1 || ""),
    };
  };

  if (parsed.tmdbId != null) {
    // TMDB ids can collide across movie/tv \u2014 SxxEyy filenames usually are TV episodes,
    // but recap/compilation movies (Solo Leveling -ReAwakening-, Shield Hero recap, etc.)
    // are registered as MOVIES with SxxEyy-style filenames. TV miss hone par movie fallback.
    if (parsed.season != null) {
      const show = await detail("tv", parsed.tmdbId);
      if (show) return { ...show, season: parsed.season, episode: parsed.episode };
      const movie = await detail("movie", parsed.tmdbId);
      if (movie) return { ...movie, season: null, episode: null };
    } else {
      const movie = await detail("movie", parsed.tmdbId);
      if (movie) return { ...movie, season: null, episode: null };
      const show = await detail("tv", parsed.tmdbId);
      if (show) return { ...show, season: parsed.season, episode: parsed.episode };
    }
  }

  if (parsed.title) {
    // Title candidates: full title + " - " se alag parts. Release names aksar
    // "Anime S01E01 - Real Title" form me hote hain \u2014 pehle wala part search
    // fail karta tha (tmdb-miss) aur video catalog me dikhai hi nahi deta tha.
    const parts = parsed.title.split(/\s+[-\u2013\u2014]\s+/).map((x) => x.trim()).filter(Boolean);
    const aka = parsed.title.split(/\s+aka\s+/i).map((x) => x.trim()).filter(Boolean);
    const stripped = [...parts, ...aka].map(stripLangTags).filter(Boolean);
    const candidates = [...new Set([
      parsed.title, stripLangTags(parsed.title), ...parts, ...aka, ...stripped,
    ])].filter(Boolean).slice(0, 2);
    // SxxEyy = TV episode \u2192 tv pehle try karo (movie search galat match de sakta hai).
    const types: ("movie" | "tv")[] = parsed.season != null ? ["tv", "movie"] : ["movie", "tv"];
    for (const candidate of candidates) {
      for (const mediaType of types) {
        const { ok, json } = await fetchJsonRetry(
          `https://api.themoviedb.org/3/search/${mediaType}?api_key=${key}&query=${encodeURIComponent(candidate)}&language=en-US`,
        );
        if (!ok || !json) continue;
        for (const r of json.results || []) {
          const name = String(r.title ?? r.name ?? "");
          const rd = r.release_date || r.first_air_date;
          const resultYear = rd ? parseInt(String(rd).slice(0, 4), 10) : null;
          if (!titleMatches(candidate, name, parsed.year, resultYear)) continue;
          return {
            tmdbId: r.id as number,
            type: (mediaType === "movie" ? "movie" : "series") as MediaType,
            title: name || "Unknown",
            poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : "",
            backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : "",
            overview: (r.overview || "") as string,
            rating: typeof r.vote_average === "number" ? r.vote_average : 0,
            genres: ((r.genres || []) as any[]).map((g: any) => String(g.name || "")).filter(Boolean).length
              ? ((r.genres || []) as any[]).map((g: any) => String(g.name || "")).filter(Boolean)
              : ((r.genre_ids || []) as number[]).map((gid: number) => String(TMDB_GENRE_NAMES[gid] || "")).filter(Boolean),
            originCountry: String(r.origin_country?.[0] || r.production_countries?.[0]?.iso_3166_1 || ""),
            // Movie match → season/episode null (recap/compilation movies).
            season: mediaType === "movie" ? null : parsed.season,
            episode: mediaType === "movie" ? null : parsed.episode,
          };
        }
      }
    }
  }
  return null;
}

const TMDB_GENRE_NAMES: Record<number, string> = {
  16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
  10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie",
  53: "Thriller", 10752: "War", 37: "Western", 28: "Action", 12: "Adventure",
  10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality",
  10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
};

/** Category derive: movie (type movie) | anime (Animation genre / JP origin) | tv. */
function categoryOf(meta: any): string {
  if (meta?.type === "movie") return "movie";
  const genres: string[] = Array.isArray(meta?.genres) ? meta.genres : [];
  const origin: string = String(meta?.originCountry || "").toUpperCase();
  if (genres.some((g) => /animation|anime/i.test(g)) || origin === "JP") return "anime";
  return "tv";
}

/** Search results me genres empty hote hain — detail endpoint se genre/origin bharo. */
async function enrichGenres(env: Env, meta: any): Promise<void> {
  if (meta?.genres?.length || !meta?.tmdbId) return;
  try {
    const mt = meta.type === "movie" ? "movie" : "tv";
    const { ok, json } = await fetchJsonRetry(`https://api.themoviedb.org/3/${mt}/${meta.tmdbId}?api_key=${env.TMDB_API_KEY}&language=en-US`);
    if (ok && json) {
      meta.genres = ((json.genres || []) as any[]).map((g: any) => String(g.name || "")).filter(Boolean);
      meta.originCountry = String(json.origin_country?.[0] || json.production_countries?.[0]?.iso_3166_1 || "");
    }
  } catch { /* ignore */ }
}

// ------------------------------------------------------------- extractors

function unpackPackedJs(input: string): string | null {
  const raw = input.trim();
  if (!/^eval\(function\(p,a,c,k,e/.test(raw) && !raw.includes("eval(function(p,a,c,k,e")) return null;
  const m = raw.match(/}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'([^']*)'/);
  if (!m) return null;
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const encodeBase = (value: number, base: number): string => {
    if (base <= 36) return value.toString(base);
    let n = value, out = "";
    do { out = alphabet[n % base] + out; n = Math.floor(n / base); } while (n > 0);
    return out;
  };
  const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const base = parseInt(m[2], 10) || 62;
  const count = parseInt(m[3], 10) || 0;
  const k = m[4].split("|");
  const r: Record<string, string> = {};
  for (let i = 0; i < count; i++) r[encodeBase(i, base)] = k[i] || encodeBase(i, base);
  let decoded = p;
  let counter = count;
  while (counter--) {
    const token = encodeBase(counter, base);
    const replacement = k[counter] || token;
    if (replacement !== token) {
      decoded = decoded.replace(new RegExp("\\b" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"), replacement);
    }
  }
  return decoded;
}

async function extractVidmoly(inputUrl: string, pageUrl?: string): Promise<string | null> {
  const embedId = (inputUrl.match(/\/embed(?:-|\/)([A-Za-z0-9]+)\.?html?/i) || [])[1]
    || (pageUrl ? (pageUrl.match(/\/embed(?:-|\/)([A-Za-z0-9]+)\.?html?/i) || [])[1] : null);
  const embedUrl = embedId ? `https://vidmoly.to/embed-${embedId}.html` : pageUrl || inputUrl;
  const { ok, status, text } = await fetchText(embedUrl, { Referer: "https://vidmoly.to/", Origin: "https://vidmoly.to" });
  if (!ok) throw new Error(`Vidmoly HTTP ${status}`);
  const hls = text.match(/['"](https?:[^'"]+\.m3u8[^'"]*)['"]/i)
    || text.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").match(/['"](https?:[^'"]+\.m3u8[^'"]*)['"]/i);
  if (!hls) throw new Error("Vidmoly: no m3u8");
  return resolveUrl(embedUrl, (hls as RegExpMatchArray)[1]);
}

async function extractStreamtape(inputUrl: string, pageUrl?: string, cookieJar?: { value: string }): Promise<string | null> {
  const embedId = (inputUrl.match(/(?:streamtape\.com)\/(?:e|v|embed)\/([A-Za-z0-9]+)/i) || [])[1]
    || (pageUrl ? (pageUrl.match(/(?:streamtape\.com)\/(?:e|v|embed)\/([A-Za-z0-9]+)/i) || [])[1] : null);
  const pageUrls = embedId
    ? [
        `https://streamtape.com/e/${embedId}`,
        `https://stape.io/e/${embedId}`,
        `https://streamtape.com/v/${embedId}`,
      ]
    : [pageUrl || inputUrl];
  let pageRes: any = null;
  let resolvedPage = pageUrls[0];
  let ok = false, status = 0, text = "";
  for (const u of pageUrls) {
    const r = await fetchTextHeaders(u, { Referer: "https://streamtape.com/", Origin: "https://streamtape.com" });
    pageRes = r;
    if (r.ok) { resolvedPage = u; ok = true; text = r.text; break; }
    status = r.status;
  }
  if (cookieJar) {
    try {
      const sc = pageRes.headers.getSetCookie?.() ?? [];
      if (sc.length) cookieJar.value = sc.map((c) => c.split(";")[0]).join("; ");
    } catch { /* ignore */ }
  }
  if (!ok) throw new Error(`Streamtape HTTP ${status}`);
  const signed = text.match(/https?:[^'"]*\/get_video\?[^'"]*/i);
  if (signed) return signed[0];
  // Streamtape ab link ko "/streamtape.com/get_video?..." (protocol-less) format me deta hai
  const relSigned = text.match(/(\/streamtape\.com\/get_video\?[^"'<>\s]+)/i);
  if (relSigned) return fixRel(relSigned[1]);
  // REAL link is built by JS: robotlink.innerHTML = 'BASE' + ('STR').substring(A).substring(B)...
  // (the static div content is a decoy token). Parse + evaluate the LAST assignment.
  const exprRe = /getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\('([^']*)'\)((?:\.substring\(\d+\))+)/g;
  let em, lastExpr = null;
  while ((em = exprRe.exec(text)) !== null) lastExpr = em;
  if (lastExpr) {
    let s = lastExpr[2];
    const ops = [...lastExpr[3].matchAll(/\.substring\((\d+)\)/g)].map((x) => parseInt(x[1], 10));
    for (const n of ops) s = s.substring(n);
    return fixRel(lastExpr[1] + s);
  }
  const robot = text.match(/id="(?:robotlink|botlink|ideoolink)"[^>]*>([^<]+)</i);
  if (robot) return fixRel(robot[1].trim());
  const token = text.match(/["']?token["']?\s*[:=]\s*["']([A-Za-z0-9]+)["']/);
  if (token && embedId) {
    const { ok: jOk, json } = await fetchJson("https://streamtape.com/ajax.php", {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: resolvedPage,
      Origin: "https://streamtape.com",
    }, 20000);
    if (jOk) {
      const direct = json?.result?.data?.link || json?.result?.link || json?.data?.link || (typeof json?.result === "string" ? json.result : null);
      if (direct && /^https?:/.test(direct)) return direct;
    }
  }
  throw new Error("Streamtape: no robotlink");
}

async function extractMixdrop(inputUrl: string, pageUrl?: string, cookieJar?: { value: string }): Promise<string | null> {
  // MixDrop rotates its embed hosts (mixdrop.co/.to/.top/.ws/.fm/.nu/.ag \u2192 mxdrop.click).
  const EMBED_RE = /(?:mixdrop|mxdrop)(?:\.co|\.to|\.top|\.ws|\.fm|\.nu|\.ag|\.click|\.ch|\.sx|\.io|\.net|\.com)?\/(?:e|f|v)\/([A-Za-z0-9]+)/i;
  const embedId = (inputUrl.match(EMBED_RE) || [])[1]
    || (pageUrl ? (pageUrl.match(EMBED_RE) || [])[1] : null);
  // Host fallback chain \u2014 kabhi kabhi ek host worker ko block/rate-limit karta hai.
  const HOSTS = ["mxdrop.click", "mixdrop.co", "mixdrop.ag", "mixdrop.to"];
  const joined = inputUrl + (pageUrl || "");
  const hm = joined.match(/https?:\/\/((?:mixdrop|mxdrop)[^/]*)/i);
  const preferred = hm ? hm[1] : null;
  const candidates = preferred ? [preferred, ...HOSTS.filter((h) => h !== preferred)] : HOSTS;
  let lastErr = "no embed id";
  if (!embedId) throw new Error(lastErr);
  for (const host of candidates) {
    const resolvedPage = `https://${host}/e/${embedId}`;
    try {
      const pageRes = await fetchTextHeaders(resolvedPage, { Referer: "https://mixdrop.ag/", Origin: "https://mixdrop.ag" });
      const { ok, status, text } = pageRes;
      if (cookieJar) {
        try {
          const sc = pageRes.headers.getSetCookie?.() ?? [];
          if (sc.length) cookieJar.value = sc.map((c) => c.split(";")[0]).join("; ");
        } catch { /* ignore */ }
      }
      if (!ok) { lastErr = `MixDrop HTTP ${status} (${host})`; continue; }
      const scripts = text.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const script of scripts) {
        if (!/MDCore|wurl/i.test(script)) continue;
        const decoded = unpackPackedJs(script);
        if (decoded) {
          // Direct MDCore.wurl assignment (also protocol-relative "//host/...").
          const assign = decoded.match(/(?:MDCore\.wurl|wurl)\s*=\s*['"]([^'"]+)['"]/i);
          if (assign) return normalizeUrl(assign[1]);
          const urls = decoded.match(/https?:[^\s'"]+/g) || [];
          if (urls.length) return urls[urls.length - 1];
        }
      }
      const plain = text.match(/(?:MDCore\.wurl|wurl)\s*=\s*['"]([^'"]+)['"]/i);
      if (plain) return normalizeUrl(plain[1]);
      lastErr = `no MDCore.wurl (${host})`;
    } catch (e) {
      lastErr = `${host}: ` + String(e).slice(0, 80);
    }
  }
  throw new Error("MixDrop: " + lastErr);
}

function toStreamtapeProxy(origin: string, url: string): string {
  const m = url.match(/streamtape\.com\/(?:e|v)\/([A-Za-z0-9]+)/i) || url.match(/get_video\?id=([A-Za-z0-9]+)/i);
  return m ? origin + "/proxy/st/" + m[1] : url;
}

function normalizeUrl(u: string): string {
  return u.startsWith("//") ? "https:" + u : u;
}

function fixRel(u: string): string {
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return "https://" + u.slice(1);
  return u;
}

// UFOload (ufoload.com): REST API (OpenAPI) \u2014 Bearer API key.
// GET /api/v1/files?status=ready&limit=100 \u2192 items[].
// Direct HLS playback: POST /api/v1/files/{fileID}/links \u2192 { playback: master.m3u8 }.
// Ye direct m3u8 EXOPLAYER/MPVKit natively chala sakta hai (webview false!).
async function listUfoloadUploads(env: Env): Promise<any[]> {
  const key = env.UFOLOAD_API_KEY || env.UFOLOAD_KEY;
  if (!key) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  try {
    for (let offset = 0; offset < 300; offset += 100) {
      const { ok, json } = await fetchJson("https://ufoload.com/api/v1/files?status=ready&limit=100&offset=" + offset, {
        Authorization: "Bearer " + key,
      });
      if (!ok || !json) break;
      const items: any[] = json.items || json.files || json?.result?.files || json?.data?.files || [];
      if (items.length === 0) break;
      for (const f of items) {
        const fid = String(f.id || "");
        if (!fid || seen.has(fid)) continue;
        seen.add(fid);
        out.push({
          id: "ufo_" + fid,
          host: "ufoload",
          fileName: String(f.name || ""),
          size: Number(f.size) || 0,
          status: f.status === "ready" ? 200 : 0,
          pageUrl: "https://ufoload.com/api/v1/files/" + fid,
        });
      }
      if (items.length < 100) break;
    }
  } catch { /* ignore */ }
  return out;
}

// EarnVids (earnvids.com): Streamtape-style API \u2014 key param, file/list pagination.
// Direct HLS: /api/file/direct_link?file_code=X \u2192 result.hls_direct (master.m3u8) \u2014 native!
async function listEarnvidsUploads(env: Env): Promise<any[]> {
  const key = env.EARNVIDS_API_KEY;
  if (!key) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= 5; page++) {
      const { ok, json } = await fetchJson("https://earnvids.com/api/file/list?key=" + encodeURIComponent(key) + "&per_page=100&page=" + page);
      if (!ok || !json?.result) break;
      const files: any[] = Array.isArray(json.result) ? json.result : (json.result.files || []);
      if (files.length === 0) break;
      for (const f of files) {
        const code = String(f.file_code || f.filecode || "");
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push({
          id: "ev_" + code,
          host: "earnvids",
          fileName: String(f.title || f.name || ""),
          size: Number(f.size) || 0,
          status: Number(f.canplay) === 1 ? 200 : 0,
          pageUrl: String(f.link || "") || ("https://morencius.com/file/" + code),
        });
      }
      if (files.length < 100) break;
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * DoodStream (doodstream.com) — same Filemoon-family API as EarnVids:
 * /api/file/list + /api/file/direct_link. India me doodstream.com block hai,
 * isliye playback worker ke HLS proxy se hoti hai (device ko CDN tak touch
 * hi nahi karna padta) — zero ads + no geo-block.
 */
async function listDoodstreamUploads(env: Env): Promise<any[]> {
  // DoodStream host REMOVED (2026-11-12): files processing me atki + India geo-block.
  // Integration disabled — data cleanup alag se kiya jata hai.
  void env;
  return [];
  const out: any[] = [];
  const seen = new Set<string>();
  let titleLookups = 0;
  // doodapi.co mirror Cloudflare edge se fail ho sakta hai → doodstream.com fallback
  const BASES = ["https://doodapi.co/api", "https://doodstream.com/api"];
  let listing: { ok: boolean; json: any } | null = null;
  for (const base of BASES) {
    try {
      const r = await fetchJson(base + "/file/list?key=" + encodeURIComponent(key) + "&per_page=100&page=1");
      if (r.ok && r.json?.result) { listing = r; break; }
    } catch { /* try next */ }
  }
  if (!listing) return [];
  for (let page = 1; page <= 5; page++) {
    const { ok, json } = page === 1
      ? (listing as { ok: boolean; json: any })
      : await fetchJson(
          "https://doodapi.co/api/file/list?key=" + encodeURIComponent(key) + "&per_page=100&page=" + page,
        );
    if (!ok || !json?.result) break;
      const files: any[] = Array.isArray(json.result) ? json.result : (json.result.files || []);
      if (files.length === 0) break;
      for (const f of files) {
        const code = String(f.file_code || f.filecode || "");
        if (!code || seen.has(code)) continue;
        seen.add(code);
        let title = String(f.title || f.name || "");
        // file/list ka title cut hota hai (S01E01 part missing) → file/info se full title lo
        // (episode mapping isi se hoti hai).
        if (!/[Ss]\d{1,2}[._\- ]?[Ee]\d{1,3}/.test(title) && titleLookups < 6) {
          titleLookups++;
          try {
            const { ok: infoOk, json: infoJson } = await fetchJson(
              "https://doodapi.co/api/file/info?key=" + encodeURIComponent(key) + "&file_code=" + encodeURIComponent(code),
            );
            const infoTitle = String(infoJson?.result?.[0]?.title || "");
            if (infoOk && infoTitle) title = infoTitle;
          } catch { /* ignore */ }
        }
        out.push({
          id: "ds_" + code,
          host: "doodstream",
          fileName: title,
          size: Number(f.size) || 0,
          // canplay=0 (premium/processing) hone par bhi include karo — embed page
          // worker WebView fallback se playable ho sakta hai. status sirf diagnostic.
          status: 200,
          pageUrl: String(f.download_url || f.link || "") || ("https://doodstream.com/file/" + code),
        });
      }
      if (files.length < 100) break;
    }
  return out;
}

/**
 * EarnVids direct HLS link (master.m3u8). Har direct_link call ek "premium view"
 * jata hai (account me limited views hote hain) isliye link cache hota hai (12h).
 * Link khud 36h valid hai (e=129600) aur HLS cross-IP playable hai \u2014 phir bhi cache
 * key me client IP rakhte hain taaki har device ko apna link mile.
 */
async function earnvidsDirectLink(env: Env, code: string, ip: string): Promise<string | null> {
  const key = env.EARNVIDS_API_KEY;
  if (!key || !code) return null;
  const cacheKey = new Request(`https://earnvids-link.internal/${code}/${ip || "any"}`);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const cached = (await hit.text()).trim();
      if (cached) return cached;
    }
  } catch { /* cache unavailable \u2014 direct fetch below */ }
  const { ok, json } = await fetchJson(
    "https://earnvids.com/api/file/direct_link?key=" + encodeURIComponent(key) +
      "&file_code=" + encodeURIComponent(code) +
      (ip ? "&ip=" + encodeURIComponent(ip) : ""),
  );
  const link = ok ? String(json?.result?.hls_direct || json?.result?.url || json?.result?.mp4 || "") : "";
  if (!link) return null;
  try {
    await caches.default.put(
      cacheKey,
      new Response(link, { headers: { "cache-control": "max-age=43200" } }),
    );
  } catch { /* ignore cache write failure */ }
  return link;
}

/**
 * Upload URL se file ref nikaalo (mixdrop/streamtape /e/<ref>, ufoload /files/<id>,
 * earnvids /file/<code>, ya stored direct mp4 /v2/<ref>.mp4).
 */
function fileRefOf(url: string): string {
  const u = String(url || "");
  const m = u.match(/\/(?:e|f|v|file)\/([A-Za-z0-9]+)/i)
    || u.match(/\/files\/([A-Za-z0-9]+)/i)
    || u.match(/\/v2\/([A-Za-z0-9]+)\.mp4/i);
  return m ? m[1] : "";
}

/** File name se row id (tmdb_ID_SxxEyy.mp4 \u2192 "<id>:<type>:<season>:<episode>"). */
function nameFastIdOf(fileName: string): string {
  const p = parseFilename(String(fileName || ""));
  if (p.tmdbId == null) return "";
  return p.tmdbId + ":" + (p.season != null ? "series" : "movie") + ":" +
    (p.season ?? 0) + ":" + (p.episode ?? 0);
}

/**
 * Existing row ka host-specific URL refresh (naya upload / expired embed link).
 * Row id format: "<tmdbId>:<type>:<season>:<episode>".
 */
async function updateHostUrl(env: Env, rowId: string, host: string, url: string): Promise<void> {
  const field = HOST_FIELD[host];
  if (!field || !url) return;
  try {
    await env.DB.prepare(
      `UPDATE media_items SET ${field}=?, updated_at=datetime('now') WHERE id=? AND ${field}<>?`,
    ).bind(url, rowId, url).run();
  } catch (e) {
    console.log("url update failed", host, String(e).slice(0, 100));
  }
}

/**
 * EarnVids/DoodStream direct HLS link (master.m3u8). Har direct_link call ek
 * "premium view" jata hai (account me limited views hote hain) isliye link cache
 * hota hai (12h). Link khud 36h valid hai (e=129600) aur HLS cross-IP playable
 * hai — phir bhi cache key me client IP rakhte hain taaki har device ko apna link mile.
 */
async function filemoonDirectLink(
  host: string,
  apiBase: string,
  apiKey: string,
  code: string,
  ip: string,
): Promise<string | null> {
  if (!apiKey || !code) return null;
  const cacheKey = new Request(`https://${host}-link.internal/${code}/${ip || "any"}`);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const cached = (await hit.text()).trim();
      if (cached) return cached;
    }
  } catch { /* cache unavailable — direct fetch below */ }
  const { ok, json } = await fetchJson(
    `${apiBase}/api/file/direct_link?key=${encodeURIComponent(apiKey)}` +
      `&file_code=${encodeURIComponent(code)}` +
      (ip ? `&ip=${encodeURIComponent(ip)}` : ""),
  );
  const link = ok ? String(json?.result?.hls_direct || json?.result?.url || json?.result?.mp4 || "") : "";
  if (!link) return null;
  try {
    await caches.default.put(
      cacheKey,
      new Response(link, { headers: { "cache-control": "max-age=43200" } }),
    );
  } catch { /* ignore cache write failure */ }
  return link;
}

/**
 * DoodStream direct HLS/mp4 link.
 *
 * 1) Pehle API ka direct_link (kuch accounts me hota hai).
 * 2) Nahi mila to EMBED PAGE unpack — worker ke IP se (CF datacenter) fetch hota hai,
 *    isliye India block bypass ho jata hai (device ko blocked site touch hi nahi karna).
 *    DoodStream bhi Filemoon-family hai, isliye wahi packed-JS unpacker chalta hai.
 */
async function doodstreamDirectLink(
  env: Env,
  code: string,
  ip: string,
  originHintUrl?: string,
): Promise<string | null> {
  const api = await filemoonDirectLink(
    "doodstream",
    "https://doodstream.com",
    env.DOODSTREAM_API_KEY || "",
    code,
    ip,
  ).catch(() => null);
  if (api) return api;
  let originHint: string | undefined;
  try {
    originHint = new URL(originHintUrl).origin;
  } catch { /* ignore */ }
  return extractDoodstreamEmbed(env, code, originHint);
}

/** DoodStream embed page → direct m3u8/mp4 (packed JS unpack karke). */
async function extractDoodstreamEmbed(
  env: Env,
  code: string,
  originHint?: string,
): Promise<string | null> {
  const origins = [originHint, "https://doodstream.com"].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const origin of origins) {
    const base = origin.replace(/\/+$/, "");
    candidates.push(`${base}/e/${code}`, `${base}/file/${code}`);
  }
  for (const pageUrl of candidates) {
    // Browser-like headers — Cloudflare challenge (403 "Just a moment...") tabhi aata hai
    // jab Accept/UA typical na ho.
    const { ok, text } = await fetchText(pageUrl, {
      "User-Agent": userAgent(env),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://doodstream.com/",
      Origin: "https://doodstream.com",
    });
    if (!ok || !text || text.length < 2000) continue;
    const scripts = text.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const script of scripts) {
      const decoded = unpackPackedJs(script);
      if (!decoded) continue;
      const wurl = decoded.match(/(?:MDCore\.wurl|wurl)\s*=\s*['"]([^'"]+)['"]/i);
      if (wurl) return normalizeUrl(wurl[1]);
      const m3u8 = decoded.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
      if (m3u8) return m3u8[0];
      const mp4 = decoded.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);
      if (mp4) return mp4[0];
    }
    const plain = text.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/i);
    if (plain) return plain[0];
  }
  return null;
}

/** Filemoon-family hosts (EarnVids / DoodStream) - same API shape. */
async function listFilemoonUploads(
  host: string,
  apiBase: string,
  apiKey: string,
): Promise<any[]> {
  if (!apiKey) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  try {
    for (let page = 1; page <= 5; page++) {
      const { ok, json } = await fetchJson(
        `${apiBase}/api/file/list?key=${encodeURIComponent(apiKey)}&per_page=100&page=${page}`,
      );
      if (!ok || !json?.result) break;
      const files: any[] = Array.isArray(json.result) ? json.result : (json.result.files || []);
      if (files.length === 0) break;
      for (const f of files) {
        const code = String(f.file_code || f.filecode || "");
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push({
          id: host + "_" + code,
          host,
          fileName: String(f.title || f.name || ""),
          size: Number(f.size) || 0,
          status: Number(f.canplay) === 1 ? 200 : 0,
          // API ka apna link (domain rotate hota hai — /file/<code> format).
          pageUrl: String(f.link || "") || `${apiBase}/file/${code}`,
        });
      }
      if (files.length < 100) break;
    }
  } catch { /* ignore */ }
  return out;
}

async function extractUfoload(inputUrl: string, pageUrl?: string): Promise<string | null> {
  const embedId = (inputUrl.match(/(?:ufoload\.io)\/(?:v|e|embed)\/([A-Za-z0-9]+)/i) || [])[1]
    || (pageUrl ? (pageUrl.match(/(?:ufoload\.io)\/(?:v|e|embed)\/([A-Za-z0-9]+)/i) || [])[1] : null);
  const resolvedPage = embedId ? `https://ufoload.io/v/${embedId}` : pageUrl || inputUrl;
  const { ok, status, text } = await fetchText(resolvedPage, { Referer: "https://ufoload.io/", Origin: "https://ufoload.io" });
  if (!ok) throw new Error(`UFOload HTTP ${status}`);
  const direct = text.match(/https?:[^'"]+\.mp4[^'"]*/i) || text.match(/(?:file|src)\s*[:=]\s*['"](https?:[^'"]+)['"]/i);
  if (!direct) throw new Error("UFOload: no mp4");
  return resolveUrl(resolvedPage, direct[0]);
}

// ------------------------------------------------------- host adapters

async function listStreamtape(env: Env) {
  const login = env.STREAMTAPE_USER || env.STREAMTAPE_LOGIN;
  if (!login || !env.STREAMTAPE_KEY) return [];
  const out: any[] = [];
  const seen = new Set<string>();

  const call = async (folder?: string): Promise<any> => {
    for (const api of ["https://api.streamtape.com/file/listfolder", "https://api.streamtape.to/file/listfolder"]) {
      const qs = `login=${encodeURIComponent(login)}&key=${encodeURIComponent(env.STREAMTAPE_KEY || "")}`;
      const r = await fetchJson(`${api}?${qs}${folder ? "&folder=" + encodeURIComponent(folder) : ""}`, { Referer: "https://streamtape.com/" });
      if (r.ok && r.json?.status === 200) return r.json;
    }
    return null;
  };

  const collect = (json: any) => {
    for (const f of (json?.result?.files || [])) {
      const fid = String(f.linkid || f.id || "");
      if (!fid || seen.has(fid)) continue;
      seen.add(fid);
      out.push({
        id: fid,
        host: "streamtape",
        fileName: String(f.name || f.file_name || ""),
        size: Number(f.size) || 0,
        status: 200,
        pageUrl: String(f.link || `https://streamtape.com/v/${fid}`),
      });
    }
  };

  const root = await call();
  if (!root) return [];
  collect(root);
  // 2 folders per run — minute ke hisaab se rotate (free-tier subrequest limit)
  const folders: any[] = root?.result?.folders || [];
  if (folders.length) {
    const start = new Date().getUTCMinutes() % folders.length;
    for (let i = 0; i < Math.min(2, folders.length); i++) {
      const folder = folders[(start + i) % folders.length];
      const fid = folder?.id;
      if (!fid) continue;
      const j = await call(String(fid));
      if (j) collect(j);
    }
  }
  return out;
}

function parseUploadsJson(env: Env) {
  if (!env.UPLOADS_JSON || !env.UPLOADS_JSON.trim()) return [];
  try {
    const parsed = JSON.parse(env.UPLOADS_JSON);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row: any, i: number) => {
      const host = String(row.host || "").toLowerCase();
      const pageUrl = String(row.url || row.pageUrl || row.iframeUrl || "");
      if (!host || !pageUrl) return null;
      return {
        id: String(row.id || i || pageUrl), host, fileName: String(row.fileName || row.name || ""),
        size: Number(row.size) || 0, status: Number(row.status) || 200, pageUrl, webview: host === "abyss",
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ watchlist (D1)

/** Detect which host a link belongs to. */
function detectHost(url: string): string | null {
  const u = url.toLowerCase();
  if (/streamtape\.com|stape\.io/.test(u)) return "streamtape";
  if (/vidmoly/.test(u)) return "vidmoly";
  if (/mixdrop|mxdrop/.test(u)) return "mixdrop";
  if (/abyss/.test(u)) return "abyss";
  if (/ufoload/.test(u)) return "ufoload";
  if (/byse|bysetayico/.test(u)) return "byse";
  if (/earnvids|morencius|dramiyos/.test(u)) return "earnvids";
  if (/doodstream|dood\.to|doodcdn|doodreels/.test(u)) return "doodstream";
  return null;
}

/** Watchlist rows stored in D1 (added via /add). */
async function listWatchlist(db: D1Database): Promise<any[]> {
  try {
    const { results } = await db.prepare("SELECT url, host, file_name, media_type, tmdb_id FROM watchlist").all<any>();
    return (results || []).map((r: any) => {
      // Explicit tmdb id / type se file name banao (title match guess nahi karna padta).
      let fileName = String(r.file_name || "");
      if (!fileName && r.tmdb_id) {
        const ep = /[Ss](\d{1,2})[Ee](\d{1,3})/.exec(fileName);
        fileName = r.media_type === "movie"
          ? `tmdb_${r.tmdb_id}.mp4`
          : `tmdb_${r.tmdb_id}.mp4`;
      }
      return {
        id: r.url,
        host: r.host,
        fileName: fileName,
        size: 0,
        status: 200,
        pageUrl: r.url,
        webview: r.host === "abyss",
      };
    });
  } catch {
    return [];
  }
}

// ------------------------------------------------------ mixdrop folder-scan

async function listAbyssUploads(env: Env): Promise<any[]> {
  if (!env.ABYSS_API_KEY) return [];
  const out: any[] = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    let u = "https://api.abyss.to/v1/resources?key=" + env.ABYSS_API_KEY + "&type=files&maxResults=100";
    if (pageToken) u += "&pageToken=" + encodeURIComponent(pageToken);
    try {
      const { ok, json } = await fetchJson(u);
      if (!ok || !json?.items) break;
      for (const f of json.items) {
        if (f.isDir) continue;
        if (f.status !== "ready") continue;
        out.push({
          id: "ab_" + f.id,
          host: "abyss",
          fileName: String(f.name || ""),
          size: Number(f.size) || 0,
          status: 200,
          pageUrl: "https://player.abyssplayer.com/" + f.id,
        });
      }
      pageToken = json.pageToken || "";
      if (!pageToken) break;
    } catch { break; }
  }
  return out;
}

// Byse (filemoon-style): folder/list (traversal) + file/list pagination.
// Embed page: https://api.byse.sx/e/{file_code} (HTML5 player \u2014 WebView me chalta hai).
async function listByseUploads(env: Env): Promise<any[]> {
  if (!env.BYSE_API_KEY) return [];
  const key = encodeURIComponent(env.BYSE_API_KEY);
  const out: any[] = [];
  const seen = new Set<string>();

  const pushFile = (f: any) => {
    const code = String(f.file_code || f.filecode || "");
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push({
      id: "byse_" + code,
      host: "byse",
      fileName: String(f.name || f.title || ""),
      size: Number(f.size) || 0,
      status: 200,
      pageUrl: "https://api.byse.sx/e/" + code,
    });
  };

  // 1) Folder list \u2192 per-folder file lists (root + up to 10 folders, max 2 API calls per folder)
  try {
    const { ok, json } = await fetchJson("https://api.byse.sx/folder/list?key=" + key + "&files=1");
    if (ok && json?.result?.folders) {
      const folders: any[] = json.result.folders;
      // root files (folder/list?files=1 already includes root files as "files")
      for (const f of (json.result.files || [])) pushFile(f);
      const maxFolders = Math.min(folders.length, 10);
      for (let i = 0; i < maxFolders; i++) {
        const fid = String(folders[i].fld_id ?? "");
        if (!fid) continue;
        try {
          const r2 = await fetchJson("https://api.byse.sx/folder/list?key=" + key + "&fld_id=" + fid + "&files=1");
          if (r2.ok && r2.json?.result?.files) {
            for (const f of r2.json.result.files) pushFile(f);
          }
        } catch { /* skip folder */ }
      }
    }
  } catch { /* fall through to file/list */ }

  // 2) file/list pagination (up to 5 pages Ã— 100) \u2014 Byse result object hai ({files:[...]}).
  try {
    for (let page = 1; page <= 5; page++) {
      const { ok, json } = await fetchJson("https://api.byse.sx/file/list?key=" + key + "&per_page=100&page=" + page);
      if (!ok || !json?.result) break;
      const files = Array.isArray(json.result) ? json.result : (json.result.files || []);
      if (files.length === 0) break;
      for (const f of files) pushFile(f);
      if (files.length < 100) break;
    }
  } catch { /* ignore */ }

  return out;
}

async function mixdropListFolder(env: Env, folderId: string): Promise<{ folders: any[]; files: any[] }> {
  const E = encodeURIComponent(env.MIXDROP_EMAIL!);
  const K = encodeURIComponent(env.MIXDROP_KEY!);
  // Rate-limit (403 "Too many requests") retry + gentle delay.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { ok, status, json } = await fetchJson("https://api.mixdrop.ag/folderlist?email=" + E + "&key=" + K + "&id=" + folderId + "&page=1");
      if (!ok || !json?.success) {
        if (status === 403) {
          // Cooldown set karo — 30 min tak MixDrop scan skip (cron 403 ko alive na rakhe).
          try {
            await env.DB.prepare("INSERT INTO sync_state (key,value) VALUES ('mxcooldown',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
              .bind(String(Date.now())).run();
          } catch { /* ignore */ }
          return { folders: [], files: [] };
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          continue;
        }
        return { folders: [], files: [] };
      }
      // page 2 (files > 50 ho to) \u2014 naye uploads page 1 ke baad ho sakte hain.
      let files: any[] = json?.result?.files || [];
      if (files.length >= 50) {
        const p2 = await fetchJson("https://api.mixdrop.ag/folderlist?email=" + E + "&key=" + K + "&id=" + folderId + "&page=2");
        if (p2.ok && p2.json?.success) {
          files = files.concat(p2.json.result?.files || []);
        }
      }
      return { folders: json?.result?.folders || [], files };
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      return { folders: [], files: [] };
    }
  }
  return { folders: [], files: [] };
}

async function listMixdropUploads(env: Env, db: D1Database, cache: Map<string, number>): Promise<any[]> {
  if (!env.MIXDROP_EMAIL || !env.MIXDROP_KEY) return [];
  const out: any[] = [];

  const root = await mixdropListFolder(env, "0");
  if (root.folders.length === 0) return out;

  // THROTTLED ROUND-ROBIN: 6 folders/run + 200ms delay \u2014 MixDrop API "Too many
  // requests" (403) trigger karta hai jab ek run me bahut saare calls hote hain.
  // 6-10 folders ka library 2-3 runs (~10-15 min) me fully cover hota hai.
  // Folder ke TMDB id sync_state cache me hote hain \u2014 repeat runs me TMDB call nahi.
  let cursor = 0;
  try {
    const cr = await db.prepare("SELECT value FROM sync_state WHERE key='mdcursor'").first<any>();
    cursor = cr?.value ? parseInt(cr.value, 10) || 0 : 0;
  } catch { cursor = 0; }

  const W = 3;
  const folders: any[] = [];
  for (let i = 0; i < W && root.folders.length > 0; i++) {
    folders.push(root.folders[(cursor + i) % root.folders.length]);
  }
  const nextCursor = (cursor + W) % root.folders.length;
  try { await db.prepare("INSERT INTO sync_state (key,value) VALUES ('mdcursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(nextCursor)).run(); } catch { /* ignore */ }

  for (const folder of folders) {
    if (!folder) continue;
    const fid = String(folder.id);
    const ftitle = String(folder.title || "").trim();
    const generic = /movie|remote|subtitle/i.test(ftitle);

    let tmdbId: number | null = cache.get("mdfolder:" + fid) ?? null;
    if (tmdbId == null && !generic) {
      const parsedF = parseFilename(ftitle);
      if (parsedF.title) {
        const meta = await tmdbMatch(env, parsedF).catch(() => null);
        if (meta) { tmdbId = meta.tmdbId; cache.set("mdfolder:" + fid, tmdbId); }
      }
    }

    const main = await mixdropListFolder(env, fid);
    const allFiles = [...main.files];
    for (const sf of main.folders) {
      await new Promise((r) => setTimeout(r, 250));
      const sub = await mixdropListFolder(env, String(sf.id));
      allFiles.push(...sub.files);
    }
    if (folders.length > 1) await new Promise((r) => setTimeout(r, 250));

    for (const f of allFiles) {
      if (f.deleted || !f.isvideo) continue;
      if (f.status && !/OK/i.test(f.status)) continue;
      const title = String(f.title || "");
      let fileName: string;
      if (tmdbId != null) {
        const ep = title.match(/[Ss](\d{1,2})[._\- ]?[Ee](\d{1,3})/)
          ?? title.match(/\b(?:Ep?|Episode)\s*[.#_-]?\s*(\d{1,3})\b/i);
        if (ep) {
          const epNum = parseInt(ep[1], 10);
          fileName = "tmdb_" + tmdbId + "_S01E" + String(epNum).padStart(2, "0") + ".mp4";
        } else {
          fileName = "tmdb_" + tmdbId + ".mp4";
        }
      } else {
        fileName = title;
      }
      out.push({ id: "md_" + f.fileref, host: "mixdrop", fileName, size: Number(f.size) || 0, status: 200, pageUrl: String(f.embedurl || ("https://mixdrop.co/e/" + f.fileref)) });
    }
  }
  return out;
}

// ------------------------------------------------------------ sync pipeline

let lastSyncErrors: string[] = [];

async function runSync(env: Env): Promise<number> {
  const db = env.DB;
  lastSyncErrors = [];
  await ensureSchema(db);

  // Phase 1: listings (HTTP subrequests ~13)
  let budget = 20;
  const mdCache = new Map<string, number>();
  try {
    const cacheRows = await db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'mdfolder:%'").all<any>();
    for (const r of (cacheRows.results || [])) mdCache.set(r.key, parseInt(r.value, 10) || 0);
  } catch { /* ignore */ }

  // Listing cache (2 min): har sync me 6 hosts list karne se ~25 subrequests + 10s sleep
  // lagta hai (free plan ka 50-subrequest limit tight ho jaata hai). Cache se repeat
  // sync ~1s me hota hai; naye upload 2-5 min me pakde jaate hain.
  const LISTING_CACHE_MS = 10 * 60 * 1000;
  const uploads: any[] = [];
  let listingFromCache = false;
  try {
    const cacheRows = await db.prepare("SELECT key, value FROM sync_state WHERE key IN ('uploads_cache','uploads_cache_at')").all<any>();
    const cm = new Map<string, string>();
    for (const r of (cacheRows.results || [])) cm.set(String(r.key), String(r.value));
    const at = Date.parse(cm.get("uploads_cache_at") || "");
    if (cm.has("uploads_cache") && Number.isFinite(at) && Date.now() - at < LISTING_CACHE_MS) {
      const cached = JSON.parse(cm.get("uploads_cache") || "[]");
      if (Array.isArray(cached)) {
        uploads.push(...cached);
        listingFromCache = true;
      }
    }
  } catch { /* ignore */ }
  if (listingFromCache) {
    // Cache active ho to bhi WATCHLIST hamesha fresh rakhna zaroori hai —
    // /add se turant add hui entries cache window ke andar bhi process honi chahiye.
    const wl = await listWatchlist(db);
    const seenWl = new Set<string>(uploads.map((u: any) => u.pageUrl).filter(Boolean));
    for (const u of wl) {
      if (!u.pageUrl || seenWl.has(u.pageUrl)) continue;
      seenWl.add(u.pageUrl);
      uploads.push(u);
    }
  }
  if (!listingFromCache) {
    // MixDrop cooldown: 403 aane par 30 min tak scan skip (rate-limit reset).
    let mxAllowed = true;
    try {
      const cd = await db.prepare("SELECT value FROM sync_state WHERE key='mxcooldown'").first<any>();
      if (cd?.value && Date.now() - Number(cd.value) < 1800000) mxAllowed = false;
    } catch { /* ignore */ }
    // Watchlist PEHLE — /add se manually added entries budget khaane wale
    // host-scan errors se pehle process hon (83-file bulk adds critical).
    // Watchlist + DoodStream pehle (naye uploads fast process — queue me peeche na rahein)
    const allUploads: any[] = [...(await listWatchlist(db)), ...(await listDoodstreamUploads(env)), ...parseUploadsJson(env), ...(await listStreamtape(env)), ...(mxAllowed ? (await listMixdropUploads(env, db, mdCache)) : []), ...(await listAbyssUploads(env)), ...(await listByseUploads(env)), ...(await listUfoloadUploads(env)), ...(await listEarnvidsUploads(env))];
    const seenUp = new Set<string>();
    for (const u of allUploads) {
      if (!u.pageUrl || seenUp.has(u.pageUrl)) continue;
      seenUp.add(u.pageUrl);
      uploads.push(u);
    }
    try {
      const stmts0 = db.prepare("INSERT INTO sync_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      await db.batch([
        stmts0.bind("uploads_cache", JSON.stringify(uploads).slice(0, 60000)),
        stmts0.bind("uploads_cache_at", new Date().toISOString()),
      ]);
    } catch { /* ignore cache write */ }
  }
  lastSyncErrors.push("debug: uploads=" + uploads.length + (listingFromCache ? " (cached)" : ""));

  // Phase 2: existing ids (1 D1 subrequest)
  const existingIds = new Set<string>();
  try {
    const allRows = await db.prepare("SELECT id FROM media_items").all<any>();
    for (const r of (allRows.results || [])) existingIds.add(r.id);
  } catch { /* ignore */ }

  // Phase 2b: pehle se ingest ho chuke uploads (pageUrl marker) + host_uploads timing
  // (direct-URL hosts \u2014 vidmoly/ufoload \u2014 ka signed link refresh kitni der baad karna hai)
  // Map: pageUrl -> row id jisme ingest hua tha (episode badalne par dobara ingest karte hain).
  const ingestedUrls = new Map<string, string>();
  try {
    const markerRows = await db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'ingested:%'").all<any>();
    for (const r of (markerRows.results || [])) {
      ingestedUrls.set(String(r.key).slice("ingested:".length), String(r.value || ""));
    }
  } catch { /* ignore */ }
  const hostCheckedAt = new Map<string, number>();
  try {
    const huRows = await db.prepare("SELECT page_url, last_checked FROM host_uploads").all<any>();
    for (const r of (huRows.results || [])) {
      if (!r?.page_url) continue;
      const t = Date.parse(String(r.last_checked || "") + "Z");
      if (Number.isFinite(t)) hostCheckedAt.set(String(r.page_url), t);
    }
  } catch { /* ignore */ }
  // 6h baad direct-URL hosts ka signed link refresh (24h cache se bache)
  const DIRECT_URL_HOSTS = new Set(["vidmoly", "ufoload"]);
  const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
  // Embed-URL hosts (streamtape/mixdrop/abyss/byse/earnvids) ka stored link stable
  // hota hai \u2014 unhe har sync me dobara extract karne ki zaroorat nahi (subrequest limit).
  const STABLE_URL_HOSTS = new Set(["streamtape", "mixdrop", "abyss", "byse", "earnvids"]);
  // Hosts jinke D1 me stored value = upload.pageUrl (embed/API link). Inke liye
  // naya upload aane par existing row ka URL refresh karna hota hai \u2014 warna
  // "naya video upload" row me write hi nahi hota (fast path skip).
  const PAGE_URL_HOSTS = new Set(["streamtape", "mixdrop", "ufoload", "abyss", "byse", "earnvids"]);

  // Phase 3: budgeted processing \u2014 D1 writes batched
  let ingested = 0;
  let processedThisRun = 0;
  // Per-run processing cap (subrequest limit safety) + TMDB/extractor call budget.
  const MAX_PROCESSED_PER_RUN = 3;
  const stmts: any[] = [];
  // Naye upload ka pageUrl marker \u2192 agli sync me dobara extract/TMDB call nahi.
  // Value = "<rowId>|<fileRef>" \u2014 file ref se pata chalta hai ki ye file pehle se
  // usi episode me ingest hui thi ya nayi file hai (duplicate name / rename).
  const markIngested = (pageUrl: string, id: string, ref?: string) => {
    if (!pageUrl) return;
    ingestedUrls.set(pageUrl, id + "|" + (ref ?? ""));
    stmts.push(db.prepare("INSERT INTO sync_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind("ingested:" + pageUrl, id + "|" + (ref ?? "")));
  };

  for (const [k2, v2] of mdCache) {
    stmts.push(db.prepare("INSERT INTO sync_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k2, String(v2)));
  }

  for (const upload of uploads) {
    if (budget < 3) { lastSyncErrors.push("budget: pausing \u2014 next run continue karega"); break; }
    // Cloudflare free plan ka 50-subrequest limit hai \u2014 ek run me zyada uploads process
    // karenge to invocation chupke se mar jayega (state update nahi hoga). Isliye
    // per-run cap: bache hue uploads next run me handle honge (marker persist hota hai).
    if (processedThisRun >= MAX_PROCESSED_PER_RUN) {
      lastSyncErrors.push("processed-cap: " + MAX_PROCESSED_PER_RUN + " \u2014 next run continue karega");
      break;
    }

    // FAST PATH 1: ye upload pehle se ingest ho chuka hai \u2192 koi extraction/TMDB call nahi.
    // (Har run me dobara extract karne se Worker ka 50-subrequest limit toot-ta tha
    //  aur naye uploads kabhi ingest hi nahi hote the.)
    // LEKIN: marker ka file-ref alag ho (naya upload / rename / duplicate name) to
    // dobara ingest karo \u2014 warna nayi file kabhi row me write hi nahi hoti.
    const uploadRef = fileRefOf(upload.pageUrl);
    if (STABLE_URL_HOSTS.has(upload.host) && ingestedUrls.has(upload.pageUrl)) {
      const marker = String(ingestedUrls.get(upload.pageUrl) || "");
      const prevId = marker.split("|")[0];
      const prevRef = marker.split("|")[1] || "";
      const sameFile = !prevRef || prevRef === uploadRef;
      const sameEpisode = !uploadRef || !prevId || prevId === nameFastIdOf(upload.fileName);
      if (sameFile && sameEpisode) {
        ingested++;
        continue;
      }
      console.log("re-ingest upload", upload.pageUrl, "marker:", marker, "newRef:", uploadRef);
    }

    let effectiveName = String(upload.fileName || "");
    // Direct-URL hosts (vidmoly/ufoload) ka signed link 6h me ek baar refresh hota
    // hai \u2014 har 15-min sync me refresh karne se subrequest limit tootta hai.
    const directUrlFresh = DIRECT_URL_HOSTS.has(upload.host)
      && (hostCheckedAt.get(upload.pageUrl) ?? 0) > Date.now() - REFRESH_AFTER_MS;
    // mixdrop/abyss/streamtape titles pehle se sahi hain \u2014 sirf vidmoly/ufoload ke liye page title
    if ((upload.host === "vidmoly" || upload.host === "ufoload") && budget > 8 && !directUrlFresh) {
      budget--;
      const pageTitle = await extractPageTitle(upload.pageUrl).catch(() => null);
      if (pageTitle && (/\.(mp4|mkv|avi|webm|ts)\b/i.test(pageTitle) || /\d{1,2}\s?[-._ ]?[Ee]\d{1,3}\b/.test(pageTitle))) {
        effectiveName = pageTitle;
      }
    }
    const parsed = parseFilename(effectiveName);

    // FAST PATH 2: tmdb-id se pata hai ki row pehle se hai \u2192 extraction/TMDB skip.
    let fastId: string | null = null;
    if (parsed.tmdbId != null) {
      const fastType = parsed.season != null ? "series" : "movie";
      fastId = parsed.tmdbId + ":" + fastType + ":" + (parsed.season ?? 0) + ":" + (parsed.episode ?? 0);
      if (existingIds.has(fastId) && !directUrlFresh) {
        // Row pehle se hai (same tmdb/season/episode). Naya upload ya expired
        // link hone par stored URL refresh karo \u2014 warna episode app me dikhta hai
        // par purana (dead) link play hota hai.
        if (PAGE_URL_HOSTS.has(upload.host) && upload.pageUrl) {
          await updateHostUrl(env, fastId, upload.host, upload.pageUrl);
        }
        // Category refresh: raw filename me "Anime" ho to anime mark karo
        // (fast-path pe tmdbMatch skip hota hai — stale category na rahe).
        if (fastType === "series" && /anime/i.test(String(upload.fileName || ""))) {
          try {
            await db.prepare("UPDATE media_items SET category='anime' WHERE id=?").bind(fastId).run();
          } catch { /* ignore */ }
        }
        processedThisRun++;
        ingested++;
        markIngested(upload.pageUrl, fastId, uploadRef);
        continue;
      }
    }

    let ready = false, valid = false, directUrl: string | null = null;

    if (upload.host === "streamtape") {
      valid = Boolean(upload.id) && Number(upload.status) === 200;
      ready = valid;
      if (ready) {
        budget--;
        try { directUrl = await extractStreamtape(upload.pageUrl); } catch (e) { directUrl = null; const es = String(e); if (!/404|no robotlink/i.test(es)) lastSyncErrors.push("streamtape: " + es.slice(0, 120)); }
      }
  } else if (upload.host === "abyss" || upload.host === "byse" || upload.host === "ufoload" || upload.host === "earnvids") {
    valid = Boolean(upload.pageUrl);
    ready = valid;
    directUrl = upload.pageUrl;
  } else if (upload.host === "doodstream") {
    // DoodStream: encode hone tak canplay=0 rehta hai - tab tak embed page
    // "not available" deta hai. Unready file skip karo (next sync me ready hoga).
    valid = Boolean(upload.pageUrl) && Number(upload.status) === 200;
    ready = valid;
    directUrl = upload.pageUrl;
  } else {
      const extractor = upload.host === "vidmoly" ? extractVidmoly : upload.host === "mixdrop" ? extractMixdrop : upload.host === "ufoload" ? extractUfoload : null;
      valid = Boolean(upload.pageUrl);
      if (extractor) {
        budget--;
        try { directUrl = await extractor(upload.pageUrl); ready = Boolean(directUrl); } catch (e) { ready = false; lastSyncErrors.push(upload.host + ": " + String(e).slice(0, 120)); }
      }
    }

    // host_uploads log (batched)
    if (upload.id) {
      stmts.push(db.prepare(
        `INSERT INTO host_uploads (id, host, file_name, size, status, page_url, direct_url, last_checked, is_valid)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT(id) DO UPDATE SET file_name=excluded.file_name, size=excluded.size, status=excluded.status,
           page_url=excluded.page_url, direct_url=excluded.direct_url, last_checked=datetime('now'), is_valid=excluded.is_valid`,
      ).bind(upload.id, upload.host, upload.fileName, upload.size, upload.status, upload.pageUrl, directUrl ?? "", valid ? 1 : 0));
    }

    if (!valid || !ready) { lastSyncErrors.push("skip-not-ready: " + upload.host + ":" + upload.fileName.slice(0, 40)); continue; }

    const meta = await tmdbMatch(env, parsed);
    if (!meta) { lastSyncErrors.push("tmdb-miss: " + upload.fileName.slice(0, 60)); continue; }
    budget--;

    // Search results me genres empty hote hain — detail se bharo (category sahi ho).
    // Budget bacha ho tab hi (subrequest limit safety).
    if ((!Array.isArray(meta.genres) || meta.genres.length === 0) && budget > 8) {
      budget--;
      await enrichGenres(env, meta);
    }
    // Raw upload fileName use karo (parseFilename strip hone ke baad "Anime" gayab hota hai)
    const rawAnime = /anime/i.test(String(upload.fileName || ""));
    let category = categoryOf(meta);
    if (category !== "movie" && rawAnime) category = "anime";
    meta.category = category;

    const id = meta.tmdbId + ":" + meta.type + ":" + (meta.season ?? 0) + ":" + (meta.episode ?? 0);
    const urlField = HOST_FIELD[upload.host] as string;
    // mixdrop: signed direct URL expire hota hai \u2014 D1 me stable embed page rakho (serve-time fresh extract hota hai)
    const hostUrl = upload.host === "streamtape" || upload.host === "mixdrop" ? upload.pageUrl : (directUrl ?? upload.pageUrl);

    // upsert: naya row ya existing me URL merge (COALESCE per-host)
    // category: movie/anime/tv (genres + origin country + raw filename se)
    const rowCategory = meta.category;
    const baseVals = [id, meta.tmdbId, meta.type, meta.title, meta.poster, meta.backdrop, meta.overview, meta.rating,
      meta.type === "series" ? meta.season : null, meta.type === "series" ? meta.episode : null, rowCategory];
  const allUrls = ["streamtape", "vidmoly", "mixdrop", "ufoload", "abyss", "byse", "earnvids", "doodstream"].map((h) => (h === upload.host ? hostUrl : ""));
    stmts.push(db.prepare(
      `INSERT INTO media_items (id, tmdb_id, type, title, poster, backdrop, overview, rating, season, episode, category, streamtape_url, vidmoly_url, mixdrop_url, ufoload_url, abyss_url, byse_url, earnvids_url, doodstream_url, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, poster=excluded.poster, backdrop=excluded.backdrop, overview=excluded.overview, rating=excluded.rating,
         season=COALESCE(excluded.season, media_items.season), episode=COALESCE(excluded.episode, media_items.episode),
         category=excluded.category,
         streamtape_url=COALESCE(nullif(excluded.streamtape_url,''), media_items.streamtape_url),
         vidmoly_url=COALESCE(nullif(excluded.vidmoly_url,''), media_items.vidmoly_url),
         mixdrop_url=COALESCE(nullif(excluded.mixdrop_url,''), media_items.mixdrop_url),
         ufoload_url=COALESCE(nullif(excluded.ufoload_url,''), media_items.ufoload_url),
         abyss_url=COALESCE(nullif(excluded.abyss_url,''), media_items.abyss_url),
         byse_url=COALESCE(nullif(excluded.byse_url,''), media_items.byse_url),
         earnvids_url=COALESCE(nullif(excluded.earnvids_url,''), media_items.earnvids_url),
         doodstream_url=COALESCE(nullif(excluded.doodstream_url,''), media_items.doodstream_url),
         is_active=1, updated_at=datetime('now')`,
    ).bind(...baseVals, allUrls[0], allUrls[1], allUrls[2], allUrls[3], allUrls[4], allUrls[5], allUrls[6], allUrls[7]));
    ingested++;
    processedThisRun++;
    markIngested(upload.pageUrl, id, uploadRef);
  }

  // Phase 4: batch write (1 D1 subrequest)
  if (stmts.length > 0) {
    try { await db.batch(stmts); } catch (e) { lastSyncErrors.push("batch: " + String(e).slice(0, 140)); }
  }

  // Phase 5: cleanup + state (batched)
  const cleanup: any[] = [];
  cleanup.push(db.prepare("UPDATE media_items SET is_active=0, updated_at=datetime('now') WHERE streamtape_url='' AND vidmoly_url='' AND mixdrop_url='' AND ufoload_url='' AND abyss_url='' AND byse_url='' AND earnvids_url='' AND doodstream_url='' AND is_title_only=0"));
  cleanup.push(db.prepare("INSERT INTO sync_state (key,value) VALUES ('lastSyncAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(new Date().toISOString()));
  cleanup.push(db.prepare("INSERT INTO sync_state (key,value) VALUES ('lastSyncCount',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(ingested)));
  cleanup.push(db.prepare("INSERT INTO sync_state (key,value) VALUES ('lastSyncErrors',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(lastSyncErrors).slice(0, 4000)));
  try { await db.batch(cleanup); } catch (e) { lastSyncErrors.push("cleanup: " + String(e).slice(0, 120)); }
  return ingested;
}

// ---------------------------------------------------------------------------
// Lazy sync: Cloudflare Cron Trigger ka scheduled handler CF side se detect
// nahi ho raha ("we lack a handler for ScheduledEvents") \u2014 jisse naye upload
// kabhi sync hi nahi hote the. Isliye catalog/stream request par, agar last
// sync stale hai, to yahin background me runSync chala dete hain.
let syncInFlight: Promise<number> | null = null;
function triggerSync(env: Env): Promise<number> {
  if (!syncInFlight) {
    syncInFlight = runSync(env)
      .catch(async (e) => {
        const msg = "lazy sync failed: " + String(e).slice(0, 300);
        console.error(msg);
        // Error D1 me bhi likho \u2014 wrangler tail ke bina dekh sakte ho ki sync kyu fail hua.
        try {
          await env.DB.prepare(
            "INSERT INTO sync_state (key,value) VALUES ('lastSyncError',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).bind(msg);
        } catch { /* ignore */ }
        return 0;
      })
      .finally(() => { syncInFlight = null; });
  }
  return syncInFlight;
}

const SYNC_STALE_MS = 5 * 60 * 1000;
async function isSyncStale(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key='lastSyncAt'").first<any>();
    const t = Date.parse(String(row?.value || ""));
    return !Number.isFinite(t) || Date.now() - t > SYNC_STALE_MS;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- app routes


const app = new Hono<{ Bindings: Env }>();

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="48" fill="#0d1117"/>
  <path d="M64 160 L128 72 L192 160 Z" fill="#1f6feb"/>
  <path d="M88 160 L128 104 L168 160 Z" fill="#58a6ff"/>
  <rect x="92" y="164" width="72" height="14" rx="7" fill="#58a6ff"/>
</svg>`;

app.get("/", (c) => c.json({ ok: true, name: "The Gate", time: new Date().toISOString() }));

app.get("/health", async (c) => {
  try {
    await ensureSchema(c.env.DB);
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM media_items WHERE is_active=1").first<any>();
    const lastSync = await c.env.DB.prepare("SELECT value FROM sync_state WHERE key='lastSyncAt'").first<any>();
    const errRow = await c.env.DB.prepare("SELECT value FROM sync_state WHERE key='lastSyncErrors'").first<any>();
    let errors: string[] = [];
    try { errors = JSON.parse(errRow?.value || "[]"); } catch { /* ignore */ }
    return c.json({ ok: true, activeItems: row?.n ?? 0, lastSync: lastSync?.value ?? null, errors });
  } catch (e) {
    return c.json({ ok: false, error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

app.get("/debug/sync", async (c) => {
  // Read-only diagnostics: last cron run ka status + per-upload errors.
  try {
    const st = await c.env.DB.prepare("SELECT key, value FROM sync_state WHERE key IN ('lastSyncAt','lastSyncCount','lastSyncErrors','lastSyncError')").all<any>();
    const map: Record<string, string> = {};
    for (const r of st.results || []) map[String(r.key)] = String(r.value);
    let errors: string[] = [];
    try { errors = JSON.parse(map.lastSyncErrors || "[]"); } catch { /* ignore */ }
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM media_items WHERE is_active=1").first<any>();
    return c.json({
      ok: true,
      activeItems: n?.n ?? 0,
      lastSync: map.lastSyncAt ?? null,
      lastSyncCount: map.lastSyncCount ?? null,
      lastSyncError: map.lastSyncError ?? null,
      errors,
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

app.get("/debug/db", async (c) => {
  try {
    const schemaErrors = await ensureSchema(c.env.DB);
    const tables = await c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<any>();
    const cols = await c.env.DB.prepare("PRAGMA table_info(media_items)").all<any>();
    return c.json({
      tables: tables.results.map((r: any) => r.name),
      mediaColumns: cols.results.map((r: any) => r.name),
      schemaErrors,
    });
  } catch (e) {
    return c.json({ ok: false, error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

app.get("/logo.svg", (c) => {
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(LOGO);
});

app.get("/api/catalog", async (c) => {
  try {
    await ensureSchema(c.env.DB);
    const type = c.req.query("type") as MediaType | undefined;
    const category = c.req.query("category");
    const q = c.req.query("q");
    let sql = "SELECT * FROM media_items WHERE is_active=1";
    const params: unknown[] = [];
    if (type) { sql += " AND type=?"; params.push(type); }
    if (category === "anime" || category === "tv") { sql += " AND category=?"; params.push(category); }
    if (q && q.trim()) { sql += " AND (title LIKE ? OR CAST(tmdb_id AS TEXT)=?)"; params.push(`%${q.trim()}%`, q.trim()); }
    sql += " ORDER BY updated_at DESC, id DESC LIMIT 500";
    const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>();
    return c.json({ items: results });
  } catch (e) {
    return c.json({ error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

app.get("/api/stream/:id", async (c) => {
  await ensureSchema(c.env.DB);
  const id = c.req.param("id") ?? "";
  const { results } = await c.env.DB.prepare("SELECT * FROM media_items WHERE is_active=1 AND (CAST(tmdb_id AS TEXT)=? OR title LIKE ?) LIMIT 1")
    .bind(id, `%${id}%`).all<any>();
  const item = results[0];
  if (!item) return c.json({ streams: [] });
  const streams: any[] = [];
  for (const host of Object.keys(HOST_FIELD)) {
    if (HIDDEN_HOSTS.has(host)) continue; // native playback impossible \u2014 hidden per owner decision
    const url = item[HOST_FIELD[host]];
    if (!url) continue;
    const playUrl = host === "streamtape" ? toStreamtapeProxy(new URL(c.req.url).origin, url) : url;
    streams.push({
      name: `The Gate \u00B7 ${HOST_LABEL[host]}`, title: item.title, host,
      url: playUrl, webview: false,
      behaviorHints: { proxyHeaders: { request: headersForHost(c.env, host) } },
    });
  }
  return c.json({ streams });
});

app.get("/manifest.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    id: c.env.ADDON_ID || "the.gate",
    version: c.env.ADDON_VERSION || "1.0.2",
    name: c.env.ADDON_NAME || "The Gate",
    description: c.env.ADDON_DESCRIPTION || "Your private Nuvio catalog",
    logo: `${origin}/logo.svg`,
    background: `${origin}/logo.svg`,
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "movies", name: "The Gate Movies", extraSupported: ["search"] },
      { type: "series", id: "series", name: "The Gate Series", extraSupported: ["search"] },
      { type: "series", id: "anime", name: "The Gate Anime", extraSupported: ["search"] },
      { type: "series", id: "tv", name: "The Gate TV", extraSupported: ["search"] },
    ],
    behaviorHints: { adult: false, p2p: false },
  });
});

app.get("/catalog/:type/:id.json", async (c) => {
  // catalog: stale sync BACKGROUND me chala kar turant fresh list serve karo.
  // (Sync ka wait karne se app ka 5s meta timeout miss ho jata tha.)
  if (await isSyncStale(c.env)) {
    c.executionCtx.waitUntil(triggerSync(c.env));
  }
  await ensureSchema(c.env.DB);
  const type = c.req.param("type") as MediaType;
  // NOTE: Hono `:id.json` param ka naam "id.json" hota hai — path se parse karo.
  const id = c.req.path.match(/\/catalog\/(?:movie|series)\/([A-Za-z0-9_-]+)\.json$/)?.[1] ?? "series";
  const q = c.req.query("q");
  let sql = "SELECT * FROM media_items WHERE is_active=1 AND type=?";
  const params: unknown[] = [type];
  // Catalog id = category filter: "anime" / "tv" (movie type apne aap movie hai)
  if (id === "anime" || id === "tv") {
    sql += " AND category=?";
    params.push(id);
  }
  if (q && q.trim()) { sql += " AND (title LIKE ? OR CAST(tmdb_id AS TEXT)=?)"; params.push(`%${q.trim()}%`, q.trim()); }
  sql += " ORDER BY updated_at DESC, id DESC LIMIT 500";
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>();
  // One card per title: episode rows share the same tmdb_id, so dedupe.
  const seen = new Set<string>();
  return c.json({
    metas: results.filter((item: any) => {
      const key = `${item.tmdb_id}:${item.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((item: any) => {
      const cat = item.category || (item.type === "movie" ? "movie" : "tv");
      const label = cat === "anime" ? "Anime" : cat === "movie" ? "Movie" : "Series";
      return {
        id: `tmdb:${item.tmdb_id}`, type: item.type, name: item.title,
        poster: item.poster, posterShape: "poster", background: item.backdrop,
        description: item.overview || item.title,
        releaseInfo: label,
        category: cat,
      };
    }),
  });
});

app.get("/meta/:type/:id.json", async (c) => {
  try {
    await ensureSchema(c.env.DB);
    // Episode list bhi stale ho sakti hai (naya upload) \u2014 stale sync chala kar
    // turant fresh episode list serve karo (catalog jaisa).
    if (await isSyncStale(c.env)) {
      c.executionCtx.waitUntil(triggerSync(c.env));
    }
    // NOTE: Hono names a param with a suffix (":id.json") literally "id.json",
    // so c.req.param("id") is undefined. Parse the id from the raw path.
    const pm = c.req.path.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    const m = pm ? decodeURIComponent(pm[2] ?? "").match(/^(?:tmdb:)?(\d+)$/) : null;
    if (!pm || !m) return c.json({ meta: null });
    const type = pm[1] as MediaType;
    const tmdbId = parseInt(m[1], 10);
    const { results: rows } = await c.env.DB.prepare("SELECT * FROM media_items WHERE tmdb_id=? AND type=? ORDER BY season, episode")
      .bind(tmdbId, type).all<any>();
    if (rows.length === 0) return c.json({ meta: null });
    const item = rows[0];
    const videos = type === "series"
      ? rows.filter((r: any) => r.season != null && r.episode != null).map((r: any) => ({
          id: `tmdb:${r.tmdb_id}:S${r.season}E${r.episode}`,
          title: `${item.title} S${r.season}E${r.episode}`,
          season: r.season, episode: r.episode,
        }))
      : [];
    return c.json({
      meta: {
        id: `tmdb:${item.tmdb_id}`, type: item.type, name: item.title,
        poster: item.poster, background: item.backdrop, description: item.overview || item.title,
        genres: [], videos,
      },
    });
  } catch (e) {
    return c.json({ error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

app.get("/stream/:type/:id.json", async (c) => {
  // stream: stale sync background me chala do (next request fresh hoga)
  if (await isSyncStale(c.env)) {
    c.executionCtx.waitUntil(triggerSync(c.env));
  }
  try {
    await ensureSchema(c.env.DB);
    // NOTE: Hono names the param "id.json" \u2014 parse the id from the raw path.
    const pm = c.req.path.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    const raw = pm ? decodeURIComponent(pm[2] ?? "") : "";
    // Episode ids come in three shapes:
    //   324502:S01E07 | tmdb:324502:S1E7  (Stremio / addon style)
    //   tmdb:324502:1:7                  (app internal style)
    const m = raw.match(/^(?:tmdb:)?(\d+)(?::(?:[Ss](\d+)[Ee](\d+)|(\d+):(\d+)))?$/);
    if (!pm || !m) return c.json({ streams: [] });
    const type = pm[1] as MediaType;
    const tmdbId = parseInt(m[1], 10);
    const season = m[2] != null ? parseInt(m[2], 10) : m[4] != null ? parseInt(m[4], 10) : null;
    const episode = m[3] != null ? parseInt(m[3], 10) : m[5] != null ? parseInt(m[5], 10) : null;

    const { results: rows } = await c.env.DB.prepare("SELECT * FROM media_items WHERE tmdb_id=? AND type=? ORDER BY season, episode")
      .bind(tmdbId, type).all<any>();

    // Filter requested episode rows in JS (robust against null binding quirks).
    let matches = season != null && episode != null
      ? rows.filter((r: any) => Number(r.season) === season && Number(r.episode) === episode)
      : rows.filter((r: any) => r.season == null && r.episode == null);
    // Bare series id \u2192 fall back to every episode's streams.
    if (matches.length === 0 && season == null && episode == null) {
      matches = rows;
    }

    const streams: any[] = [];
    for (const item of matches) {
      for (const host of Object.keys(HOST_FIELD)) {
        if (HIDDEN_HOSTS.has(host)) continue; // native playback impossible \u2014 hidden per owner decision
        const url = item[HOST_FIELD[host]];
        if (!url) continue;
        // abyss/byse \u2192 hidden (encrypted embeds, koi direct m3u8/mp4 nahi).
        // streamtape/mixdrop \u2192 embed URL + webview flag; app device-side resolve
        //   karti hai (residential IP) \u2192 direct link \u2192 native player.
        //   (Cloudflare edge se 403/blocked \u2014 /proxy/st & /proxy/mx dono dead, verified.)
        let useWebview = host === "abyss";
        let finalUrl = url;
        if (host === "abyss") {
          const abRef = url.match(/(?:abyssplayer\.com|abyss\.to)\/(?:v\/)?([A-Za-z0-9_-]+)/i)?.[1];
          if (abRef) finalUrl = new URL(c.req.url).origin + "/abyss/" + abRef;
          useWebview = true;
        }
        if (host === "streamtape") {
          // Stored direct mp4 (a-delivery*.mxcontent.net/v2/<ref>.mp4) expire hota hai \u2014
          // ref recover karke mxdrop embed banao; app device-side resolve karti hai.
          // Embed URL milne par bhi app device-side resolve karti hai \u2014 Cloudflare edge
          // IPs streamtape/mxdrop dono ke liye 403/blocked hain (verified 2026-11-10).
          const mxRef = url.match(/\/v2\/([A-Za-z0-9]+)\.mp4/i)?.[1];
          finalUrl = mxRef ? ("https://mxdrop.click/e/" + mxRef) : url;
          useWebview = true;
        }
        if (host === "mixdrop") {
          const ref = url.match(/\/(?:e|f|v)\/([A-Za-z0-9]+)/i)?.[1]
            ?? url.match(/\/v2\/([A-Za-z0-9]+)\.mp4/i)?.[1]
            ?? url.match(/(?:mixdrop|mxdrop)[^/]*\/e\/([A-Za-z0-9]+)/i)?.[1];
          if (ref) finalUrl = "https://mxdrop.click/e/" + ref;
          useWebview = true;
        }
        if (host === "earnvids") {
          // EarnVids: fresh direct_link \u2192 HLS master.m3u8 \u2192 NATIVE player (ExoPlayer/MPVKit),
          // zero ads, koi WebView nahi. HLS cross-IP playable hai (verified 2026-11-10:
          // manifest 200 + segment 206 foreign-IP generated link se bhi).
          const evId = url.match(/\/file\/([A-Za-z0-9]+)/i)?.[1]
            ?? url.match(/\/v\/([A-Za-z0-9]+)/i)?.[1]
            ?? url.match(/file_code=([A-Za-z0-9]+)/i)?.[1];
          if (evId) {
            const clientIp = c.req.header("CF-Connecting-IP")
              || (c.req.header("X-Forwarded-For") || "").split(",")[0].trim();
            const m3u8 = await earnvidsDirectLink(c.env, evId, clientIp).catch(() => null);
            if (m3u8) {
              finalUrl = m3u8;
              useWebview = false;
            } else {
              // API se link nahi mila \u2192 player page fallback (WebView + capture).
              finalUrl = "https://morencius.com/file/" + evId;
              useWebview = true;
            }
          }
        }
        if (host === "ufoload") {
          // UFOload: fresh POST /files/{id}/links \u2192 direct HLS (master.m3u8).
          // Ye NATIVE player (ExoPlayer/MPVKit) chala sakta hai \u2014 webview false!
          const ufId = url.match(/\/api\/v1\/files\/([A-Za-z0-9]+)/)?.[1];
          if (ufId) {
            const key = c.env.UFOLOAD_API_KEY || c.env.UFOLOAD_KEY;
            if (key) {
              try {
                // /links endpoint POST hai \u2014 direct fetch (fetchJson GET-only hai).
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 15000);
                let playback: string | undefined;
                try {
                  const links = await fetch("https://ufoload.com/api/v1/files/" + ufId + "/links", {
                    method: "POST",
                    signal: ctrl.signal,
                    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
                  });
                  if (links.ok) {
                    const j: any = await links.json().catch(() => null);
                    playback = typeof j?.playback === "string" ? j.playback : undefined;
                  }
                } finally {
                  clearTimeout(timer);
                }
                if (playback && /^https?:\/\//.test(playback)) {
                  finalUrl = playback;
                  useWebview = false;
                }
              } catch { /* fallback page */ }
            }
          }
          if (useWebview) {
            finalUrl = "https://ufoload.com/e/" + (url.match(/\/api\/v1\/files\/([A-Za-z0-9]+)/)?.[1] ?? "");
          }
        }
        if (host === "byse") {
          // Byse embed player (HTML5) \u2014 device ka apna IP direct load karta hai; ABYSS jaisa iframe-gate nahi.
          // IMPORTANT: main domain (byse.sx/api.byse.sx) par player BLOCKED hai \u2014
          // assigned embed domain (get/domain \u2192 embed_domain) chahiye.
          const byRef = url.match(/\/(?:e|f|v)\/([A-Za-z0-9]+)/i)?.[1];
          if (byRef) {
            try {
              const dom = await fetchJson("https://api.byse.sx/get/domain?key=" + encodeURIComponent(c.env.BYSE_API_KEY ?? ""));
              const nd = dom.json?.embed_domain || dom.json?.new_domain || "";
              const host = nd.replace(/^https?:\/\//, "").replace(/\/$/, "");
              if (host) {
                finalUrl = "https://" + host + "/e/" + byRef;
              } else {
                finalUrl = "https://api.byse.sx/e/" + byRef;
              }
            } catch {
              finalUrl = "https://api.byse.sx/e/" + byRef;
            }
          }
          useWebview = true;
        }
        streams.push({
          name: `The Gate \u00B7 ${HOST_LABEL[host]}`,
          title: item.season != null ? `${item.title} S${item.season}E${item.episode}` : item.title,
          host, url: finalUrl, webview: useWebview,
          behaviorHints: { proxyHeaders: { request: headersForHost(c.env, host) } },
        });
      }
    }
    // Auto-select/sort: native-direct streams (webview:false) PEHLE, embed/WebView last —
    // taaki player pehla stream choose kare to bypass buffering (embed HTML play nahi ho sakta).
    streams.sort((a: any, b: any) => ((a.webview ? 1 : 0) - (b.webview ? 1 : 0)));
    if (c.req.query("debug") != null) {
      return c.json({ streams, debug: { raw, tmdbId, type, season, episode, rows: rows.length, matches: matches.length } });
    }
    return c.json({ streams });
  } catch (e) {
    return c.json({ error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

app.get("/debug/ds/:code", async (c) => {
  const code = c.req.param("code") ?? "";
  if (!/^[A-Za-z0-9]+$/.test(code)) return c.text("bad id", 400);
  const origins = ["https://doodstream.com", "https://playmogo.com"];
  const pages: any[] = [];
  for (const origin of origins) {
    for (const p of ["/e/", "/file/", "/d/"]) {
      const pageUrl = origin + p + code;
      const res = await fetch(pageUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": userAgent(c.env),
          Referer: origin + "/",
          Origin: origin,
          Accept: "text/html,application/xhtml+xml,*/*",
        },
      });
      const text = await res.text().catch(() => "");
      const scripts = res.ok ? (text.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []) : [];
      let found = "";
      let decodedSample = "";
      for (const s of scripts) {
        const d = unpackPackedJs(s);
        if (!d) continue;
        if (!decodedSample) decodedSample = d.slice(0, 180);
        const m = d.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/i);
        if (m) { found = m[0]; break; }
      }
      pages.push({
        pageUrl, ok: res.ok, status: res.status,
        location: res.headers.get("location") || "",
        ctype: res.headers.get("content-type") || "",
        size: (text || "").length, scripts: scripts.length,
        found, decodedSample, head: (text || "").slice(0, 120),
      });
    }
  }
  return c.json({ code, pages });
});

app.get("/debug/st/:embedId", async (c) => {
  const embedId = c.req.param("embedId") ?? "";
  try {
    const r = await fetchText("https://streamtape.com/e/" + embedId + "/", { Referer: "https://streamtape.com/" });
    return c.json({
      status: r.status,
      len: r.text.length,
      robotAssign: (r.text.match(/robotlink/g) || []).length,
      getVideo: (r.text.match(/get_video/g) || []).length,
      hasSubstringChain: /getElementById\(['"]robotlink/.test(r.text),
      head: r.text.slice(0, 200),
    });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.get("/debug/mxfolders", async (c) => {
  if (!c.env.MIXDROP_EMAIL || !c.env.MIXDROP_KEY) return c.json({ error: "creds missing", email: c.env.MIXDROP_EMAIL ?? null, key: c.env.MIXDROP_KEY ? "set" : null });
  try {
    const E = encodeURIComponent(c.env.MIXDROP_EMAIL);
    const K = encodeURIComponent(c.env.MIXDROP_KEY);
    const res = await fetch("https://api.mixdrop.ag/folderlist?email=" + E + "&key=" + K + "&id=0&page=1");
    const text = await res.text();
    return c.json({ status: res.status, body: text.slice(0, 400) });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// DISCOVERY DIAG: har host ki live listing loop \u2014 kaunsi files catalog me NAHII hain.
// Ye batata hai ki naya upload kahan phans raha hai.
app.get("/debug/discovery", async (c) => {
  await ensureSchema(c.env.DB);
  try {
    const mdCache = new Map<string, number>();
    try {
      const cacheRows = await c.env.DB.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'mdfolder:%'").all<any>();
      for (const r of (cacheRows.results || [])) mdCache.set(r.key, parseInt(r.value, 10) || 0);
    } catch { /* ignore */ }
    const all: any[] = [
      ...(await listStreamtape(c.env)),
      ...(await listMixdropUploads(c.env, c.env.DB, mdCache)),
      ...(await listAbyssUploads(c.env)),
      ...(await listByseUploads(c.env)),
      ...(await listUfoloadUploads(c.env)),
      ...(await listEarnvidsUploads(c.env)),
      ...(await listDoodstreamUploads(c.env)),
      ...parseUploadsJson(c.env),
    ];
    // Existing rows me URL columns (host-specific) \u2014 upload ki pageUrl/embed inme match karna chahiye.
    // Embed host spelling rotate hoti hai (mixdrop.top vs mxdrop.click) \u2014 compare
    // file ref se, warna same file "missing" report hoti hai.
    const norm = (u: string) => {
      const m = u.match(/\/(?:e|f|v|file)\/([A-Za-z0-9]+)/i) || u.match(/\/v2\/([A-Za-z0-9]+)\.mp4/i);
      return m ? "ref:" + m[1] : u.replace(/\/$/, "");
    };
    const existingUrls = new Set<string>();
    try {
      const rows = await c.env.DB.prepare(
        "SELECT streamtape_url, vidmoly_url, mixdrop_url, ufoload_url, abyss_url, byse_url, earnvids_url FROM media_items WHERE is_active=1",
      ).all<any>();
      for (const r of (rows.results || [])) {
        for (const k of ["streamtape_url", "vidmoly_url", "mixdrop_url", "ufoload_url", "abyss_url", "byse_url", "earnvids_url"]) {
          if (r[k]) existingUrls.add(norm(String(r[k])));
        }
      }
    } catch { /* ignore */ }
    const missing = all.filter((u: any) => {
      if (!u.pageUrl) return false;
      return !existingUrls.has(norm(String(u.pageUrl)));
    }).map((u: any) => ({
      host: u.host, id: u.id, file: String(u.fileName || "").slice(0, 70), page: (u.pageUrl || "").slice(0, 60),
    }));
    // Poora upload list bhi do (debug ke liye) \u2014 kaun sa file catalog me hai.
    const uploads = all.map((u: any) => ({
      host: u.host,
      file: String(u.fileName || "").slice(0, 70),
      page: (u.pageUrl || "").slice(0, 70),
      inCatalog: existingUrls.has(norm(String(u.pageUrl || ""))),
    }));
    return c.json({ total: all.length, inCatalog: all.length - missing.length, missing, uploads });
  } catch (e) {
    return c.json({ error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

// ------------------------------------------- signed HLS proxy (geo-block bypass)

/** HMAC sign (worker open proxy nahi banega — sirf apne signed URLs serve honge). */
async function hlsSign(env: Env, url: string): Promise<string> {
  const secret = env.SYNC_KEY || "the-gate";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Playlist ke andar ke har reference ko signed proxy URL se replace karo. */
async function hlsRewrite(env: Env, playlist: string, baseUrl: string, code: string): Promise<string> {
  const origin = new URL(baseUrl).origin;
  const out: string[] = [];
  for (const rawLine of playlist.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      out.push(rawLine);
      continue;
    }
    let abs: string;
    try {
      abs = new URL(line, baseUrl).toString();
    } catch {
      out.push(rawLine);
      continue;
    }
    const sig = await hlsSign(env, abs);
    out.push(`${origin}/proxy/ds/${code}?u=${encodeURIComponent(abs)}&s=${sig}`);
  }
  return out.join("\n");
}

/**
 * DoodStream HLS proxy — device ko doodstream.com / CDN tak touch hi nahi karna padta
 * (India me doodstream.com block hai) + worker se bytes pipe hote hain (zero ads).
 */
app.get("/proxy/ds/:code", async (c) => {
  const code = c.req.param("code") ?? "";
  if (!/^[A-Za-z0-9]+$/.test(code)) return c.text("bad id", 400);
  const target = c.req.query("u") || "";
  const clientIp = c.req.header("CF-Connecting-IP")
    || (c.req.header("X-Forwarded-For") || "").split(",")[0].trim();
  let url = target;
  if (!url) {
    const m3u8 = await doodstreamDirectLink(c.env, code, clientIp).catch(() => null);
    if (!m3u8) return c.text("resolve failed", 502);
    url = m3u8;
  } else {
    const sig = c.req.query("s") || "";
    if (sig !== (await hlsSign(c.env, url))) return c.text("bad signature", 403);
  }
  const range = c.req.header("Range");
  const upstream = await fetch(url, {
    headers: {
      "User-Agent": userAgent(c.env),
      Referer: "https://doodstream.com/",
      Accept: "*/*",
      ...(range ? { Range: range } : {}),
    },
  });
  if (!upstream.ok && upstream.status !== 206) {
    return new Response("upstream " + upstream.status, { status: 502 });
  }
  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("mpegurl")) {
    const text = await upstream.text();
    return new Response(await hlsRewrite(c.env, text, url, code), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ------------------------------------------------------- streamtape proxy
// Streamtape links are IP-locked to whoever resolved them. The player hits
// THIS route instead: we resolve a fresh link (server IP) and stream the
// video through with Range support, so playback works on any device.
app.get("/proxy/st/:embedId", async (c) => {
  const embedId = c.req.param("embedId") ?? "";
  if (!/^[A-Za-z0-9]+$/.test(embedId)) return c.text("bad id", 400);
  let direct: string | null = null;
  let stCookies = "";
  try {
    const jar = { value: "" };
    direct = await extractStreamtape("https://streamtape.com/e/" + embedId + "/", undefined, jar);
    stCookies = jar.value;
  } catch {
    direct = null;
  }
  if (!direct) return c.text("resolve failed", 502);
  const range = c.req.header("Range");
  const upstream = await fetch(direct, {
    redirect: "follow",
    headers: {
      ...(range ? { Range: range } : {}),
      ...(stCookies ? { Cookie: stCookies } : {}),
      Referer: "https://streamtape.com/",
      Origin: "https://streamtape.com",
      "User-Agent": userAgent(c.env),
      Accept: "*/*",
    },
  });
  if (!upstream.ok && upstream.status !== 206) {
    return c.text("upstream " + upstream.status, 502);
  }
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "video/mp4");
  return new Response(upstream.body, { status: upstream.status, headers });
});

// Abyss player page ko worker se PROXY karke serve karte hain:
// 1) Player ka JS top-level load par window.location = "https://abyss.to" redirect karta hai \u2014 strip.
// 2) JWPlayer advertising config strip (WebView me ad-block hai, VAST ad fail hone par video bhi stuck hota hai).
// Baaki player JS (jwplayer iamcdn se, sources AJAX) device par hi chalega.
app.get("/abyss/:fileId", async (c) => {
  const fileId = c.req.param("fileId") ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return c.text("bad id", 400);
  try {
    const { ok, text } = await fetchText("https://player.abyssplayer.com/" + fileId, {
      "User-Agent": userAgent(c.env),
      Referer: new URL(c.req.url).origin + "/",
    });
    if (!ok) return c.text("player fetch " + ok, 502);
    let html = text;
    // Homepage redirect strip \u2014 dono quote variants.
    html = html.replace(/window\.location\s*=\s*["']https:\/\/abyss\.to["'];?/gi, ";");
    // JWPlayer advertising config strip (block-scoped, greedy-safe for one nested level).
    html = html.replace(/advertising\s*:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*,?/i, "");
    // Popup-ad flow bypass \u2014 Abyss randomized JS variants serve karta hai (variable names rotate),
    // isliye name-INDEPENDENT patch: body ke end me apna script inject karo jo overlay handlers
    // overwrite kare \u2014 single tap \u2192 overlay remove \u2192 jwplayer().play() (original flow 2 popup-ad
    // taps maangta hai jo WebView me fail hote hain).
    html = html.replace(/<\/body>/i, `<script>(function(){function rdy(){var o=document.getElementById('overlay');if(!o){setTimeout(rdy,300);return;}var h=function(){o.onclick=null;o.ontouchend=null;try{o.remove();}catch(e){}try{var ts=typeof isTouchScreen!=='undefined'?isTouchScreen:false;if(typeof jwplayer!=='undefined'&&typeof jwplayer().play==='function'&&!ts){jwplayer().play();}}catch(e){}};o.onclick=h;o.ontouchend=h;}rdy();})();</script></body>`);
    return c.html(html);
  } catch (e) {
    return c.text(String(e), 502);
  }
});

// MixDrop links bhi IP-locked hote hain \u2014 proxy fresh wurl (server IP) nikal ke video stream karta hai.
app.get("/proxy/mx/:fileRef", async (c) => {
  const fileRef = c.req.param("fileRef") ?? "";
  if (!/^[A-Za-z0-9]+$/.test(fileRef)) return c.text("bad id", 400);
  let direct: string | null = null;
  const jar = { value: "" };
  try {
    direct = await extractMixdrop("https://mxdrop.click/e/" + fileRef, undefined, jar);
  } catch {
    direct = null;
  }
  if (!direct) return c.text("resolve failed", 502);
  const range = c.req.header("Range");
  const upstream = await fetch(direct, {
    redirect: "follow",
    headers: {
      ...(range ? { Range: range } : {}),
      ...(jar.value ? { Cookie: jar.value } : {}),
      Referer: "https://mxdrop.click/",
      Origin: "https://mxdrop.click",
      "User-Agent": userAgent(c.env),
      Accept: "*/*",
    },
  });
  if (!upstream.ok && upstream.status !== 206) {
    return c.text("upstream " + upstream.status, 502);
  }
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "video/mp4");
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ------------------------------------------------------- watchlist /add (phone-friendly)

// ------------------------------------------------------ add: movies/anime/series

async function tmdbDetail(env: Env, mediaType: "movie" | "tv", id: number) {
  const key = env.TMDB_API_KEY;
  if (!key) return null;
  const { ok, json } = await fetchJsonRetry(
    `https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${key}&language=en-US`,
  );
  if (!ok || !json) return null;
  return {
    tmdbId: id,
    type: (mediaType === "movie" ? "movie" : "series") as MediaType,
    title: String(json.title ?? json.name ?? "Unknown"),
    poster: json.poster_path ? `https://image.tmdb.org/t/p/w500${json.poster_path}` : "",
    backdrop: json.backdrop_path ? `https://image.tmdb.org/t/w1280${json.backdrop_path}` : "",
    overview: String(json.overview ?? ""),
    rating: typeof json.vote_average === "number" ? json.vote_average : 0,
  };
}

async function tmdbSearch(env: Env, query: string, mediaType: "movie" | "tv") {
  const key = env.TMDB_API_KEY;
  if (!key || !query) return null;
  const { ok, json } = await fetchJsonRetry(
    `https://api.themoviedb.org/3/search/${mediaType}?api_key=${key}&query=${encodeURIComponent(query)}&language=en-US`,
  );
  if (!ok || !json) return null;
  for (const r of json.results || []) {
    const title = String(r.title ?? r.name ?? "");
    if (!title) continue;
    return {
      tmdbId: Number(r.id),
      type: (mediaType === "movie" ? "movie" : "series") as MediaType,
      title,
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : "",
      backdrop: r.backdrop_path ? `https://image.tmdb.org/t/w1280${r.backdrop_path}` : "",
      overview: String(r.overview ?? ""),
      rating: typeof r.vote_average === "number" ? r.vote_average : 0,
    };
  }
  return null;
}

/** TMDB id ya title se match (type hint ke saath). */
async function resolveAddMatch(
  env: Env,
  tmdbId: number | null,
  title: string,
  typeHint: string,
): Promise<any | null> {
  if (tmdbId) {
    const order: ("movie" | "tv")[] =
      typeHint === "movie" ? ["movie", "tv"] : typeHint === "series" ? ["tv", "movie"] : ["movie", "tv"];
    for (const t of order) {
      const d = await tmdbDetail(env, t, tmdbId);
      if (d) return d;
    }
    return null;
  }
  const clean = title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(480p|720p|1080p|2160p|4k|WEB-?DL|WEBRip|BluRay|x26[45]|HEVC|AAC\s?2\s?0|Multi\s?Audio|ESub|ESubs|Dubbed|HindiDub)\b/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = clean.split(/\s+[-\u201D\u2014]\s+/).map((x) => x.trim()).filter(Boolean);
  const candidates = [...new Set([clean, ...parts])].filter(Boolean).slice(0, 3);
  const types: ("movie" | "tv")[] =
    typeHint === "movie" ? ["movie", "tv"] : typeHint === "series" ? ["tv", "movie"] : ["movie", "tv"];
  for (const cand of candidates) {
    for (const t of types) {
      const m = await tmdbSearch(env, cand, t);
      if (m) return m;
    }
  }
  return null;
}

/** Title ko catalog me register karo (card turant dikhe; file baad me bhi aa sakti hai). */
async function registerTitle(
  env: Env,
  match: any,
  season: number | null,
  episode: number | null,
): Promise<string> {
  const id = `${match.tmdbId}:${match.type}:${season ?? 0}:${episode ?? 0}`;
  await env.DB.prepare(
    `INSERT INTO media_items (id, tmdb_id, type, title, poster, backdrop, overview, rating, season, episode, is_title_only, is_active, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,1,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, poster=excluded.poster, backdrop=excluded.backdrop,
       overview=excluded.overview, rating=excluded.rating, is_title_only=1, is_active=1, updated_at=datetime('now')`,
  )
    .bind(
      id,
      match.tmdbId,
      match.type,
      match.title,
      match.poster || "",
      match.backdrop || "",
      match.overview || "",
      match.rating || 0,
      season,
      episode,
    )
    .run();
  return id;
}

app.get("/add/preview", async (c) => {
  const key = c.req.query("key");
  if (!c.env.SYNC_KEY || key !== c.env.SYNC_KEY) return c.json({ error: "unauthorized" }, 401);
  const tmdbId = Number(c.req.query("tmdb") || 0) || null;
  const title = (c.req.query("title") || "").trim();
  const typeHint = (c.req.query("type") || "auto").trim();
  if (!tmdbId && !title) return c.json({ ok: false, error: "TMDB id ya title chahiye" });
  const match = await resolveAddMatch(c.env, tmdbId, title, typeHint);
  if (!match) {
    return c.json({ ok: false, error: "TMDB par match nahi mila - title spelling check karo" });
  }
  return c.json({ ok: true, match });
});

// STREAMTAPE BROWSER-BRIDGE: logged-in browser (streamtape.com session) se scrape
// karke yahan push karo — { items: [{url, fileName}] }. Watchlist me upsert, agli
// sync me catalog me aa jayenge. Website API session/CSRF-based hai (API-key se
// folders nahi milte), isliye ye bridge hi full-auto path hai.
app.post("/ingest/st", async (c) => {
  const key = c.req.query("key");
  if (!c.env.SYNC_KEY || key !== c.env.SYNC_KEY) return c.json({ ok: false, error: "unauthorized" }, 401);
  try {
    const body = await c.req.json().catch(() => null);
    const items: any[] = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return c.json({ ok: false, error: "items khali hai" }, 400);
    await ensureSchema(c.env.DB);
    const stmts = c.env.DB.prepare(
      `INSERT INTO watchlist (url, host, file_name, media_type, tmdb_id) VALUES (?,?,?,?,?)
       ON CONFLICT(url) DO UPDATE SET file_name=excluded.file_name`,
    );
    const batch: any[] = [];
    let added = 0;
    for (const it of items) {
      const url = String(it.url || "").trim();
      const fileName = String(it.fileName || "").trim();
      if (!url || !fileName || !/streamtape\.com\/(?:e|v)\/[A-Za-z0-9]+/i.test(url)) continue;
      const mediaType = /[Ss]\d{1,2}[._\- ]?[Ee]\d{1,3}/.test(fileName) ? "series" : "movie";
      batch.push(stmts.bind(url, "streamtape", fileName, mediaType, 0));
      added++;
    }
    if (batch.length) await c.env.DB.batch(batch);
    return c.json({ ok: true, added, total: items.length });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

app.get("/add/list", async (c) => {
  const key = c.req.query("key");
  if (!c.env.SYNC_KEY || key !== c.env.SYNC_KEY) return c.json({ error: "unauthorized" }, 401);
  await ensureSchema(c.env.DB);
  const rows = await c.env.DB.prepare(
    `SELECT w.url, w.host, w.file_name, w.media_type, w.tmdb_id, w.added_at,
            m.title AS media_title, m.tmdb_id AS media_tmdb, m.is_active,
            (CASE WHEN COALESCE(m.streamtape_url,'') <> '' OR COALESCE(m.vidmoly_url,'') <> ''
                OR COALESCE(m.mixdrop_url,'') <> '' OR COALESCE(m.ufoload_url,'') <> ''
                OR COALESCE(m.earnvids_url,'') <> '' THEN 1 ELSE 0 END) AS has_streams
       FROM watchlist w LEFT JOIN media_items m
         ON m.tmdb_id = w.tmdb_id
        AND m.type = CASE WHEN w.media_type='movie' THEN 'movie' ELSE 'series' END
      ORDER BY w.added_at DESC LIMIT 25`,
  ).all<any>();
  return c.json({ ok: true, items: rows.results || [] });
});

app.get("/add", async (c) => {
  const key = c.req.query("key");
  const authorized = !!c.env.SYNC_KEY && key === c.env.SYNC_KEY;
  const action = c.req.query("do") || "";
  const tmdbId = Number(c.req.query("tmdb") || 0) || null;
  const title = (c.req.query("title") || "").trim();
  const typeHint = (c.req.query("type") || "auto").trim();
  const epRaw = (c.req.query("ep") || "").trim();
  const url = (c.req.query("url") || "").trim();
  const nameOverride = (c.req.query("name") || "").trim();

  const style = `body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;line-height:1.5}
    h1{font-size:1.35em;color:#58a6ff;margin-bottom:4px} h2{font-size:1.05em;color:#e6edf3;margin:22px 0 6px}
    label{display:block;font-size:.82em;color:#8b949e;margin:12px 0 4px}
    input,select,button{width:100%;padding:13px;margin:4px 0;border-radius:10px;border:1px solid #30363d;box-sizing:border-box;font-size:1em}
    input,select{background:#161b22;color:#e6edf3} input:focus,select:focus{outline:2px solid #1f6feb}
    button{background:#1f6feb;color:#fff;border:none;font-weight:600;cursor:pointer} button:active{background:#388bfd}
    .hint{font-size:.82em;color:#8b949e;margin:6px 0 0} .ok{color:#3fb950;font-weight:700} .err{color:#f85149}
    .card{display:flex;gap:12px;align-items:center;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:12px;margin:8px 0}
    .card img{width:56px;height:84px;object-fit:cover;border-radius:6px;background:#0d1117}
    .row{display:flex;justify-content:space-between;gap:10px;font-size:.85em;color:#8b949e;margin-top:6px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72em;border:1px solid #30363d}
    .pill.ok{color:#3fb950;border-color:#238636} .pill.wait{color:#d29922;border-color:#9e6a03}
    a{color:#58a6ff}`;

  if (action === "add") {
    if (!authorized) return c.text("unauthorized - sahi key daalo", 401);
    if (!tmdbId && !title) return c.text("TMDB id ya title chahiye", 400);
    const match = await resolveAddMatch(c.env, tmdbId, title, typeHint);
    if (!match) {
      return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Add failed</title><style>${style}</style></head><body><h1>Match nahi mila</h1><p class="err">TMDB par "${escapeHtml(title || String(tmdbId))}" nahi mila. Title spelling ya TMDB id check karo.</p><p><a href="/add?key=${encodeURIComponent(key || "")}">&#8592; Wapas</a></p></body></html>`);
    }
    let season: number | null = null;
    let episode: number | null = null;
    const epMatch = epRaw.match(/[Ss]?(\d{1,2})[Ee]?(\d{1,3})/);
    if (match.type === "series" && epMatch) {
      season = parseInt(epMatch[1], 10);
      episode = parseInt(epMatch[2], 10);
    }
    const rowId = await registerTitle(c.env, match, season, episode);

    let hostMsg = "";
    if (url) {
      const host = detectHost(url);
      if (!host) {
        hostMsg = "Link ka host pehchana nahi hua (Streamtape/Vidmoly/MixDrop/UFOload/EarnVids link daalo)";
      } else {
        const fileName = nameOverride ||
          (match.type === "movie"
            ? `tmdb_${match.tmdbId}.mp4`
            : season != null && episode != null
              ? `tmdb_${match.tmdbId}_S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}.mp4`
              : `tmdb_${match.tmdbId}.mp4`);
        await c.env.DB.prepare(
          `INSERT INTO watchlist (url, host, file_name, media_type, tmdb_id) VALUES (?,?,?,?,?)
           ON CONFLICT(url) DO UPDATE SET file_name=excluded.file_name, media_type=excluded.media_type, tmdb_id=excluded.tmdb_id`,
        ).bind(url, host, fileName, match.type, match.tmdbId).run();
        hostMsg = `${host} - ${fileName}`;
      }
    }

    let synced = 0;
    try {
      synced = await Promise.race([
        triggerSync(c.env),
        new Promise<number>((r) => setTimeout(() => r(0), 15000)),
      ]);
    } catch { /* ignore */ }

    return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Added</title><style>${style}</style></head><body>
      <h1>Add ho gaya</h1>
      <div class="card">
        ${match.poster ? `<img src="${match.poster}">` : ""}
        <div>
          <div><b>${escapeHtml(match.title)}</b></div>
          <div class="hint">TMDB ${match.tmdbId} - ${match.type} - ${rowId}</div>
          <div class="hint">${escapeHtml(hostMsg || "Link nahi diya - card abhi se dikhega, file baad me bhi aa sakti hai")}</div>
        </div>
      </div>
      <p class="hint">Sync: ${synced} item(s) processed. App me abhi dikhna chahiye (home - refresh).</p>
      <p><a href="/add?key=${encodeURIComponent(key || "")}">Aur add karo</a> - <a href="/add/list?key=${encodeURIComponent(key || "")}">List</a></p>
    </body></html>`);
  }

  return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Gate - Add</title><style>${style}</style></head><body>
    <h1>The Gate - Add</h1>
    <p class="hint">Movie / Anime / Series add karo - TMDB id ya title se match hoga.</p>
    <form method="get" action="/add" id="f">
      <input type="hidden" name="do" value="add">
      <input type="hidden" name="key" value="${escapeHtml(key || "")}">
      <label>TMDB id (optional - title se bhi chalta hai)</label>
      <input name="tmdb" inputmode="numeric" placeholder="e.g. 270603" value="${escapeHtml(String(c.req.query("tmdb") || ""))}">
      <label>Title</label>
      <input name="title" placeholder="e.g. The Strongest Magician in the Demon Lord's Army" value="${escapeHtml(title)}">
      <label>Type</label>
      <select name="type">
        <option value="auto"${typeHint === "auto" ? " selected" : ""}>Auto</option>
        <option value="movie"${typeHint === "movie" ? " selected" : ""}>Movie</option>
        <option value="series"${typeHint === "series" ? " selected" : ""}>Anime / Series</option>
      </select>
      <label>Episode (series ke liye, optional)</label>
      <input name="ep" placeholder="S01E05" value="${escapeHtml(epRaw)}">
      <label>Embed link (optional - file register karne ke liye)</label>
      <input name="url" placeholder="https://streamtape.com/e/XXXX" value="${escapeHtml(url)}">
      <button type="button" id="pv">Preview (TMDB match)</button>
      <button type="submit">Add &amp; Sync Now</button>
      <div id="pvOut" class="hint"></div>
    </form>
    <h2>Recent adds</h2>
    <div id="list" class="hint">loading...</div>
    <p class="hint" style="margin-top:20px"><a href="/add/list?key=${encodeURIComponent(key || "")}">JSON list</a> - <a href="/">Home</a></p>
    <script>
      const key = ${JSON.stringify(key || "")};
      const q = () => new URLSearchParams(new FormData(document.getElementById('f'))).toString();
      document.getElementById('pv').onclick = async () => {
        const out = document.getElementById('pvOut');
        out.textContent = 'checking...';
        try {
          const p = new URLSearchParams(q());
          p.set('do','preview'); p.set('key', key);
          const r = await fetch('/add/preview?' + p.toString());
          const j = await r.json();
          if (!j.ok) { out.innerHTML = '<span class="err">' + (j.error||'no match') + '</span>'; return; }
          const m = j.match;
          out.innerHTML = '<div class="card">' + (m.poster ? '<img src="'+m.poster+'">' : '') +
            '<div><b>'+m.title+'</b><div class="hint">TMDB '+m.tmdbId+' - '+m.type+' - rating '+m.rating+'</div></div></div>';
        } catch(e) { out.innerHTML = '<span class="err">'+e+'</span>'; }
      };
      (async () => {
        const el = document.getElementById('list');
        if (!key) { el.textContent = 'key daalo - list dikhegi'; return; }
        try {
          const r = await fetch('/add/list?key=' + encodeURIComponent(key));
          const j = await r.json();
          if (!j.ok) { el.textContent = 'unauthorized'; return; }
          el.innerHTML = j.items.map(i =>
            '<div class="card"><div style="flex:1"><b>'+(i.media_title||'(match nahi)')+'</b>' +
            '<div class="row"><span>'+(i.host||'')+'</span><span>'+(i.file_name||'')+'</span></div>' +
            '<div class="row"><span class="pill '+(i.has_streams?'ok':'wait')+'">'+(i.has_streams?'streams ready':'streams pending')+'</span>' +
            '<span>'+(i.added_at||'')+'</span></div></div></div>').join('') || 'kuch nahi';
        } catch(e) { el.textContent = String(e); }
      })();
    </script>
  </body></html>`);
});
app.get("/remove", async (c) => {
  const key = c.req.query("key");
  if (!c.env.SYNC_KEY || key !== c.env.SYNC_KEY) return c.text("unauthorized", 401);
  const url = c.req.query("url");
  if (!url) return c.text("url param required", 400);
  await ensureSchema(c.env.DB);
  await c.env.DB.prepare("DELETE FROM watchlist WHERE url = ?").bind(url).run();
  return c.html(`\u2705 Removed: ${url} <a href="/api/sync?key=${key}">Sync</a>`);
});

// ------------------------------------------------------- manual sync (browser)

app.get("/api/sync", async (c) => {
  const key = c.req.query("key");
  if (!c.env.SYNC_KEY || key !== c.env.SYNC_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const ingested = await runSync(c.env);
    return c.json({ ok: true, ingested, errors: lastSyncErrors });
  } catch (e) {
    return c.json({ ok: false, error: String(e), stack: (e as Error)?.stack ?? null }, 500);
  }
});

// ---------------------------------------------------------------- cron

export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  if (env.CRON_ENABLED === "false") return;
  ctx.waitUntil(
    (async () => {
      try {
        const n = await runSync(env);
        console.log(`[cron] done, ingested=${n}`);
      } catch (e) {
        console.error("[cron] failed:", e);
      }
    })(),
  );
}


// ---------------------------------------------------------------------------
// Generic resolver: CloudStream video link -> The Gate
// GET /resolve?url=<video/embed url> -> JSON { ok, url, type, headers, source }
// GET /proxy?url=<direct url>        -> bytes streamed through The Gate (Range)
// ---------------------------------------------------------------------------

const GATE_RESOLVE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const GATE_RESOLVE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function gateParseExternalUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    // SSRF guard - local/private targets block
    if (
      h === "localhost" ||
      h === "::1" ||
      h === "127.0.0.1" ||
      h.startsWith("10.") ||
      h.startsWith("192.168.") ||
      h.startsWith("172.16.")
    ) return null;
    return u;
  } catch {
    return null;
  }
}

function gateHeadersForTarget(target: URL): Record<string, string> {
  return {
    Referer: target.origin + "/",
    Origin: target.origin,
    "User-Agent": GATE_RESOLVE_UA,
  };
}

// Best video server ranking — HLS > MP4, known-good hosts > unknown, https > http
const GATE_HOST_SCORES: Array<[RegExp, number]> = [
  [/stream\.andromedans\.live/i, 100],
  [/(?:^|\.)ufoload\./i, 90],
  [/(?:^|\.)streamtape\./i, 85],
  [/(?:^|\.)(?:mixdrop|mxdrop)\./i, 80],
  [/(?:^|\.)vidmoly\./i, 75],
  [/(?:^|\.)(?:doodstream|dood)\./i, 70],
];

function gateScoreMediaUrl(u: string): number {
  let score = /\.m3u8(?:\?|$)/i.test(u) ? 40 : 10;
  if (/^https:/i.test(u)) score += 15;
  try {
    const h = new URL(u).hostname.toLowerCase();
    for (const [re, pts] of GATE_HOST_SCORES) {
      if (re.test(h)) { score += pts; break; }
    }
    if (/(1080|720|hdr)/i.test(u)) score += 5;
  } catch { /* ignore malformed */ }
  return score;
}

function gateFindBestMediaUrl(html: string, base: URL): { url: string; score: number; count: number } | null {
  const clean = html
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  const found = new Set<string>();
  for (const m of clean.matchAll(/https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>]*)?/gi)) {
    found.add(m[0]);
  }
  for (const m of clean.matchAll(
    /(?:get_video_url|video_url|file|url|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
  )) {
    const v = m[1];
    try { found.add(v.startsWith("http") ? v : new URL(v, base).href); } catch { /* ignore */ }
  }
  // Streamtape protocol-less get_video links (host resolver fail hone par bhi pakde gaye)
  for (const m of clean.matchAll(/(\/streamtape\.com\/get_video\?[^"'<>\s]+)/gi)) {
    found.add("https://" + m[1].replace(/^\//, ""));
  }
  if (!found.size) return null;
  const ranked = [...found]
    .map((u) => ({ url: u, score: gateScoreMediaUrl(u) }))
    .sort((a, b) => b.score - a.score);
  return { url: ranked[0].url, score: ranked[0].score, count: found.size };
}

app.get("/resolve", async (c) => {
  const target = gateParseExternalUrl(c.req.query("url") ?? "");
  if (!target) {
    return c.json({ ok: false, error: "invalid or blocked url" }, 400, GATE_RESOLVE_CORS as any);
  }
  try {
    const headers = gateHeadersForTarget(target);
    const wantProxy = c.req.query("proxy") === "1";
    const gateWrap = (raw: string) => {
      if (!wantProxy) return raw;
      return `${new URL(c.req.url).origin}/proxy?url=${encodeURIComponent(raw)}`;
    };

    // Best video server pehle: known host ke liye host-specific resolver chalao
    const hname = target.hostname.toLowerCase();
    let hostDirect: string | null = null;
    let via = "";
    try {
      if (/streamtape/i.test(hname)) { hostDirect = await extractStreamtape(target.href); via = "streamtape"; }
      else if (/mixdrop|mxdrop/i.test(hname)) { hostDirect = await extractMixdrop(target.href); via = "mixdrop"; }
      else if (/vidmoly/i.test(hname)) { hostDirect = await extractVidmoly(target.href); via = "vidmoly"; }
      else if (/ufoload/i.test(hname)) { hostDirect = await extractUfoload(target.href); via = "ufoload"; }
      else if (/dood/i.test(hname)) {
        const code = (target.pathname.match(/\/(?:e|d|file)\/([A-Za-z0-9]+)/i) || [])[1];
        if (code) { hostDirect = await extractDoodstreamEmbed(c.env, code, target.origin); via = "doodstream"; }
      }
    } catch { /* host resolver fail -> generic fallback */ }
    if (hostDirect) {
      return c.json(
        {
          ok: true,
          url: gateWrap(hostDirect),
          type: /\.m3u8/i.test(hostDirect) ? "m3u8" : "mp4",
          headers: gateHeadersForTarget(new URL(hostDirect)),
          source: "The Gate",
          via,
          chosen: "best-known-host",
        },
        200,
        GATE_RESOLVE_CORS as any,
      );
    }

    const res = await fetch(target.href, {
      headers,
      redirect: "follow",
      cf: { cacheTtl: 0 } as any,
    });
    const finalUrl = res.url || target.href;
    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("html") || ct.includes("text")) {
      const html = await res.text();
      const best = gateFindBestMediaUrl(html, new URL(finalUrl));
      if (!best) {
        return c.json(
          { ok: false, error: "no media link found in page", host: target.hostname },
          422,
          GATE_RESOLVE_CORS as any,
        );
      }
      return c.json(
        {
          ok: true,
          url: gateWrap(best.url),
          type: best.url.includes(".m3u8") ? "m3u8" : "mp4",
          headers,
          source: "The Gate",
          via: "extract",
          chosen: "best-ranked",
          servers: best.count,
          score: best.score,
        },
        200,
        GATE_RESOLVE_CORS as any,
      );
    }

    const type =
      ct.includes("mpegurl") || finalUrl.includes(".m3u8") ? "m3u8" : "mp4";
    return c.json(
      { ok: true, url: gateWrap(finalUrl), type, headers, source: "The Gate", via: "direct" },
      200,
      GATE_RESOLVE_CORS as any,
    );
  } catch (e: any) {
    return c.json(
      { ok: false, error: String(e?.message ?? e) },
      502,
      GATE_RESOLVE_CORS as any,
    );
  }
});

app.get("/proxy", async (c) => {
  const target = gateParseExternalUrl(c.req.query("url") ?? "");
  if (!target) return c.json({ ok: false, error: "invalid url" }, 400);
  try {
    const headers: Record<string, string> = gateHeadersForTarget(target);
    const range = c.req.header("Range");
    if (range) headers["Range"] = range;
    const res = await fetch(target.href, { headers, redirect: "follow" });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("mpegurl") || /\.m3u8(?:\?|$)/i.test(target.pathname)) {
      const origin = new URL(c.req.url).origin;
      const px = (u: string) => {
        try {
          const abs = new URL(u, res.url || target.href).href;
          if (abs.includes("/proxy?url=")) return abs;
          return `${origin}/proxy?url=${encodeURIComponent(abs)}`;
        } catch { return u; }
      };
      const playlist = await res.text();
      const rewritten = playlist.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${px(u)}"`);
        return px(t);
      }).join("\n");
      const hlsHeaders = new Headers();
      const hct = res.headers.get("content-type");
      if (hct) hlsHeaders.set("content-type", hct);
      hlsHeaders.set("Access-Control-Allow-Origin", "*");
      hlsHeaders.set("Cache-Control", "no-store");
      return new Response(rewritten, { status: res.status, headers: hlsHeaders });
    }
    const out = new Headers();
    for (const k of [
      "content-type", "content-length", "accept-ranges",
      "content-range", "etag",
    ]) {
      const v = res.headers.get(k);
      if (v) out.set(k, v);
    }
    out.set("Access-Control-Allow-Origin", "*");
    out.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502);
  }
});


// --------------------------------------------------- TMDB-friendly file rename
// GET /debug/names?host=streamtape|ufoload|all&apply=1&limit=20
// Default dry-run. apply=1 → host API se file ka naam tmdb_<ID>_<title>.mp4 karta hai.
app.get("/debug/names", async (c) => {
  const host = (c.req.query("host") || "all").toLowerCase();
  const apply = c.req.query("apply") === "1";
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10) || 20, 25);
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);
  const skipRenamed = c.req.query("skipRenamed") === "1";
  const jobs: any[] = [];
  try {
    if (host === "all" || host === "streamtape") {
      jobs.push(...(await listStreamtape(c.env)).map((f: any) => ({ ...f, host: "streamtape" })));
    }
    if (host === "all" || host === "ufoload") {
      jobs.push(...(await listUfoloadUploads(c.env)).map((f: any) => ({ ...f, host: "ufoload" })));
    }
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 500, GATE_RESOLVE_CORS as any);
  }

  let allJobs = skipRenamed ? jobs.filter((f: any) => !/^tmdb_\d+_/i.test(String(f.fileName || ""))) : jobs;
  const q = (c.req.query("q") || "").toLowerCase();
  if (q) allJobs = allJobs.filter((f: any) => String(f.fileName || "").toLowerCase().includes(q));
  const forceId = parseInt(c.req.query("forceId") || "0", 10) || 0;
  const results: any[] = [];
  for (const f of allJobs.slice(offset, offset + limit)) {
    const parsed = parseFilename(String(f.fileName || ""));
    const m = forceId
      ? { tmdbId: forceId, title: parsed.title || q || "Movie", type: "movie" }
      : await tmdbMatch(c.env, parsed);
    if (!m) {
      results.push({ host: f.host, id: f.id, old: f.fileName, match: null, renamed: false });
      continue;
    }
    const title = String(m.title || "")
      .replace(/[^a-zA-Z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const ep = parsed.season != null
      ? `_S${String(parsed.season).padStart(2, "0")}E${String(parsed.episode ?? 1).padStart(2, "0")}`
      : "";
    const newName = `tmdb_${m.tmdbId}_${title || "Movie"}${ep}.mp4`;
    let renamed = false, error = "";
    if (apply) {
      try {
        if (f.host === "streamtape") {
          const login = c.env.STREAMTAPE_USER || c.env.STREAMTAPE_LOGIN || "";
          const r = await fetchJson(
            `https://api.streamtape.com/file/rename?login=${encodeURIComponent(login)}&key=${encodeURIComponent(c.env.STREAMTAPE_KEY || "")}&id=${encodeURIComponent(f.id)}&name=${encodeURIComponent(newName)}`,
          );
          renamed = !!r.ok && r.json?.status === 200;
          if (!renamed) error = JSON.stringify(r.json || r.text || {}).slice(0, 140);
        } else {
          const fid = String(f.id || "").replace(/^ufo_/, "");
          const key = c.env.UFOLOAD_API_KEY || c.env.UFOLOAD_KEY || "";
          for (const body of [{ name: newName }, { title: newName }]) {
            const r = await fetch(`https://ufoload.com/api/v1/files/${fid}`, {
              method: "PATCH",
              headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (r.ok) { renamed = true; break; }
            error = `HTTP ${r.status}`;
          }
        }
      } catch (e: any) {
        error = String(e?.message ?? e).slice(0, 140);
      }
    }
    results.push({ host: f.host, id: f.id, old: f.fileName, new: newName, tmdbId: m.tmdbId, renamed, error });
  }
  return c.json({ ok: true, apply, scanned: allJobs.length, offset, results }, 200, GATE_RESOLVE_CORS as any);
});


app.get("/debug/uploads", async (c) => {
  const raw = parseUploadsJson(c.env);
  return c.json({ ok: true, uploads: raw.map((f: any) => ({ host: f.host, id: f.id, fileName: f.fileName, pageUrl: f.pageUrl })) }, 200, GATE_RESOLVE_CORS as any);
});


app.get("/debug/runsync", async (c) => {
  try {
    const n = await runSync(c.env);
    return c.json({ ok: true, ingested: n, errors: lastSyncErrors.slice(0, 20) }, 200, GATE_RESOLVE_CORS as any);
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.stack || e).slice(0, 600) }, 500, GATE_RESOLVE_CORS as any);
  }
});


app.get("/debug/fetch", async (c) => {
  const url = c.req.query("url") || "";
  const t = gateParseExternalUrl(url);
  if (!t) return c.json({ ok:false, error:"bad url" }, 400);
  try {
    const r = await fetch(t.href, { headers: { "User-Agent": GATE_RESOLVE_UA, Referer: t.origin + "/", Accept: "*/*" }, redirect: "follow" });
    const text = await r.text();
    return c.json({
      ok:true, status:r.status, final:r.url, ct:r.headers.get("content-type"), size:text.length,
      getvideo:(text.match(/get_video/g)||[]).length,
      relmatch:(text.match(/\/streamtape\.com\/get_video/gi)||[]).length,
      snippet:text.slice(Math.max(0,text.indexOf("get_video")-90), text.indexOf("get_video")+160),
    }, 200, GATE_RESOLVE_CORS as any);
  } catch(e:any) { return c.json({ok:false,error:String(e)},500); }
});

export default app;

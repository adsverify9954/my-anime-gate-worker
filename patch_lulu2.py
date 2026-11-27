import io
p = r'C:\Users\sgdys\AppData\Local\Temp\worker-fix\src\index.ts'
s = io.open(p, encoding='utf-8', newline='').read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, f"count {n} != {count} for {old[:70]!r}"
    s = s.replace(old, new)

# 1) helpers before parseUploadsJson
anchor = "/** Vidara API key: env secret ya D1 sync_state cfg:vidara_key. */"
assert s.count(anchor) == 1
helpers = '''/** LuluStream API key: env secret ya D1 sync_state cfg:lulu_key. */
async function luluKey(env: Env): Promise<string> {
  if (env.LULUSTREAM_API_KEY) return String(env.LULUSTREAM_API_KEY);
  try {
    const r = await env.DB.prepare("SELECT value FROM sync_state WHERE key='cfg:lulu_key'").first<any>();
    return String(r?.value || "");
  } catch { return ""; }
}

/** Byse API key: env secret ya D1 sync_state cfg:byse_key. */
async function byseKey(env: Env): Promise<string> {
  if (env.BYSE_API_KEY) return String(env.BYSE_API_KEY);
  try {
    const r = await env.DB.prepare("SELECT value FROM sync_state WHERE key='cfg:byse_key'").first<any>();
    return String(r?.value || "");
  } catch { return ""; }
}

/** LuluStream video list — API at api.lulustream.com (embed link lplaygo.com/<code>). */
async function listLulustreamUploads(env: Env): Promise<any[]> {
  const key = await luluKey(env);
  if (!key) return [];
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetchJson(`https://api.lulustream.com/api/file/list?key=${encodeURIComponent(key)}&per_page=100&page=${page}`);
    const files = r.json?.result?.files;
    if (!Array.isArray(files) || files.length === 0) break;
    for (const f of files) {
      const code = String(f.file_code || f.filecode || "");
      if (!code) continue;
      out.push({
        id: code, host: "lulustream", fileName: String(f.title || f.name || ""),
        size: Number(f.size) || 0, status: 200,
        pageUrl: `https://lplaygo.com/e/${code}`,
      });
    }
    if (files.length < 100) break;
  }
  return out;
}

''' + anchor
s = s.replace(anchor, helpers, 1)

# 2) listByseUploads key fallback
rep('''async function listByseUploads(env: Env): Promise<any[]> {
  if (!env.BYSE_API_KEY) return [];
  const key = encodeURIComponent(env.BYSE_API_KEY);''',
'''async function listByseUploads(env: Env): Promise<any[]> {
  const bkeyRaw = await byseKey(env);
  if (!bkeyRaw) return [];
  const key = encodeURIComponent(bkeyRaw);''')

# 3) stream byse branch key
rep('const dom = await fetchJson("https://api.byse.sx/get/domain?key=" + encodeURIComponent(c.env.BYSE_API_KEY ?? ""));',
    'const dom = await fetchJson("https://api.byse.sx/get/domain?key=" + encodeURIComponent(await byseKey(c.env)));')

# 4) debug endpoints before /debug/setvidara
anchor2 = '// Vidara API key save: /debug/setvidara?key=<api key>'
assert s.count(anchor2) == 1
eps = '''// LuluStream API key save: /debug/setlulu?key=<api key>
app.get("/debug/setlulu", async (c) => {
  const key = String(c.req.query("key") || "").trim();
  if (!/^[A-Za-z0-9]{12,80}$/.test(key)) return c.json({ ok: false, error: "valid api key required" }, 400);
  try {
    await c.env.DB.prepare("INSERT INTO sync_state (key,value) VALUES ('cfg:lulu_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).run();
    return c.json({ ok: true, stored: true }, 200, GATE_RESOLVE_CORS as any);
  } catch (e: any) { return c.json({ ok: false, error: String(e?.message ?? e).slice(0, 150) }, 500); }
});

// Byse API key save: /debug/setbyse?key=<api key>
app.get("/debug/setbyse", async (c) => {
  const key = String(c.req.query("key") || "").trim();
  if (!/^[A-Za-z0-9]{12,80}$/.test(key)) return c.json({ ok: false, error: "valid api key required" }, 400);
  try {
    await c.env.DB.prepare("INSERT INTO sync_state (key,value) VALUES ('cfg:byse_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key).run();
    return c.json({ ok: true, stored: true }, 200, GATE_RESOLVE_CORS as any);
  } catch (e: any) { return c.json({ ok: false, error: String(e?.message ?? e).slice(0, 150) }, 500); }
});

''' + anchor2
s = s.replace(anchor2, eps, 1)

# 5) Env interface additions
rep("  VIDARA_API_KEY?: string;\n", "  VIDARA_API_KEY?: string;\n  LULUSTREAM_API_KEY?: string;\n")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("PATCH LULU/BYSE-2 applied OK")

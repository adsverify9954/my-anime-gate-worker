import io
p = r'C:\Users\sgdys\AppData\Local\Temp\worker-fix\src\index.ts'
s = io.open(p, encoding='utf-8', newline='').read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, f"count {n} != {count} for {old[:70]!r}"
    s = s.replace(old, new)

# A-D
rep("  vidara_url: string;\n", "  vidara_url: string;\n  lulustream_url: string;\n")
rep('  vidara: { Referer: "https://vidara.to/", Origin: "https://vidara.to" },\n',
    '  vidara: { Referer: "https://vidara.to/", Origin: "https://vidara.to" },\n  lulustream: { Referer: "https://lulustream.com/", Origin: "https://lulustream.com" },\n')
rep('  vidara: "vidara_url",\n', '  vidara: "vidara_url",\n  lulustream: "lulustream_url",\n')
rep('  vidara: "Vidara",\n', '  vidara: "Vidara",\n  lulustream: "LuluStream",\n')

# E-F
rep("    vidara_url TEXT NOT NULL DEFAULT '',\n", "    vidara_url TEXT NOT NULL DEFAULT '',\n    lulustream_url TEXT NOT NULL DEFAULT '',\n")
rep('  ["media_items", "vidara_url TEXT NOT NULL DEFAULT \'\'"],\n',
    '  ["media_items", "vidara_url TEXT NOT NULL DEFAULT \'\'"],\n  ["media_items", "lulustream_url TEXT NOT NULL DEFAULT \'\'"],\n')

# G-H
rep('const allUrls = ["streamtape", "vidmoly", "mixdrop", "ufoload", "abyss", "byse", "earnvids", "doodstream", "vidara"].map',
    'const allUrls = ["streamtape", "vidmoly", "mixdrop", "ufoload", "abyss", "byse", "earnvids", "doodstream", "vidara", "lulustream"].map')
rep('vidara_url, is_active)', 'vidara_url, lulustream_url, is_active)')
rep('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
rep("         vidara_url=COALESCE(nullif(excluded.vidara_url,''), media_items.vidara_url),\n",
    "         vidara_url=COALESCE(nullif(excluded.vidara_url,''), media_items.vidara_url),\n         lulustream_url=COALESCE(nullif(excluded.lulustream_url,''), media_items.lulustream_url),\n")
rep('.bind(...baseVals, allUrls[0], allUrls[1], allUrls[2], allUrls[3], allUrls[4], allUrls[5], allUrls[6], allUrls[7], allUrls[8]));',
    '.bind(...baseVals, allUrls[0], allUrls[1], allUrls[2], allUrls[3], allUrls[4], allUrls[5], allUrls[6], allUrls[7], allUrls[8], allUrls[9]));')

# I
old = "AND earnvids_url='' AND doodstream_url='' AND vidara_url='' AND is_title_only=0"
assert s.count(old) == 4, s.count(old)
s = s.replace(old, "AND earnvids_url='' AND doodstream_url='' AND vidara_url='' AND lulustream_url='' AND is_title_only=0")

# J
old = 'earnvids: "earnvids_url", doodstream: "doodstream_url", vidara: "vidara_url",'
assert s.count(old) == 2, s.count(old)
s = s.replace(old, 'earnvids: "earnvids_url", doodstream: "doodstream_url", vidara: "vidara_url", lulustream: "lulustream_url",')

# K
rep('const STABLE_URL_HOSTS = new Set(["streamtape", "mixdrop", "abyss", "byse", "earnvids", "vidara"]);',
    'const STABLE_URL_HOSTS = new Set(["streamtape", "mixdrop", "abyss", "byse", "earnvids", "vidara", "lulustream"]);')
rep('const PAGE_URL_HOSTS = new Set(["streamtape", "mixdrop", "ufoload", "abyss", "byse", "earnvids", "vidara"]);',
    'const PAGE_URL_HOSTS = new Set(["streamtape", "mixdrop", "ufoload", "abyss", "byse", "earnvids", "vidara", "lulustream"]);')

# L
rep('    ["ufoload", "abyss", "byse", "earnvids", "doodstream", "vidara"],\n',
    '    ["ufoload", "abyss", "byse", "earnvids", "doodstream", "vidara", "lulustream"],\n')
rep('        else if (host === "vidara") fresh.push(...(await listVidaraUploads(env)));\n',
    '        else if (host === "vidara") fresh.push(...(await listVidaraUploads(env)));\n        else if (host === "lulustream") fresh.push(...(await listLulustreamUploads(env)));\n')
rep('...(await listEarnvidsUploads(env)), ...(await listVidaraUploads(env))];',
    '...(await listEarnvidsUploads(env)), ...(await listVidaraUploads(env)), ...(await listLulustreamUploads(env))];')
rep('      ...(await listVidaraUploads(c.env)),\n      ...parseUploadsJson(c.env),',
    '      ...(await listVidaraUploads(c.env)),\n      ...(await listLulustreamUploads(c.env)),\n      ...parseUploadsJson(c.env),')

# M: ingest branch (full replacement)
old_m = """  } else if (upload.host === "vidara") {
    // Vidara: pageUrl (vidara.to/<code>) store hota hai — /stream serve-time HLS resolve karta hai.
    valid = Boolean(upload.pageUrl);
    ready = valid;
    directUrl = upload.pageUrl;
  } else if (upload.host === "doodstream") {"""
new_m = """  } else if (upload.host === "vidara") {
    // Vidara: pageUrl (vidara.to/<code>) store hota hai — /stream serve-time HLS resolve karta hai.
    valid = Boolean(upload.pageUrl);
    ready = valid;
    directUrl = upload.pageUrl;
  } else if (upload.host === "lulustream") {
    // LuluStream: embed player URL (lplaygo.com/e/<code>) — WebView playback.
    valid = Boolean(upload.pageUrl);
    ready = valid;
    directUrl = upload.pageUrl;
  } else if (upload.host === "doodstream") {"""
rep(old_m, new_m)

# N: auto-rename condition + lulu branch
rep('    if ((upload.host === "vidara" || !/^tmdb_\\d+/i.test(String(upload.fileName || ""))) && upload.id) {',
    '    if ((upload.host === "vidara" || upload.host === "lulustream" || !/^tmdb_\\d+/i.test(String(upload.fileName || ""))) && upload.id) {')
old_n = """        } else if (upload.host === "mixdrop") {
          const ref = fileRefOf(upload.pageUrl);
          if (ref && env.MIXDROP_EMAIL && env.MIXDROP_KEY) {
            budget--;
            await fetchJson(`https://api.mixdrop.ag/filerename?email=${encodeURIComponent(String(env.MIXDROP_EMAIL))}&key=${encodeURIComponent(String(env.MIXDROP_KEY))}&ref=${encodeURIComponent(ref)}&title=${encodeURIComponent(newName.replace(/\\.mp4$/i, ""))}`);
          }
        }"""
new_n = old_n + """ else if (upload.host === "lulustream") {
          const lk = await luluKey(env);
          const code = String(upload.id || "");
          if (lk && code) {
            budget--;
            await fetchJson(`https://api.lulustream.com/api/file/edit?key=${encodeURIComponent(lk)}&file_code=${encodeURIComponent(code)}&file_title=${encodeURIComponent(newName)}`);
          }
        }"""
rep(old_n, new_n)

# O: rich stream loop lulu branch
old_o = """        if (host === "vidara") {
          // Ads-free: /api/stream se fresh HLS master.m3u8 → native player.
          const direct = await extractVidara(url).catch(() => null);
          if (direct) { finalUrl = direct; useWebview = false; }
          else { finalUrl = url; useWebview = true; }
        }"""
new_o = old_o + """
        if (host === "lulustream") {
          // Direct HLS browser-locked hai (non-browser clients 403) — embed player WebView.
          finalUrl = url;
          useWebview = true;
        }"""
rep(old_o, new_o)

# P: /api/stream simple loop
old_p = """    let playUrl = host === "streamtape" ? toStreamtapeProxy(new URL(c.req.url).origin, url) : url;
    let webview = false;
    if (host === "vidara") {
      const direct = await extractVidara(url).catch(() => null);
      if (direct) playUrl = direct; else webview = true;
    }"""
new_p = old_p + """
    if (host === "lulustream") webview = true;"""
rep(old_p, new_p)

# Q
rep('  if (/vidara\\.to|vidara\\.so/.test(u)) return "vidara";\n',
    '  if (/vidara\\.to|vidara\\.so/.test(u)) return "vidara";\n  if (/lulustream|lplaygo/.test(u)) return "lulustream";\n')

# R
rep('const HIDDEN_HOSTS = new Set(["abyss", "byse"]);', 'const HIDDEN_HOSTS = new Set(["abyss"]);')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("PATCH LULU/BYSE-1 applied OK")

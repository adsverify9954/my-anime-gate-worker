# The Gate — Cloudflare Worker (deploy source)

Live worker: `https://my-anime-gate.unityads9954.workers.dev`

Ye repo **asli deployed source** hai (2663-line single-file worker). Isme CloudStream ke liye naye endpoints hain:

| Endpoint | Kaam |
|---|---|
| `GET /resolve?url=<video/embed link>` | CloudStream ka koi bhi video link worker ko bhejo → direct `.m3u8`/`.mp4` + headers milega |
| `GET /proxy?url=<direct url>` | Video bytes The Gate se stream (Range supported) |

Baki saare endpoints (`/manifest.json`, `/catalog`, `/meta`, `/stream`) pehle ki tarah hain.

## Deploy (Cloudflare Dashboard se — ek baar)

1. **https://dash.cloudflare.com** → apna account → **Workers & Pages** → **Create**
2. **Import repository** → GitHub account connect karo (pehli baar authorize hoga) → **`my-anime-gate-worker`** repo select karo
3. Build settings auto-detect hote hain (`npm install` / `wrangler deploy`) → **Save and Deploy**
4. Worker ka naam **`my-anime-gate`** hi rakho (live URL same rahe)
5. Deploy complete hone do (1-2 min)

## Secret verify karo

Agar naya worker bana hai to **Workers & Pages → my-anime-gate → Settings → Variables and Secrets** mein ye secrets dobara daalo (purane worker se copy karo):

```
TMDB_API_KEY, STREAMTAPE_USER, STREAMTAPE_KEY, MIXDROP_KEY,
ABYSS_API_KEY, UFOLOAD_LOGIN, UFOLOAD_KEY, EARNVIDS_API_KEY
```

D1 binding `anime-db` `wrangler.toml` mein already hai — kuch change nahi karna.

## Test (deploy ke baad)

```bash
curl "https://my-anime-gate.unityads9954.workers.dev/resolve?url=https%3A%2F%2Fexample.com%2Fvideo.m3u8"
```

Expected: `{"ok":true,"url":"...","type":"m3u8","source":"The Gate",...}`

## Future updates

Bas `src/index.ts` edit karke push karo — Cloudflare khud auto-deploy kar dega.


---
CloudStream link support: /resolve?url=... + /proxy?url=... enabled. Deploy trigger 2026-11-23.

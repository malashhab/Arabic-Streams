# Arabic Movies & Series (Stremio addon)

An Arabic-first discovery addon: latest Arabic movies/series, browse by year, Ramadan seasons, Saudi/Gulf, Egyptian, Levantine and Maghreb productions, and search that understands Arabic spelling variants and Latin transliterations ("Bab Al Hara" finds باب الحارة).

Torrent sources: your own Torznab index (Prowlarr/Jackett), plus optional Torrentio and Comet (public Stremio addons, asked by IMDb id only). Releases are checked on TorBox / Real-Debrid before they are offered.

## What it does, honestly

| Feature | Needs | Status |
|---|---|---|
| Catalogs (latest, by year, Ramadan, regions) | free TMDB token | implemented, tested with mocked TMDB |
| Arabic / transliterated search | free TMDB token | implemented, tested |
| Metadata (Arabic title, original title, poster, background, description, year, genres, language, episodes) | TMDB | implemented, tested |
| TorBox: cache check + play | your TorBox key + a Torznab indexer | implemented, tested with mocks, **not tested live** |
| Real-Debrid: play | your RD key + a Torznab indexer | implemented, tested with mocks, **not tested live** |
| Internet Archive direct streams | nothing | implemented, tested with mocks |
| Shahid / WATCH IT / Netflix / OSN+ / TOD | - | **not supported**: DRM/subscription services are never accessed. Titles from them appear only as TMDB metadata; the addon does not imply they are playable. |

No live integration has been run: I had no TMDB/TorBox/Real-Debrid credentials, so those paths are verified against mocked API responses only. The first real run is yours to do (see "First real test").

### Things the addon will never claim
- **Cached**: only shown ("⚡ cached") when TorBox's own `checkcached` says so. **Real-Debrid removed its cache-check endpoint in Nov 2024**, so RD releases are labelled "cache unknown" and play only if RD can serve them when you click.
- **Quality** (1080p, 4K, HDR...): taken from the release's file name only. Nothing is assumed.
- **Availability**: if no source is found you get an empty list, not placeholder streams.

## Setup

Requirements: Node.js 20+ (you have 24).

```powershell
cd D:\addon\Arabic
npm install
copy .env.example .env      # then edit .env
```

Edit `.env`:
1. `TMDB_READ_TOKEN` - create a free account at themoviedb.org, then Settings → API → copy the **API Read Access Token** (the long one).
2. `CONFIG_SECRET` - optional. Leave empty and the addon creates `data/.secret` automatically on first start. Keep that file safe; if it is lost, everyone must re-install.
3. For torrent releases: either set `TORZNAB_URL` / `TORZNAB_API_KEY` (your own Prowlarr or Jackett Torznab feed), or let each user enter theirs on the settings page. Without an indexer you only get Internet Archive streams.

Run:

```powershell
npm run dev        # development, auto-reload
npm run build; npm start   # production
```

Open http://localhost:7100/configure, choose your debrid service and key, pick catalogs, press **Create install link**, then open the Stremio link (or paste the https manifest URL into Stremio/Nuvio). Your keys are encrypted (AES-256-GCM) into that link and are never stored on the server or shown in stream URLs/logs.

Local URL without personalisation: `http://localhost:7100/manifest.json` (all catalogs, no debrid).

### First real test
1. Put your TMDB token in `.env`, start, install `http://localhost:7100/manifest.json` into Stremio on the same PC.
2. Open the "Arabic Series - Latest" catalog; check posters/titles.
3. Search `باب الحارة` and `Bab Al Hara`.
4. Then add TorBox/RD + an indexer via `/configure` and try a title.

## Tests and checks

```powershell
npm test            # 71 tests, all external APIs mocked
npm run typecheck
npm run build
npm run check       # all three
```

Covered: Arabic normalisation, transliteration + fuzzy matching, ID parsing, catalog responses (incl. Ramadan dates), manifest/catalog/meta/stream schema validation, credential isolation between users, token encryption/tampering, TorBox and Real-Debrid flows, rate-limit/invalid-key/empty-result handling, SSRF blocking, log redaction, retries.

## Catalog configuration ("hideable")

Stremio's manifest has no flag to hide a catalog. This addon does the supported thing: the settings page lets each user choose catalogs, and their personal manifest URL lists only those. Stremio also lets you hide catalogs from the Home board inside the app.

"By Year" and "Ramadan" catalogs use the `genre` dropdown for the year (Stremio's standard way to offer a picker). Ramadan windows are computed from the Umm al-Qura Islamic calendar (about ±1 day vs. moon sighting); the TMDB query uses first-air-date from 10 days before Ramadan until its end. For Ramadan 2026 you can override with `RAMADAN_2026_START` / `RAMADAN_2026_END` in `.env`. Today is after Ramadan 2026, so that catalog works as an archive.

## Nuvio compatibility

From published guides, Nuvio (NuvioTV / Nuvio mobile) installs Stremio addons from a normal `manifest.json` URL and has native TorBox / Real-Debrid / Premiumize resolvers. This addon speaks the plain Stremio protocol, so it should install the same way: paste the https manifest URL from the settings page. **I could not verify this in a running Nuvio app**, and sources disagree on iOS availability, so treat it as "expected to work, please test". No separate adapter was built because none appears necessary. Note Nuvio must be able to reach your server over https from the device (see deployment).

## Deployment

Render (free tier): create a Blueprint from this repo (`render.yaml`), then set `CONFIG_SECRET` (any 32+ character random string, keep it so install links survive restarts), `TMDB_READ_TOKEN` and, if you want, `BASE_URL`. Optional: `TORRENTIO_URL`, `COMET_URL` to point at other instances.

Docker (any VPS or home server with Docker):

```bash
git clone <your repo>  # or copy the Arabic folder to the server
cd Arabic
cp .env.example .env   # edit it; set BASE_URL=https://your-public-address and TRUST_PROXY=1 if behind a proxy/tunnel
docker compose up -d --build
```

Stremio on phones/TVs requires **https**, so put it behind your existing reverse proxy or a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:7100` gives a temporary https address for testing). The install URL is then `<BASE_URL>/configure`. I can't give you a final URL because it depends on the domain you choose.

Health check: `GET /health`. The server shuts down gracefully on SIGTERM.


## Security notes
- No secrets are hard-coded; `.env` is git-ignored.
- User settings live only inside the encrypted token in the URL. Stream URLs contain that opaque token, not the raw key; treat your install URL as private.
- Stream and resolve responses are `no-store`; only public TMDB data is cached (in memory).
- User-supplied indexer URLs must be public http(s) hosts (blocks localhost/LAN) unless the operator sets `ALLOW_PRIVATE_INDEXERS=true` for a private instance. DNS-rebinding is not fully mitigated.
- Rate limits: global per IP, stricter on `/resolve` and `/api/config`. Set `TRUST_PROXY=1` behind a proxy or all users share one limit.
- Logs are JSON and redact keys, tokens and query-string secrets.
- Use only indexers and content you are legally allowed to access; you are responsible for what your own indexer and debrid account fetch.

## Limitations
- Many Arabic series are poorly tagged on TMDB (language/country); some will be missing from region catalogs. "Arabic only" search filtering relies on the same tags.
- Release names rarely contain Arabic, so torrent matching uses the English/original titles; obscure titles may find nothing.
- Torznab results without an info hash (only a `.torrent` link) are skipped.
- Real-Debrid: no cache info; first click on an uncached release queues it and you must retry later. TorBox: uncached releases are queued in your account on click (the player shows an error until ready).
- Internet Archive: movies only, close title matches only.
- Series Season-pack releases are matched to the episode by file name (SxxEyy). Packs with other numbering (e.g. "Episode 12" only) may not resolve.
- Catalog/meta data and ordering come from TMDB; no TVDB mapping is implemented (IMDb ids are used where TMDB provides them).

## Troubleshooting
- **Catalogs show "Failed to fetch"** → open `/health`; `tmdbConfigured:false` means `TMDB_READ_TOKEN` is missing.
- **"install URL is invalid"** → the server's `CONFIG_SECRET` changed or `data/.secret` was lost; recreate the link at `/configure`.
- **"API key rejected"** stream → wrong TorBox/RD key.
- **Stream gives an error right after clicking** → release was not cached; wait and retry.
- **No streams** → add a Torznab indexer; check your indexer returns `infohash` attributes.
- **Stremio on phone cannot install** → needs a public https URL (`BASE_URL`).
- Logs: `docker compose logs -f arabic-addon`.

## Layout
```
src/arabic/      normalisation, transliteration, fuzzy matching
src/metadata/    TMDB client, id parsing, Stremio meta mapping
src/catalogs/    catalog definitions, Ramadan dates, catalog service
src/providers/   release sources (Torznab, Internet Archive) - add new ones by implementing StreamProvider
src/debrid/      TorBox and Real-Debrid
src/streams/     stream assembly and ranking
src/protocol/    manifest + response schemas (zod)
src/server/      Express routes, settings page
src/config/      env validation, encrypted per-user config
tests/           vitest, mocked APIs
```


# IPTV Web UI

A small self-hosted web UI for watching free-to-air IPTV streams in the
browser. Point it at an M3U playlist (by default the
[iptv-org](https://github.com/iptv-org/iptv) UK list) and you get a dark,
TV-style channel grid with logos, category filters, search, favourites, an
HLS player, a now-&-next programme guide, and a live viewer admin page.

Single small Node.js service, one dependency (Express), designed to sit
behind a reverse proxy such as Traefik.

## Features

- **Channel grid** — logos, category chips, search, favourites
  (localStorage), quality and status badges
- **Built-in HLS stream proxy** — many free streams are plain HTTP or lack
  CORS headers, so browsers on an HTTPS page can't play them directly. The
  server proxies streams and rewrites `.m3u8` playlists so every
  segment/key URI routes through it. Proxy URLs are HMAC-signed
  (`PROXY_SECRET`) so the endpoint can't be abused as an open proxy.
- **EPG (now & next)** — two free sources, refreshed every 12 hours, each
  surviving the other's failure:
  - XMLTV from epgshare01.online (`EPG_URL`), matched by `tvg-id`, then
    normalized id/name, then a small alias map for abbreviated names
  - Pluto TV's open API (`PLUTO_API`, no credentials) — Pluto-sourced
    streams embed Pluto's channel id in their URL, so matching is an exact
    id join. Pluto geo-targets the lineup by IP; the fetch is pinned to
    IPv4 (see `fetchIPv4` in `epg.js` if your host's v4/v6 egress differs).
- **Channel curation** — `config/filter.json` blocks or allowlists
  channels/categories server-side, hot-reloaded on every request
- **Admin page** at `/admin` — live viewer sessions (IP, reverse-DNS
  hostname, channel, watch time, bytes served, device) plus recent history.
  Playback segments all flow through `/stream`, so those requests double as
  heartbeats; sessions end after 2 minutes without one. In-memory only.

## Quick start

```bash
npm install
node server.js   # http://localhost:3000
```

### Docker + Traefik

`docker-compose.yml` includes Traefik v2 labels. Set two variables in a
`.env` file next to it:

```bash
IPTV_HOSTNAME=iptv.example.com
PROXY_SECRET=$(openssl rand -hex 32)   # keeps stream URLs valid across restarts
```

Then:

```bash
docker compose up --build -d
```

The compose file assumes an external Traefik network named `traefik-proxy`
and a cert resolver named `letsencrypt` — adjust the labels to your setup.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PLAYLIST_URL` | iptv-org UK list | Any M3U playlist with `#EXTINF` metadata |
| `PROXY_SECRET` | random per boot | HMAC key for signed proxy URLs |
| `REFRESH_HOURS` | 6 | Playlist re-fetch interval |
| `EPG_URL` | epgshare01 UK feed | XMLTV source (`.xml.gz`) |
| `PLUTO_API` | api.pluto.tv | Pluto TV guide endpoint |
| `FILTER_PATH` | `config/filter.json` | Channel curation file |
| `PORT` | 3000 | Listen port |

### Curating channels

`config/filter.json` (matching is case-insensitive against channel name or
category; the file is re-read on every request, so edits apply instantly):

```json
{
  "mode": "block",
  "channels": ["Some Channel"],
  "groups": ["Shop"]
}
```

- `mode: "block"` — hide the listed channels/groups, keep everything else
- `mode: "allow"` — keep ONLY the listed channels/groups

Compound playlist categories like `Animation;Kids` are split into separate
tags, so blocking `"Kids"` catches every channel tagged Kids.

## Endpoints

| Path | What |
| --- | --- |
| `/` | Channel grid + player |
| `/admin` | Viewer sessions (⚠ unauthenticated — protect it at your proxy, e.g. Traefik basic-auth middleware) |
| `/api/channels` | Filtered channel list |
| `/api/epg` | Now/next per visible channel |
| `/api/epg/status` | EPG source health + unmatched channel list (useful when tuning aliases) |
| `/api/admin/sessions` | Session data behind `/admin` |
| `/stream` | Signed HLS proxy |
| `/healthz` | Health + channel counts |

## Notes & caveats

- Client IPs come from `X-Forwarded-For` (`trust proxy` is on) — only
  meaningful if the app is reached exclusively through your reverse proxy,
  and only as accurate as the network path (NAT along the way will mask
  real addresses).
- Community playlists contain streams marked `[Geo-blocked]` or
  `[Not 24/7]` — those may fail to play; the UI surfaces an error rather
  than hanging.
- All viewer traffic flows through the proxy, so budget bandwidth
  accordingly: every concurrent viewer streams through your server.
- Only ever point this at streams you're entitled to watch — the default
  playlist is community-maintained free-to-air content.

## License

[MIT](LICENSE)

# IPTV Web UI

Self-hosted web UI for free-to-air IPTV streams, served at
https://iptv.djbenjones.co.uk from server1 (192.168.4.3) behind Traefik.

## How it works

- `server.js` fetches the [iptv-org](https://github.com/iptv-org/iptv) UK
  playlist (`PLAYLIST_URL`) every 6 hours and parses it into a channel list
  served at `/api/channels`.
- All playback goes through the built-in `/stream` proxy. This is required
  because many free streams are plain HTTP (blocked as mixed content on an
  HTTPS page) or lack CORS headers. The proxy rewrites `.m3u8` playlists so
  every segment/key URI also routes through it.
- Proxy URLs are HMAC-signed (`PROXY_SECRET`) so the endpoint cannot be used
  as an open proxy — only URLs derived from the playlist are accepted.
- Frontend is vanilla JS + [hls.js](https://github.com/video-dev/hls.js) with
  a channel grid, category filters, search, and favourites (localStorage).

## EPG (now & next)

`epg.js` refreshes two free sources every 12 hours, either surviving the
other's failure (last-good data is kept per source):

- **XMLTV** from epgshare01.online (`EPG_URL`) — matched by exact `tvg-id`,
  then normalized id/name, then the hand-written `ALIASES` map (needed for
  abbreviated BBC regional names like "BBC.One.E.Mid.HD.uk")
- **Pluto TV** (`PLUTO_API`, no credentials needed) — Pluto-sourced streams
  embed Pluto's channel `_id` in their URL (`jmp2.uk/plu-<id>.m3u8`), so
  matching is an exact id join. The fetch is pinned to IPv4 because the
  box's IPv6 egresses abroad and Pluto geo-targets the lineup by IP.

Roughly 166 channels match; the remaining tail (Red Button, Samsung
TV Plus-sourced streams like FailArmy, obscure streams) has no data in
either source. `/api/epg` serves now/next for
visible channels; `/api/epg/status` shows match stats and the unmatched
list (useful when tuning aliases). The UI shows the current programme and
a progress bar on each card, and now/next in the player bar.

## Admin page

`/admin` (currently unauthenticated) shows live viewer sessions and recent
history. Playback segments all flow through `/stream`, so those requests
double as heartbeats: proxy URLs carry a `c=<channelId>` tag, and the server
tracks one session per IP+channel (ended after 2 minutes without a request,
kept in a 200-entry history). Shows IP, reverse-DNS hostname (best-effort,
cached 1h), channel, watch duration, last activity, bytes served, and
browser/OS. Data lives in memory only — restarts clear it. JSON at
`/api/admin/sessions`. Client IP comes from X-Forwarded-For via Traefik
(`trust proxy` is on, so direct-to-container requests could spoof it —
irrelevant while the only route in is Traefik).

## Curating channels

`config/filter.json` controls which channels are served (matching is
case-insensitive against the channel name or its category group):

```json
{
  "mode": "block",
  "channels": ["Aaj Tak", "Alb UK TV"],
  "groups": ["Religious", "Shop"]
}
```

- `mode: "block"` — hide the listed channels/groups, keep everything else
- `mode: "allow"` — keep ONLY the listed channels/groups
- The file is re-read on every request, so edits apply immediately — no
  restart needed. Edit it locally and rsync, or edit `/root/iptv/config/filter.json`
  on the server directly (note a later deploy rsync will overwrite server-side
  edits, so prefer editing the repo copy).

Some channels in the playlist are marked `[Geo-blocked]` or `[Not 24/7]` —
those may fail to play; the UI shows the tags as badges and surfaces a
playback error rather than hanging.

## Deploy

Target: `ha` (server1), stack dir `/root/iptv`, Traefik network
`traefik-proxy`, cert resolver `letsencrypt` (same pattern as the Jellyfin
stack).

```bash
rsync -av --delete --exclude node_modules --exclude .git --exclude .env \
  ./ ha:/root/iptv/
ssh ha 'cd /root/iptv && docker compose up --build -d'
```

`PROXY_SECRET` lives in `/root/iptv/.env` on the server (not committed).
Generate one with `openssl rand -hex 32`. Keeping it stable means stream URLs
survive container restarts.

## Local dev

```bash
npm install
node server.js   # http://localhost:3000
```

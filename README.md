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

`epg.js` downloads the free UK XMLTV feed from epgshare01.online (`EPG_URL`)
every 12 hours and matches its channels to ours by exact `tvg-id`, then
normalized id/name, then the hand-written `ALIASES` map (needed for
abbreviated BBC regional names like "BBC.One.E.Mid.HD.uk"). Roughly 79
channels match — the mainstream ones; the long tail (Red Button, Pluto,
obscure streams) has no data in the feed. `/api/epg` serves now/next for
visible channels; `/api/epg/status` shows match stats and the unmatched
list (useful when tuning aliases). The UI shows the current programme and
a progress bar on each card, and now/next in the player bar.

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

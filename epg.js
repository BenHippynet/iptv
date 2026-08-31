// EPG: fetches an XMLTV guide feed, matches its channels to our playlist
// channels (exact tvg-id, then normalized id/name, then hand-written
// aliases), and answers "what's on now & next" per channel.

const zlib = require("zlib");
const https = require("https");

const EPG_URL =
  process.env.EPG_URL || "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz";
const PLUTO_API = process.env.PLUTO_API || "https://api.pluto.tv/v2/channels";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Our channel name (normalized) -> EPG channel id, for channels whose EPG
// names are abbreviated beyond what normalization can bridge.
const ALIASES = {
  "bbc one east midlands": "BBC.One.E.Mid.HD.uk",
  "bbc one london": "BBC.One.Lon.HD.uk",
  "bbc one north east": "BBC.One.NE.and.C.HD.uk",
  "bbc one north west": "BBC.One.N.West.HD.uk",
  "bbc one northern ireland": "BBC.One.NI.HD.uk",
  "bbc one scotland": "BBC.One.ScotHD.uk",
  "bbc one south": "BBC.One.Sth.HD.uk",
  "bbc one south east": "BBC.One.S.East.HD.uk",
  "bbc one south west": "BBC.One.S.West.HD.uk",
  "bbc one wales": "BBC.One.Wal.HD.uk",
  "bbc one west midlands": "BBC.One.WM.HD.uk",
  "bbc one yorks": "BBC.One.Y.and.L.HD.uk",
  "bbc news uk": "BBC.NEWS.HD.uk",
  "bbc four cbeebies": "BBC.Four.HD.uk",
  "bbc three cbbc": "BBC.Three.HD.uk",
  "talking pictures tv": "TalkingPictures.uk",
  "together tv": "Together.uk",
};

let ALIAS_NORM; // built after norm() is defined

let epgNames = new Map(); // epgId -> [display names]
let programmes = new Map(); // epgId -> [{start, stop, title, desc}] sorted by start
let mapping = new Map(); // our channel id -> epgId
let unmatched = [];
let lastEpgRefresh = null;
// Last-good data per source, so one source failing doesn't drop the other.
// Pluto ids are stored prefixed "pluto:" to avoid clashing with XMLTV ids.
const sources = {
  xmltv: { chans: new Map(), progs: new Map(), fetched: null, error: null },
  pluto: { chans: new Map(), progs: new Map(), fetched: null, error: null },
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function norm(s) {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\.(uk|us|in|de|fr|ca)$/, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/(hd|uhd|sd|hevc)+$/, "");
}

ALIAS_NORM = new Map(Object.entries(ALIASES).map(([k, v]) => [norm(k), v]));

function parseXmltvDate(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
  if (!m) return null;
  let ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) {
    const off = (+m[8] * 60 + +m[9]) * 60000;
    ts += m[7] === "+" ? -off : off;
  }
  return ts;
}

function parseFeed(xml) {
  const chans = new Map();
  for (const m of xml.matchAll(/<channel id="([^"]+)"\s*>([\s\S]*?)<\/channel>/g)) {
    const names = [...m[2].matchAll(/<display-name[^>]*>([^<]*)<\/display-name>/g)].map((x) =>
      decodeEntities(x[1].trim())
    );
    chans.set(m[1], names);
  }

  const progs = new Map();
  const from = Date.now() - 3 * 3600e3;
  const to = Date.now() + 48 * 3600e3;
  for (const m of xml.matchAll(/<programme\s+([^>]+)>([\s\S]*?)<\/programme>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-z]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const start = parseXmltvDate(attrs.start || "");
    const stop = parseXmltvDate(attrs.stop || "");
    if (!start || !stop || stop < from || start > to) continue;
    const title = (m[2].match(/<title[^>]*>([^<]*)<\/title>/) || [])[1];
    if (!title) continue;
    const desc = (m[2].match(/<desc[^>]*>([^<]*)<\/desc>/) || [])[1];
    if (!progs.has(attrs.channel)) progs.set(attrs.channel, []);
    progs.get(attrs.channel).push({
      start,
      stop,
      title: decodeEntities(title),
      desc: desc ? decodeEntities(desc).slice(0, 300) : null,
    });
  }
  for (const list of progs.values()) list.sort((a, b) => a.start - b.start);
  return { chans, progs };
}

function rebuildMapping(channels) {
  // Candidate lookup tables from the EPG side. Ids that actually carry
  // programme data register first so they win normalization collisions
  // (e.g. MUTV.uk with no data vs MUTV.HD.uk with data).
  const byId = new Map();
  const byNormId = new Map();
  const byNormName = new Map();
  const orderedIds = [...epgNames.keys()].sort(
    (a, b) => (programmes.has(b) ? 1 : 0) - (programmes.has(a) ? 1 : 0)
  );
  for (const id of orderedIds) {
    const names = epgNames.get(id);
    byId.set(id, id);
    if (!byNormId.has(norm(id))) byNormId.set(norm(id), id);
    for (const n of names) {
      if (!byNormName.has(norm(n))) byNormName.set(norm(n), id);
    }
  }

  mapping = new Map();
  unmatched = [];
  for (const c of channels) {
    // Pluto-sourced streams embed Pluto's channel _id in the URL
    // (jmp2.uk/plu-<id>.m3u8) — an exact join, so it wins outright.
    const plutoId = (c.url.match(/\/plu-([a-f0-9]{24})/) || [])[1];
    if (plutoId && programmes.has(`pluto:${plutoId}`)) {
      mapping.set(c.id, `pluto:${plutoId}`);
      continue;
    }
    const tvgBase = (c.tvgId || "").split("@")[0];
    const epgId =
      byId.get(tvgBase) ||
      ALIAS_NORM.get(norm(c.name)) ||
      byNormId.get(norm(tvgBase)) ||
      byNormName.get(norm(c.name)) ||
      byNormId.get(norm(c.name)) ||
      null;
    if (epgId && programmes.has(epgId)) mapping.set(c.id, epgId);
    else unmatched.push(c.name);
  }
}

// Pluto geo-targets by IP; the box's IPv6 egresses in the wrong country,
// so this fetch is pinned to IPv4.
function fetchIPv4(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { family: 4, headers: { "user-agent": UA }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const bufs = [];
        res.on("data", (d) => bufs.push(d));
        res.on("end", () => resolve(Buffer.concat(bufs)));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function fetchXmltv() {
  const resp = await fetch(EPG_URL, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const gz = Buffer.from(await resp.arrayBuffer());
  const xml = zlib.gunzipSync(gz).toString("utf8");
  const { chans, progs } = parseFeed(xml);
  if (chans.size === 0 || progs.size === 0) throw new Error("parsed empty");
  return { chans, progs };
}

async function fetchPluto() {
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  const stop = new Date(start.getTime() + 14 * 3600e3);
  const url = `${PLUTO_API}?start=${start.toISOString()}&stop=${stop.toISOString()}`;
  const list = JSON.parse((await fetchIPv4(url)).toString("utf8"));
  if (!Array.isArray(list) || list.length === 0) throw new Error("empty channel list");
  const chans = new Map();
  const progs = new Map();
  for (const c of list) {
    if (!c._id || !c.name) continue;
    const key = `pluto:${c._id}`;
    chans.set(key, [c.name]);
    const items = [];
    for (const t of c.timelines || []) {
      const startTs = Date.parse(t.start);
      const stopTs = Date.parse(t.stop);
      if (!startTs || !stopTs || !t.title) continue;
      const desc = t.episode?.description;
      items.push({
        start: startTs,
        stop: stopTs,
        title: t.title,
        desc: desc ? String(desc).slice(0, 300) : null,
      });
    }
    if (items.length) {
      items.sort((a, b) => a.start - b.start);
      progs.set(key, items);
    }
  }
  if (progs.size === 0) throw new Error("no timelines");
  return { chans, progs };
}

async function refreshEpg(getChannels) {
  const jobs = { xmltv: fetchXmltv(), pluto: fetchPluto() };
  for (const [name, job] of Object.entries(jobs)) {
    try {
      const { chans, progs } = await job;
      sources[name] = { chans, progs, fetched: new Date(), error: null };
    } catch (err) {
      sources[name].error = err.message;
      console.error(`EPG source ${name} failed: ${err.message} (keeping last good data)`);
    }
  }
  if (sources.xmltv.progs.size === 0 && sources.pluto.progs.size === 0) {
    throw new Error("all EPG sources failed");
  }

  epgNames = new Map([...sources.xmltv.chans, ...sources.pluto.chans]);
  programmes = new Map([...sources.xmltv.progs, ...sources.pluto.progs]);
  lastEpgRefresh = new Date();
  rebuildMapping(getChannels());
  console.log(
    `EPG refreshed: ${epgNames.size} channels (${sources.pluto.chans.size} pluto), ` +
      `${[...programmes.values()].reduce((a, l) => a + l.length, 0)} programmes, ${mapping.size} matched`
  );
}

// { [ourChannelId]: { now: {...}, next: {...} } } for matched channels
function getNowNext() {
  const now = Date.now();
  const out = {};
  for (const [chId, epgId] of mapping) {
    const list = programmes.get(epgId);
    if (!list) continue;
    let current = null;
    let next = null;
    for (const p of list) {
      if (p.start <= now && now < p.stop) current = p;
      else if (p.start > now) {
        next = p;
        break;
      }
    }
    if (current || next) out[chId] = { now: current, next };
  }
  return out;
}

function status() {
  return {
    lastEpgRefresh,
    epgChannels: epgNames.size,
    matched: mapping.size,
    sources: Object.fromEntries(
      Object.entries(sources).map(([k, s]) => [
        k,
        { channels: s.chans.size, withProgrammes: s.progs.size, fetched: s.fetched, error: s.error },
      ])
    ),
    unmatched,
  };
}

module.exports = { refreshEpg, rebuildMapping, getNowNext, status };

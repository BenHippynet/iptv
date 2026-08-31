// EPG: fetches an XMLTV guide feed, matches its channels to our playlist
// channels (exact tvg-id, then normalized id/name, then hand-written
// aliases), and answers "what's on now & next" per channel.

const zlib = require("zlib");

const EPG_URL =
  process.env.EPG_URL || "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz";
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

async function refreshEpg(getChannels) {
  const resp = await fetch(EPG_URL, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) throw new Error(`EPG fetch: HTTP ${resp.status}`);
  const gz = Buffer.from(await resp.arrayBuffer());
  const xml = zlib.gunzipSync(gz).toString("utf8");
  const { chans, progs } = parseFeed(xml);
  if (chans.size === 0 || progs.size === 0) throw new Error("EPG parsed empty");
  epgNames = chans;
  programmes = progs;
  lastEpgRefresh = new Date();
  rebuildMapping(getChannels());
  console.log(
    `EPG refreshed: ${chans.size} channels, ${[...progs.values()].reduce((a, l) => a + l.length, 0)} programmes, ${mapping.size} matched`
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
    unmatched,
  };
}

module.exports = { refreshEpg, rebuildMapping, getNowNext, status };

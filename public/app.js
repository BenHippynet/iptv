(() => {
  const grid = document.getElementById("grid");
  const groupsNav = document.getElementById("groups");
  const searchInput = document.getElementById("search");
  const meta = document.getElementById("meta");
  const playerWrap = document.getElementById("player-wrap");
  const video = document.getElementById("video");
  const nowPlaying = document.getElementById("now-playing");
  const playerError = document.getElementById("player-error");
  const closeBtn = document.getElementById("close-player");

  let channels = [];
  let activeGroup = "All";
  let query = "";
  let playingId = null;
  let hls = null;

  const favs = new Set(JSON.parse(localStorage.getItem("iptv-favs") || "[]"));
  const saveFavs = () => localStorage.setItem("iptv-favs", JSON.stringify([...favs]));

  // ---------------- Player ----------------

  function stopPlayback() {
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute("src");
    video.load();
    playingId = null;
    playerWrap.hidden = true;
    playerError.hidden = true;
    document.querySelectorAll(".card.playing").forEach((el) => el.classList.remove("playing"));
  }

  function showError(msg) {
    playerError.textContent = msg;
    playerError.hidden = false;
  }

  function play(ch) {
    stopPlayback();
    playingId = ch.id;
    playerWrap.hidden = false;
    playerError.hidden = true;
    nowPlaying.textContent = ch.name + (ch.quality ? ` (${ch.quality})` : "");
    document.querySelector(`.card[data-id="${ch.id}"]`)?.classList.add("playing");
    playerWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        manifestLoadingTimeOut: 15000,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 25000,
      });
      let recoveries = 0;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
          recoveries++;
          hls.recoverMediaError();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveries < 2) {
          recoveries++;
          hls.startLoad();
        } else {
          showError(
            "This stream could not be played. It may be offline, geo-blocked, or not 24/7."
          );
          hls.destroy();
          hls = null;
        }
      });
      hls.loadSource(ch.src);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = ch.src;
      video.onerror = () =>
        showError("This stream could not be played. It may be offline or geo-blocked.");
    } else {
      showError("HLS playback is not supported in this browser.");
    }
    video.play().catch(() => {});
  }

  closeBtn.addEventListener("click", stopPlayback);

  // ---------------- Rendering ----------------

  function visibleChannels() {
    let list = channels;
    if (activeGroup === "★ Favorites") list = list.filter((c) => favs.has(c.id));
    else if (activeGroup !== "All") list = list.filter((c) => c.group === activeGroup);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    return list;
  }

  function renderGroups() {
    const names = [...new Set(channels.map((c) => c.group))].sort();
    const all = ["All", "★ Favorites", ...names];
    groupsNav.innerHTML = "";
    for (const g of all) {
      const btn = document.createElement("button");
      btn.className = "chip" + (g === activeGroup ? " active" : "");
      btn.textContent = g;
      btn.addEventListener("click", () => {
        activeGroup = g;
        renderGroups();
        renderGrid();
      });
      groupsNav.appendChild(btn);
    }
  }

  function renderGrid() {
    const list = visibleChannels();
    grid.innerHTML = "";
    if (list.length === 0) {
      grid.innerHTML = '<div class="empty">No channels match.</div>';
      return;
    }
    for (const ch of list) {
      const card = document.createElement("div");
      card.className = "card" + (ch.id === playingId ? " playing" : "");
      card.dataset.id = ch.id;

      const logo = document.createElement("div");
      logo.className = "logo";
      if (ch.logo) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = ch.logo;
        img.alt = "";
        img.onerror = () => (logo.innerHTML = '<span class="placeholder">📺</span>');
        logo.appendChild(img);
      } else {
        logo.innerHTML = '<span class="placeholder">📺</span>';
      }

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = ch.name;

      const badges = document.createElement("div");
      badges.className = "badges";
      if (ch.quality) {
        const b = document.createElement("span");
        b.className = "badge quality";
        b.textContent = ch.quality;
        badges.appendChild(b);
      }
      for (const t of ch.tags) {
        const b = document.createElement("span");
        b.className = "badge warn";
        b.textContent = t;
        badges.appendChild(b);
      }

      const fav = document.createElement("button");
      fav.className = "fav" + (favs.has(ch.id) ? " on" : "");
      fav.textContent = "★";
      fav.title = "Favourite";
      fav.addEventListener("click", (e) => {
        e.stopPropagation();
        favs.has(ch.id) ? favs.delete(ch.id) : favs.add(ch.id);
        saveFavs();
        fav.classList.toggle("on");
        if (activeGroup === "★ Favorites") renderGrid();
      });

      card.append(fav, logo, name, badges);
      card.addEventListener("click", () => play(ch));
      grid.appendChild(card);
    }
  }

  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value.trim();
      renderGrid();
    }, 150);
  });

  // ---------------- Init ----------------

  async function init() {
    try {
      const resp = await fetch("/api/channels");
      const data = await resp.json();
      channels = data.channels;
      meta.textContent = `${channels.length} channels`;
      renderGroups();
      renderGrid();
    } catch {
      grid.innerHTML = '<div class="empty">Failed to load channel list.</div>';
    }
  }

  init();
})();

(() => {
  const API = '';
  const audio = new Audio();
  let tracks = [];
  let currentTrack = null;
  let rightClickedTrack = null;
  let pollTimer = null;
  let forcePollEnd = 0;
  let dlStartTime = 0;
  let dlStartCount = 0;

  // --- WebSocket / Jam ---
  let ws = null;
  let isHost = false;
  let jamActive = false;

  // --- DOM refs ---
  const $ = id => document.getElementById(id);

  // --- Navigation ---
  function showView(viewName) {
    document.querySelectorAll('.nav-pill').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.add('hidden'));
    const pill = document.querySelector(`.nav-pill[data-view="${viewName}"]`);
    if (pill) pill.classList.add('active');
    $('view-' + viewName)?.classList.remove('hidden');
  }

  document.querySelectorAll('.nav-pill[data-view]').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // Home greeting
  function setGreeting() {
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const el = $('home-greeting');
    if (el) el.textContent = greet;
  }
  setGreeting();

  let profiles = [];
  let activeProfile = JSON.parse(localStorage.getItem('syncbeats_profile') || 'null');
  let customPlaylists = [];
  let repeatMode = 'off'; // 'off' | 'one' | 'all'
  let isAuthenticated = localStorage.getItem('syncbeats_auth') === 'true';

  // --- Password Visibility Toggle ---
  const togglePwSpan = $('toggle-pw-btn');
  const pwInput = $('auth-key-input');
  if (togglePwSpan && pwInput) {
    togglePwSpan.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isPassword = pwInput.type === 'password';
      pwInput.type = isPassword ? 'text' : 'password';
      const eyeOff = $('eye-icon-off');
      const eyeOn = $('eye-icon-on');
      if (eyeOff) eyeOff.style.display = isPassword ? 'none' : 'block';
      if (eyeOn) eyeOn.style.display = isPassword ? 'block' : 'none';
    });
  }

  // --- Liked Songs (Isolated Per Profile) ---
  function getLikedSongs() {
    if (!activeProfile) return new Set();
    const stored = localStorage.getItem(`syncbeats_liked_${activeProfile.id}`);
    return new Set(stored ? JSON.parse(stored) : []);
  }

  function saveLikedSongs(setObj) {
    if (!activeProfile) return;
    localStorage.setItem(`syncbeats_liked_${activeProfile.id}`, JSON.stringify(Array.from(setObj)));
  }

  // --- Auth Verification ---
  async function checkAuth() {
    const authModal = $('auth-modal');
    if (isAuthenticated) {
      authModal?.classList.add('hidden');
      loadProfiles();
      return;
    }
    authModal?.classList.remove('hidden');
  }


  $('auth-key-input')?.addEventListener('input', () => {
    const err = $('auth-error');
    if (err) err.style.display = 'none';
  });

  $('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('auth-key-input').value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Verifying...';
    
    try {
      const r = await fetch(API + '/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      if (r.ok) {
        isAuthenticated = true;
        localStorage.setItem('syncbeats_auth', 'true');
        const modal = $('auth-modal');
        if (modal) {
          modal.classList.add('hidden');
          modal.style.display = 'none';
        }
        toast('Access Granted! Welcome to SyncBeats.');
        loadProfiles();
      } else {
        const err = $('auth-error');
        if (err) err.style.display = 'block';
        if (submitBtn) submitBtn.textContent = 'Unlock';
      }
    } catch (err) {
      const errEl = $('auth-error');
      if (errEl) errEl.style.display = 'block';
      if (submitBtn) submitBtn.textContent = 'Unlock';
    }
  });

  // --- Profiles Management ---
  async function loadProfiles() {
    try {
      const r = await fetch(API + '/profiles');
      profiles = await r.json();
      renderProfileGrid();
      // Always show profile selection screen if activeProfile isn't set, or allow switching
      if (!activeProfile) {
        showProfileModal();
      } else {
        updateProfileUI();
        loadCustomPlaylists();
      }
    } catch (e) {}
  }

  function updateProfileUI() {
    const nameEl = $('active-profile-name');
    if (nameEl && activeProfile) {
      nameEl.textContent = activeProfile.name;
    }
  }

  function showProfileModal() {
    $('profile-modal')?.classList.remove('hidden');
  }

  $('switch-profile-btn')?.addEventListener('click', () => {
    showProfileModal();
  });

  function renderProfileGrid() {
    const grid = $('profile-grid');
    if (!grid) return;
    grid.className = 'profile-grid';
    grid.innerHTML = profiles.map(p => `
      <div class="profile-card ${activeProfile && activeProfile.id === p.id ? 'active' : ''}" data-pid="${p.id}">
        ${profiles.length > 1 ? `<button class="profile-del-btn" data-del-pid="${p.id}" title="Delete Profile">✕</button>` : ''}
        <div class="profile-avatar-circle">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </div>
        <div class="profile-card-name">${esc(p.name)}</div>
      </div>
    `).join('');

    grid.querySelectorAll('.del-profile-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pid = parseInt(btn.dataset.delPid);
        const targetProf = profiles.find(x => x.id === pid);
        if (!targetProf) return;
        if (confirm(`Delete profile "${targetProf.name}"?`)) {
          try {
            const res = await fetch(API + `/profiles/${pid}`, { method: 'DELETE' });
            if (res.ok) {
              toast(`Profile "${targetProf.name}" deleted.`);
              if (activeProfile && activeProfile.id === pid) {
                activeProfile = null;
                localStorage.removeItem('syncbeats_profile');
              }
              await loadProfiles();
              loadCustomPlaylists();
              renderLibrary();
            }
          } catch (err) {
            toast('Failed to delete profile', 'error');
          }
        }
      });
    });

    grid.querySelectorAll('[data-pid]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.del-profile-btn')) return;
        const pid = parseInt(card.dataset.pid);
        activeProfile = profiles.find(x => x.id === pid);
        localStorage.setItem('syncbeats_profile', JSON.stringify(activeProfile));
        updateProfileUI();
        $('profile-modal')?.classList.add('hidden');
        toast(`Logged in as ${activeProfile.name}`);
        loadCustomPlaylists();
        if (typeof renderLibrary === 'function') renderLibrary();
      });
    });
  }


  $('create-profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('new-profile-name').value.trim();
    if (!name) return;
    try {
      const r = await fetch(API + '/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, avatar: 'user' })
      });
      if (r.ok) {
        const p = await r.json();
        $('new-profile-name').value = '';
        activeProfile = p;
        localStorage.setItem('syncbeats_profile', JSON.stringify(activeProfile));
        // Clear any old liked songs key for fresh profile
        localStorage.removeItem(`syncbeats_liked_${p.id}`);
        $('profile-modal')?.classList.add('hidden');
        toast(`Profile "${p.name}" created! Welcome.`);
        loadProfiles();
      }
    } catch (e) {}
  });


  // --- Custom Playlists Modal ---
  function openCreatePlaylistModal(defaultName = '') {
    if (!activeProfile) return toast('Please select a profile first', 'error');
    const modal = $('create-playlist-modal');
    const input = $('playlist-modal-name');
    if (modal && input) {
      input.value = defaultName;
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 100);
    }
  }

  function closeCreatePlaylistModal() {
    $('create-playlist-modal')?.classList.add('hidden');
  }

  $('create-playlist-btn')?.addEventListener('click', () => openCreatePlaylistModal());
  $('close-create-playlist-modal')?.addEventListener('click', closeCreatePlaylistModal);
  $('cancel-create-playlist-btn')?.addEventListener('click', closeCreatePlaylistModal);

  $('create-playlist-modal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('playlist-modal-name').value.trim();
    if (!name || !activeProfile) return;

    try {
      const r = await fetch(API + '/custom-playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, profile_id: activeProfile.id })
      });
      if (r.ok) {
        const cp = await r.json();
        closeCreatePlaylistModal();
        toast(`Playlist "${cp.name}" created!`);
        await loadCustomPlaylists();
        if (pendingAddTrackId) {
          await addTrackToCustomPlaylist(cp.id, pendingAddTrackId);
          pendingAddTrackId = null;
        }
      }
    } catch (err) {
      toast('Failed to create playlist', 'error');
    }
  });

  let pendingAddTrackId = null;

  async function loadCustomPlaylists() {
    if (!activeProfile) return;
    try {
      const r = await fetch(API + `/custom-playlists/${activeProfile.id}`);
      customPlaylists = await r.json();
      renderSidebar();
    } catch (e) {}
  }



  // --- Toast ---
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }


  // --- Format helpers ---
  function fmt(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // --- Download Terminal Logger ---
  let lastLogCount = -1;
  async function loadDownloadLogs() {
    try {
      const r = await fetch(API + '/download-logs');
      if (!r.ok) return;
      const logs = await r.json();
      const term = $('download-terminal');
      if (!term) return;

      if (!logs || logs.length === 0) {
        if (lastLogCount !== 0) {
          term.innerHTML = '<div class="term-line" style="color:#888;">[SYSTEM] Terminal ready. Download logs will appear below...</div>';
          lastLogCount = 0;
        }
        return;
      }

      if (logs.length === lastLogCount) return;
      lastLogCount = logs.length;

      term.innerHTML = logs.map(l => {
        let color = '#33ff66';
        if (l.level === 'ERROR') color = '#ff5555';
        else if (l.level === 'WARNING') color = '#ffb86c';
        else if (l.level === 'SKIP') color = '#8be9fd';

        return `<div class="term-line" style="color:${color};margin-bottom:2px;">[${esc(l.timestamp)}] [${esc(l.level)}] ${esc(l.message)}</div>`;
      }).join('');

      term.scrollTop = term.scrollHeight;
    } catch (e) {}
  }

  // Poll download logs continuously every 1s
  setInterval(loadDownloadLogs, 1000);

  const clearTermBtn = $('clear-term-btn');
  if (clearTermBtn) {
    clearTermBtn.addEventListener('click', async () => {
      try {
        await fetch(API + '/download-logs/clear', { method: 'POST' });
      } catch (e) {}
      lastLogCount = -1;
      const term = $('download-terminal');
      if (term) term.innerHTML = '<div class="term-line" style="color:#888;">[SYSTEM] Logs cleared.</div>';
    });
  }

  // --- Fetch tracks ---
  async function loadTracks() {
    try {
      const r = await fetch(API + '/tracks');
      tracks = await r.json();
      renderLibrary();
      renderDownloadQueue();
      renderSidebar();
      updateDlBanner();
      loadDownloadLogs();
    } catch (e) { console.error(e); }
  }



  let searchQuery = '';
  let activePlaylist = null; // null means 'All Songs'
  const UNKNOWN_ARTISTS = new Set(['', 'unknown', 'unknown artist', 'various artists', 'n/a', 'none']);
  const isUnknownArtist = (artist) => UNKNOWN_ARTISTS.has((artist || '').trim().toLowerCase());

  // --- Search Input Listeners (Topbar, Library & Playlist) ---
  const handleSearchInput = (val) => {
    searchQuery = (val || '').trim().toLowerCase();
    
    // If on playlist view, filter the current playlist without leaving
    if ($('view-playlist') && !$('view-playlist').classList.contains('hidden')) {
      renderPlaylistViewSearch(searchQuery);
      return;
    }

    // Switch to home view if searching from home topbar
    if (searchQuery && $('view-home')?.classList.contains('hidden')) {
      showView('home');
    }

    renderLibrary();
  };

  ['search-input', 'pl-search-input', 'track-search-input', 'pl-search-filter-input'].forEach(id => {
    $(id)?.addEventListener('input', (e) => handleSearchInput(e.target.value));
  });

  // --- Sidebar Playlist Selector ---
  document.querySelectorAll('[data-filter="all"]').forEach(btn => {
    btn.addEventListener('click', () => {
      activePlaylist = null;
      renderLibrary();
      renderSidebar();
    });
  });

  document.querySelectorAll('[data-filter="unknown-artists"]').forEach(btn => {
    btn.addEventListener('click', () => {
      activePlaylist = 'UNKNOWN_ARTISTS';
      renderLibrary();
      renderSidebar();
    });
  });

  // --- Download Queue Renderer ---
  function renderDownloadQueue() {
    const queueEl = $('download-queue');
    if (!queueEl) return;

    const pendingOrProcessing = tracks.filter(t => t.status === 'pending' || t.status === 'processing');
    if (pendingOrProcessing.length === 0) {
      queueEl.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:8px 0;">No active downloads in progress.</div>';
      return;
    }

    queueEl.innerHTML = '';
    pendingOrProcessing.forEach(t => {
      const isError = t.status === 'error';
      const item = document.createElement('div');
      item.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:${isError ? 'rgba(226,33,52,0.1)' : 'rgba(255,255,255,0.05)'};border-radius:6px;margin-bottom:6px;border:1px solid ${isError ? 'rgba(226,33,52,0.3)' : 'transparent'};`;

      const info = document.createElement('div');
      info.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;margin-right:12px;';

      const titleEl = document.createElement('div');
      titleEl.style.cssText = `font-weight:600;font-size:0.9rem;color:${isError ? '#fca5a5' : '#fff'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      titleEl.textContent = t.title || 'Processing track...';

      const subEl = document.createElement('div');
      subEl.style.cssText = 'font-size:0.75rem;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      subEl.textContent = t.artist ? `${t.artist} · ${t.youtube_url || ''}` : (t.youtube_url || '');

      info.appendChild(titleEl);
      info.appendChild(subEl);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:12px;flex-shrink:0;';

      const statusEl = document.createElement('span');
      statusEl.style.cssText = `font-size:0.8rem;color:${isError ? 'var(--red)' : 'var(--green)'};font-weight:600;`;
      statusEl.textContent = t.step || t.status;

      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'width:80px;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;';
      const barFill = document.createElement('div');
      barFill.style.cssText = `width:${t.progress || 0}%;height:100%;background:${isError ? 'var(--red)' : 'var(--green)'};transition:width 0.3s;`;
      barWrap.appendChild(barFill);

      right.appendChild(statusEl);
      right.appendChild(barWrap);
      item.appendChild(info);
      item.appendChild(right);
      queueEl.appendChild(item);
    });
  }

  // --- Download Banner (playlist-level progress) ---
  function updateDlBanner() {
    const banner = $('dl-banner');
    const active = tracks.filter(t => t.status === 'pending' || t.status === 'processing');
    const recent = tracks.filter(t => {
      // Count tracks that were part of recent batch (last 60s)
      return t.status === 'pending' || t.status === 'processing' || t.status === 'ready' || t.status === 'error';
    });

    if (active.length === 0) {
      banner?.classList.add('hidden');
      return;
    }

    banner?.classList.remove('hidden');
    const total = active.length + tracks.filter(t => t.status === 'ready').length;
    const done = tracks.filter(t => t.status === 'ready').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // Calculate speed
    let speedText = '—';
    if (dlStartTime > 0) {
      const elapsed = (Date.now() - dlStartTime) / 1000;
      const tracksCompleted = done - dlStartCount;
      if (elapsed > 2 && tracksCompleted > 0) {
        const rate = tracksCompleted / (elapsed / 60);
        speedText = `${rate.toFixed(1)} tracks/min`;
      } else if (elapsed > 2) {
        speedText = 'Starting...';
      }
    }

    if ($('dl-banner-title')) $('dl-banner-title').textContent = `Downloading ${active.length} track${active.length > 1 ? 's' : ''}...`;
if ($('dl-banner-done')) $('dl-banner-done').textContent = done;
    if ($('dl-banner-total')) $('dl-banner-total').textContent = total;
    if ($('dl-banner-speed')) $('dl-banner-speed').textContent = speedText;
    if ($('dl-banner-fill')) $('dl-banner-fill').style.width = pct + '%';
    if ($('dl-banner-pct')) $('dl-banner-pct').textContent = pct + '%';
  }

  // --- Render Library (main track table with filtering & search) ---
  function renderLibrary() {
    const el = $('track-list');
    if (!el) return;

    const likedSet = getLikedSongs();

    // Filter by playlist / Liked Songs and search query
    let filtered = tracks;
    if (activePlaylist === 'LIKED') {
      filtered = filtered.filter(t => likedSet.has(t.id));
    } else if (activePlaylist === 'UNKNOWN_ARTISTS') {
      filtered = filtered.filter(t => isUnknownArtist(t.artist));
    } else if (activePlaylist && typeof activePlaylist === 'object' && activePlaylist.track_ids) {
      const pTrackIds = new Set(activePlaylist.track_ids);
      filtered = filtered.filter(t => pTrackIds.has(t.id));
    } else if (activePlaylist && typeof activePlaylist === 'string') {
      filtered = filtered.filter(t => (t.playlist || 'My Library') === activePlaylist);
    }

    if (searchQuery) {
      filtered = filtered.filter(t =>
        (t.title && t.title.toLowerCase().includes(searchQuery)) ||
        (t.artist && t.artist.toLowerCase().includes(searchQuery))
      );
    }

    const readyTracks = filtered.filter(t => t.status === 'ready');
    const stats = $('library-stats');
    if (stats) stats.textContent = `${readyTracks.length} song${readyTracks.length !== 1 ? 's' : ''} · ${fmt(readyTracks.reduce((a, t) => a + (t.duration || 0), 0))} total`;

    // Update filter badge
    const badge = $('current-filter-badge');
    if (badge) {
      let label = 'All Songs';
      if (activePlaylist === 'LIKED') label = 'Liked Songs';
      else if (activePlaylist === 'UNKNOWN_ARTISTS') label = 'Needs Artist Review';
      else if (activePlaylist && activePlaylist.name) label = `Playlist: ${activePlaylist.name}`;
      else if (typeof activePlaylist === 'string') label = `Playlist: ${activePlaylist}`;
      if (searchQuery) label += ` · "${searchQuery}"`;

      badge.innerHTML = `${esc(label)} ${(activePlaylist || searchQuery) ? '<span class="close-filter" id="clear-filter-btn">✕</span>' : ''}`;
      $('clear-filter-btn')?.addEventListener('click', () => {
        activePlaylist = null;
        searchQuery = '';
        if (searchInput) searchInput.value = '';
        renderLibrary();
        renderSidebar();
      });
    }

    if (!filtered.length) {
      if (searchQuery) {
        el.innerHTML = `<p style="color:var(--text-sub);text-align:center;padding:60px 0;font-size:.88rem">No songs found matching "${esc(searchQuery)}".</p>`;
      } else if (activePlaylist === 'LIKED') {
        el.innerHTML = `<p style="color:var(--text-sub);text-align:center;padding:60px 0;font-size:.88rem">You haven't liked any songs yet.<br><span style="color:var(--muted);font-size:.78rem">Right-click any song to add it to Liked Songs.</span></p>`;
      } else if (activePlaylist === 'UNKNOWN_ARTISTS') {
        el.innerHTML = '<p style="color:var(--text-sub);text-align:center;padding:60px 0;font-size:.88rem">Great — every visible track has an artist.</p>';
      } else if (activePlaylist) {
        el.innerHTML = `<p style="color:var(--text-sub);text-align:center;padding:60px 0;font-size:.88rem">No songs in playlist "${esc(activePlaylist.name || activePlaylist)}".</p>`;
      } else {
        el.innerHTML = '<p style="color:var(--text-sub);text-align:center;padding:60px 0;font-size:.88rem">Your library is empty.<br><span style="color:var(--muted);font-size:.78rem">Go to Download to add music.</span></p>';
      }
      return;
    }

    el.innerHTML = `
      <div class="track-table">
        <div class="track-header">
          <div>#</div><div>Title</div><div>Status</div><div>Duration</div><div></div>
        </div>
        ${filtered.map((t, i) => {
          const isActive = currentTrack?.id === t.id;
          const isProcessing = t.status === 'pending' || t.status === 'processing';
          const isError = t.status === 'error';
          const pct = t.progress || 0;
          const isLiked = likedSet.has(t.id);

          return `
            <div class="track-row ${isActive ? 'active' : ''}" data-id="${t.id}">
              <div class="track-art-col">
                <svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
              </div>
              <div class="track-num">
                <span class="track-num-text">${isActive ? '♫' : (i + 1)}</span>
                <span class="track-play-icon">▶</span>
              </div>
              <div class="track-info">
                <div class="track-title ${isProcessing ? 'downloading' : ''}" style="display:flex;align-items:center;gap:6px">
                  ${esc(t.title)}
                  ${isLiked ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="#1db954"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' : ''}
                </div>
                <div class="track-artist">${esc(t.artist)}</div>
                ${isProcessing ? `
                  <div class="track-dl-progress">
                    <div class="track-dl-bar"><div class="track-dl-fill" style="width:${pct}%"></div></div>
                    <span class="track-dl-text">${esc(t.step || 'Queued')} ${pct.toFixed(0)}%</span>
                  </div>
                ` : ''}
              </div>
              <div class="track-status">
                <span class="dot dot-${t.status}"></span>
                <span class="${isError ? 'status-error-link' : ''}" data-err-id="${isError ? t.id : ''}">${t.status}</span>
              </div>
              <div class="track-dur">${t.duration ? fmt(t.duration) : '—'}</div>
              <div class="track-actions">
                ${t.status === 'ready' ? `
                  <a href="${API}/download/${t.id}" download class="track-action-btn" title="Download MP3 to device">⬇</a>
                ` : ''}
                <button class="track-action-btn del" data-del="${t.id}" title="Remove">✕</button>
                <button class="track-more-btn" data-more="${t.id}" title="Options">⋮</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Event listeners
    el.querySelectorAll('.track-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.track-action-btn') || e.target.closest('.track-more-btn') || e.target.closest('.status-error-link')) return;
        const id = Number(row.dataset.id);
        const t = tracks.find(x => x.id === id);
        if (t && t.status === 'ready') playTrack(t);
      });

      row.addEventListener('contextmenu', (e) => {
        const id = Number(row.dataset.id);
        const t = tracks.find(x => x.id === id);
        if (t) showContextMenu(e, t);
      });

      row.querySelector('.track-more-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(row.dataset.id);
        const t = tracks.find(x => x.id === id);
        if (t) showContextMenu(e, t);
      });
    });

    el.querySelectorAll('.status-error-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = Number(link.dataset.errId);
        const t = tracks.find(x => x.id === id);
        if (t && t.error) showErrorModal(t.title, t.error);
      });
    });

    el.querySelectorAll('.del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.del);
        await fetch(API + '/tracks/' + id, { method: 'DELETE' });
        loadTracks();
      });
    });

    // Download All MP3s handler
    const dlAllBtn = $('dl-all-btn');
    if (dlAllBtn) {
      dlAllBtn.onclick = () => {
        const ready = filtered.filter(t => t.status === 'ready');
        if (!ready.length) return toast('No ready tracks to download', 'error');
        ready.forEach(t => {
          const a = document.createElement('a');
          a.href = `${API}/download/${t.id}`;
          a.download = t.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
      };
    }

    // Polling
    if (tracks.some(t => t.status === 'pending' || t.status === 'processing') || Date.now() < forcePollEnd) {
      if (!pollTimer) pollTimer = setInterval(loadTracks, 1000);
    } else {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // --- Sidebar Spotify Playlists Renderer ---
  function renderSidebar() {
    const el = $('sidebar-playlists');
    const countEl = $('lib-count');
    if (!el) return;

    const likedCount = getLikedSongs().size;
    const playlistTotal = customPlaylists.length + (likedCount > 0 ? 1 : 0);
    if (countEl) countEl.textContent = `${playlistTotal} playlist${playlistTotal !== 1 ? 's' : ''}`;

    const profName = activeProfile ? activeProfile.name : 'You';

    let html = `
      <!-- Liked Songs (Pinned) -->
      <div class="sidebar-playlist-item ${activePlaylist === 'LIKED' ? 'active' : ''}" data-plist="LIKED">
        <div class="sidebar-playlist-art liked-art">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </div>
        <div class="sidebar-playlist-info">
          <div class="sidebar-playlist-title">Liked Songs</div>
          <div class="sidebar-playlist-sub">
            <span class="pin-badge">
              <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
              Playlist
            </span>
            <span>· ${likedCount} song${likedCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    `;

    // Render user's custom playlists
    customPlaylists.forEach(p => {
      const isActive = activePlaylist && typeof activePlaylist === 'object' && activePlaylist.id === p.id;
      const tCount = p.track_ids ? p.track_ids.length : 0;
      html += `
        <div class="sidebar-playlist-item ${isActive ? 'active' : ''}" data-custom-id="${p.id}">
          <div class="sidebar-playlist-art">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="var(--text-sub)"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
          </div>
          <div class="sidebar-playlist-info">
            <div class="sidebar-playlist-title">${esc(p.name)}</div>
            <div class="sidebar-playlist-sub">
              <span class="pin-badge">
                <svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                ${esc(profName)}
              </span>
              <span>· ${tCount} song${tCount !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>
      `;
    });

    el.innerHTML = html;

    const mobileLibEl = $('mobile-library-playlists');
    if (mobileLibEl) {
      mobileLibEl.innerHTML = html;
    }

    const attachPlaylistClicks = (container) => {
      if (!container) return;
      container.querySelectorAll('[data-plist="LIKED"]').forEach(item => {
        item.addEventListener('click', () => {
          openPlaylistView('LIKED');
        });
      });
      container.querySelectorAll('[data-custom-id]').forEach(item => {
        item.addEventListener('click', () => {
          const cid = parseInt(item.dataset.customId);
          const pl = customPlaylists.find(x => x.id === cid) || null;
          openPlaylistView(pl);
        });
      });
    };

    attachPlaylistClicks(el);
    attachPlaylistClicks(mobileLibEl);
    renderQuickPicks();
  }

  // --- Home Quick Picks (2-Column Spotify Mobile Grid) ---
  function renderQuickPicks() {
    const qpEl = $('quick-picks-grid');
    if (!qpEl) return;

    const likedCount = getLikedSongs().size;
    let html = `
      <div class="quick-pick-card" data-qp="LIKED">
        <div class="quick-pick-art liked-art">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        </div>
        <div class="quick-pick-title">Liked Songs</div>
      </div>
    `;

    customPlaylists.slice(0, 7).forEach(p => {
      html += `
        <div class="quick-pick-card" data-qp-custom="${p.id}">
          <div class="quick-pick-art">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="var(--text-sub)"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
          </div>
          <div class="quick-pick-title">${esc(p.name)}</div>
        </div>
      `;
    });

    qpEl.innerHTML = html;

    qpEl.querySelector('[data-qp="LIKED"]')?.addEventListener('click', () => openPlaylistView('LIKED'));
    qpEl.querySelectorAll('[data-qp-custom]').forEach(item => {
      item.addEventListener('click', () => {
        const cid = parseInt(item.dataset.qpCustom);
        const pl = customPlaylists.find(x => x.id === cid) || null;
        openPlaylistView(pl);
      });
    });
  }

  // --- Playlist Detail View ---
  function openPlaylistView(pl) {
    activePlaylist = pl;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $('view-playlist')?.classList.remove('hidden');

    const heroName = $('playlist-hero-name');
    const heroType = $('playlist-hero-type');
    const heroMeta = $('playlist-hero-meta');

    let plTracks = [];
    if (pl === 'LIKED') {
      const likedSet = getLikedSongs();
      plTracks = tracks.filter(t => likedSet.has(t.id));
      if (heroName) heroName.textContent = 'Liked Songs';
      if (heroType) heroType.textContent = 'Playlist';
      if (heroMeta) heroMeta.textContent = `${activeProfile ? activeProfile.name : 'You'} · ${plTracks.length} song${plTracks.length !== 1 ? 's' : ''}`;
    } else if (pl && typeof pl === 'object') {
      const pSet = new Set(pl.track_ids || []);
      plTracks = tracks.filter(t => pSet.has(t.id));
      if (heroName) heroName.textContent = pl.name;
      if (heroType) heroType.textContent = 'Playlist';
      if (heroMeta) heroMeta.textContent = `Playlist by ${activeProfile ? activeProfile.name : 'User'} · ${plTracks.length} song${plTracks.length !== 1 ? 's' : ''}`;
    }

    renderPlaylistBody(plTracks);
  }

  function renderPlaylistViewSearch(query) {
    if (!activePlaylist) return;
    let plTracks = [];
    if (activePlaylist === 'LIKED') {
      const likedSet = getLikedSongs();
      plTracks = tracks.filter(t => likedSet.has(t.id));
    } else if (typeof activePlaylist === 'object') {
      const pSet = new Set(activePlaylist.track_ids || []);
      plTracks = tracks.filter(t => pSet.has(t.id));
    }
    if (query) {
      plTracks = plTracks.filter(t =>
        (t.title && t.title.toLowerCase().includes(query)) ||
        (t.artist && t.artist.toLowerCase().includes(query))
      );
    }
    renderPlaylistBody(plTracks);
  }

  function renderPlaylistBody(plTracks) {
    const bodyEl = $('playlist-track-list');
    if (!bodyEl) return;

    if (!plTracks.length) {
      bodyEl.innerHTML = '<p style="color:var(--text-sub);text-align:center;padding:60px 0;font-size:.88rem">This playlist is empty.</p>';
      return;
    }

    const likedSet = getLikedSongs();

    bodyEl.innerHTML = `
      <div class="track-table">
        <div class="track-header">
          <div>#</div><div>Title</div><div>Status</div><div>Duration</div><div></div>
        </div>
        ${plTracks.map((t, i) => {
          const isActive = currentTrack?.id === t.id;
          const isLiked = likedSet.has(t.id);
          return `
            <div class="track-row ${isActive ? 'active' : ''}" data-id="${t.id}">
              <div class="track-num">
                <span class="track-num-text">${isActive ? '♫' : (i + 1)}</span>
                <span class="track-play-icon">▶</span>
              </div>
              <div class="track-info">
                <div class="track-title" style="display:flex;align-items:center;gap:6px">
                  ${esc(t.title)}
                  ${isLiked ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="#1db954"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>' : ''}
                </div>
                <div class="track-artist">${esc(t.artist)}</div>
              </div>
              <div class="track-status">
                <span class="dot dot-${t.status}"></span>
                <span>${t.status}</span>
              </div>
              <div class="track-dur">${t.duration ? fmt(t.duration) : '—'}</div>
              <div class="track-actions">
                <button class="track-action-btn del" data-del="${t.id}" title="Remove">✕</button>
                <button class="track-more-btn" data-more="${t.id}" title="Options">⋮</button>
              </div>
            </div>`;
        }).join('')}
      </div>`;

    bodyEl.querySelectorAll('.track-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.track-action-btn') || e.target.closest('.track-more-btn')) return;
        const id = Number(row.dataset.id);
        const t = tracks.find(x => x.id === id);
        if (t && t.status === 'ready') playTrack(t);
      });

      row.addEventListener('contextmenu', (e) => {
        const id = Number(row.dataset.id);
        const t = tracks.find(x => x.id === id);
        if (t) showContextMenu(e, t);
      });
    });
  }

  // Playlist view back buttons, download & play all
  $('pl-back-btn')?.addEventListener('click', () => showView('home'));
  $('pl-play-btn')?.addEventListener('click', () => {
    let plTracks = [];
    if (activePlaylist === 'LIKED') {
      const likedSet = getLikedSongs();
      plTracks = tracks.filter(t => likedSet.has(t.id));
    } else if (activePlaylist && typeof activePlaylist === 'object') {
      const pSet = new Set(activePlaylist.track_ids || []);
      plTracks = tracks.filter(t => pSet.has(t.id));
    }
    const ready = plTracks.filter(t => t.status === 'ready');
    if (ready.length > 0) playTrack(ready[0]);
  });

  // Download Playlist button (Spotify style ZIP export)
  $('pl-download-btn')?.addEventListener('click', () => {
    if (activePlaylist && typeof activePlaylist === 'object' && activePlaylist.id) {
      toast(`Preparing download for playlist "${activePlaylist.name}"...`);
      window.location.href = API + `/download/playlist/${activePlaylist.id}`;
    } else if (activePlaylist === 'LIKED') {
      toast('Downloading individual liked tracks from library...');
      const likedSet = getLikedSongs();
      const likedTracks = tracks.filter(t => likedSet.has(t.id) && t.status === 'ready');
      if (likedTracks.length === 0) return toast('No ready tracks in Liked Songs to download', 'error');
      likedTracks.forEach((t, i) => {
        setTimeout(() => {
          const a = document.createElement('a');
          a.href = API + `/download/${t.id}`;
          a.download = `${t.title || 'track'}.mp3`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, i * 300);
      });
    } else {
      toast('Please open a custom playlist to download it as a ZIP', 'error');
    }
  });

  let isShuffle = false;
  let userQueue = [];
  let shuffledQueue = [];

  function generateShuffledQueue() {
    const ready = tracks.filter(t => t.status === 'ready');
    const remaining = ready.filter(t => !currentTrack || t.id !== currentTrack.id);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    shuffledQueue = remaining;
  }

  function updateShuffleUI() {
    const dskShuffle = $('shuffle-btn');
    const fpShuffle = $('fp-shuffle-btn');
    if (dskShuffle) dskShuffle.classList.toggle('active', isShuffle);
    if (fpShuffle) fpShuffle.classList.toggle('active', isShuffle);
  }

  // --- Queue Panel (Desktop & Mobile) ---
  function updateQueuePanel() {
    const nowEl = $('queue-now-track');
    const nextEl = $('queue-next-list');
    const fpQueueList = $('fp-queue-list');

    const ready = tracks.filter(t => t.status === 'ready');
    const curIdx = ready.findIndex(t => t.id === currentTrack?.id);

    let upcoming = [];
    if (isShuffle) {
      upcoming = shuffledQueue.slice(0, 15);
    } else {
      upcoming = curIdx >= 0 ? ready.slice(curIdx + 1, curIdx + 16) : ready.slice(0, 15);
    }

    const combined = [...userQueue.slice(0, 5), ...upcoming].slice(0, 15);

    // Desktop Queue Panel
    if (nowEl && nextEl) {
      if (currentTrack) {
        nowEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px;padding:8px 0">
            <div style="width:40px;height:40px;border-radius:4px;background:#282828;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="#1db954"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
            </div>
            <div style="min-width:0">
              <div style="font-size:.85rem;font-weight:600;color:#1db954;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(currentTrack.title)}</div>
              <div style="font-size:.75rem;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(currentTrack.artist)}</div>
            </div>
          </div>`;
      } else {
        nowEl.innerHTML = '<div style="color:var(--muted);font-size:.82rem;padding:8px 0">Nothing playing</div>';
      }

      if (!combined.length) {
        nextEl.innerHTML = '<div style="color:var(--muted);font-size:.82rem;padding:8px 0">Queue is empty</div>';
      } else {
        nextEl.innerHTML = combined.map((t, i) => `
          <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-radius:4px;cursor:pointer" class="queue-track-item" data-qid="${t.id}">
            <div style="width:36px;height:36px;border-radius:4px;background:#282828;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:.75rem;color:var(--text-sub)">${i < userQueue.slice(0,5).length ? '★' : (i + 1)}</div>
            <div style="min-width:0;flex:1">
              <div style="font-size:.85rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
              <div style="font-size:.75rem;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist)}</div>
            </div>
          </div>`).join('');

        nextEl.querySelectorAll('.queue-track-item').forEach(item => {
          item.addEventListener('click', () => {
            const tid = Number(item.dataset.qid);
            const t = tracks.find(x => x.id === tid);
            if (t) playTrack(t);
          });
        });
      }
    }

    // Mobile Queue Drawer
    if (fpQueueList) {
      if (!combined.length) {
        fpQueueList.innerHTML = '<div style="color:var(--muted);font-size:.9rem;text-align:center;padding:40px 0">Queue is empty</div>';
      } else {
        fpQueueList.innerHTML = `
          <div style="font-size:.78rem;font-weight:700;color:var(--text-sub);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">${isShuffle ? 'Shuffled Next' : 'Next Up'}</div>
          ${combined.map((t, i) => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer" class="fp-queue-item" data-qid="${t.id}">
              <div style="width:40px;height:40px;border-radius:6px;background:#282828;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:.8rem;color:var(--text-sub)">${i < userQueue.slice(0,5).length ? '★' : (i + 1)}</div>
              <div style="min-width:0;flex:1">
                <div style="font-size:.92rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</div>
                <div style="font-size:.8rem;color:var(--text-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist)}</div>
              </div>
              <div style="font-size:.78rem;color:var(--text-sub)">${t.duration ? fmt(t.duration) : ''}</div>
            </div>`).join('')}`;

        fpQueueList.querySelectorAll('.fp-queue-item').forEach(item => {
          item.addEventListener('click', () => {
            const tid = Number(item.dataset.qid);
            const t = tracks.find(x => x.id === tid);
            if (t) {
              playTrack(t);
              $('fp-queue-drawer')?.classList.add('hidden');
            }
          });
        });
      }
    }
  }

  $('queue-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('queue-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) updateQueuePanel();
  });

  $('close-queue-btn')?.addEventListener('click', () => $('queue-panel')?.classList.add('hidden'));

  // Full Player Queue Drawer Toggle
  $('fp-queue-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const drawer = $('fp-queue-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    if (!drawer.classList.contains('hidden')) updateQueuePanel();
  });

  $('close-fp-queue-btn')?.addEventListener('click', () => $('fp-queue-drawer')?.classList.add('hidden'));

  // --- Shuffle Toggle ---
  const toggleShuffle = () => {
    isShuffle = !isShuffle;
    if (isShuffle) generateShuffledQueue();
    updateShuffleUI();
    updateQueuePanel();
    toast(isShuffle ? 'Shuffle enabled' : 'Shuffle disabled');
  };

  $('shuffle-btn')?.addEventListener('click', toggleShuffle);
  $('fp-shuffle-btn')?.addEventListener('click', toggleShuffle);

  // --- Context Menu Management ---
  const ctxMenu = $('context-menu');
  const ctxSubmenu = $('ctx-playlist-submenu');

  function hideContextMenu() {
    ctxMenu?.classList.add('hidden');
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });

  function showContextMenu(e, track) {
    e.preventDefault();
    if (!ctxMenu) return;
    rightClickedTrack = track;

    // Populate playlist submenu with user's custom playlists
    let subHtml = customPlaylists.map(p => `
      <div class="ctx-item" data-act="add-to-custom-plist" data-cpid="${p.id}">
        <span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-right:6px"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
          ${esc(p.name)}
        </span>
      </div>
    `).join('');

    subHtml += `
      <div class="ctx-divider"></div>
      <div class="ctx-item" data-act="create-new-custom-plist">
        <span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-right:6px"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          New Playlist...
        </span>
      </div>
    `;
    if (ctxSubmenu) ctxSubmenu.innerHTML = subHtml;

    // Update Toggle Liked label
    const likedSet = getLikedSongs();
    const isLiked = likedSet.has(track.id);
    const likedItem = $('ctx-remove-liked');
    if (likedItem) {
      likedItem.querySelector('span:last-child').textContent = isLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs';
    }

    // Re-attach submenu listeners
    ctxSubmenu?.querySelectorAll('[data-act]').forEach(item => {
      item.addEventListener('click', async (evt) => {
        evt.stopPropagation();
        hideContextMenu();
        const act = item.dataset.act;
        if (act === 'add-to-custom-plist') {
          const cpid = parseInt(item.dataset.cpid);
          await addTrackToCustomPlaylist(cpid, rightClickedTrack.id);
        } else if (act === 'create-new-custom-plist') {
          pendingAddTrackId = rightClickedTrack.id;
          openCreatePlaylistModal();
        }

      });
    });

    // Position menu within viewport
    const x = Math.min(e.clientX, window.innerWidth - 230);
    const y = Math.min(e.clientY, window.innerHeight - 200);
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.remove('hidden');
  }

  async function addTrackToCustomPlaylist(playlistId, trackId) {
    try {
      await fetch(API + `/custom-playlists/${playlistId}/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: trackId })
      });
      toast('Added to playlist');
      loadCustomPlaylists();
    } catch (err) {
      toast('Failed to add to playlist', 'error');
    }
  }

  // Toggle Liked Songs on right-click menu item
  $('ctx-remove-liked')?.addEventListener('click', () => {
    if (!rightClickedTrack) return;
    hideContextMenu();
    const likedSet = getLikedSongs();
    if (likedSet.has(rightClickedTrack.id)) {
      likedSet.delete(rightClickedTrack.id);
      toast(`Removed "${rightClickedTrack.title}" from Liked Songs`);
    } else {
      likedSet.add(rightClickedTrack.id);
      toast(`Added "${rightClickedTrack.title}" to Liked Songs`);
    }
    saveLikedSongs(likedSet);
    renderLibrary();
    renderSidebar();
  });


  $('ctx-add-queue')?.addEventListener('click', () => {
    if (!rightClickedTrack) return;
    hideContextMenu();
    userQueue.push(rightClickedTrack);
    toast(`Added "${rightClickedTrack.title}" to queue`);
    updateQueuePanel();
  });

  $('ctx-play-next')?.addEventListener('click', () => {
    if (!rightClickedTrack) return;
    hideContextMenu();
    userQueue.unshift(rightClickedTrack);
    toast(`Will play "${rightClickedTrack.title}" next`);
    updateQueuePanel();
  });

  $('ctx-remove-playlist')?.addEventListener('click', async () => {
    if (!rightClickedTrack || !activePlaylist || typeof activePlaylist !== 'object') return;
    hideContextMenu();
    try {
      await fetch(API + `/custom-playlists/${activePlaylist.id}/tracks/${rightClickedTrack.id}`, { method: 'DELETE' });
      toast(`Removed "${rightClickedTrack.title}" from ${activePlaylist.name}`);
      await loadCustomPlaylists();
      if (activePlaylist) openPlaylistView(customPlaylists.find(p => p.id === activePlaylist.id) || activePlaylist);
    } catch (e) {
      toast('Failed to remove track from playlist', 'error');
    }
  });

  $('ctx-edit-metadata')?.addEventListener('click', async () => {
    if (!rightClickedTrack) return;
    hideContextMenu();
    const title = prompt('Track title', rightClickedTrack.title || '');
    if (title === null) return;
    const artist = prompt('Artist', rightClickedTrack.artist || '');
    if (artist === null) return;
    if (!title.trim() || !artist.trim()) return toast('Title and artist are required', 'error');
    try {
      const response = await fetch(API + `/tracks/${rightClickedTrack.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist })
      });
      if (!response.ok) throw new Error('update failed');
      toast('Track metadata updated');
      await loadTracks();
    } catch (error) {
      toast('Could not update track metadata', 'error');
    }
  });

  // --- Next Track Picker (supports Shuffle & Queue) ---
  function getNextTrack() {
    const ready = tracks.filter(t => t.status === 'ready');
    if (!ready.length) return null;

    if (userQueue.length > 0) {
      const trk = userQueue.shift();
      updateQueuePanel();
      return trk;
    }

    if (isShuffle) {
      if (!shuffledQueue.length) generateShuffledQueue();
      const trk = shuffledQueue.shift() || ready[0];
      updateQueuePanel();
      return trk;
    }

    const idx = ready.findIndex(t => t.id === currentTrack?.id);
    if (idx >= 0 && idx < ready.length - 1) return ready[idx + 1];
    return ready[0];
  }

  function getPrevTrack() {
    const ready = tracks.filter(t => t.status === 'ready');
    if (!ready.length) return null;

    if (isShuffle) {
      const candidates = ready.filter(t => !currentTrack || t.id !== currentTrack.id);
      if (!candidates.length) return ready[0];
      const randIdx = Math.floor(Math.random() * candidates.length);
      return candidates[randIdx];
    }

    const idx = ready.findIndex(t => t.id === currentTrack?.id);
    if (idx > 0) return ready[idx - 1];
    return ready[ready.length - 1];
  }

  // --- Error Modal ---
  function showErrorModal(title, errText) {
    const modal = $('error-modal');
    const textEl = $('error-modal-text');
    if (modal && textEl) {
      textEl.textContent = `Track: ${title}\n\n${errText}`;
      modal.classList.remove('hidden');
    }
  }

  const modalClose = $('error-modal-close');
  if (modalClose) {
    modalClose.addEventListener('click', () => {
      $('error-modal')?.classList.add('hidden');
    });
  }

  // --- Playback ---
  function updatePlayerLikeBtn() {
    const likeBtn = $('player-like-btn');
    const fpLikeBtn = $('fp-like-btn');
    if (!currentTrack) {
      if (likeBtn) likeBtn.style.color = 'var(--text-sub)';
      if (fpLikeBtn) fpLikeBtn.style.color = 'var(--text-sub)';
      return;
    }
    const likedSet = getLikedSongs();
    const isLiked = likedSet.has(currentTrack.id);
    const color = isLiked ? 'var(--green)' : 'var(--text-sub)';
    if (likeBtn) likeBtn.style.color = color;
    if (fpLikeBtn) fpLikeBtn.style.color = color;
  }

  $('fp-like-btn')?.addEventListener('click', () => $('player-like-btn')?.click());

  function playTrack(t) {
    if (!t) return;
    currentTrack = t;
    audio.src = API + '/download/' + t.id;
    audio.play();
    $('np-title').textContent = t.title;
    $('np-artist').textContent = t.artist;
    if ($('fp-title')) $('fp-title').textContent = t.title;
    if ($('fp-artist')) $('fp-artist').textContent = t.artist;
    updatePlayIcon(true);
    updatePlayerLikeBtn();
    renderLibrary();
    updateQueuePanel();

    if (jamActive && isHost) {
      wsSend({ type: 'track_change', track_id: t.id, position: 0 });
    }

    // Set lock screen media controls (iOS & Android)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: 'SyncBeats',
        artwork: [
          { src: '/static/icon.svg', sizes: '512x512', type: 'image/svg+xml' }
        ]
      });
      navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNext());
    }
  }

  function updatePlayIcon(playing) {
    const icon = $('play-icon');
    const fpIcon = $('fp-play-icon');
    const mIcon = $('mobile-play-icon');
    const svgPath = playing
      ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
      : '<path d="M8 5v14l11-7z"/>';
    if (icon) icon.innerHTML = svgPath;
    if (fpIcon) fpIcon.innerHTML = svgPath;
    if (mIcon) mIcon.innerHTML = svgPath;
  }

  $('mobile-play-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('play-btn')?.click();
  });

  const togglePlayPause = () => {
    if (!currentTrack) {
      // If nothing is playing, play first available ready track
      const ready = tracks.filter(t => t.status === 'ready');
      if (ready.length > 0) playTrack(ready[0]);
      return;
    }
    if (audio.paused) {
      audio.play();
      updatePlayIcon(true);
      if (jamActive) wsSend({ type: 'play', position: audio.currentTime });
    } else {
      audio.pause();
      updatePlayIcon(false);
      if (jamActive) wsSend({ type: 'pause', position: audio.currentTime });
    }
  };

  $('play-btn')?.addEventListener('click', togglePlayPause);
  $('fp-play-btn')?.addEventListener('click', togglePlayPause);

  // Player Bar Like Button
  $('player-like-btn')?.addEventListener('click', () => {
    if (!currentTrack) return;
    const likedSet = getLikedSongs();
    if (likedSet.has(currentTrack.id)) {
      likedSet.delete(currentTrack.id);
      toast(`Removed "${currentTrack.title}" from Liked Songs`);
    } else {
      likedSet.add(currentTrack.id);
      toast(`Added "${currentTrack.title}" to Liked Songs`);
    }
    saveLikedSongs(likedSet);
    updatePlayerLikeBtn();
    renderLibrary();
    renderSidebar();
  });

  // Library Play All button
  $('lib-play-all-btn')?.addEventListener('click', () => {
    const ready = tracks.filter(t => t.status === 'ready');
    if (ready.length > 0) playTrack(ready[0]);
    else toast('No songs available to play', 'error');
  });

  // Playlist view profile switcher
  $('pl-switch-profile-btn')?.addEventListener('click', () => {
    showProfileModal();
  });

  // --- Repeat Mode Handler ---
  // (repeatMode is declared at the top of the IIFE)

  function updateRepeatUI() {
    const dskRep = $('repeat-btn');
    const fpRep = $('fp-repeat-btn');
    const dskIcon = $('repeat-icon');
    const fpIcon = $('fp-repeat-icon');

    const isActive = repeatMode !== 'off';
    if (dskRep) dskRep.classList.toggle('active', isActive);
    if (fpRep) fpRep.classList.toggle('active', isActive);

    let iconSvg = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';
    if (repeatMode === 'one') {
      iconSvg = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-3V9h-1l-2 1v1h1.5v4H13z"/>';
    }
    if (dskIcon) dskIcon.innerHTML = iconSvg;
    if (fpIcon) fpIcon.innerHTML = iconSvg;
  }

  const toggleRepeat = () => {
    if (repeatMode === 'off') {
      repeatMode = 'all';
      toast('Repeat Playlist enabled');
    } else if (repeatMode === 'all') {
      repeatMode = 'one';
      toast('Repeat Track enabled');
    } else {
      repeatMode = 'off';
      toast('Repeat disabled');
    }
    updateRepeatUI();
  };

  $('repeat-btn')?.addEventListener('click', toggleRepeat);
  $('fp-repeat-btn')?.addEventListener('click', toggleRepeat);

  // Next / Previous
  const handleNext = () => {
    const nxt = getNextTrack();
    if (nxt) playTrack(nxt);
  };

  const handlePrev = () => {
    const prv = getPrevTrack();
    if (prv) playTrack(prv);
  };

  $('next-btn')?.addEventListener('click', handleNext);
  $('fp-next-btn')?.addEventListener('click', handleNext);
  $('prev-btn')?.addEventListener('click', handlePrev);
  $('fp-prev-btn')?.addEventListener('click', handlePrev);

  // Expand / Close Full Mobile Player
  $('player-bar')?.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && !e.target.closest('button')) {
      $('full-player-modal')?.classList.remove('hidden');
    }
  });

  $('close-full-player-btn')?.addEventListener('click', () => {
    $('full-player-modal')?.classList.add('hidden');
  });

  audio.addEventListener('timeupdate', () => {
    if (!audio.duration || isSeeking || isDesktopSeeking) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    $('progress-fill').style.width = pct + '%';
    if ($('player-bar')) $('player-bar').style.setProperty('--player-progress', pct + '%');
    if ($('fp-progress-fill')) $('fp-progress-fill').style.width = pct + '%';
    $('time-cur').textContent = fmt(audio.currentTime);
    $('time-dur').textContent = fmt(audio.duration);
    if ($('fp-time-cur')) $('fp-time-cur').textContent = fmt(audio.currentTime);
    if ($('fp-time-dur')) $('fp-time-dur').textContent = fmt(audio.duration);
  });

  // Robust Seekbar Drag & Click handling (Touch & Mouse)
  let isSeeking = false;
  let isDesktopSeeking = false;

  function handleSeek(clientX, barEl) {
    if (!audio.duration || !barEl) return;
    const rect = barEl.getBoundingClientRect();
    const pos = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const pct = (pos / rect.width);
    const newTime = pct * audio.duration;
    
    $('progress-fill').style.width = (pct * 100) + '%';
    if ($('player-bar')) $('player-bar').style.setProperty('--player-progress', (pct * 100) + '%');
    if ($('fp-progress-fill')) $('fp-progress-fill').style.width = (pct * 100) + '%';
    if ($('time-cur')) $('time-cur').textContent = fmt(newTime);
    if ($('fp-time-cur')) $('fp-time-cur').textContent = fmt(newTime);
    return newTime;
  }

  // Mobile Full Player Seekbar
  const fpBar = $('fp-progress-bar');
  if (fpBar) {
    const onTouchMove = (e) => {
      if (!isSeeking) return;
      const touch = e.touches[0];
      handleSeek(touch.clientX, fpBar);
    };

    const onTouchEnd = (e) => {
      if (!isSeeking) return;
      isSeeking = false;
      const touch = e.changedTouches[0];
      const finalTime = handleSeek(touch.clientX, fpBar);
      if (finalTime !== undefined && !isNaN(finalTime)) {
        audio.currentTime = finalTime;
        if (jamActive) wsSend({ type: 'seek', position: finalTime });
      }
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    fpBar.addEventListener('touchstart', (e) => {
      isSeeking = true;
      const touch = e.touches[0];
      handleSeek(touch.clientX, fpBar);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd, { passive: false });
    }, { passive: false });

    fpBar.addEventListener('click', (e) => {
      const finalTime = handleSeek(e.clientX, fpBar);
      if (finalTime !== undefined && !isNaN(finalTime)) {
        audio.currentTime = finalTime;
        if (jamActive) wsSend({ type: 'seek', position: finalTime });
      }
    });
  }

  // Desktop Player Seekbar
  const dskBar = $('progress-bar');
  if (dskBar) {
    const onMouseMove = (e) => {
      if (!isDesktopSeeking) return;
      handleSeek(e.clientX, dskBar);
    };
    const onMouseUp = (e) => {
      if (!isDesktopSeeking) return;
      isDesktopSeeking = false;
      const finalTime = handleSeek(e.clientX, dskBar);
      if (finalTime !== undefined && !isNaN(finalTime)) {
        audio.currentTime = finalTime;
        if (jamActive) wsSend({ type: 'seek', position: finalTime });
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    dskBar.addEventListener('mousedown', (e) => {
      isDesktopSeeking = true;
      handleSeek(e.clientX, dskBar);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    dskBar.addEventListener('click', (e) => {
      const finalTime = handleSeek(e.clientX, dskBar);
      if (finalTime !== undefined && !isNaN(finalTime)) {
        audio.currentTime = finalTime;
        if (jamActive) wsSend({ type: 'seek', position: finalTime });
      }
    });
  }

  // Audio Ended Handler
  audio.addEventListener('ended', () => {
    updatePlayIcon(false);
    $('progress-fill').style.width = '0%';
    if ($('fp-progress-fill')) $('fp-progress-fill').style.width = '0%';

    if (repeatMode === 'one' && currentTrack) {
      playTrack(currentTrack);
      return;
    }

    const nxt = getNextTrack();
    if (nxt) {
      playTrack(nxt);
    } else if (repeatMode === 'all') {
      const ready = tracks.filter(t => t.status === 'ready');
      if (ready.length > 0) playTrack(ready[0]);
    }
  });

  // Volume
  const volSlider = $('volume-slider');
  const volIcon = $('vol-icon');
  if (volSlider) {
    volSlider.addEventListener('input', (e) => { audio.volume = e.target.value; });
  }
  if (volIcon) {
    volIcon.addEventListener('click', () => {
      audio.muted = !audio.muted;
      volIcon.textContent = audio.muted ? '🔇' : '🔊';
    });
  }

  // --- Ingest: Single Song ---
  $('song-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('song-url').value.trim();
    if (!url) return;
    try {
      const r = await fetch(API + '/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, profile_id: activeProfile ? activeProfile.id : null }),
      });
      const data = await r.json();
      if (data.status === 'duplicate') {
        toast('Track already exists: ' + (data.title || ''), 'error');
      } else {
        toast('Song queued for download!');
        forcePollEnd = Date.now() + 20000;
        if (!pollTimer) pollTimer = setInterval(loadTracks, 1000);
      }
      $('song-url').value = '';
      showView('download');
      await loadTracks();
      await loadDownloadLogs();
    } catch (err) {
      toast('Failed to add song', 'error');
    }
  });

  // --- Ingest: Playlist ---
  $('playlist-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('playlist-url').value.trim();
    if (!url) return;
    const createPlaylist = $('playlist-as-custom-pl')?.checked || false;
    const customName = $('playlist-custom-name')?.value.trim() || null;
    try {
      toast('Extracting playlist tracks and checking for duplicates...');
      const r = await fetch(API + '/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          profile_id: activeProfile ? activeProfile.id : null,
          create_playlist: createPlaylist,
          playlist_name: customName,
        }),
      });
      const data = await r.json();
      if (data.status === 'playlist_queued') {
        const total = data.total_extracted || 0;
        const skipped = data.skipped_duplicates || 0;
        const queued = data.queued_count || 0;
        const plName = data.playlist_name || 'Playlist';
        if (createPlaylist && activeProfile) {
          toast(`Saved "${plName}" (${total} tracks: ${skipped} already in library, ${queued} queued to download)!`);
          await loadCustomPlaylists();
        } else if (total > 0) {
          toast(`Playlist loaded: ${total} songs extracted (${skipped} duplicates skipped, ${queued} queued)!`);
        } else {
          toast('Playlist queued! Tracks will appear as they are extracted.');
        }
        dlStartTime = Date.now();
        dlStartCount = tracks.filter(t => t.status === 'ready').length;
        forcePollEnd = Date.now() + 60000;
        if (!pollTimer) pollTimer = setInterval(loadTracks, 1000);
      } else if (data.status === 'duplicate') {
        toast('Track already exists in your library!', 'warning');
      } else {
        toast('Queued for download!');
        forcePollEnd = Date.now() + 30000;
        if (!pollTimer) pollTimer = setInterval(loadTracks, 1000);
      }
      $('playlist-url').value = '';
      if ($('playlist-custom-name')) $('playlist-custom-name').value = '';
      showView('download');
      await loadTracks();
      await loadDownloadLogs();
    } catch (err) {
      toast('Failed to add playlist', 'error');
    }
  });

  const handleBatchSubmit = async (e) => {
    if (e) e.preventDefault();
    const textarea = $('batch-urls');
    if (!textarea) return;
    const url = textarea.value.trim();
    if (!url) return;
    const createPlaylist = $('batch-as-custom-pl')?.checked || false;
    const customName = $('batch-custom-name')?.value.trim() || null;
    try {
      toast('Processing multiline URL list and extracting tracks...');
      const r = await fetch(API + '/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          profile_id: activeProfile ? activeProfile.id : null,
          create_playlist: createPlaylist,
          playlist_name: customName,
        }),
      });
      const data = await r.json();
      if (data.status === 'playlist_queued') {
        const total = data.total_extracted || 0;
        const skipped = data.skipped_duplicates || 0;
        const queued = data.queued_count || 0;
        const plName = data.playlist_name || 'Batch Playlist';
        if (createPlaylist && activeProfile) {
          toast(`Saved "${plName}" (${total} tracks: ${skipped} in library, ${queued} queued to download)!`);
          await loadCustomPlaylists();
        } else {
          toast(`Batch queued: ${queued} tracks downloading (${skipped} duplicates skipped)`);
        }
        dlStartTime = Date.now();
        dlStartCount = tracks.filter(t => t.status === 'ready').length;
        forcePollEnd = Date.now() + Math.max(queued * 30000, 60000);
        if (!pollTimer) pollTimer = setInterval(loadTracks, 1000);
      } else {
        toast('Batch list queued!');
        forcePollEnd = Date.now() + 60000;
        if (!pollTimer) pollTimer = setInterval(loadTracks, 1000);
      }
      textarea.value = '';
      if ($('batch-custom-name')) $('batch-custom-name').value = '';
      showView('download');
      await loadTracks();
      await loadDownloadLogs();
    } catch (err) {
      toast('Failed to process batch URLs', 'error');
    }
  };

  $('batch-submit-btn')?.addEventListener('click', handleBatchSubmit);
  $('batch-form')?.addEventListener('submit', handleBatchSubmit);



  // --- Jam WebSocket ---
  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  $('jam-connect-btn').addEventListener('click', () => {
    const room = $('room-input').value.trim() || 'default-room';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/${room}`);

    ws.onopen = () => {
      jamActive = true;
      $('jam-status').classList.remove('hidden');
      $('jam-connect-btn').classList.add('hidden');
      toast('Joined room: ' + room);
    };

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      switch (data.type) {
        case 'connected':
          isHost = data.is_host;
          $('jam-info').textContent = (isHost ? '👑 Host' : '🎧 Listener') + ' · ' + data.members + ' in room';
          if (data.state && data.state.track_id) {
            const t = tracks.find(x => x.id === data.state.track_id);
            if (t) {
              currentTrack = t;
              audio.src = API + '/download/' + t.id;
              audio.currentTime = data.state.position || 0;
              $('np-title').textContent = t.title;
              $('np-artist').textContent = t.artist;
              if ($('fp-title')) $('fp-title').textContent = t.title;
              if ($('fp-artist')) $('fp-artist').textContent = t.artist;
              if (data.state.is_playing) {
                audio.play().catch(() => {});
                updatePlayIcon(true);
              } else {
                audio.pause();
                updatePlayIcon(false);
              }
              renderLibrary();
            }
          }
          break;
        case 'member_update':
          $('jam-info').textContent = (isHost ? '👑 Host' : '🎧 Listener') + ' · ' + data.members + ' in room';
          break;
        case 'track_change':
          if (!isHost) {
            const t = tracks.find(x => x.id === data.track_id);
            if (t) {
              currentTrack = t;
              audio.src = API + '/download/' + t.id;
              audio.currentTime = data.position || 0;
              $('np-title').textContent = t.title;
              $('np-artist').textContent = t.artist;
              if ($('fp-title')) $('fp-title').textContent = t.title;
              if ($('fp-artist')) $('fp-artist').textContent = t.artist;
              audio.play().catch(() => {});
              updatePlayIcon(true);
              renderLibrary();
            }
          }
          break;
        case 'play':
          if (!isHost) {
            if (data.position !== undefined) audio.currentTime = data.position;
            audio.play().catch(() => {});
            updatePlayIcon(true);
          }
          break;
        case 'pause':
          if (!isHost) {
            if (data.position !== undefined) audio.currentTime = data.position;
            audio.pause();
            updatePlayIcon(false);
          }
          break;
        case 'seek':
          if (!isHost) {
            if (data.position !== undefined) audio.currentTime = data.position;
          }
          break;
      }
    };

    ws.onclose = () => { disconnectJam(); };
    ws.onerror = () => { toast('WebSocket error', 'error'); disconnectJam(); };
  });

  function disconnectJam() {
    jamActive = false;
    isHost = false;
    if (ws) { ws.close(); ws = null; }
    $('jam-status')?.classList.add('hidden');
    $('jam-connect-btn')?.classList.remove('hidden');
  }

  $('jam-leave-btn')?.addEventListener('click', () => { disconnectJam(); toast('Left room'); });

  // --- Init ---
  checkAuth();
  loadTracks();
})();

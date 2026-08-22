const AIRDATE_VERSION = 46;
console.log('AIRDATE frontend v' + AIRDATE_VERSION);

const state = {
  library: [],
  upcoming: [],
  watchlist: [],
  isAdmin: false,
};

const $ = (sel) => document.querySelector(sel);

// ---------- API helper ----------
// The browser's own calendar date, not UTC — used so "today" always matches
// what the user's clock actually says, regardless of server timezone.
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function api(path, opts = {}) {
  // These endpoints do "is this today or later / has this aired" comparisons
  // server-side, so they need the browser's local date, not the server's.
  const needsToday = path.startsWith('/upcoming') || path.startsWith('/watchlist') || path.startsWith('/show/');
  if (needsToday) {
    const sep = path.includes('?') ? '&' : '?';
    path += `${sep}today=${localDateStr()}`;
  }
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('not authenticated');
  }
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

// ---------- Screens ----------
function showLogin() {
  $('#app-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}
function showApp(username, isAdmin) {
  $('#login-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  $('#current-username').textContent = username || '';
  state.isAdmin = !!isAdmin;
  boot();
}

async function checkSession() {
  try {
    const { authenticated, username, is_admin } = await api('/session');
    if (authenticated) showApp(username, is_admin);
    else showLogin();
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('bad login');
    const data = await res.json();
    $('#login-error').classList.add('hidden');
    $('#login-password').value = '';
    showApp(data.username, data.is_admin);
  } catch {
    $('#login-error').classList.remove('hidden');
  }
});

// ---------- User menu dropdown ----------
$('#current-username').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#user-dropdown').classList.toggle('hidden');
});
// Close the dropdown when clicking anywhere else on the page.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu')) $('#user-dropdown').classList.add('hidden');
});
// Close it after picking an item, regardless of what that item does.
$('#user-dropdown').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') $('#user-dropdown').classList.add('hidden');
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
});

// ---------- Accounts ----------
$('#accounts-btn').addEventListener('click', () => openAccountsModal());
$('#close-accounts-modal').addEventListener('click', () => $('#accounts-modal').classList.add('hidden'));
$('#accounts-modal').addEventListener('click', (e) => {
  if (e.target === $('#accounts-modal')) $('#accounts-modal').classList.add('hidden');
});

async function openAccountsModal() {
  $('#new-account-username').value = '';
  $('#new-account-password').value = '';
  $('#accounts-error').classList.add('hidden');
  $('#change-pw-current').value = '';
  $('#change-pw-new').value = '';
  $('#change-pw-error').classList.add('hidden');
  $('#change-pw-success').classList.add('hidden');
  $('.accounts-add-section').classList.toggle('hidden', !state.isAdmin);
  $('#accounts-modal').classList.remove('hidden');
  await renderAccountsList();
  refreshPushStatus();
}

async function renderAccountsList() {
  const container = $('#accounts-list');
  container.innerHTML = '<p class="empty-note">Loading&hellip;</p>';
  try {
    const { accounts } = await api('/accounts');
    container.innerHTML = '';
    for (const acc of accounts) {
      const row = document.createElement('div');
      row.className = 'account-row';
      const isCurrent = acc.username === $('#current-username').textContent;
      const badges = [
        acc.is_admin ? '<span class="you-badge admin-badge">Admin</span>' : '',
        isCurrent ? '<span class="you-badge">this session</span>' : '',
      ].join('');
      const canRemove = state.isAdmin && !isCurrent;
      const canReset = state.isAdmin && !isCurrent;
      row.innerHTML = `
        <span>${escapeHtml(acc.username)}</span>
        <div class="account-row-right">
          ${badges}
          ${canReset ? `<button class="btn-ghost small account-reset-btn" data-id="${acc.id}" data-username="${escapeHtml(acc.username)}">Reset password</button>` : ''}
          ${canRemove ? `<button class="btn-ghost small account-remove-btn" data-id="${acc.id}" data-username="${escapeHtml(acc.username)}">Remove</button>` : ''}
        </div>
      `;
      container.appendChild(row);
    }
    container.querySelectorAll('.account-reset-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.username;
        const newPassword = prompt(`New password for "${username}" (min. 4 characters):`);
        if (newPassword === null) return; // cancelled
        if (newPassword.length < 4) {
          alert('Password must be at least 4 characters.');
          return;
        }
        btn.disabled = true;
        try {
          await api(`/accounts/${btn.dataset.id}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ new_password: newPassword }),
          });
          alert(`Password updated for "${username}".`);
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
    container.querySelectorAll('.account-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.username;
        if (!confirm(`Remove account "${username}"? This also permanently deletes their entire library and watched history.`)) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/accounts/${btn.dataset.id}`, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to remove account');
          await renderAccountsList();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  } catch {
    container.innerHTML = '<p class="empty-note">Couldn\u2019t load accounts.</p>';
  }
}

$('#new-account-submit').addEventListener('click', async () => {
  const username = $('#new-account-username').value.trim();
  const password = $('#new-account-password').value;
  const errorEl = $('#accounts-error');
  errorEl.classList.add('hidden');
  if (!username || !password) {
    errorEl.textContent = 'Username and password are both required.';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create account');
    $('#new-account-username').value = '';
    $('#new-account-password').value = '';
    await renderAccountsList();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

$('#change-pw-submit').addEventListener('click', async () => {
  const current_password = $('#change-pw-current').value;
  const new_password = $('#change-pw-new').value;
  const errorEl = $('#change-pw-error');
  const successEl = $('#change-pw-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');
  if (!current_password || !new_password) {
    errorEl.textContent = 'Both fields are required.';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update password');
    $('#change-pw-current').value = '';
    $('#change-pw-new').value = '';
    successEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---------- Boot ----------
async function boot() {
  await loadLibrary();
  await loadUpcoming();
  refreshWatchlistBadge();
}

// ---------- Tabs ----------
$('#tab-upcoming').addEventListener('click', () => switchView('upcoming'));
$('#tab-watchlist').addEventListener('click', () => switchView('watchlist'));
$('#tab-library').addEventListener('click', () => switchView('library'));
$('#refresh-watchlist').addEventListener('click', () => loadWatchlist());

function switchView(view) {
  for (const v of ['upcoming', 'watchlist', 'library']) {
    $(`#${v}-view`).classList.toggle('hidden', v !== view);
    $(`#tab-${v}`).classList.toggle('active', v === view);
  }
  if (view === 'upcoming') loadUpcoming();
  if (view === 'watchlist') loadWatchlist();
  if (view === 'library') loadLibrary();
}

// Reloads whichever tab is currently on screen. Used after actions (like
// pausing/resuming a show) taken from within a modal, so the list behind it
// is already correct the moment the modal closes — no manual refresh needed.
function refreshActiveTab() {
  if (!$('#upcoming-view').classList.contains('hidden')) loadUpcoming();
  else if (!$('#watchlist-view').classList.contains('hidden')) loadWatchlist();
  else if (!$('#library-view').classList.contains('hidden')) loadLibrary();
}

// ---------- Watchlist ----------
async function loadWatchlist() {
  const container = $('#watchlist-list');
  container.innerHTML = '<p class="empty-note">Loading&hellip;</p>';
  const { watchlist } = await api('/watchlist');
  state.watchlist = watchlist;
  renderWatchlist();
  updateBadge(watchlist);
}

async function refreshWatchlistBadge() {
  try {
    const { watchlist } = await api('/watchlist');
    state.watchlist = watchlist;
    updateBadge(watchlist);
  } catch { /* badge is cosmetic; ignore */ }
}

function updateBadge(watchlist) {
  const total = watchlist.reduce((sum, s) => sum + s.count, 0);
  const badge = $('#watchlist-badge');
  badge.textContent = total > 99 ? '99+' : total;
  badge.classList.toggle('hidden', total === 0);
}

function renderWatchlist() {
  const container = $('#watchlist-list');
  container.innerHTML = '';
  $('#watchlist-empty').classList.toggle('hidden', state.watchlist.length > 0);

  for (const show of state.watchlist) {
    const card = document.createElement('div');
    card.className = 'watch-card';
    card.dataset.libraryId = show.library_id;

    const isMovie = show.media_type === 'movie';
    let label = isMovie
      ? 'Movie · released'
      : `${show.count} episode${show.count === 1 ? '' : 's'} behind`;
    // When only one episode is behind, its specific time is unambiguous and
    // worth surfacing right in the summary line, not just inside the row.
    if (!isMovie && show.count === 1) {
      const onlyEp = show.unwatched[0];
      const t = localAirtime(onlyEp.air_date, onlyEp.airtime, onlyEp.timezone, onlyEp.airtime_is_override, onlyEp.airstamp);
      if (t) label += ` \u00b7 ${t}`;
    }

    card.innerHTML = `
      <div class="watch-card-header">
        ${posterImg(show.poster_path, show.name)}
        <div class="info">
          <div class="name">${escapeHtml(show.name)}</div>
          <div class="meta-row">
            <span class="meta">${label}</span>
            ${!isMovie ? channelBadgeHtml(show.network, show.network_logo_path, 'sm') : ''}
          </div>
        </div>
        <button class="btn-mark-all">${isMovie ? 'Watched' : 'Mark all watched'}</button>
        ${isMovie ? '' : '<button class="btn-ghost small btn-expand">&#9662;</button>'}
      </div>
      <div class="watch-episodes hidden"></div>
    `;

    // Mark all (or the movie) watched
    card.querySelector('.btn-mark-all').addEventListener('click', async (e) => {
      e.stopPropagation();
      e.target.disabled = true;
      await api('/watched', {
        method: 'POST',
        body: JSON.stringify(
          isMovie
            ? { library_id: show.library_id, watched: true }
            : {
                library_id: show.library_id,
                watched: true,
                episodes: show.unwatched.map((ep) => ({ season: ep.season, episode: ep.episode })),
              }
        ),
      });
      await loadWatchlist();
    });

    // Expand to per-episode list
    if (!isMovie) {
      const expandBtn = card.querySelector('.btn-expand');
      const epContainer = card.querySelector('.watch-episodes');
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = epContainer.classList.contains('hidden');
        epContainer.classList.toggle('hidden');
        expandBtn.innerHTML = opening ? '&#9652;' : '&#9662;';
        if (opening && epContainer.children.length === 0) {
          renderEpisodeRows(epContainer, show);
        }
      });

      // Clicking the card itself (poster/title/anywhere but the two buttons
      // above) jumps straight into the oldest unwatched episode's detail,
      // and marking it watched there auto-advances to the next oldest.
      card.querySelector('.watch-card-header').addEventListener('click', () => {
        if (show.unwatched.length > 0) openWatchlistEpisode(show, show.unwatched[0]);
      });
    }

    container.appendChild(card);
  }
}

// Mark one episode watched, update local state, and refresh just that
// card's label (and its expanded episode list, if open) without a full
// watchlist reload — reloading only happens once a show has nothing left.
async function markWatchlistEpisodeWatched(show, ep) {
  await api('/watched', {
    method: 'POST',
    body: JSON.stringify({
      library_id: show.library_id,
      watched: true,
      episodes: [{ season: ep.season, episode: ep.episode }],
    }),
  });
  show.unwatched = show.unwatched.filter((e) => !(e.season === ep.season && e.episode === ep.episode));
  show.count = show.unwatched.length;
  refreshWatchlistBadge();

  const card = document.querySelector(`.watch-card[data-library-id="${show.library_id}"]`);
  if (card) {
    const metaEl = card.querySelector('.meta');
    if (metaEl) {
      let label = `${show.count} episode${show.count === 1 ? '' : 's'} behind`;
      metaEl.textContent = label;
    }
    const epContainer = card.querySelector('.watch-episodes');
    if (epContainer && !epContainer.classList.contains('hidden')) renderEpisodeRows(epContainer, show);
  }
}

// Open an episode's detail modal in the Watchlist context: marking it
// watched there automatically advances to the next-oldest unwatched
// episode for the same show, so you can binge through in order.
function openWatchlistEpisode(show, ep) {
  openEpisodeDetail(ep, {
    showName: show.name,
    network: show.network,
    networkLogoPath: show.network_logo_path,
    watched: false,
    onToggle: async () => {
      await markWatchlistEpisodeWatched(show, ep);
      if (show.unwatched.length > 0) {
        openWatchlistEpisode(show, show.unwatched[0]);
      } else {
        $('#episode-modal').classList.add('hidden');
        await loadWatchlist(); // show has nothing left, so it drops off the list
      }
    },
  });
}

function renderEpisodeRows(container, show) {
  container.innerHTML = '';
  for (const ep of show.unwatched) {
    const row = document.createElement('div');
    row.className = 'episode-row';
    row.dataset.season = ep.season;
    row.dataset.episode = ep.episode;
    const code = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    const time = localAirtime(ep.air_date, ep.airtime, ep.timezone, ep.airtime_is_override, ep.airstamp);
    row.innerHTML = `
      <div class="info">
        <span class="ep-code">${code}</span>
        <span class="ep-name">${escapeHtml(ep.name)}</span>
        <span class="ep-date">${ep.air_date}${time ? ' \u00b7 ' + time : ''}</span>
      </div>
      <button class="btn-check" title="Mark watched">&#10003;</button>
    `;
    // Quick check-off: marks watched right here without opening the detail
    // modal or auto-advancing — a fast lightweight action for when you
    // already know what you're checking off.
    row.querySelector('.btn-check').addEventListener('click', async (e) => {
      e.stopPropagation();
      e.target.disabled = true;
      await markWatchlistEpisodeWatched(show, ep);
      row.remove();
      if (show.unwatched.length === 0) setTimeout(() => loadWatchlist(), 300);
    });
    // Clicking the row opens full detail, and marking watched from there
    // auto-advances to the next-oldest unwatched episode for this show.
    row.addEventListener('click', () => openWatchlistEpisode(show, ep));
    container.appendChild(row);
  }
}

// ---------- Library ----------
async function loadLibrary() {
  const { library } = await api('/library');
  state.library = library;
  renderLibrary();
  refreshTvdbToggle();
}

function renderLibrary() {
  const list = $('#library-list');
  list.innerHTML = '';
  $('#library-empty').classList.toggle('hidden', state.library.length > 0);
  const tv = state.library.filter((i) => i.media_type === 'tv').length;
  const movies = state.library.length - tv;
  $('#library-count').textContent = state.library.length
    ? `${tv} show${tv === 1 ? '' : 's'} · ${movies} movie${movies === 1 ? '' : 's'}`
    : '';

  for (const item of state.library) {
    const card = document.createElement('div');
    card.className = `lib-card${item.status === 'stopped' ? ' paused' : ''}`;
    card.title = 'View details';
    card.innerHTML = `
      ${posterImg(item.poster_path, item.name, 'w185')}
      ${item.status === 'stopped' ? '<div class="paused-badge">Paused</div>' : ''}
      <div class="lib-card-body">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="badge ${item.media_type}">${item.media_type}</div>
      </div>
    `;
    card.addEventListener('click', () => openShowModal(item.id));
    list.appendChild(card);
  }
}

function posterImg(posterPath, alt, size = 'w92') {
  if (posterPath) {
    return `<img src="https://image.tmdb.org/t/p/${size}${posterPath}" alt="${escapeHtml(alt)}">`;
  }
  return `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='42'%3E%3Crect width='100%25' height='100%25' fill='%231e222b'/%3E%3C/svg%3E" alt="${escapeHtml(alt)}">`;
}

// A small inline "media" glyph used as the fallback badge when no channel
// is known at all. This is self-contained (no network request), unlike an
// external hotlink, which can silently fail to load — many sites (unlike
// TMDB's purpose-built image CDN) block or restrict direct embedding of
// their own marketing-site images from other domains.
function embyIconSvg(sizeClass) {
  return `<svg class="channel-logo emby-logo ${sizeClass}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="22" height="22" rx="6" fill="#52b54b"/>
    <path d="M9.5 7.2v9.6l8-4.8-8-4.8z" fill="#fff"/>
  </svg>`;
}

function channelLogoUrl(network, logoPath) {
  if (logoPath) return `https://image.tmdb.org/t/p/w200${logoPath}`;
  return null; // channel name is known, just no logo image available for it
}

// A small "channel stands out" badge: real logo image + name when we have
// one, an Emby-branded icon when no channel is known at all, or just the
// name as plain text when we know the channel but have no image for it.
function channelBadgeHtml(network, logoPath, sizeClass = '') {
  const url = channelLogoUrl(network, logoPath);
  if (url) {
    return `<span class="channel-badge ${sizeClass}"><img class="channel-logo ${sizeClass}" src="${url}" alt="${escapeHtml(network)}"><span class="channel-badge-label">${escapeHtml(network)}</span></span>`;
  }
  if (!network) {
    return `<span class="channel-badge ${sizeClass}">${embyIconSvg(sizeClass)}<span class="channel-badge-label">Emby</span></span>`;
  }
  return `<span class="channel-badge text-only ${sizeClass}"><span class="channel-badge-label">${escapeHtml(network)}</span></span>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ---------- Add title modal ----------
$('#add-btn').addEventListener('click', () => {
  $('#add-modal').classList.remove('hidden');
  $('#search-input').value = '';
  $('#search-results').innerHTML = '';
  $('#search-input').focus();
});
$('#close-modal').addEventListener('click', () => $('#add-modal').classList.add('hidden'));
$('#add-modal').addEventListener('click', (e) => {
  if (e.target === $('#add-modal')) $('#add-modal').classList.add('hidden');
});

let searchDebounce;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (!q) { $('#search-results').innerHTML = ''; return; }
  searchDebounce = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
  const container = $('#search-results');
  container.innerHTML = '';
  if (results.length === 0) {
    container.innerHTML = `<p class="empty-note">No matches found.</p>`;
    return;
  }
  for (const r of results) {
    const alreadyAdded = state.library.some(
      (l) => l.tmdb_id === r.tmdb_id && l.media_type === r.media_type
    );
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = `
      ${posterImg(r.poster_path, r.name)}
      <div class="info">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">${r.media_type.toUpperCase()} ${r.year ? '· ' + r.year : ''}</div>
      </div>
      <button class="add-result-btn" ${alreadyAdded ? 'disabled' : ''}>${alreadyAdded ? 'Added' : 'Add'}</button>
    `;
    div.querySelector('.add-result-btn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Added';
      await api('/library', {
        method: 'POST',
        body: JSON.stringify({
          tmdb_id: r.tmdb_id,
          media_type: r.media_type,
          name: r.name,
          poster_path: r.poster_path,
        }),
      });
      await loadLibrary();
      await loadUpcoming();
    });
    container.appendChild(div);
  }
}

// ---------- Upcoming ----------
$('#refresh-upcoming').addEventListener('click', () => loadUpcoming());

async function loadUpcoming() {
  const container = $('#upcoming-list');
  container.innerHTML = '<p class="empty-note">Loading&hellip;</p>';
  const { upcoming } = await api('/upcoming');
  state.upcoming = upcoming;
  renderUpcoming();
}

// Format a plain "HH:MM" 24-hour string as "7:00 PM" with no timezone math —
// used for manually-entered air times, since those are typed in the user's
// own local time already.
function formatTime24to12(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// Convert a network-local air time (e.g. "21:00" America/New_York) to the
// browser's local time for display. Returns e.g. "8:00 PM" or null.
// If isOverride is true, timeStr is already the user's own local time (typed
// in manually), so it's just formatted directly with no timezone conversion.
// If airstamp is given (a full ISO instant with the correct UTC offset
// already applied, from TVmaze), that's the most reliable source and is
// used directly — no manual DST/timezone guesswork needed at all.
function localAirtime(dateStr, timeStr, tz, isOverride, airstamp) {
  if (isOverride) return timeStr ? formatTime24to12(timeStr) : null;
  if (airstamp) {
    const d = new Date(airstamp);
    if (!isNaN(d)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (!timeStr) return null;
  try {
    const utcGuess = new Date(`${dateStr}T${timeStr}:00Z`);
    if (isNaN(utcGuess)) return formatTime24to12(timeStr); // bad/missing date -> skip tz math
    const tzView = new Date(utcGuess.toLocaleString('en-US', { timeZone: tz || 'America/New_York' }));
    const actual = new Date(utcGuess.getTime() + (utcGuess - tzView));
    return actual.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return formatTime24to12(timeStr);
  }
}

function dateGroupLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d - today) / 86400000);
  if (diffDays === 0) return 'TODAY';
  if (diffDays === 1) return 'TOMORROW';
  return d.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
}

function renderUpcoming() {
  const container = $('#upcoming-list');
  container.innerHTML = '';
  $('#upcoming-empty').classList.toggle('hidden', state.upcoming.length > 0);

  let lastGroup = null;
  for (const ev of state.upcoming) {
    const group = dateGroupLabel(ev.date);
    if (group !== lastGroup) {
      const header = document.createElement('div');
      header.className = 'upcoming-date-header';
      header.textContent = group;
      container.appendChild(header);
      lastGroup = group;
    }

    const time = localAirtime(ev.date, ev.airtime, ev.timezone, ev.airtime_is_override, ev.airstamp);
    const metaParts = [ev.subtitle];
    if (time) metaParts.push(time);

    const row = document.createElement('div');
    row.className = 'upcoming-row';
    row.innerHTML = `
      ${posterImg(ev.poster_path, ev.title)}
      <div class="info">
        <div class="name">${escapeHtml(ev.title)}</div>
        <div class="meta-row">
          <span class="meta">${escapeHtml(metaParts.filter(Boolean).join(' \u00b7 '))}</span>
          ${ev.type === 'tv' ? channelBadgeHtml(ev.network, ev.network_logo_path, 'sm') : ''}
        </div>
      </div>
      <div class="type-badge ${ev.type}">${ev.type === 'movie' ? 'MOVIE' : 'TV'}</div>
    `;
    row.addEventListener('click', () => {
      if (ev.type === 'tv') openUpcomingEpisode(ev);
      else openShowModal(ev.library_id);
    });
    container.appendChild(row);
  }
}

// ---------- Episode detail modal ----------
$('#close-episode-modal').addEventListener('click', () => $('#episode-modal').classList.add('hidden'));
$('#episode-modal').addEventListener('click', (e) => {
  if (e.target === $('#episode-modal')) $('#episode-modal').classList.add('hidden');
});

function openEpisodeDetail(ep, { showName, network, networkLogoPath, watched, onToggle }) {
  const code = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
  $('#episode-modal-title').textContent = ep.name ? `${code} \u00b7 ${ep.name}` : code;

  const time = localAirtime(ep.air_date, ep.airtime, ep.timezone, ep.airtime_is_override, ep.airstamp);
  const metaParts = [showName, ep.air_date || 'TBA', time];
  if (ep.runtime) metaParts.push(`${ep.runtime} min`);
  if (ep.vote_average) metaParts.push(`\u2605 ${ep.vote_average.toFixed(1)}`);

  const stillHtml = ep.still_path
    ? `<img class="episode-still" src="https://image.tmdb.org/t/p/w500${ep.still_path}" alt="${escapeHtml(ep.name || code)}">`
    : '';

  const body = $('#episode-modal-body');
  body.innerHTML = `
    ${stillHtml}
    ${channelBadgeHtml(network, networkLogoPath, 'lg')}
    <div class="episode-meta">${escapeHtml(metaParts.filter(Boolean).join(' \u00b7 '))}</div>
    <p class="episode-overview">${escapeHtml(ep.overview) || '<span class="empty-note">No synopsis available.</span>'}</p>
    <button class="btn-mark-all episode-toggle-btn">${watched ? 'Mark unwatched' : 'Mark watched'}</button>
  `;
  body.querySelector('.episode-toggle-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await onToggle();
  });

  $('#episode-modal').classList.remove('hidden');
}

// Opens straight to a specific episode's detail from the Upcoming tab,
// without showing the full season/episode listing behind it (that stays
// exclusive to the Library tab). Still fetches full show data since that's
// where episode overview/still/runtime come from — just doesn't render it
// as a season list.
async function openUpcomingEpisode(ev) {
  try {
    const show = await api(`/show/${ev.library_id}`);
    const season = show.seasons.find((s) => s.season_number === ev.season);
    const ep = season && season.episodes.find((e) => e.episode === ev.episode);
    if (!ep) { openShowModal(ev.library_id); return; } // fallback: shouldn't normally happen

    openEpisodeDetail(ep, {
      showName: show.name,
      network: show.network,
      networkLogoPath: show.network_logo_path,
      watched: ep.watched,
      onToggle: async () => {
        await postWatched(show.library_id, [{ season: ep.season, episode: ep.episode }], !ep.watched);
        $('#episode-modal').classList.add('hidden');
        loadUpcoming(); // refresh so this row updates to whatever's next, or disappears
      },
    });
  } catch (err) {
    console.error('Failed to open upcoming episode:', err);
  }
}

// ---------- Show detail modal ----------
let currentShow = null;
const openSeasons = new Set(); // remember which accordions are open across re-renders

$('#close-show-modal').addEventListener('click', () => $('#show-modal').classList.add('hidden'));
$('#show-modal').addEventListener('click', (e) => {
  if (e.target === $('#show-modal')) $('#show-modal').classList.add('hidden');
});

async function openShowModal(libraryId) {
  currentShow = null;
  openSeasons.clear();
  $('#show-modal-title').textContent = 'Loading\u2026';
  $('#show-modal-body').innerHTML = '';
  $('#show-modal').classList.remove('hidden');
  try {
    currentShow = await api(`/show/${libraryId}`);
    renderShowModal();
  } catch {
    $('#show-modal-title').textContent = 'Failed to load';
    $('#show-modal-body').innerHTML = '<p class="empty-note">TMDB lookup failed. Try again in a minute.</p>';
  }
}

async function postWatched(libraryId, episodes, watched) {
  await api('/watched', {
    method: 'POST',
    body: JSON.stringify(
      episodes ? { library_id: libraryId, watched, episodes } : { library_id: libraryId, watched }
    ),
  });
  refreshWatchlistBadge();
}

function renderShowModal() {
  const show = currentShow;
  $('#show-modal-title').textContent = show.name;
  const body = $('#show-modal-body');
  body.innerHTML = '';

  const mgmtRow = document.createElement('div');
  mgmtRow.className = 'mgmt-row';
  renderManagementRow(mgmtRow, show);
  body.appendChild(mgmtRow);

  // ---- Movie: single toggle ----
  if (show.media_type === 'movie') {
    const div = document.createElement('div');
    div.className = 'movie-detail';
    div.innerHTML = `
      <p class="empty-note">${show.release_date ? 'Released ' + show.release_date : 'No release date yet'}</p>
      <button class="btn-mark-all">${show.watched ? 'Mark unwatched' : 'Mark watched'}</button>
    `;
    div.querySelector('button').addEventListener('click', async (e) => {
      e.target.disabled = true;
      show.watched = !show.watched;
      await postWatched(show.library_id, null, show.watched);
      renderShowModal();
    });
    body.appendChild(div);
    return;
  }

  // ---- TV: network row (editable) ----
  const netRow = document.createElement('div');
  netRow.className = 'network-row';
  renderNetworkRow(netRow, show);
  body.appendChild(netRow);

  // Build off-DOM and insert once. Appending 30+ season blocks one at a time
  // (as this used to do) can desync paint from layout on some mobile browsers,
  // leaving rows visually blank until a tap forces a repaint.
  const fragment = document.createDocumentFragment();
  for (const season of show.seasons) {
    const allWatched = season.total > 0 && season.watched_count === season.total;
    const wrap = document.createElement('div');
    wrap.className = 'season-block';
    wrap.innerHTML = `
      <div class="season-header">
        <button class="btn-ghost small season-expand">${openSeasons.has(season.season_number) ? '&#9652;' : '&#9662;'}</button>
        <div class="season-title">SEASON ${season.season_number}</div>
        <div class="season-progress">${season.watched_count}/${season.total}</div>
        <button class="btn-mark-all season-toggle">${allWatched ? 'Unwatch season' : 'Watch season'}</button>
      </div>
      <div class="season-episodes ${openSeasons.has(season.season_number) ? '' : 'hidden'}"></div>
    `;

    const epContainer = wrap.querySelector('.season-episodes');
    if (openSeasons.has(season.season_number)) renderSeasonEpisodes(epContainer, season);

    // Expand / collapse
    const expandBtn = wrap.querySelector('.season-expand');
    const headerEl = wrap.querySelector('.season-header');
    headerEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('season-toggle')) return;
      const opening = epContainer.classList.contains('hidden');
      epContainer.classList.toggle('hidden');
      expandBtn.innerHTML = opening ? '&#9652;' : '&#9662;';
      if (opening) {
        openSeasons.add(season.season_number);
        if (epContainer.children.length === 0) renderSeasonEpisodes(epContainer, season);
      } else {
        openSeasons.delete(season.season_number);
      }
    });

    // Whole-season toggle
    wrap.querySelector('.season-toggle').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const markWatched = !allWatched;
      const eps = season.episodes.map((ep) => ({ season: ep.season, episode: ep.episode }));
      for (const ep of season.episodes) ep.watched = markWatched;
      season.watched_count = markWatched ? season.total : 0;
      await postWatched(show.library_id, eps, markWatched);
      renderShowModal();
    });

    fragment.appendChild(wrap);
  }
  body.appendChild(fragment);
}

function renderManagementRow(container, show) {
  const isStopped = show.status === 'stopped';
  container.innerHTML = `
    <button class="btn-ghost small mgmt-status-btn">${isStopped ? '\u25b6 Resume watching' : '\u23f8 Stop watching'}</button>
    <button class="btn-ghost small mgmt-remove-btn">Remove from library</button>
  `;

  container.querySelector('.mgmt-status-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const newStatus = isStopped ? 'watching' : 'stopped';
    await api('/status', {
      method: 'POST',
      body: JSON.stringify({ library_id: show.library_id, status: newStatus }),
    });
    show.status = newStatus;
    refreshActiveTab(); // update whichever tab is behind the modal right now
    refreshUpcomingSilently();
    refreshWatchlistBadge();
    renderShowModal();
  });

  container.querySelector('.mgmt-remove-btn').addEventListener('click', async () => {
    if (!confirm(`Remove "${show.name}" from your library? This also clears its watched history.`)) return;
    await api(`/library/${show.library_id}`, { method: 'DELETE' });
    $('#show-modal').classList.add('hidden');
    refreshActiveTab();
    refreshUpcomingSilently();
    refreshWatchlistBadge();
  });
}

// A static list of common network/streaming service names for the
// searchable picker in the network editor. Names only — no logos here,
// since fabricating exact TMDB image paths without live API access would
// just produce broken images. Whatever name gets picked still shows its
// real logo automatically elsewhere in the app if that show's own TMDB
// data happens to match it.
const KNOWN_NETWORKS = [
  'A&E', 'ABC', 'AMC', 'Animal Planet', 'Apple TV+', 'BBC', 'BBC America', 'BET',
  'Bravo', 'Cartoon Network', 'CBS', 'Cinemax', 'CNN', 'Comedy Central', 'Cooking Channel',
  'Discovery Channel', 'Disney Channel', 'Disney+', 'E!', 'ESPN', 'Food Network', 'Fox',
  'Freeform', 'FX', 'FYI', 'Game Show Network', 'HBO', 'HGTV', 'History', 'Hulu',
  'ID (Investigation Discovery)', 'IFC', 'Lifetime', 'MTV', 'National Geographic',
  'NBC', 'Netflix', 'Nickelodeon', 'OWN', 'Oxygen', 'Paramount Network', 'Paramount+',
  'Peacock', 'PBS', 'Science Channel', 'Showtime', 'Starz', 'Syfy', 'TBS', 'The CW',
  'TLC', 'TNT', 'Travel Channel', 'truTV', 'USA Network', 'VH1', 'The Weather Channel',
].sort((a, b) => a.localeCompare(b));

function renderNetworkRow(container, show) {
  const timeText = show.airtime ? localAirtime(localDateStr(), show.airtime, show.timezone, show.airtime_is_override) : 'No air time';
  container.innerHTML = `
    ${channelBadgeHtml(show.network, show.network_logo_path, 'sm')}
    <span class="network-sep">&middot;</span>
    <span class="network-label ${show.airtime ? '' : 'muted'}">${timeText}</span>
    <button class="btn-ghost small network-edit-btn">Edit</button>
  `;

  container.querySelector('.network-edit-btn').addEventListener('click', () => {
    container.innerHTML = `
      <div class="network-edit-form">
        <div class="network-search-wrap">
          <input type="text" class="network-input" placeholder="Network, e.g. History" value="${escapeHtml(show.network_is_override ? show.network : '')}" maxlength="60" ${show.network_is_hidden ? 'disabled' : ''} autocomplete="off">
          <div class="network-suggestions hidden"></div>
        </div>
        <input type="time" class="airtime-input" value="${show.airtime_is_override ? show.airtime : ''}">
        <label class="network-hide-toggle">
          <input type="checkbox" class="network-hide-checkbox" ${show.network_is_hidden ? 'checked' : ''}>
          No network (always show Emby)
        </label>
        <div class="network-edit-actions">
          <button class="btn-mark-all network-save-btn">Save</button>
          <button class="btn-ghost small network-cancel-btn">Cancel</button>
        </div>
      </div>
    `;
    const netInput = container.querySelector('.network-input');
    const timeInput = container.querySelector('.airtime-input');
    const hideCheckbox = container.querySelector('.network-hide-checkbox');
    const suggestions = container.querySelector('.network-suggestions');
    netInput.focus();

    // Searchable suggestions: type "hist" -> shows "History", etc.
    netInput.addEventListener('input', () => {
      const query = netInput.value.trim().toLowerCase();
      if (!query) { suggestions.classList.add('hidden'); suggestions.innerHTML = ''; return; }
      const matches = KNOWN_NETWORKS.filter((n) => n.toLowerCase().includes(query)).slice(0, 8);
      if (matches.length === 0) { suggestions.classList.add('hidden'); suggestions.innerHTML = ''; return; }
      suggestions.innerHTML = matches.map((n) => `<div class="network-suggestion">${escapeHtml(n)}</div>`).join('');
      suggestions.classList.remove('hidden');
      suggestions.querySelectorAll('.network-suggestion').forEach((el) => {
        el.addEventListener('click', () => {
          netInput.value = el.textContent;
          suggestions.classList.add('hidden');
          suggestions.innerHTML = '';
          netInput.focus();
        });
      });
    });
    // Hide suggestions when clicking elsewhere, but not when clicking a suggestion itself.
    document.addEventListener('click', function outsideClick(e) {
      if (!container.contains(e.target)) { document.removeEventListener('click', outsideClick); return; }
      if (!e.target.closest('.network-search-wrap')) { suggestions.classList.add('hidden'); }
    });

    // Checking "No network" disables the text field, since it's moot while forced to Emby.
    hideCheckbox.addEventListener('change', () => {
      netInput.disabled = hideCheckbox.checked;
      if (hideCheckbox.checked) { suggestions.classList.add('hidden'); suggestions.innerHTML = ''; }
    });

    container.querySelector('.network-cancel-btn').addEventListener('click', () => renderNetworkRow(container, show));
    const save = () => saveNetwork(container, show, netInput.value, timeInput.value, hideCheckbox.checked);
    container.querySelector('.network-save-btn').addEventListener('click', save);
    netInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') renderNetworkRow(container, show); });
    timeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') renderNetworkRow(container, show); });
  });
}

async function saveNetwork(container, show, networkValue, airtimeValue, hideNetwork) {
  const network = networkValue.trim();
  const airtime = airtimeValue || '';
  await api('/network', {
    method: 'POST',
    body: JSON.stringify({
      library_id: show.library_id,
      network: hideNetwork ? null : (network || null),
      airtime: airtime || null,
      hide_network: hideNetwork,
    }),
  });
  show.network_is_hidden = !!hideNetwork;
  show.network = hideNetwork ? null : (network || null);
  show.network_is_override = !hideNetwork && !!network;
  show.airtime = airtime || null;
  show.airtime_is_override = !!airtime;
  renderNetworkRow(container, show);
  refreshUpcomingSilently();
}

// Refresh the Upcoming feed in the background so an updated network shows up
// next time that tab is opened, without disrupting whatever's on screen now.
async function refreshUpcomingSilently() {
  try {
    const { upcoming } = await api('/upcoming');
    state.upcoming = upcoming;
  } catch { /* best effort */ }
}

function renderSeasonEpisodes(container, season) {
  container.innerHTML = '';
  for (const ep of season.episodes) {
    const row = document.createElement('div');
    row.className = 'episode-row';
    row.dataset.season = ep.season;
    row.dataset.episode = ep.episode;
    const code = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    row.innerHTML = `
      <div class="info">
        <span class="ep-code">${code}</span>
        <span class="ep-name">${escapeHtml(ep.name)}</span>
        <span class="ep-date">${ep.air_date || 'TBA'}</span>
      </div>
      <button class="btn-check ${ep.watched ? 'checked' : ''}" title="Toggle watched">&#10003;</button>
    `;

    async function toggleEpisode() {
      ep.watched = !ep.watched;
      season.watched_count += ep.watched ? 1 : -1;
      await postWatched(currentShow.library_id, [{ season: ep.season, episode: ep.episode }], ep.watched);
      renderShowModal();
    }
    const showDetail = () => openEpisodeDetail(ep, {
      showName: currentShow.name,
      network: currentShow.network,
      networkLogoPath: currentShow.network_logo_path,
      watched: ep.watched,
      onToggle: async () => { await toggleEpisode(); showDetail(); },
    });

    row.querySelector('.btn-check').addEventListener('click', (e) => {
      e.stopPropagation();
      e.target.disabled = true;
      toggleEpisode();
    });
    row.addEventListener('click', showDetail);
    container.appendChild(row);
  }
}

// ---------- TV Time import ----------
$('#import-btn').addEventListener('click', () => $('#import-file').click());

$('#refresh-logos-btn').addEventListener('click', async () => {
  const modal = $('#import-modal');
  const body = $('#import-modal-body');
  const title = $('#import-modal-title');
  const closeBtn = $('#close-import-modal');

  title.textContent = 'Finding network logos\u2026';
  body.innerHTML = `<p class="empty-note">Checking every show's network against TMDB for a real logo. This can take a minute or two for a large library \u2014 leave this open.</p>`;
  closeBtn.classList.add('hidden');
  modal.classList.remove('hidden');

  try {
    const report = await api('/refresh-network-logos', { method: 'POST' });
    title.textContent = 'Done';
    body.innerHTML = `<p>
      <strong>${report.networks_checked}</strong> networks checked \u00b7
      <strong>${report.already_had_logos}</strong> already had logos \u00b7
      <strong>${report.newly_found}</strong> newly found \u00b7
      <strong>${report.not_found}</strong> not found
    </p>`;
    closeBtn.classList.remove('hidden');
    await loadLibrary();
    refreshUpcomingSilently();
  } catch (err) {
    title.textContent = 'Failed';
    body.innerHTML = `<p class="empty-note">Something went wrong: ${escapeHtml(err.message)}. Try again in a minute.</p>`;
    closeBtn.classList.remove('hidden');
  }
});
$('#close-import-modal').addEventListener('click', () => $('#import-modal').classList.add('hidden'));

async function refreshTvdbToggle() {
  const wrap = $('#tvdb-toggle-wrap');
  const note = $('#tvdb-toggle-note');
  if (!state.isAdmin) {
    wrap.classList.add('hidden');
    note.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  try {
    const status = await api('/settings/tvdb');
    $('#tvdb-toggle').checked = status.enabled;
    if (!status.configured) {
      note.textContent = 'Not available \u2014 TVDB_API_KEY isn\u2019t set in the server environment. Requires a free TheTVDB project key plus your own $11.99/yr TheTVDB subscription PIN.';
      note.classList.remove('hidden');
      $('#tvdb-toggle').disabled = true;
    } else {
      note.classList.add('hidden');
      $('#tvdb-toggle').disabled = false;
    }
  } catch {
    wrap.classList.add('hidden');
  }
}

$('#tvdb-toggle').addEventListener('change', async (e) => {
  const checkbox = e.target;
  const note = $('#tvdb-toggle-note');
  const wantEnabled = checkbox.checked;
  checkbox.disabled = true;
  try {
    await api('/settings/tvdb', { method: 'POST', body: JSON.stringify({ enabled: wantEnabled }) });
    note.textContent = wantEnabled
      ? 'On \u2014 shows will also be checked against TheTVDB for episodes TMDB/TVmaze don\u2019t have yet.'
      : 'Off.';
    note.classList.remove('hidden');
  } catch (err) {
    checkbox.checked = !wantEnabled; // revert on failure
    note.textContent = `Couldn't update: ${err.message}`;
    note.classList.remove('hidden');
  } finally {
    checkbox.disabled = false;
  }
});

$('#import-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length === 0) return;

  let shows_csv = null, movies_csv = null;
  for (const f of files) {
    const text = await f.text();
    const header = text.slice(0, 2000);
    // Identify by columns, not filename, since people rename things.
    if (header.includes('series_name')) shows_csv = text;
    else if (header.includes('movie_name')) movies_csv = text;
  }

  const modal = $('#import-modal');
  const body = $('#import-modal-body');
  const title = $('#import-modal-title');
  const closeBtn = $('#close-import-modal');

  if (!shows_csv && !movies_csv) {
    title.textContent = 'Import failed';
    body.innerHTML = `<p class="empty-note">Couldn't recognize those files. Use the CSVs from your TV Time data export:
      <strong>tracking-prod-records-v2.csv</strong> (shows) and/or <strong>tracking-prod-records.csv</strong> (movies).</p>`;
    closeBtn.classList.remove('hidden');
    modal.classList.remove('hidden');
    return;
  }

  title.textContent = 'Importing\u2026';
  body.innerHTML = `<p class="empty-note">Matching your TV Time history against TMDB. Large libraries can take a couple of minutes \u2014 leave this open.</p>`;
  closeBtn.classList.add('hidden');
  modal.classList.remove('hidden');

  try {
    const { report } = await api('/import/tvtime', {
      method: 'POST',
      body: JSON.stringify({ shows_csv, movies_csv }),
    });
    title.textContent = 'Import complete';
    const lines = [
      `<strong>${report.shows_added}</strong> shows added`,
      `<strong>${report.episodes_marked}</strong> episodes marked watched`,
      `<strong>${report.movies_added}</strong> movies added`,
      `<strong>${report.movies_marked_watched}</strong> movies marked watched`,
    ];
    let html = `<p>${lines.join(' \u00b7 ')}</p>`;
    if (report.unmatched.length > 0) {
      html += `<p class="empty-note">Couldn't match ${report.unmatched.length} title(s) \u2014 add these manually:</p>
        <div class="unmatched-list">${report.unmatched.map((n) => `<div>${escapeHtml(n)}</div>`).join('')}</div>`;
    }
    body.innerHTML = html;
    closeBtn.classList.remove('hidden');
    await loadLibrary();
    await loadUpcoming();
    refreshWatchlistBadge();
  } catch (err) {
    title.textContent = 'Import failed';
    body.innerHTML = `<p class="empty-note">Something went wrong: ${escapeHtml(err.message)}. Check the container logs (docker logs airdate) and try again \u2014 re-running is safe, nothing gets duplicated.</p>`;
    closeBtn.classList.remove('hidden');
  }
});

// ---------- Push notifications ----------
// Registered once at load, independent of login state — the browser just
// needs the worker on file before a subscription can be created.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.error('Service worker registration failed:', err);
  });
}

// Converts the VAPID public key (base64url, as the server hands it out)
// into the raw byte array pushManager.subscribe() actually wants.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function refreshPushStatus() {
  const note = $('#push-status-note');
  const controls = $('#push-controls');
  const enableBtn = $('#push-enable-btn');
  const disableBtn = $('#push-disable-btn');
  const testBtn = $('#push-test-btn');
  const clockBtn = $('#push-clock-btn');
  const digestBtn = $('#push-digest-btn');
  const timeInput = $('#push-time-input');
  $('#push-error').classList.add('hidden');
  $('#push-test-result').classList.add('hidden');
  $('#push-clock-result').classList.add('hidden');
  $('#push-digest-result').classList.add('hidden');

  if (!pushSupported()) {
    note.textContent = 'Not supported in this browser. On iPhone, add AIRDATE to your Home Screen first, then try again from there.';
    controls.classList.add('hidden');
    return;
  }
  controls.classList.remove('hidden');

  try {
    const status = await api('/push/status');
    if (status.enabled && status.device_count > 0) {
      note.textContent = `On for this account \u2014 ${status.device_count} device${status.device_count === 1 ? '' : 's'} subscribed.`;
      timeInput.value = status.time;
      enableBtn.textContent = 'Update time';
      disableBtn.classList.remove('hidden');
      testBtn.classList.remove('hidden');
      clockBtn.classList.remove('hidden');
      digestBtn.classList.remove('hidden');
    } else {
      note.textContent = 'A morning notification listing what airs today.';
      enableBtn.textContent = 'Enable';
      disableBtn.classList.add('hidden');
      testBtn.classList.add('hidden');
      clockBtn.classList.add('hidden');
      digestBtn.classList.add('hidden');
    }
  } catch {
    note.textContent = 'A morning notification listing what airs today.';
  }
}

$('#push-enable-btn').addEventListener('click', async () => {
  const errorEl = $('#push-error');
  errorEl.classList.add('hidden');
  const time = $('#push-time-input').value || '08:00';

  if (!pushSupported()) return;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      errorEl.textContent = 'Notification permission was denied \u2014 check your browser/site settings to allow it.';
      errorEl.classList.remove('hidden');
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { publicKey } = await api('/push/vapid-public-key');
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await api('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: subscription.toJSON(), timezone, time }),
    });
    await refreshPushStatus();
  } catch (err) {
    errorEl.textContent = `Couldn't enable notifications: ${err.message}`;
    errorEl.classList.remove('hidden');
  }
});

$('#push-disable-btn').addEventListener('click', async () => {
  try {
    if (pushSupported()) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      } else {
        await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({}) });
      }
    }
    await refreshPushStatus();
  } catch (err) {
    $('#push-error').textContent = `Couldn't disable notifications: ${err.message}`;
    $('#push-error').classList.remove('hidden');
  }
});

$('#push-test-btn').addEventListener('click', async () => {
  const resultEl = $('#push-test-result');
  const btn = $('#push-test-btn');
  btn.disabled = true;
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = 'Sending\u2026';
  try {
    const { results } = await api('/push/test', { method: 'POST' });
    const okCount = results.filter((r) => r.ok).length;

    // Dead subscriptions were just cleaned up server-side by the call
    // above — refresh the device count first, since this also resets this
    // same result element; the actual result text goes last so it isn't
    // clobbered by that reset.
    await refreshPushStatus();
    resultEl.classList.remove('hidden');

    if (okCount === results.length) {
      resultEl.innerHTML = `Sent successfully to ${okCount} device${okCount === 1 ? '' : 's'}. If it didn't show up on your phone, the problem is on the device side (notification permission, battery optimization, or Do Not Disturb) \u2014 not this app.`;
    } else {
      const lines = [`<strong>${okCount} of ${results.length} device${results.length === 1 ? '' : 's'} succeeded.</strong>`];
      results.forEach((r, i) => {
        if (r.ok) {
          lines.push(`Device ${i + 1}: sent successfully.`);
        } else if (r.statusCode === 404 || r.statusCode === 410) {
          lines.push(`Device ${i + 1}: that subscription is no longer valid (HTTP ${r.statusCode}) \u2014 it's been removed automatically. Re-enable notifications on that specific device to fix it.`);
        } else {
          lines.push(`Device ${i + 1}: ${escapeHtml(r.error)}${r.statusCode ? ` (HTTP ${r.statusCode})` : ''}`);
        }
      });
      resultEl.innerHTML = lines.join('<br>');
    }
  } catch (err) {
    resultEl.textContent = `Test failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('#push-clock-btn').addEventListener('click', async () => {
  const resultEl = $('#push-clock-result');
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = 'Checking\u2026';
  try {
    const data = await api('/push/clock-check');
    const yourNow = new Date();
    const yourTimeStr = yourNow.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const yourDateStr = localDateStr(yourNow);

    if (!data.local_time) {
      resultEl.textContent = `Server's clock (UTC): ${data.server_utc}. Your device says it's ${yourTimeStr} on ${yourDateStr}. No timezone saved yet \u2014 re-enable notifications once to record it.`;
      return;
    }

    const serverTime12h = formatTime24to12(data.local_time);
    const matches = data.local_date === yourDateStr && Math.abs(
      (parseInt(data.local_time.split(':')[0]) * 60 + parseInt(data.local_time.split(':')[1])) -
      (yourNow.getHours() * 60 + yourNow.getMinutes())
    ) <= 2; // small tolerance for the moment it takes to click the button

    const scheduleLine = data.schedule_status ? `<br><br><strong>Scheduler status:</strong> ${escapeHtml(data.schedule_status.reason)}` : '';

    if (matches) {
      resultEl.innerHTML = `Server's clock looks correct \u2014 it computes ${serverTime12h} in your timezone, matching your device's ${yourTimeStr}. Your digest is set for ${data.digest_time ? formatTime24to12(data.digest_time) : '(not set)'}.${scheduleLine}`;
    } else {
      resultEl.innerHTML = `Mismatch: the server computes ${serverTime12h} on ${data.local_date} in your timezone, but your device says ${yourTimeStr} on ${yourDateStr}. This means the NAS's system clock is off \u2014 fix it in your NAS's own date/time settings (enable NTP time sync if it isn't already), then restart the container.${scheduleLine}`;
    }
  } catch (err) {
    resultEl.textContent = `Couldn't check: ${err.message}`;
  }
});

$('#push-digest-btn').addEventListener('click', async () => {
  const resultEl = $('#push-digest-result');
  const btn = $('#push-digest-btn');
  btn.disabled = true;
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = 'Running today\u2019s digest\u2026';
  try {
    const data = await api('/push/send-digest-now', { method: 'POST' });
    if (data.outcome === 'fetch_failed') {
      resultEl.textContent = "Couldn't check what's airing today \u2014 every show failed to fetch (likely a TMDB API problem). Nothing was sent; try again once that's resolved.";
    } else if (data.outcome === 'nothing_to_report') {
      resultEl.textContent = "Ran successfully \u2014 genuinely nothing airing today for this account, so no notification was sent. This is working correctly.";
    } else if (data.outcome === 'sent') {
      const okCount = data.sendResults.filter((r) => r.ok).length;
      const total = data.sendResults.length;
      resultEl.innerHTML = `Sent: <strong>${escapeHtml(data.message.title)}</strong> \u2014 "${escapeHtml(data.message.body)}". Delivered to ${okCount} of ${total} device${total === 1 ? '' : 's'}. If it doesn't show up on your phone within a minute, the problem is device-side (permission, battery optimization, Do Not Disturb) \u2014 not the digest logic itself.`;
    }
    await refreshPushStatus();
    resultEl.classList.remove('hidden');
  } catch (err) {
    resultEl.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

checkSession();

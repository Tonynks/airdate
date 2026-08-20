const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme'; // used only for first-run migration, see below
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || 'tvman'; // ditto
const SESSION_SECRET = process.env.SESSION_SECRET || 'please-change-this-secret';
const PORT = process.env.PORT || 3000;
const TMDB_BASE = 'https://api.themoviedb.org/3';
// Web Push requires a contact address in case a push service needs to reach
// the sender — doesn't need to be a real monitored inbox, just a valid one.
const PUSH_CONTACT_EMAIL = process.env.PUSH_CONTACT_EMAIL || 'admin@example.com';

if (!TMDB_API_KEY) {
  console.warn('WARNING: TMDB_API_KEY is not set. Search and calendar will fail until it is.');
}

// ---------- Storage ----------
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LEGACY_LIBRARY_FILE = path.join(DATA_DIR, 'library.json'); // pre-accounts single-library format
const NETWORK_LOGO_CACHE_FILE = path.join(DATA_DIR, 'network-logos.json');
const VAPID_KEYS_FILE = path.join(DATA_DIR, 'vapid-keys.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Web Push setup ----------
// VAPID keys identify this server to push services (FCM, Mozilla autopush,
// etc.) — generated once and persisted, no external account/signup needed.
function loadOrCreateVapidKeys() {
  if (fs.existsSync(VAPID_KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf8'));
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(keys, null, 2));
  console.log('Generated new VAPID keys for push notifications.');
  return keys;
}
const VAPID_KEYS = loadOrCreateVapidKeys();
webpush.setVapidDetails(`mailto:${PUSH_CONTACT_EMAIL}`, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

function readPushSubs() {
  if (!fs.existsSync(PUSH_SUBS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writePushSubs(data) {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(data, null, 2));
}

function getUserPushSettings(userId) {
  const all = readPushSubs();
  return all[userId] || { enabled: false, time: '08:00', timezone: null, last_sent_date: null, subscriptions: [] };
}
// Adds (or updates, if the same endpoint already exists) a subscription for
// this account, and sets the digest time/timezone from whichever device
// just subscribed — last one to (re)subscribe wins for scheduling purposes,
// since all of an account's devices share one digest time.
function addPushSubscription(userId, subscription, timezone, time) {
  const all = readPushSubs();
  const existing = all[userId] || { enabled: false, time: '08:00', timezone: null, last_sent_date: null, subscriptions: [] };
  existing.enabled = true;
  existing.timezone = timezone || existing.timezone;
  if (time) existing.time = time;
  existing.subscriptions = existing.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  existing.subscriptions.push({ ...subscription, added_at: new Date().toISOString() });
  all[userId] = existing;
  writePushSubs(all);
}
function removePushSubscription(userId, endpoint) {
  const all = readPushSubs();
  const existing = all[userId];
  if (!existing) return;
  existing.subscriptions = existing.subscriptions.filter((s) => s.endpoint !== endpoint);
  if (existing.subscriptions.length === 0) existing.enabled = false;
  all[userId] = existing;
  writePushSubs(all);
}
function disableUserPush(userId) {
  const all = readPushSubs();
  if (!all[userId]) return;
  all[userId].enabled = false;
  all[userId].subscriptions = [];
  writePushSubs(all);
}
function updatePushTime(userId, time) {
  const all = readPushSubs();
  if (!all[userId]) return false;
  all[userId].time = time;
  writePushSubs(all);
  return true;
}


function libraryPathFor(userId) {
  return path.join(DATA_DIR, `library-${userId}.json`);
}
function readLibrary(userId) {
  const file = libraryPathFor(userId);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ nextId: 1, items: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeLibrary(userId, data) {
  fs.writeFileSync(libraryPathFor(userId), JSON.stringify(data, null, 2));
}

// A network's logo is the same image no matter which show or which user is
// looking at it. So once we've confirmed a real logo_path for "History" (or
// any network) from one show's own TMDB data, remember it — and reuse it for
// every other show with that same network name, including manual overrides
// and shows whose own TMDB entry doesn't happen to list that network. This
// is shared across all accounts on purpose: it's a fact about the network,
// not about any one person's library.
function readNetworkLogoCache() {
  if (!fs.existsSync(NETWORK_LOGO_CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(NETWORK_LOGO_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function cacheNetworkLogo(name, logoPath) {
  if (!name || !logoPath) return;
  const key = name.trim().toLowerCase();
  const cache = readNetworkLogoCache();
  if (cache[key] === logoPath) return; // already recorded, skip the write
  cache[key] = logoPath;
  fs.writeFileSync(NETWORK_LOGO_CACHE_FILE, JSON.stringify(cache, null, 2));
}
function getCachedNetworkLogo(name) {
  if (!name) return null;
  const cache = readNetworkLogoCache();
  return cache[name.trim().toLowerCase()] || null;
}

// Actively looks up a real logo for a network name, instead of waiting for
// one to turn up by coincidence on some other show. Searches TMDB's TV
// catalog for the network name itself (the same /search/tv endpoint already
// used for "+ Add title", so it's proven-reliable — no hardcoded network
// IDs or guessed image paths involved), then checks each result's own real
// `networks` data for a name match. Channel names very often turn up shows
// that are actually on that channel, so this works well in practice.
// Runs one TMDB TV search + checks the top candidates' real network data for
// a name match. Returns a logo_path or null. Doesn't touch the cache itself
// — the caller decides what to do with a hit.
async function trySearchForNetworkLogo(query, target) {
  const searchResults = await tmdb('/search/tv', { query });
  const candidates = (searchResults.results || []).slice(0, 8);
  for (const candidate of candidates) {
    try {
      const full = await tmdb(`/tv/${candidate.id}`);
      const match = (full.networks || []).find((n) => {
        if (!n.name) return false;
        const name = n.name.toLowerCase();
        return name.includes(target) || target.includes(name);
      });
      if (match && match.logo_path) return match.logo_path;
    } catch (err) {
      // this candidate didn't pan out — keep trying the others
    }
  }
  return null;
}

async function discoverNetworkLogo(networkName) {
  if (!networkName) return null;
  const cached = getCachedNetworkLogo(networkName);
  if (cached) return cached;

  const target = networkName.trim().toLowerCase();
  // Short or punctuation-heavy names (like "A&E") tend to pull back TV
  // shows that have nothing to do with the actual channel when searched
  // bare — TMDB's search matches on show titles, not networks, so a vague
  // 2-3 letter query mostly returns noise. Longer, more specific queries
  // (appending "Network"/"Channel") tend to surface the channel's own
  // branded content more reliably.
  const isAmbiguous = target.length <= 5 || /[^a-z0-9 ]/.test(target);
  const queries = isAmbiguous
    ? [networkName, `${networkName} Network`, `${networkName} Channel`]
    : [networkName];

  for (const query of queries) {
    try {
      const logoPath = await trySearchForNetworkLogo(query, target);
      if (logoPath) {
        cacheNetworkLogo(networkName, logoPath);
        return logoPath;
      }
    } catch (err) {
      console.error(`Network logo discovery failed for "${networkName}" (query "${query}"):`, err.message);
    }
  }
  return null;
}

// ---------- Accounts ----------
function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return { nextId: 1, accounts: [] };
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}
function writeAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}
function findAccountByUsername(username) {
  const db = readAccounts();
  const lower = (username || '').trim().toLowerCase();
  return db.accounts.find((a) => a.username.toLowerCase() === lower) || null;
}
function findAccountById(id) {
  const db = readAccounts();
  return db.accounts.find((a) => a.id === Number(id)) || null;
}
// Throws if the username is already taken; otherwise creates the account
// and returns it (never returns the password hash to callers other than
// internally — routes should only ever send back {id, username}).
function createAccount(username, password, isAdmin = false) {
  const name = (username || '').trim();
  if (!name) throw new Error('username required');
  if (!password || password.length < 4) throw new Error('password must be at least 4 characters');
  const db = readAccounts();
  if (db.accounts.some((a) => a.username.toLowerCase() === name.toLowerCase())) {
    throw new Error('that username is already taken');
  }
  const account = {
    id: db.nextId++,
    username: name,
    password_hash: bcrypt.hashSync(password, 10),
    created_at: new Date().toISOString(),
    is_admin: !!isAdmin,
  };
  db.accounts.push(account);
  writeAccounts(db);
  return account;
}

// Removes an account (and its library file). Refuses to remove the last
// remaining admin, or the account making the request, so there's no way to
// lock yourself out of account management entirely.
function removeAccount(requestingUserId, targetId) {
  const db = readAccounts();
  const target = db.accounts.find((a) => a.id === Number(targetId));
  if (!target) return { ok: false, error: 'account not found' };
  if (target.id === Number(requestingUserId)) {
    return { ok: false, error: "you can't remove the account you're currently logged in as" };
  }
  const adminCount = db.accounts.filter((a) => a.is_admin).length;
  if (target.is_admin && adminCount <= 1) {
    return { ok: false, error: 'cannot remove the last remaining admin' };
  }
  db.accounts = db.accounts.filter((a) => a.id !== target.id);
  writeAccounts(db);
  const libFile = libraryPathFor(target.id);
  if (fs.existsSync(libFile)) fs.unlinkSync(libFile);
  return { ok: true };
}

// Changes an account's password after verifying the current one. Only ever
// called for req.userId (the logged-in session's own account) — there's no
// path to change someone else's password without already knowing it.
function changePassword(userId, currentPassword, newPassword) {
  const db = readAccounts();
  const account = db.accounts.find((a) => a.id === Number(userId));
  if (!account) return { ok: false, error: 'account not found' };
  if (!currentPassword || !bcrypt.compareSync(currentPassword, account.password_hash)) {
    return { ok: false, error: 'current password is incorrect' };
  }
  if (!newPassword || newPassword.length < 4) {
    return { ok: false, error: 'new password must be at least 4 characters' };
  }
  account.password_hash = bcrypt.hashSync(newPassword, 10);
  writeAccounts(db);
  return { ok: true };
}

// First-run migration: before accounts existed, there was one shared
// password (APP_PASSWORD) and one shared library (library.json). If we're
// starting up with no accounts.json yet, create a single admin account from
// that old password/username so the existing login and library carry over
// exactly as they were, then adopt the old library file as that account's.
(function migrateLegacySingleAccount() {
  if (fs.existsSync(ACCOUNTS_FILE)) return;
  const account = createAccount(ACCOUNT_NAME, APP_PASSWORD, true);
  if (fs.existsSync(LEGACY_LIBRARY_FILE)) {
    fs.renameSync(LEGACY_LIBRARY_FILE, libraryPathFor(account.id));
    console.log(`Migrated existing library to account "${account.username}" (id ${account.id}).`);
  }
  console.log(`Created initial admin account "${account.username}" from APP_PASSWORD. Add more from the app once logged in.`);
})();

// Second migration: accounts.json may already exist from a version of this
// app that had accounts but no admin concept yet. If so, nobody has
// is_admin set — designate one now (preferring ACCOUNT_NAME/"tvman" if
// present, since that's the original owner account) so account management
// still works after upgrading.
(function ensureAdminExists() {
  const db = readAccounts();
  if (db.accounts.length === 0 || db.accounts.some((a) => a.is_admin)) return;
  const preferred = db.accounts.find((a) => a.username.toLowerCase() === ACCOUNT_NAME.toLowerCase());
  const target = preferred || db.accounts.slice().sort((a, b) => a.id - b.id)[0];
  target.is_admin = true;
  writeAccounts(db);
  console.log(`Designated "${target.username}" as admin (upgrading from a version without admin accounts).`);
})();

function addToLibrary(userId, { tmdb_id, media_type, name, poster_path }) {
  const db = readLibrary(userId);
  const exists = db.items.some((i) => i.tmdb_id === tmdb_id && i.media_type === media_type);
  if (exists) return;
  db.items.push({
    id: db.nextId++,
    tmdb_id,
    media_type,
    name,
    poster_path: poster_path || null,
    added_at: new Date().toISOString(),
    // tv: array of "season-episode" keys; movie: boolean
    watched: media_type === 'movie' ? false : [],
    network_override: null, // manual network name, used when TVmaze has none
    airtime_override: null, // manual "HH:MM" in the user's own local time, used when TVmaze has none
    status: 'watching', // 'watching' | 'stopped' — stopped shows stay in Library but skip Upcoming/Watchlist
  });
  writeLibrary(userId, db);
}
function removeFromLibrary(userId, id) {
  const db = readLibrary(userId);
  db.items = db.items.filter((i) => i.id !== Number(id));
  writeLibrary(userId, db);
}

function epKey(season, episode) {
  return `${season}-${episode}`;
}

// Runs `fn` over `items` with at most `limit` running at once, instead of
// firing all of them simultaneously via Promise.all. A library with dozens
// of shows means dozens of simultaneous TMDB/TVmaze requests on a cold
// cache (e.g. first load after a restart) — that burst is what actually
// trips rate limits and causes shows to silently drop out of results.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
// "Today" must be the user's local calendar date, not the server's. The
// server may be in UTC (or any TZ) while the browser is elsewhere — in the
// evening those dates can disagree, silently dropping same-day episodes.
// The frontend passes ?today=YYYY-MM-DD computed from the browser's clock;
// fall back to server UTC only if that's missing or malformed.
function clientToday(req) {
  const q = req.query.today;
  if (typeof q === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return new Date().toISOString().slice(0, 10);
}
function setWatched(userId, libraryId, { episodes, watched }) {
  const db = readLibrary(userId);
  const item = db.items.find((i) => i.id === Number(libraryId));
  if (!item) return false;
  if (item.media_type === 'movie') {
    item.watched = watched !== false;
  } else {
    const set = new Set(Array.isArray(item.watched) ? item.watched : []);
    for (const ep of episodes || []) {
      const key = epKey(ep.season, ep.episode);
      if (watched === false) set.delete(key);
      else set.add(key);
    }
    item.watched = [...set];
  }
  writeLibrary(userId, db);
  return true;
}
function setStatus(userId, libraryId, status) {
  if (status !== 'watching' && status !== 'stopped') return false;
  const db = readLibrary(userId);
  const item = db.items.find((i) => i.id === Number(libraryId));
  if (!item) return false;
  item.status = status;
  writeLibrary(userId, db);
  return true;
}
function setShowOverrides(userId, libraryId, { network, airtime, hideNetwork }) {
  const db = readLibrary(userId);
  const item = db.items.find((i) => i.id === Number(libraryId));
  if (!item || item.media_type !== 'tv') return false;
  item.network_hide = !!hideNetwork; // forces "no network" (Emby) regardless of TVmaze/TMDB
  item.network_override = (!hideNetwork && network) ? network.trim().slice(0, 60) || null : null;
  item.airtime_override = /^\d{2}:\d{2}$/.test(airtime || '') ? airtime : null;
  writeLibrary(userId, db);
  return true;
}
// Combine manual overrides with TVmaze data for a TV item's network/air-time.
function resolveShowMeta(item, extras, epContext = null, tmdbShow = null) {
  const usingAirtimeOverride = !!item.airtime_override;
  let airtime = usingAirtimeOverride ? item.airtime_override : extras.airtime;
  let airstamp = null;

  // When we know the specific episode being displayed (Upcoming, per-episode
  // rows), prefer TVmaze's per-episode time over the show's generic schedule
  // time — some shows air specials or vary slot week to week, so a single
  // "usual" time applied to every episode is often wrong. airstamp is best of
  // all: it's a full instant with the correct offset already baked in, so no
  // timezone math is needed on the frontend at all.
  if (!usingAirtimeOverride && epContext) {
    const epInfo = extras.episodeInfo && extras.episodeInfo[epKey(epContext.season, epContext.episode)];
    if (epInfo) {
      airtime = epInfo.airtime || airtime;
      airstamp = epInfo.airstamp || null;
    }
  }

  const network = item.network_hide ? null : (item.network_override || extras.network || null);

  // TMDB (not TVmaze) is the source for an actual logo image — it returns a
  // `networks` array with a `logo_path`. But that array can include the
  // show's ORIGINAL broadcaster from years ago, which may differ from what
  // TVmaze/override says airs it now, or TMDB may list a network even when
  // we don't actually know the current one. So only use a logo when its
  // name actually matches the network we're displaying — otherwise we'd
  // show a real logo for the wrong channel, or a logo when none should
  // appear at all (letting the Emby fallback show instead).
  let networkLogoPath = null;
  if (!item.network_hide && network) {
    // First choice: this show's own real TMDB data, if it has a network
    // entry whose name matches. This is checked regardless of whether the
    // network name came from auto-detection or a manual pick — if you
    // picked "A&E" from the dropdown and this show's actual TMDB data
    // confirms A&E with a logo, that's the best possible source there is,
    // and ignoring it just because it happened to be manually selected
    // would be needlessly worse. The fuzzy name match below still protects
    // against showing a logo for an unrelated network if the picked name
    // doesn't actually match what this show's real data says.
    if (tmdbShow && Array.isArray(tmdbShow.networks)) {
      const target = network.toLowerCase();
      const match = tmdbShow.networks.find((n) => {
        if (!n.name) return false;
        const name = n.name.toLowerCase();
        return name.includes(target) || target.includes(name);
      });
      if (match && match.logo_path) {
        networkLogoPath = match.logo_path;
        cacheNetworkLogo(network, networkLogoPath); // remember this real match for reuse elsewhere
      }
    }
    // Fallback: we may already know this network's real logo from a
    // DIFFERENT show that had it directly in its own TMDB data — reuse
    // that here. This covers manual overrides, and shows whose own TMDB
    // entry doesn't happen to list a network we otherwise know about.
    if (!networkLogoPath) {
      networkLogoPath = getCachedNetworkLogo(network);
    }
  }

  return {
    network,
    network_is_override: !!item.network_override,
    network_is_hidden: !!item.network_hide,
    network_logo_path: networkLogoPath,
    airtime,
    airtime_is_override: usingAirtimeOverride,
    airstamp,
    timezone: extras.timezone,
  };
}

// ---------- Simple in-memory cache for TMDB responses ----------
const cache = new Map(); // key -> { expires, data }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Small delay helper for retry backoff.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdb(pathname, params = {}) {
  const key = pathname + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;

  const url = new URL(TMDB_BASE + pathname);
  url.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // A cold cache means every show in the library fires off several requests
  // at once (this one included) — under that burst, a transient rate-limit
  // or timeout on any single call used to silently drop that show from
  // Watchlist/Upcoming's count entirely, since the failure was caught
  // upstream and just skipped. A couple of quick retries covers almost all
  // of those cases without meaningfully slowing down the common case where
  // nothing goes wrong.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Rate limits and server hiccups (429/5xx) are worth retrying;
        // a genuine 404/401 etc. won't fix itself, so fail fast on those.
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`TMDB ${res.status} ${pathname}: ${body}`);
        }
        throw Object.assign(new Error(`TMDB ${res.status} ${pathname}: ${body}`), { noRetry: true });
      }
      const data = await res.json();
      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });
      return data;
    } catch (err) {
      lastErr = err;
      if (err.noRetry || attempt === 2) break;
      await sleep(250 * (attempt + 1)); // 250ms, then 500ms
    }
  }
  throw lastErr;
}

// TVmaze provides network + air time, which TMDB doesn't.
// Look up by TVDB id (from TMDB's external_ids), fall back to IMDB id.

// Generic retry wrapper for a plain fetch() call (used for TVmaze, which
// isn't behind the tmdb() helper). Same reasoning as tmdb()'s retry: under
// a cold-cache burst across a whole library, a transient rate-limit or
// blip shouldn't silently drop a show from the results.
async function fetchWithRetry(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok && (res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function getShowExtras(tmdbId) {
  const cacheKey = `extras:${tmdbId}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.data;

  let extras = { network: null, airtime: null, timezone: null, episodeInfo: {} };
  try {
    const ext = await tmdb(`/tv/${tmdbId}/external_ids`);
    let url = null;
    if (ext.tvdb_id) url = `https://api.tvmaze.com/lookup/shows?thetvdb=${ext.tvdb_id}`;
    else if (ext.imdb_id) url = `https://api.tvmaze.com/lookup/shows?imdb=${ext.imdb_id}`;
    if (url) {
      const res = await fetchWithRetry(url);
      if (res.ok) {
        const show = await res.json();
        const net = show.network || show.webChannel; // webChannel covers streaming (Netflix etc.)
        extras = {
          network: net ? net.name : null,
          airtime: (show.schedule && show.schedule.time) || null,
          timezone: (net && net.country && net.country.timezone) || 'America/New_York',
          episodeInfo: {},
        };

        // TVmaze's per-episode air dates/times are crowdsourced from actual
        // broadcast schedules and are often more accurate than TMDB's or the
        // show's own generic schedule (particularly for reality/documentary
        // shows, or ones whose slot varies week to week). airstamp is the
        // most reliable field of all: a full instant with the correct UTC
        // offset already applied, so no manual timezone math is needed.
        try {
          const epRes = await fetchWithRetry(`https://api.tvmaze.com/shows/${show.id}/episodes`);
          if (epRes.ok) {
            const tvmazeEpisodes = await epRes.json();
            for (const e of tvmazeEpisodes) {
              if (e.season && e.number) {
                extras.episodeInfo[epKey(e.season, e.number)] = {
                  airdate: e.airdate || null,
                  airtime: e.airtime || null,
                  airstamp: e.airstamp || null,
                };
              }
            }
          }
        } catch (err) {
          console.error(`TVmaze episode list failed for tmdb ${tmdbId}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`TVmaze lookup failed for tmdb ${tmdbId}:`, err.message);
  }
  cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, data: extras });
  return extras;
}

// Prefer TVmaze's air date for a given episode when it has one and it
// differs from TMDB's; otherwise fall back to TMDB's date unchanged.
function resolveAirDate(seasonNum, episodeNum, tmdbDate, extras) {
  const epInfo = extras.episodeInfo && extras.episodeInfo[epKey(seasonNum, episodeNum)];
  return (epInfo && epInfo.airdate) || tmdbDate;
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(cookieSession({
  name: 'airdate_session',
  secret: SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  sameSite: 'lax',
}));

function requireAuth(req, res, next) {
  // Also require session.userId specifically — older sessions from before
  // accounts existed only have `authenticated: true` with no userId, and
  // must re-login rather than being treated as some default account.
  if (req.session && req.session.authenticated && req.session.userId) {
    // Re-check against the live account record rather than trusting the
    // session blindly — if the account was removed since this cookie was
    // issued, this is what actually locks them out immediately instead of
    // leaving their existing session usable until it expires on its own.
    const account = findAccountById(req.session.userId);
    if (!account) {
      req.session = null;
      return res.status(401).json({ error: 'not authenticated' });
    }
    req.userId = account.id;
    req.isAdmin = !!account.is_admin;
    return next();
  }
  return res.status(401).json({ error: 'not authenticated' });
}

// Chain after requireAuth on routes that manage accounts.
function requireAdmin(req, res, next) {
  if (req.isAdmin) return next();
  return res.status(403).json({ error: 'admin only' });
}

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const account = username ? findAccountByUsername(username) : null;
  if (account && password && bcrypt.compareSync(password, account.password_hash)) {
    req.session.authenticated = true;
    req.session.userId = account.id;
    req.session.username = account.username;
    req.session.isAdmin = !!account.is_admin;
    return res.json({ ok: true, username: account.username, is_admin: !!account.is_admin });
  }
  return res.status(401).json({ error: 'wrong username or password' });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  if (!(req.session && req.session.authenticated && req.session.userId)) {
    return res.json({ authenticated: false, username: null, is_admin: false });
  }
  const account = findAccountById(req.session.userId);
  if (!account) {
    req.session = null;
    return res.json({ authenticated: false, username: null, is_admin: false });
  }
  res.json({ authenticated: true, username: account.username, is_admin: !!account.is_admin });
});

// List existing accounts (usernames only — never password hashes) so the
// UI can show who's already set up on this box.
app.get('/api/accounts', requireAuth, (req, res) => {
  const db = readAccounts();
  res.json({ accounts: db.accounts.map((a) => ({ id: a.id, username: a.username, is_admin: !!a.is_admin })) });
});

// Add another account. Admin only.
app.post('/api/accounts', requireAuth, requireAdmin, (req, res) => {
  const { username, password } = req.body || {};
  try {
    const account = createAccount(username, password, false);
    res.json({ ok: true, account: { id: account.id, username: account.username, is_admin: false } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an account. Admin only. Refuses to remove yourself or the last
// remaining admin (see removeAccount for details).
app.delete('/api/accounts/:id', requireAuth, requireAdmin, (req, res) => {
  const result = removeAccount(req.userId, req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Change the current session's own account password. Requires the current
// password as confirmation — there's no admin override to reset someone
// else's password from within the app.
app.post('/api/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const result = changePassword(req.userId, current_password, new_password);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ---- Push notifications ----
app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

app.get('/api/push/status', requireAuth, (req, res) => {
  const settings = getUserPushSettings(req.userId);
  res.json({ enabled: settings.enabled, time: settings.time, device_count: settings.subscriptions.length });
});

// Subscribes this device to the daily digest. `subscription` is the raw
// PushSubscription object from the browser; `timezone` is the browser's own
// IANA zone (e.g. "America/Chicago") so the digest fires at the right local
// time regardless of what timezone the server itself is running in.
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription, timezone, time } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription is required' });
  }
  if (time && !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: 'time must be in HH:MM format' });
  }
  addPushSubscription(req.userId, subscription, timezone, time);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) removePushSubscription(req.userId, endpoint);
  else disableUserPush(req.userId);
  res.json({ ok: true });
});

app.post('/api/push/update-time', requireAuth, (req, res) => {
  const { time } = req.body || {};
  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: 'time must be in HH:MM format' });
  }
  const ok = updatePushTime(req.userId, time);
  if (!ok) return res.status(400).json({ error: 'not currently subscribed' });
  res.json({ ok: true });
});

// Sends a notification immediately, bypassing the scheduler and its
// once-a-day time window entirely — the fastest way to tell whether a
// delivery problem is happening on the server (signing/sending to the push
// service) or somewhere after that (phone/browser settings, battery
// optimization, etc.), since this reports exactly what happened per device
// instead of making you wait for tomorrow's digest window.
app.post('/api/push/test', requireAuth, async (req, res) => {
  const settings = getUserPushSettings(req.userId);
  if (!settings.enabled || settings.subscriptions.length === 0) {
    return res.status(400).json({ error: 'not currently subscribed on any device' });
  }
  const payload = JSON.stringify({
    title: 'AIRDATE test notification',
    body: 'If you can see this, push notifications are working on this device.',
    url: '/',
  });
  const results = [];
  for (const sub of settings.subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      results.push({ endpoint: sub.endpoint, ok: true });
    } catch (err) {
      results.push({ endpoint: sub.endpoint, ok: false, error: err.message, statusCode: err.statusCode || null });
      if (err.statusCode === 404 || err.statusCode === 410) {
        removePushSubscription(req.userId, sub.endpoint); // no longer valid on the browser's end
      }
    }
  }
  res.json({ ok: true, results });
});

// Shows exactly what the server thinks "now" is, both in raw UTC and
// resolved into the account's own timezone (using the identical function
// the digest scheduler itself uses) — the fastest way to confirm or rule
// out a wrong system clock as the reason a digest never fires, without
// needing shell access to the NAS. Also shows the scheduler's actual
// decision right now (already sent today / in window / how long until the
// window opens), since silently doing nothing until the right minute makes
// the scheduler otherwise impossible to inspect from outside the logs.
app.get('/api/push/clock-check', requireAuth, (req, res) => {
  const settings = getUserPushSettings(req.userId);
  const server_utc = new Date().toISOString();
  const local = settings.timezone ? getLocalTimeParts(settings.timezone) : null;

  let schedule_status = null;
  if (local && settings.enabled) {
    const alreadySentToday = settings.last_sent_date === local.date;
    const nowMin = hmToMinutes(local.time);
    const targetMin = hmToMinutes(settings.time || '08:00');
    const inWindow = nowMin >= targetMin && nowMin < targetMin + DIGEST_WINDOW_MINUTES;

    let reason;
    if (alreadySentToday) {
      reason = `Already checked today (marked ${settings.last_sent_date}). Next check will be tomorrow around ${settings.time}.`;
    } else if (inWindow) {
      reason = `Currently inside today's digest window \u2014 should fire on the next scheduler check, within ${Math.round(DIGEST_CHECK_INTERVAL_MS / 60000)} minutes.`;
    } else if (nowMin < targetMin) {
      reason = `Not time yet today \u2014 about ${targetMin - nowMin} minute(s) until your ${settings.time} window opens.`;
    } else {
      reason = `Today's window (${settings.time}, for ${DIGEST_WINDOW_MINUTES} minutes) already passed without marking today as sent \u2014 this points to a real problem (check server logs for "Digest" errors around that time).`;
    }
    schedule_status = { already_sent_today: alreadySentToday, in_window: inWindow, last_sent_date: settings.last_sent_date, reason };
  }

  res.json({
    server_utc,
    timezone: settings.timezone || null,
    local_date: local ? local.date : null,
    local_time: local ? local.time : null,
    digest_time: settings.time || null,
    schedule_status,
  });
});

// Forces today's REAL digest to run right now, using the exact same
// function the scheduler calls — not a generic test message. This is the
// definitive way to answer "does the actual digest work?" without waiting
// for the time window or fiddling with the clock: it either genuinely finds
// nothing airing today, hits the same fetch-failure condition the scheduler
// would, or sends the real notification and reports exactly how that went.
app.post('/api/push/send-digest-now', requireAuth, async (req, res) => {
  const settings = getUserPushSettings(req.userId);
  if (!settings.enabled || settings.subscriptions.length === 0) {
    return res.status(400).json({ error: 'not currently subscribed on any device' });
  }
  if (!settings.timezone) {
    return res.status(400).json({ error: 'no timezone on file \u2014 re-enable notifications once to record it' });
  }
  const todayLocal = getLocalTimeParts(settings.timezone).date;
  const result = await sendDigestToUser(req.userId, settings, todayLocal);
  res.json({ ok: true, ...result });
});

// ---- Search (TV + Movie) ----
app.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const data = await tmdb('/search/multi', { query: q, include_adult: 'false' });
    const results = (data.results || [])
      .filter(r => r.media_type === 'tv' || r.media_type === 'movie')
      .map(r => ({
        tmdb_id: r.id,
        media_type: r.media_type,
        name: r.media_type === 'tv' ? r.name : r.title,
        year: (r.first_air_date || r.release_date || '').slice(0, 4),
        poster_path: r.poster_path,
        overview: r.overview,
      }));
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'TMDB search failed' });
  }
});

// ---- Library ----
app.get('/api/library', requireAuth, (req, res) => {
  const db = readLibrary(req.userId);
  const sorted = [...db.items].sort((a, b) => a.name.localeCompare(b.name));
  res.json({ library: sorted });
});

app.post('/api/library', requireAuth, (req, res) => {
  const { tmdb_id, media_type, name, poster_path } = req.body || {};
  if (!tmdb_id || !['tv', 'movie'].includes(media_type) || !name) {
    return res.status(400).json({ error: 'tmdb_id, media_type, and name are required' });
  }
  try {
    addToLibrary(req.userId, { tmdb_id, media_type, name, poster_path });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to add to library' });
  }
});

app.delete('/api/library/:id', requireAuth, (req, res) => {
  removeFromLibrary(req.userId, req.params.id);
  res.json({ ok: true });
});

// ---- Full detail for one library item: all seasons/episodes + watched flags ----
app.get('/api/show/:id', requireAuth, async (req, res) => {
  const item = readLibrary(req.userId).items.find((i) => i.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'not in library' });

  try {
    if (item.media_type === 'movie') {
      const details = await tmdb(`/movie/${item.tmdb_id}`);
      return res.json({
        library_id: item.id,
        media_type: 'movie',
        name: item.name,
        poster_path: item.poster_path,
        watched: item.watched === true,
        release_date: details.release_date || null,
        status: item.status || 'watching',
      });
    }

    const watchedSet = new Set(Array.isArray(item.watched) ? item.watched : []);
    const [show, extras] = await Promise.all([
      tmdb(`/tv/${item.tmdb_id}`),
      getShowExtras(item.tmdb_id),
    ]);
    const seasonList = (show.seasons || []).filter((s) => s.season_number > 0);
    const today = clientToday(req);

    const seasons = await Promise.all(seasonList.map(async (s) => {
      const season = await tmdb(`/tv/${item.tmdb_id}/season/${s.season_number}`);
      const episodes = (season.episodes || []).map((ep) => {
        const airDate = resolveAirDate(ep.season_number, ep.episode_number, ep.air_date || null, extras);
        const timeMeta = resolveShowMeta(item, extras, { season: ep.season_number, episode: ep.episode_number }, show);
        return {
          season: ep.season_number,
          episode: ep.episode_number,
          name: ep.name || '',
          air_date: airDate,
          aired: !!(airDate && airDate <= today),
          watched: watchedSet.has(epKey(ep.season_number, ep.episode_number)),
          overview: ep.overview || '',
          still_path: ep.still_path || null,
          runtime: ep.runtime || null,
          vote_average: ep.vote_average || null,
          airtime: timeMeta.airtime,
          airtime_is_override: timeMeta.airtime_is_override,
          airstamp: timeMeta.airstamp,
          timezone: timeMeta.timezone,
        };
      });
      return {
        season_number: s.season_number,
        episodes,
        watched_count: episodes.filter((e) => e.watched).length,
        total: episodes.length,
      };
    }));

    seasons.sort((a, b) => a.season_number - b.season_number);
    res.json({
      library_id: item.id,
      media_type: 'tv',
      name: item.name,
      poster_path: item.poster_path,
      ...resolveShowMeta(item, extras, null, show),
      status: item.status || 'watching',
      seasons,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'lookup failed' });
  }
});

// Set (or clear) manual network/air-time overrides for a TV show, used when
// TVmaze doesn't have them on file. airtime is "HH:MM" already in the user's
// own local time (not a network timezone) — no conversion is applied to it.
app.post('/api/network', requireAuth, async (req, res) => {
  const { library_id, network, airtime, hide_network } = req.body || {};
  if (!library_id) return res.status(400).json({ error: 'library_id required' });
  const item = readLibrary(req.userId).items.find((i) => i.id === Number(library_id));
  const ok = setShowOverrides(req.userId, library_id, { network, airtime, hideNetwork: hide_network });
  if (!ok) return res.status(404).json({ error: 'not a TV show in library' });
  // Best-effort: actively go find a real logo for this network name right
  // now, rather than waiting for one to turn up by coincidence later.
  if (!hide_network && network && item) {
    try {
      // This show's OWN TMDB data is the fastest and most authoritative
      // source, when it happens to have a matching entry — check that
      // directly before falling back to a blind global search.
      let found = false;
      if (item.tmdb_id) {
        try {
          const tmdbShow = await tmdb(`/tv/${item.tmdb_id}`);
          const target = network.trim().toLowerCase();
          const match = (tmdbShow.networks || []).find((n) => {
            if (!n.name) return false;
            const name = n.name.toLowerCase();
            return name.includes(target) || target.includes(name);
          });
          if (match && match.logo_path) {
            cacheNetworkLogo(network, match.logo_path);
            found = true;
          }
        } catch (err) {
          console.error('Own-show TMDB lookup failed during network save:', err.message);
        }
      }
      if (!found) await discoverNetworkLogo(network);
    } catch (err) {
      console.error('Network logo discovery error:', err.message);
    }
  }
  res.json({ ok: true });
});

// One-time backfill: goes through every TV show in the library (not just
// ones edited through the network picker), figures out each one's actual
// current network name (manual override if set, otherwise whatever
// TVmaze/auto-detection already found), and runs the same live logo
// discovery for any network name that isn't cached yet. Lets existing
// shows with auto-detected networks (e.g. "NBC") pick up real logos
// without having to manually re-save each one through the edit form.
app.post('/api/refresh-network-logos', requireAuth, async (req, res) => {
  const db = readLibrary(req.userId);
  const tvItems = db.items.filter((i) => i.media_type === 'tv' && !i.network_hide);

  const names = new Set();
  await Promise.all(tvItems.map(async (item) => {
    let name = item.network_override || null;
    if (!name) {
      try {
        const extras = await getShowExtras(item.tmdb_id);
        name = extras.network || null;
      } catch (err) {
        console.error(`Failed to look up network for tmdb ${item.tmdb_id}:`, err.message);
      }
    }
    if (name) names.add(name.trim());
  }));

  let alreadyCached = 0;
  let newlyFound = 0;
  let notFound = 0;
  for (const name of names) {
    if (getCachedNetworkLogo(name)) { alreadyCached++; continue; }
    const logo = await discoverNetworkLogo(name);
    if (logo) newlyFound++;
    else notFound++;
  }

  res.json({
    ok: true,
    networks_checked: names.size,
    already_had_logos: alreadyCached,
    newly_found: newlyFound,
    not_found: notFound,
  });
});

// Pause or resume tracking for a library item. A "stopped" item stays in
// the Library (and keeps its watched history) but is excluded from
// Upcoming and Watchlist until set back to "watching".
app.post('/api/status', requireAuth, (req, res) => {
  const { library_id, status } = req.body || {};
  if (!library_id || !status) return res.status(400).json({ error: 'library_id and status are required' });
  const ok = setStatus(req.userId, library_id, status);
  if (!ok) return res.status(400).json({ error: 'invalid library_id or status' });
  res.json({ ok: true });
});

// ---------- TV Time import ----------
// Minimal CSV parser handling quoted fields, embedded commas/newlines.
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
    return obj;
  });
}

async function tmdbSearchBest(kind, name, year) {
  const params = { query: name, include_adult: 'false' };
  if (kind === 'movie' && year) params.primary_release_year = year;
  const data = await tmdb(`/search/${kind}`, params);
  const results = data.results || [];
  if (results.length === 0) return null;
  const lower = name.toLowerCase();
  // Prefer an exact title match, else take TMDB's top result.
  const exact = results.find((r) => ((kind === 'tv' ? r.name : r.title) || '').toLowerCase() === lower);
  return exact || results[0];
}

// Accepts the raw text of TV Time GDPR export CSVs.
// shows_csv  = tracking-prod-records-v2.csv (one row per watched episode)
// movies_csv = tracking-prod-records.csv    (movie activity: watch/rewatch/watchlist)
app.post('/api/import/tvtime', requireAuth, async (req, res) => {
  const { shows_csv, movies_csv } = req.body || {};
  if (!shows_csv && !movies_csv) {
    return res.status(400).json({ error: 'no CSV data provided' });
  }

  const report = {
    shows_added: 0, episodes_marked: 0,
    movies_added: 0, movies_marked_watched: 0,
    unmatched: [], skipped_rows: 0,
  };
  const db = readLibrary(req.userId);

  function findOrCreate(tmdbResult, media_type) {
    const tmdb_id = tmdbResult.id;
    let item = db.items.find((i) => i.tmdb_id === tmdb_id && i.media_type === media_type);
    if (!item) {
      item = {
        id: db.nextId++,
        tmdb_id,
        media_type,
        name: media_type === 'tv' ? tmdbResult.name : tmdbResult.title,
        poster_path: tmdbResult.poster_path || null,
        added_at: new Date().toISOString(),
        watched: media_type === 'movie' ? false : [],
        network_override: null,
        airtime_override: null,
        status: 'watching',
      };
      db.items.push(item);
      if (media_type === 'tv') report.shows_added++;
      else report.movies_added++;
    }
    return item;
  }

  // ---- Shows ----
  if (shows_csv) {
    const rows = parseCsv(shows_csv).filter((r) => r.series_name);
    // Group watched episodes per series
    const bySeries = new Map();
    for (const r of rows) {
      const season = parseInt(r.season_number, 10);
      const episode = parseInt(r.episode_number, 10);
      if (!Number.isFinite(season) || !Number.isFinite(episode) || season === 0) {
        report.skipped_rows++;
        continue;
      }
      if (!bySeries.has(r.series_name)) bySeries.set(r.series_name, new Set());
      bySeries.get(r.series_name).add(epKey(season, episode));
    }

    for (const [seriesName, epSet] of bySeries) {
      try {
        const match = await tmdbSearchBest('tv', seriesName);
        if (!match) { report.unmatched.push(`TV: ${seriesName}`); continue; }
        const item = findOrCreate(match, 'tv');
        const set = new Set(Array.isArray(item.watched) ? item.watched : []);
        const before = set.size;
        for (const key of epSet) set.add(key);
        item.watched = [...set];
        report.episodes_marked += set.size - before;
      } catch (err) {
        console.error(`Import failed for show "${seriesName}":`, err.message);
        report.unmatched.push(`TV: ${seriesName}`);
      }
    }
  }

  // ---- Movies ----
  if (movies_csv) {
    const rows = parseCsv(movies_csv).filter((r) => r.movie_name);
    // Collapse duplicate rows per movie; watched wins over watchlist.
    const byMovie = new Map();
    for (const r of rows) {
      const watchedRow = ['watch', 'rewatch'].includes((r.type || '').toLowerCase());
      const year = /^\d{4}/.test(r.release_date || '') && r.release_date.slice(0, 4) !== '0000'
        ? r.release_date.slice(0, 4) : null;
      const prev = byMovie.get(r.movie_name);
      byMovie.set(r.movie_name, {
        watched: (prev && prev.watched) || watchedRow,
        year: (prev && prev.year) || year,
      });
    }

    for (const [movieName, info] of byMovie) {
      try {
        const match = await tmdbSearchBest('movie', movieName, info.year);
        if (!match) { report.unmatched.push(`Movie: ${movieName}`); continue; }
        const item = findOrCreate(match, 'movie');
        if (info.watched && item.watched !== true) {
          item.watched = true;
          report.movies_marked_watched++;
        }
      } catch (err) {
        console.error(`Import failed for movie "${movieName}":`, err.message);
        report.unmatched.push(`Movie: ${movieName}`);
      }
    }
  }

  writeLibrary(req.userId, db);
  res.json({ ok: true, report });
});

// ---- Watchlist: everything aired but not yet watched ----
app.get('/api/watchlist', requireAuth, async (req, res) => {
  const today = clientToday(req);
  const items = readLibrary(req.userId).items.filter((i) => i.status !== 'stopped');
  const out = [];

  await mapWithConcurrency(items, 6, async (item) => {
    try {
      if (item.media_type === 'movie') {
        if (item.watched === true) return;
        const details = await tmdb(`/movie/${item.tmdb_id}`);
        if (details.release_date && details.release_date <= today) {
          out.push({
            library_id: item.id,
            media_type: 'movie',
            name: item.name,
            poster_path: item.poster_path,
            unwatched: [{ name: 'Released ' + details.release_date, air_date: details.release_date }],
            count: 1,
          });
        }
      } else {
        const watchedSet = new Set(Array.isArray(item.watched) ? item.watched : []);
        const [show, extras] = await Promise.all([
          tmdb(`/tv/${item.tmdb_id}`),
          getShowExtras(item.tmdb_id),
        ]);
        const seasons = (show.seasons || []).filter((s) => s.season_number > 0);
        const unwatched = [];

        await Promise.all(seasons.map(async (s) => {
          const season = await tmdb(`/tv/${item.tmdb_id}/season/${s.season_number}`);
          for (const ep of season.episodes || []) {
            const airDate = resolveAirDate(ep.season_number, ep.episode_number, ep.air_date || null, extras);
            if (
              airDate && airDate <= today &&
              !watchedSet.has(epKey(ep.season_number, ep.episode_number))
            ) {
              const timeMeta = resolveShowMeta(item, extras, { season: ep.season_number, episode: ep.episode_number }, show);
              unwatched.push({
                season: ep.season_number,
                episode: ep.episode_number,
                name: ep.name || '',
                air_date: airDate,
                overview: ep.overview || '',
                still_path: ep.still_path || null,
                runtime: ep.runtime || null,
                airtime: timeMeta.airtime,
                airtime_is_override: timeMeta.airtime_is_override,
                airstamp: timeMeta.airstamp,
                timezone: timeMeta.timezone,
              });
            }
          }
        }));

        if (unwatched.length > 0) {
          unwatched.sort((a, b) => a.season - b.season || a.episode - b.episode);
          out.push({
            library_id: item.id,
            media_type: 'tv',
            name: item.name,
            poster_path: item.poster_path,
            ...resolveShowMeta(item, extras, null, show),
            unwatched,
            count: unwatched.length,
          });
        }
      }
    } catch (err) {
      console.error(`Watchlist fetch failed for ${item.media_type} ${item.tmdb_id}:`, err.message);
    }
  });

  out.sort((a, b) => b.count - a.count);
  res.json({ watchlist: out });
});

// Mark episodes (or a movie) watched/unwatched.
// TV:    { library_id, episodes: [{season, episode}, ...], watched: true|false }
// Movie: { library_id, watched: true|false }
app.post('/api/watched', requireAuth, (req, res) => {
  const { library_id, episodes, watched } = req.body || {};
  if (!library_id) return res.status(400).json({ error: 'library_id required' });
  const ok = setWatched(req.userId, library_id, { episodes, watched });
  if (!ok) return res.status(404).json({ error: 'not in library' });
  res.json({ ok: true });
});

// ---- Calendar ----
// Returns the next upcoming episode (TV) or release (movie) for everything
// in the library, from today onward — this is the whole feed for the
// Upcoming tab, sorted chronologically.
// Core computation shared by the /api/upcoming route and the daily digest
// scheduler, so both always agree on exactly what's "upcoming" for a user.
async function computeUpcomingEvents(userId, today) {
  const items = readLibrary(userId).items.filter((i) => i.status !== 'stopped');
  const events = [];
  let errorCount = 0;

  await mapWithConcurrency(items, 6, async (item) => {
    try {
      if (item.media_type === 'movie') {
        if (item.watched === true) return;
        const details = await tmdb(`/movie/${item.tmdb_id}`);
        if (details.release_date && details.release_date >= today) {
          events.push({
            date: details.release_date,
            type: 'movie',
            title: item.name,
            subtitle: 'Release',
            poster_path: item.poster_path,
            library_id: item.id,
          });
        }
      } else {
        const [show, extras] = await Promise.all([
          tmdb(`/tv/${item.tmdb_id}`),
          getShowExtras(item.tmdb_id),
        ]);

        // TMDB can roll next_episode_to_air forward as soon as an episode's
        // date passes on their end, even if the user hasn't watched it yet
        // (and even if it's still "today" for the user). So also consider
        // last_episode_to_air, and show whichever unwatched one is soonest.
        // Air dates also get corrected against TVmaze here, since TMDB's
        // dates are occasionally off by a day for reality/documentary shows.
        const watchedSet = new Set(Array.isArray(item.watched) ? item.watched : []);
        const seen = new Set();
        const candidates = [show.last_episode_to_air, show.next_episode_to_air]
          .filter(Boolean)
          .filter((c) => {
            const key = epKey(c.season_number, c.episode_number);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((c) => ({ ...c, air_date: resolveAirDate(c.season_number, c.episode_number, c.air_date, extras) }))
          .filter((c) => c.air_date && c.air_date >= today && !watchedSet.has(epKey(c.season_number, c.episode_number)))
          .sort((a, b) => a.air_date.localeCompare(b.air_date));

        const ep = candidates[0];
        if (ep) {
          events.push({
            date: ep.air_date,
            type: 'tv',
            title: item.name,
            subtitle: `S${String(ep.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}${ep.name ? ' · ' + ep.name : ''}`,
            poster_path: item.poster_path,
            library_id: item.id,
            season: ep.season_number,
            episode: ep.episode_number,
            ...resolveShowMeta(item, extras, { season: ep.season_number, episode: ep.episode_number }, show),
          });
        }
      }
    } catch (err) {
      errorCount++;
      console.error(`Failed to fetch upcoming data for ${item.media_type} ${item.tmdb_id}:`, err.message);
    }
  });

  events.sort((a, b) => a.date.localeCompare(b.date));
  // Every single item failing (with a non-empty library) points to a
  // systemic problem — a bad API key, TMDB/TVmaze being unreachable, etc. —
  // rather than a library that genuinely has nothing airing today.
  const totalFailure = items.length > 0 && errorCount === items.length;
  return { events, totalFailure };
}

app.get('/api/upcoming', requireAuth, async (req, res) => {
  const today = clientToday(req);
  const { events } = await computeUpcomingEvents(req.userId, today);
  res.json({ upcoming: events });
});

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Daily digest scheduler ----------
// Gets the current date/time as the user actually sees it, in their own
// timezone — captured from their browser when they subscribed, since the
// server itself could be running in any timezone.
function getLocalTimeParts(timezone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  // Intl can format midnight as "24:00" instead of "00:00" — normalize.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}
function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function buildDigestMessage(events) {
  const titles = events.map((e) => e.title);
  if (titles.length === 0) return null;
  const body = titles.length <= 3
    ? titles.join(', ')
    : `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more`;
  return {
    title: `${titles.length} show${titles.length === 1 ? '' : 's'} air${titles.length === 1 ? 's' : ''} today`,
    body,
  };
}

async function sendDigestToUser(userId, settings, todayLocal) {
  let shouldMarkDone = true;
  try {
    const { events, totalFailure } = await computeUpcomingEvents(userId, todayLocal);
    if (totalFailure) {
      // Every single show failed to fetch — almost certainly a systemic
      // problem (bad TMDB key, TMDB/TVmaze unreachable) rather than a
      // library that genuinely has nothing airing today. Don't mark today
      // as handled, so this gets retried on the next check instead of
      // silently going quiet for the rest of the day once whatever broke
      // gets fixed.
      shouldMarkDone = false;
      console.error(`Digest for account ${userId} skipped: every show failed to fetch (check TMDB_API_KEY / connectivity). Will retry.`);
      return { outcome: 'fetch_failed' };
    }
    const todayEvents = events.filter((e) => e.date === todayLocal);
    const message = buildDigestMessage(todayEvents);
    if (message) {
      const payload = JSON.stringify({ title: message.title, body: message.body, url: '/' });
      const sendResults = [];
      for (const sub of settings.subscriptions) {
        try {
          await webpush.sendNotification(sub, payload);
          sendResults.push({ endpoint: sub.endpoint, ok: true });
        } catch (err) {
          sendResults.push({ endpoint: sub.endpoint, ok: false, error: err.message, statusCode: err.statusCode || null });
          if (err.statusCode === 404 || err.statusCode === 410) {
            removePushSubscription(userId, sub.endpoint); // no longer valid on the browser's end
          } else {
            console.error(`Push send failed for account ${userId}:`, err.message);
          }
        }
      }
      return { outcome: 'sent', message, sendResults };
    }
    return { outcome: 'nothing_to_report' };
  } finally {
    // Mark as checked today unless the fetch itself failed entirely (see
    // above) — otherwise this account isn't re-evaluated every few minutes
    // for the rest of the day.
    if (shouldMarkDone) {
      const all = readPushSubs();
      if (all[userId]) {
        all[userId].last_sent_date = todayLocal;
        writePushSubs(all);
      }
    }
  }
}

const DIGEST_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DIGEST_WINDOW_MINUTES = 10; // must be >= the check interval, in minutes, so no one gets skipped between checks

async function runDigestCheck() {
  const all = readPushSubs();
  for (const [userId, settings] of Object.entries(all)) {
    if (!settings.enabled || !settings.subscriptions || settings.subscriptions.length === 0) continue;
    if (!settings.timezone) continue;
    const local = getLocalTimeParts(settings.timezone);
    if (settings.last_sent_date === local.date) continue; // already handled today
    const nowMin = hmToMinutes(local.time);
    const targetMin = hmToMinutes(settings.time || '08:00');
    if (nowMin >= targetMin && nowMin < targetMin + DIGEST_WINDOW_MINUTES) {
      await sendDigestToUser(userId, settings, local.date).catch((err) => {
        console.error(`Digest send failed for account ${userId}:`, err.message);
      });
    }
  }
}
setInterval(() => {
  runDigestCheck().catch((err) => console.error('Digest scheduler error:', err.message));
}, DIGEST_CHECK_INTERVAL_MS);

app.listen(PORT, () => console.log(`airdate listening on :${PORT}`));

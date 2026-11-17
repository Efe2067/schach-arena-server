const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { Chess } = require("chess.js");

const IAP_CATALOG = require("./iap-products.json");
const IAP_PRODUCTS = new Map(
  (Array.isArray(IAP_CATALOG.products) ? IAP_CATALOG.products : [])
    .filter((entry) => entry && typeof entry.id === "string")
    .map((entry) => [
      entry.id,
      {
        id: entry.id,
        coins: Math.max(0, Math.floor(Number(entry.coins) || 0)),
        title: typeof entry.title === "string" ? entry.title : entry.id,
      },
    ]),
);
const REVENUECAT_WEBHOOK_SECRET =
  typeof process.env.REVENUECAT_WEBHOOK_SECRET === "string"
    ? process.env.REVENUECAT_WEBHOOK_SECRET.trim()
    : "";
const IAP_CREDIT_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "NON_RENEWING_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
]);

const PORT = Number(process.env.PORT) || 3001;
const CLOCK_MS = Number(process.env.CLOCK_MS) || 15 * 60 * 1000;
const ROOM_TTL_MS = 45 * 60 * 1000;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const MAX_BODY_BYTES = 128 * 1024;
const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[A-Za-z0-9_.\-äöüÄÖÜß]{3,20}$/;

const rooms = new Map();
const queue = [];
let moveSeq = 0;

function emptyAccountStore() {
  return { users: {}, tokens: {} };
}

function loadAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users:
        parsed && typeof parsed.users === "object" && parsed.users
          ? parsed.users
          : {},
      tokens:
        parsed && typeof parsed.tokens === "object" && parsed.tokens
          ? parsed.tokens
          : {},
    };
  } catch {
    return emptyAccountStore();
  }
}

const accounts = loadAccounts();

function saveAccounts() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = `${ACCOUNTS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(accounts), "utf8");
    fs.renameSync(temp, ACCOUNTS_FILE);
  } catch (error) {
    console.error("[accounts] Speichern fehlgeschlagen:", error.message);
  }
}

function userKey(username) {
  return String(username).trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

function passwordMatches(password, user) {
  try {
    const expected = Buffer.from(user.hash, "hex");
    const actual = Buffer.from(hashPassword(password, user.salt), "hex");
    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

function pruneTokens() {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for (const [token, entry] of Object.entries(accounts.tokens)) {
    if (
      !entry ||
      typeof entry.createdAt !== "number" ||
      entry.createdAt < cutoff
    ) {
      delete accounts.tokens[token];
    }
  }
}

function issueToken(key) {
  const token = crypto.randomBytes(24).toString("hex");
  pruneTokens();
  accounts.tokens[token] = { user: key, createdAt: Date.now() };
  saveAccounts();
  return token;
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const list = value
    .filter((entry) => typeof entry === "string")
    .slice(0, 64);
  const unique = Array.from(new Set(list));
  return unique.length > 0 ? unique : [...fallback];
}

function sanitizeQuestProgress(value) {
  const progress = value && typeof value === "object" ? value : {};
  const metrics = {};
  if (progress.metrics && typeof progress.metrics === "object") {
    for (const [key, amount] of Object.entries(progress.metrics).slice(0, 32)) {
      if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
        metrics[key] = Math.min(Math.floor(amount), 1000000);
      }
    }
  }
  const claimed = Array.isArray(progress.claimed)
    ? progress.claimed
        .filter((id) => typeof id === "string")
        .slice(0, 32)
    : [];
  return {
    period:
      typeof progress.period === "string"
        ? progress.period.slice(0, 32)
        : "",
    metrics,
    claimed,
  };
}

function statNumber(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function sanitizeStats(value) {
  const stats = value && typeof value === "object" ? value : {};
  const rating = statNumber(stats.rating, 1000, 100, 4000);
  const peak = statNumber(stats.peakRating, rating, 100, 4000);
  const qualityInput =
    stats.quality && typeof stats.quality === "object" ? stats.quality : {};
  const quality = {};
  for (const key of [
    "brilliant",
    "great",
    "best",
    "excellent",
    "good",
    "book",
    "inaccuracy",
    "mistake",
    "miss",
    "blunder",
  ]) {
    quality[key] = statNumber(qualityInput[key], 0, 0, 1000000000);
  }
  return {
    games: statNumber(stats.games, 0, 0, 1000000000),
    wins: statNumber(stats.wins, 0, 0, 1000000000),
    losses: statNumber(stats.losses, 0, 0, 1000000000),
    draws: statNumber(stats.draws, 0, 0, 1000000000),
    onlineGames: statNumber(stats.onlineGames, 0, 0, 1000000000),
    onlineWins: statNumber(stats.onlineWins, 0, 0, 1000000000),
    botGames: statNumber(stats.botGames, 0, 0, 1000000000),
    botWins: statNumber(stats.botWins, 0, 0, 1000000000),
    checkmates: statNumber(stats.checkmates, 0, 0, 1000000000),
    captures: statNumber(stats.captures, 0, 0, 1000000000),
    moves: statNumber(stats.moves, 0, 0, 1000000000),
    rating,
    peakRating: Math.max(peak, rating),
    streak: statNumber(stats.streak, 0, 0, 1000000000),
    bestStreak: statNumber(stats.bestStreak, 0, 0, 1000000000),
    quality,
  };
}

function sanitizeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    captureAnimations: settings.captureAnimations !== false,
  };
}

function sanitizeTrailId(value) {
  if (typeof value !== "string") {
    return "none";
  }
  const id = value.trim().slice(0, 64);
  return id || "none";
}

function sanitizeDailyAd(value) {
  const ad = value && typeof value === "object" ? value : {};
  return {
    date: typeof ad.date === "string" ? ad.date.slice(0, 32) : "",
    claimed: ad.claimed === true,
  };
}

function sanitizePuzzle(value) {
  const puzzle = value && typeof value === "object" ? value : {};
  return {
    date: typeof puzzle.date === "string" ? puzzle.date.slice(0, 32) : "",
    solved: puzzle.solved === true,
    attempts: statNumber(puzzle.attempts, 0, 0, 5),
    step: statNumber(puzzle.step, 0, 0, 64),
    rewardClaimed: puzzle.rewardClaimed === true,
  };
}

function sanitizeFriends(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const friends = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const name = entry.trim().slice(0, 20);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    friends.push(name);
    if (friends.length >= 50) {
      break;
    }
  }
  return friends;
}

function sanitizeProfile(input) {
  const profile = input && typeof input === "object" ? input : {};
  const quests =
    profile.quests && typeof profile.quests === "object" ? profile.quests : {};
  const updatedAt =
    typeof profile.updatedAt === "number" && Number.isFinite(profile.updatedAt)
      ? Math.max(0, Math.floor(profile.updatedAt))
      : 0;
  return {
    coins:
      typeof profile.coins === "number" && Number.isFinite(profile.coins)
        ? Math.min(Math.max(0, Math.floor(profile.coins)), 1000000000)
        : 100,
    owned: stringList(profile.owned, ["classic"]),
    selected:
      typeof profile.selected === "string"
        ? profile.selected.slice(0, 64)
        : "classic",
    ownedDesigns: stringList(profile.ownedDesigns, ["classic"]),
    selectedDesign:
      typeof profile.selectedDesign === "string"
        ? profile.selectedDesign.slice(0, 64)
        : "classic",
    ownedTrails: stringList(profile.ownedTrails, ["none"]),
    selectedTrail:
      typeof profile.selectedTrail === "string"
        ? profile.selectedTrail.slice(0, 64)
        : "none",
    theme:
      typeof profile.theme === "string"
        ? profile.theme.slice(0, 64)
        : "neon",
    quests: {
      daily: sanitizeQuestProgress(quests.daily),
      weekly: sanitizeQuestProgress(quests.weekly),
      monthly: sanitizeQuestProgress(quests.monthly),
    },
    stats: sanitizeStats(profile.stats),
    friends: sanitizeFriends(profile.friends),
    settings: sanitizeSettings(profile.settings),
    dailyAd: sanitizeDailyAd(profile.dailyAd),
    puzzle: sanitizePuzzle(profile.puzzle),
    updatedAt,
  };
}

function iapState(user) {
  if (!user.iapLedger || typeof user.iapLedger !== "object") {
    user.iapLedger = {};
  }
  if (!Number.isFinite(user.iapCredit)) {
    user.iapCredit = 0;
  }
  if (!Number.isFinite(user.iapTotalClaimed)) {
    user.iapTotalClaimed = 0;
  }
  return user;
}

function iapSummary(user) {
  iapState(user);
  let pending = 0;
  for (const entry of Object.values(user.iapLedger)) {
    if (entry && !entry.claimedAt) {
      pending += 1;
    }
  }
  return {
    credit: Math.max(0, Math.floor(user.iapCredit)),
    totalClaimed: Math.max(0, Math.floor(user.iapTotalClaimed)),
    pendingTransactions: pending,
  };
}

function creditIapTransaction(user, transaction) {
  iapState(user);
  const transactionId =
    typeof transaction.transactionId === "string"
      ? transaction.transactionId.trim().slice(0, 200)
      : "";
  if (!transactionId) {
    return { credited: false, reason: "missing-transaction" };
  }
  const existing = user.iapLedger[transactionId];
  if (existing) {
    // Webhooks werden von RevenueCat bei Fehlern erneut zugestellt.
    // Die transaction_id macht die Gutschrift deshalb idempotent.
    return { credited: false, duplicate: true, coins: existing.coins || 0 };
  }
  const product = IAP_PRODUCTS.get(transaction.productId);
  if (!product || product.coins <= 0) {
    return { credited: false, reason: "unknown-product" };
  }
  const purchasedAt = Number(transaction.purchasedAt);
  user.iapLedger[transactionId] = {
    productId: product.id,
    coins: product.coins,
    source:
      typeof transaction.source === "string"
        ? transaction.source.slice(0, 32)
        : "revenuecat",
    eventType:
      typeof transaction.eventType === "string"
        ? transaction.eventType.slice(0, 48)
        : "",
    purchasedAt: Number.isFinite(purchasedAt) ? purchasedAt : null,
    createdAt: Date.now(),
    claimedAt: null,
  };
  user.iapCredit += product.coins;
  return { credited: true, coins: product.coins };
}

function webhookAuthorized(req) {
  // Ohne konfiguriertes Secret bleibt der Endpoint gesperrt. Sonst könnte
  // jeder beliebige Münzen auf fremde Konten buchen.
  if (!REVENUECAT_WEBHOOK_SECRET) {
    return false;
  }
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const trimmed = header.trim();
  const provided = trimmed.startsWith("Bearer ")
    ? trimmed.slice("Bearer ".length).trim()
    : trimmed;
  if (!provided) {
    return false;
  }
  const expected = Buffer.from(REVENUECAT_WEBHOOK_SECRET, "utf8");
  const actual = Buffer.from(provided, "utf8");
  return (
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  );
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, payload) {
  cors(res);
  // Serverzeit mitschicken: Die App nutzt sie als Schutz gegen eine
  // manipulierte Geräteuhr bei Tagesbelohnungen und Quests.
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload, serverTime: Date.now() }
      : payload;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Die Anfrage ist zu groß."));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!body) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Ungültige Anfrage."));
      }
    });
    req.on("error", reject);
  });
}

function tokenFrom(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function accountFrom(req) {
  const token = tokenFrom(req);
  if (!token) {
    return null;
  }
  const entry = accounts.tokens[token];
  if (!entry || typeof entry.user !== "string") {
    return null;
  }
  const user = accounts.users[entry.user];
  return user ? { token, user, key: entry.user } : null;
}

function publicPlayer(user) {
  return {
    username: user.username,
    stats: sanitizeStats(user.profile && user.profile.stats),
  };
}

function rankedPlayers(limit) {
  return Object.values(accounts.users)
    .filter(
      (user) =>
        user &&
        user.profile &&
        user.profile.stats &&
        Number(user.profile.stats.games) > 0,
    )
    .map(publicPlayer)
    .sort(
      (a, b) =>
        b.stats.rating - a.stats.rating ||
        b.stats.wins - a.stats.wins ||
        a.username.localeCompare(b.username),
    )
    .slice(0, limit);
}

async function handleApi(req, res, pathname, url) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, users: Object.keys(accounts.users).length });
    return;
  }

  if (pathname === "/api/leaderboard" && req.method === "GET") {
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.floor(requested), 1), 100)
      : 25;
    sendJson(res, 200, { players: rankedPlayers(limit) });
    return;
  }

  if (pathname === "/api/players" && req.method === "GET") {
    const raw = url.searchParams.get("names") || "";
    const names = raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 50);
    const players = [];
    const seen = new Set();
    for (const name of names) {
      const key = userKey(name);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const user = accounts.users[key];
      if (user) {
        players.push(publicPlayer(user));
      }
    }
    sendJson(res, 200, { players });
    return;
  }

  if (pathname === "/api/account/register" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    const username =
      body && typeof body.username === "string" ? body.username.trim() : "";
    const password =
      body && typeof body.password === "string" ? body.password : "";
    if (!USERNAME_PATTERN.test(username)) {
      sendJson(res, 400, {
        error:
          "Der Name muss 3–20 Zeichen haben und darf nur Buchstaben, Zahlen, Punkt, _ oder - enthalten.",
      });
      return;
    }
    if (password.length < 6 || password.length > 128) {
      sendJson(res, 400, {
        error: "Das Passwort muss zwischen 6 und 128 Zeichen lang sein.",
      });
      return;
    }
    const key = userKey(username);
    if (accounts.users[key]) {
      sendJson(res, 409, { error: "Dieser Name ist bereits vergeben." });
      return;
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const profile = sanitizeProfile(body && body.profile);
    profile.updatedAt = Date.now();
    accounts.users[key] = {
      username,
      salt,
      hash: hashPassword(password, salt),
      profile,
      createdAt: Date.now(),
    };
    const token = issueToken(key);
    sendJson(res, 201, {
      token,
      username,
      profile,
      iapCredit: 0,
      iapTotalClaimed: 0,
    });
    return;
  }

  if (pathname === "/api/account/login" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    const username =
      body && typeof body.username === "string" ? body.username.trim() : "";
    const password =
      body && typeof body.password === "string" ? body.password : "";
    const key = userKey(username);
    const user = accounts.users[key];
    if (!user || !passwordMatches(password, user)) {
      sendJson(res, 401, { error: "Name oder Passwort ist falsch." });
      return;
    }
    const token = issueToken(key);
    const iap = iapSummary(user);
    sendJson(res, 200, {
      token,
      username: user.username,
      profile: user.profile,
      iapCredit: iap.credit,
      iapTotalClaimed: iap.totalClaimed,
    });
    return;
  }

  if (
    pathname === "/api/iap/revenuecat-webhook" &&
    req.method === "POST"
  ) {
    if (!webhookAuthorized(req)) {
      sendJson(res, 401, { error: "Nicht autorisiert." });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    const event =
      body && body.event && typeof body.event === "object"
        ? body.event
        : null;
    if (!event) {
      sendJson(res, 400, { error: "Ungültiges RevenueCat-Event." });
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (!IAP_CREDIT_EVENT_TYPES.has(type)) {
      sendJson(res, 200, { ok: true, ignored: true, reason: "event-type" });
      return;
    }
    const appUserId =
      typeof event.app_user_id === "string" ? event.app_user_id.trim() : "";
    const key = appUserId ? userKey(appUserId) : "";
    const user = key ? accounts.users[key] : null;
    if (!user) {
      // Nicht unser Konto (z. B. Testkauf mit anonymer RevenueCat-ID).
      // 200 zurückgeben, damit RevenueCat nicht endlos erneut zustellt.
      sendJson(res, 200, { ok: true, ignored: true, reason: "unknown-user" });
      return;
    }
    const productId =
      typeof event.product_id === "string" ? event.product_id : "";
    const rawTransaction =
      typeof event.transaction_id === "string"
        ? event.transaction_id.trim()
        : "";
    const transactionId =
      rawTransaction ||
      `${appUserId}:${productId}:${
        event.purchased_at_ms ?? event.event_timestamp_ms ?? ""
      }`;
    const result = creditIapTransaction(user, {
      transactionId,
      productId,
      source: "revenuecat",
      eventType: type,
      purchasedAt: event.purchased_at_ms,
    });
    if (result.credited) {
      saveAccounts();
      console.log(
        `[iap] ${user.username} +${result.coins} Münzen (${productId}, ${transactionId})`,
      );
    }
    sendJson(res, 200, {
      ok: true,
      ...result,
      credit: iapSummary(user).credit,
    });
    return;
  }

  if (pathname === "/api/iap/claim" && req.method === "POST") {
    const account = accountFrom(req);
    if (!account) {
      sendJson(res, 401, { error: "Bitte melde dich erneut an." });
      return;
    }
    const user = iapState(account.user);
    const granted = Math.max(0, Math.floor(user.iapCredit));
    if (granted > 0) {
      const now = Date.now();
      user.iapCredit = 0;
      user.iapTotalClaimed += granted;
      for (const entry of Object.values(user.iapLedger)) {
        if (entry && !entry.claimedAt) {
          entry.claimedAt = now;
        }
      }
      saveAccounts();
      console.log(`[iap] ${user.username} hat ${granted} Münzen abgeholt`);
    }
    sendJson(res, 200, {
      granted,
      iapCredit: 0,
      totalClaimed: Math.max(0, Math.floor(user.iapTotalClaimed)),
    });
    return;
  }

  if (pathname === "/api/account/profile") {
    const account = accountFrom(req);
    if (!account) {
      sendJson(res, 401, { error: "Bitte melde dich erneut an." });
      return;
    }
    if (req.method === "GET") {
      const iap = iapSummary(account.user);
      sendJson(res, 200, {
        profile: account.user.profile,
        iapCredit: iap.credit,
        iapTotalClaimed: iap.totalClaimed,
      });
      return;
    }
    if (req.method === "PUT") {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      const incoming = sanitizeProfile(body && body.profile);
      const current = account.user.profile || {};
      const currentUpdated =
        typeof current.updatedAt === "number" ? current.updatedAt : 0;
      if (incoming.updatedAt < currentUpdated) {
        sendJson(res, 200, { profile: current });
        return;
      }
      if (!incoming.updatedAt) {
        incoming.updatedAt = Date.now();
      }
      account.user.profile = incoming;
      saveAccounts();
      sendJson(res, 200, { profile: incoming });
      return;
    }
  }

  if (pathname === "/api/account/delete" && req.method === "POST") {
    const account = accountFrom(req);
    if (!account) {
      sendJson(res, 401, { error: "Bitte melde dich erneut an." });
      return;
    }
    const key = account.key;
    const username = account.user.username;
    delete accounts.users[key];
    for (const [token, entry] of Object.entries(accounts.tokens)) {
      if (entry && entry.user === key) {
        delete accounts.tokens[token];
      }
    }
    saveAccounts();
    sendJson(res, 200, { ok: true, username });
    console.log(`[account] ${username} gelöscht`);
    return;
  }

  sendJson(res, 404, { error: "Nicht gefunden." });
}

const httpServer = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(req, res, requestUrl.pathname, requestUrl).catch((error) => {
      console.error("[api]", error);
      sendJson(res, 500, { error: "Interner Serverfehler." });
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Schach Arena server is running");
});

const wss = new WebSocketServer({ server: httpServer });

function send(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload) {
  for (const player of room.players.values()) {
    send(player.ws, payload);
  }
}

function opposite(color) {
  return color === "w" ? "b" : "w";
}

function cleanName(name) {
  const value = typeof name === "string" ? name.trim().slice(0, 20) : "";
  return value || "Gast";
}

function cleanRating(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1000;
  }
  return Math.max(100, Math.min(4000, Math.round(value)));
}

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  do {
    id = "";
    for (let i = 0; i < 5; i += 1) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(id));
  return id;
}

function currentClocks(room) {
  const clocks = { ...room.clocks };
  if (room.started && !room.gameOver) {
    const turn = room.chess.turn();
    clocks[turn] = Math.max(0, clocks[turn] - (Date.now() - room.turnStartedAt));
  }
  return clocks;
}

function stateFor(room) {
  return {
    fen: room.chess.fen(),
    turn: room.chess.turn(),
    clocks: currentClocks(room),
    captures: room.captures,
    lastMove: room.lastMove,
    gameOver: room.gameOver,
    players: {
      w: room.players.get("w")?.name ?? "Weiß",
      b: room.players.get("b")?.name ?? "Schwarz",
    },
    ratings: {
      w: room.ratings.w ?? 1000,
      b: room.ratings.b ?? 1000,
    },
    check: room.chess.inCheck(),
    started: room.started,
    trails: { w: room.trails.w, b: room.trails.b },
  };
}

function addPlayer(room, color, ws, name, trail, rating) {
  room.players.set(color, { ws, name, color });
  room.trails[color] = sanitizeTrailId(trail);
  room.ratings[color] = cleanRating(rating);
  ws.roomId = room.id;
  ws.color = color;
}

function startRoom(room) {
  room.started = true;
  room.turnStartedAt = Date.now();
  for (const player of room.players.values()) {
    send(player.ws, {
      type: "start",
      roomId: room.id,
      color: player.color,
      state: stateFor(room),
    });
  }
}

function finish(room, result, reason) {
  if (room.gameOver) {
    return;
  }
  room.gameOver = { result, reason };
  broadcast(room, { type: "gameover", state: stateFor(room) });
}

function removeFromQueue(ws) {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].ws === ws) {
      queue.splice(i, 1);
    }
  }
}

function leaveRoom(ws, notify = true) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  if (!room) {
    ws.roomId = undefined;
    ws.color = undefined;
    return;
  }

  const color = ws.color;
  const player = color ? room.players.get(color) : null;
  if (player && player.ws === ws) {
    room.players.delete(color);
  }
  ws.roomId = undefined;
  ws.color = undefined;

  if (!room.gameOver && room.started && notify) {
    const remaining = [...room.players.values()][0];
    if (remaining) {
      send(remaining.ws, { type: "opponentLeft" });
      room.gameOver = { result: remaining.color, reason: "abandon" };
    }
  }

  if (room.players.size === 0) {
    rooms.delete(room.id);
  }
}

function createRoom() {
  const room = {
    id: makeRoomId(),
    chess: new Chess(),
    players: new Map(),
    clocks: { w: CLOCK_MS, b: CLOCK_MS },
    captures: { w: [], b: [] },
    ratings: { w: 1000, b: 1000 },
    turnStartedAt: 0,
    lastMove: null,
    gameOver: null,
    started: false,
    trails: { w: "none", b: "none" },
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function handleCreate(ws, msg) {
  removeFromQueue(ws);
  leaveRoom(ws);
  const room = createRoom();
  addPlayer(room, "w", ws, cleanName(msg.name), msg.trail, msg.rating);
  send(ws, { type: "room", roomId: room.id, color: "w", state: stateFor(room) });
}

function handleJoin(ws, msg) {
  const roomId = typeof msg.roomId === "string" ? msg.roomId.trim().toUpperCase() : "";
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: "error", message: "Raum nicht gefunden." });
    return;
  }
  if (room.started || room.players.size >= 2) {
    send(ws, { type: "error", message: "Dieser Raum ist bereits voll oder gestartet." });
    return;
  }
  removeFromQueue(ws);
  leaveRoom(ws);
  addPlayer(room, "b", ws, cleanName(msg.name), msg.trail, msg.rating);
  startRoom(room);
}

function handleQuick(ws, msg) {
  removeFromQueue(ws);
  leaveRoom(ws);

  const index = queue.findIndex(
    (entry) => entry.ws !== ws && entry.ws.readyState === 1 && !entry.ws.roomId
  );
  if (index === -1) {
    queue.push({
      ws,
      name: cleanName(msg.name),
      trail: msg.trail,
      rating: msg.rating,
    });
    send(ws, { type: "queued" });
    return;
  }

  const opponent = queue[index];
  queue.splice(index, 1);
  const room = createRoom();
  addPlayer(room, "w", opponent.ws, opponent.name, opponent.trail, opponent.rating);
  addPlayer(room, "b", ws, cleanName(msg.name), msg.trail, msg.rating);
  startRoom(room);
}

function handleMove(ws, msg) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  if (!room || !room.started) {
    send(ws, { type: "error", message: "Keine aktive Partie." });
    return;
  }
  if (room.gameOver) {
    return;
  }
  const color = ws.color;
  if (!color || room.chess.turn() !== color) {
    send(ws, { type: "error", message: "Du bist nicht am Zug.", state: stateFor(room) });
    return;
  }

  const elapsed = Date.now() - room.turnStartedAt;
  const remaining = room.clocks[color] - elapsed;
  if (remaining <= 0) {
    room.clocks[color] = 0;
    finish(room, opposite(color), "timeout");
    return;
  }

  let move;
  try {
    const payload = { from: msg.from, to: msg.to };
    if (msg.promotion) {
      payload.promotion = msg.promotion;
    }
    move = room.chess.move(payload);
  } catch {
    send(ws, { type: "error", message: "Ungültiger Zug.", state: stateFor(room) });
    return;
  }

  room.clocks[color] = remaining;
  room.turnStartedAt = Date.now();
  room.lastMove = {
    from: move.from,
    to: move.to,
    piece: move.piece,
    captured: move.captured ?? null,
    promotion: move.promotion ?? null,
    san: move.san,
    color,
    seq: (moveSeq += 1),
  };
  if (move.captured) {
    room.captures[color].push(move.captured);
  }

  if (room.chess.isCheckmate()) {
    finish(room, color, "checkmate");
    return;
  }
  if (room.chess.isStalemate()) {
    finish(room, "draw", "stalemate");
    return;
  }
  if (room.chess.isInsufficientMaterial()) {
    finish(room, "draw", "insufficient");
    return;
  }
  if (room.chess.isThreefoldRepetition()) {
    finish(room, "draw", "repetition");
    return;
  }
  if (room.chess.isDraw()) {
    finish(room, "draw", "fifty-move");
    return;
  }

  broadcast(room, { type: "move", move: room.lastMove, state: stateFor(room) });
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "create":
      handleCreate(ws, msg);
      break;
    case "join":
      handleJoin(ws, msg);
      break;
    case "quick":
      handleQuick(ws, msg);
      break;
    case "move":
      handleMove(ws, msg);
      break;
    case "resign": {
      const room = ws.roomId ? rooms.get(ws.roomId) : null;
      if (room && room.started && !room.gameOver && ws.color) {
        finish(room, opposite(ws.color), "resign");
      }
      break;
    }
    case "leave":
      removeFromQueue(ws);
      leaveRoom(ws);
      break;
    case "ping":
      send(ws, { type: "pong" });
      break;
    default:
      break;
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg && typeof msg.type === "string") {
      handleMessage(ws, msg);
    }
  });
  ws.on("close", () => {
    removeFromQueue(ws);
    leaveRoom(ws);
  });
  ws.on("error", () => {
    removeFromQueue(ws);
    leaveRoom(ws);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started || room.gameOver) {
      continue;
    }
    const clocks = currentClocks(room);
    const turn = room.chess.turn();
    if (clocks[turn] <= 0) {
      room.clocks[turn] = 0;
      finish(room, opposite(turn), "timeout");
      continue;
    }
    broadcast(room, { type: "clock", clocks });
  }
}, 1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const stale = now - room.createdAt > ROOM_TTL_MS;
    const empty = room.players.size === 0;
    if (stale || empty) {
      rooms.delete(id);
    }
  }
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].ws.readyState !== 1) {
      queue.splice(i, 1);
    }
  }
}, 30000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`Schach Arena server listening on port ${PORT}`);
});

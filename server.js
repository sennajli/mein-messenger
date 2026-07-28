const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { Client, GatewayIntentBits } = require("discord.js");

const PORT = process.env.PORT || 3000;

// ==========================================================
// Discord-Bot Setup
// - Lokal auf deinem PC: liest die Datei discord-config.json
// - Auf Render: liest die Umgebungsvariablen DISCORD_BOT_TOKEN / DISCORD_ALLOWED_IDS
// ==========================================================
let discordConfig = { token: null, requiredRoleId: null };
if (process.env.DISCORD_BOT_TOKEN) {
  discordConfig.token = process.env.DISCORD_BOT_TOKEN;
  discordConfig.requiredRoleId = process.env.DISCORD_REQUIRED_ROLE_ID || null;
} else {
  try {
    discordConfig = require("./discord-config.json");
  } catch (e) {
    console.log("⚠️  Keine discord-config.json gefunden - Discord-Bot bleibt aus (Zugangscode funktioniert erst, wenn du sie einrichtest).");
  }
}

// Merkt sich vergebene Codes: code -> Ablaufzeitpunkt (in ms)
let activationCodes = new Map();

if (discordConfig.token) {
  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers
    ]
  });

  discordClient.on("ready", () => {
    console.log(`✅ Discord-Bot eingeloggt als ${discordClient.user.tag}`);
  });

  discordClient.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!msg.guild) return; // nur auf Nachrichten in einem Server reagieren, keine DMs mehr

    const text = msg.content.trim().toLowerCase();
    if (text !== "!code" && text !== "/code") return;

    const requiredRole = discordConfig.requiredRoleId;
    if (requiredRole) {
      const member = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !member.roles.cache.has(requiredRole)) {
        msg.reply("❌ Du hast nicht die nötige Rolle, um einen Zugangscode anzufordern.");
        return;
      }
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-stelliger Code
    activationCodes.set(code, Date.now() + 5 * 60 * 1000); // 5 Minuten gültig
    msg.reply(`🔑 Aktivierungscode: **${code}**\nGültig für 5 Minuten.`);
  });

  discordClient.login(discordConfig.token).catch(e => {
    console.log("⚠️  Discord-Bot konnte sich nicht einloggen:", e.message);
  });
}

// ==========================================================
// Firebase / Firestore Setup
// - Lokal auf deinem PC: liest die Datei serviceAccountKey.json
// - Auf Render: liest den Inhalt aus der Umgebungsvariable FIREBASE_SERVICE_ACCOUNT
// ==========================================================
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./serviceAccountKey.json");
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const usersCol = db.collection("users");
const messagesCol = db.collection("messages");
const groupsCol = db.collection("groups");
const friendRequestsCol = db.collection("friendRequests");
const trustedDevicesCol = db.collection("trustedDevices");

const app = express();
app.use(express.static("public"));
app.use(express.json({ limit: "20mb" }));

function conversationKey(a, b) { return [a, b].sort().join("|"); }

let sessions = new Map(); // token -> username
function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function getUserFromToken(token) { return sessions.get(token) || null; }

// ==========================================================
// Sicherheits-Helfer
// ==========================================================

// Erlaubt nur unbedenkliche Zeichen im Benutzernamen. Das verhindert u.a.,
// dass jemand über seinen eigenen Usernamen JS/HTML in andere Clients
// einschleust (der Name landet an mehreren Stellen im Frontend in
// Inline-onclick-Strings, nicht nur als Text).
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;
function isValidUsername(u) { return typeof u === "string" && USERNAME_RE.test(u); }

// Avatare/Wallpaper dürfen nur "echte" Bild-Daten oder https-URLs sein,
// und nicht beliebig groß werden (Firestore-Dokumente sind auf 1 MiB limitiert).
const MAX_AVATAR_BYTES = 700 * 1024; // ~700KB Rohstring, reicht für ein komprimiertes Profilbild
function isValidImageValue(v) {
  if (v === "" || v === null || v === undefined) return true; // leer/entfernen ist ok
  if (typeof v !== "string") return false;
  if (v.length > MAX_AVATAR_BYTES) return false;
  return v.startsWith("data:image/") || v.startsWith("https://");
}

// Einfacher In-Memory Rate-Limiter für sensible Endpunkte (Login, Registrierung,
// Zugangscode). Kein Ersatz für einen echten Reverse-Proxy-Rate-Limiter in Produktion,
// aber verhindert triviales Brute-Forcing.
const rateBuckets = new Map(); // key -> { count, resetAt }
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ":" + (req.ip || req.headers["x-forwarded-for"] || "unknown");
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({ error: "Zu viele Versuche. Bitte kurz warten." });
    }
    next();
  };
}
// Alte Buckets ab und zu aufräumen, damit die Map nicht unbegrenzt wächst
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
}, 10 * 60 * 1000);

let onlineUsers = new Map(); // username -> ws
let typingTimers = new Map();

function sendTo(username, data) {
  const ws = onlineUsers.get(username);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

async function getUser(username) {
  const doc = await usersCol.doc(username).get();
  return doc.exists ? doc.data() : null;
}

// ===== REST API =====

// Hilfsfunktion: prüft, ob ein Gerät bereits dauerhaft freigeschaltet ist
async function isDeviceTrusted(deviceToken) {
  if (!deviceToken) return false;
  const doc = await trustedDevicesCol.doc(deviceToken).get();
  return doc.exists;
}

// Einmal-Code (von Discord) einlösen -> Gerät wird DAUERHAFT freigeschaltet
app.post("/api/check-access", rateLimit("check-access", 20, 10 * 60 * 1000), async (req, res) => {
  const { code } = req.body;
  const expiry = activationCodes.get(code);
  if (!expiry || expiry < Date.now()) {
    return res.json({ ok: false });
  }
  activationCodes.delete(code); // Code ist nur einmal gültig
  const deviceToken = crypto.randomBytes(32).toString("hex");
  await trustedDevicesCol.doc(deviceToken).set({ createdAt: Date.now() });
  res.json({ ok: true, deviceToken });
});

// Prüft, ob ein gespeichertes Geräte-Token noch gültig ist (z.B. beim Seiten-Neuladen)
app.post("/api/check-device", async (req, res) => {
  const ok = await isDeviceTrusted(req.body.deviceToken);
  res.json({ ok });
});

app.post("/api/register", rateLimit("register", 10, 10 * 60 * 1000), async (req, res) => {
  const { deviceToken, username, password } = req.body;
  if (!(await isDeviceTrusted(deviceToken))) return res.status(403).json({ error: "Dieses Gerät ist nicht freigeschaltet." });
  if (!username || !password || password.length < 4)
    return res.status(400).json({ error: "Name und Passwort (min. 4 Zeichen) nötig." });
  const uname = username.trim().toLowerCase();
  if (!isValidUsername(uname))
    return res.status(400).json({ error: "Name muss 3-20 Zeichen sein: nur Buchstaben, Zahlen, '_' und '.'." });
  const existing = await getUser(uname);
  if (existing) return res.status(400).json({ error: "Name schon vergeben." });
  const passwordHash = await bcrypt.hash(password, 10);
  const userData = {
    passwordHash, contacts: [], avatar: "", publicKey: null,
    settings: { darkMode: true },
    bio: "", socials: { instagram: "", tiktok: "", twitter: "" },
    statusMessage: "", statusEmoji: "🟢"
  };
  await usersCol.doc(uname).set(userData);
  const token = makeToken();
  sessions.set(token, uname);
  res.json({ token, username: uname });
});

app.post("/api/login", rateLimit("login", 15, 10 * 60 * 1000), async (req, res) => {
  const { deviceToken, username, password } = req.body;
  if (!(await isDeviceTrusted(deviceToken))) return res.status(403).json({ error: "Dieses Gerät ist nicht freigeschaltet." });
  const uname = (username || "").trim().toLowerCase();
  const user = await getUser(uname);
  if (!user) return res.status(400).json({ error: "Name oder Passwort falsch." });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: "Name oder Passwort falsch." });
  const token = makeToken();
  sessions.set(token, uname);
  res.json({
    token, username: uname,
    avatar: user.avatar || "",
    settings: user.settings || {},
    bio: user.bio || "",
    socials: user.socials || {},
    statusMessage: user.statusMessage || "",
    statusEmoji: user.statusEmoji || "🟢"
  });
});

app.post("/api/profile", async (req, res) => {
  const { token, avatar, bio, socials, statusMessage, statusEmoji } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  if (avatar !== undefined && !isValidImageValue(avatar))
    return res.status(400).json({ error: "Ungültiges Avatarbild (zu groß oder falsches Format)." });
  const updates = {};
  if (avatar !== undefined) updates.avatar = avatar;
  if (bio !== undefined) updates.bio = String(bio).substring(0, 300);
  if (socials !== undefined) {
    const s = socials || {};
    updates.socials = {
      instagram: String(s.instagram || "").substring(0, 40),
      tiktok: String(s.tiktok || "").substring(0, 40),
      twitter: String(s.twitter || "").substring(0, 40)
    };
  }
  if (statusMessage !== undefined) updates.statusMessage = String(statusMessage).substring(0, 100);
  if (statusEmoji !== undefined) updates.statusEmoji = String(statusEmoji).substring(0, 8);
  await usersCol.doc(me).set(updates, { merge: true });
  const meData = await getUser(me);
  (meData.contacts || []).forEach(c => sendTo(c, {
    type: "profileUpdate", username: me,
    avatar: meData.avatar, bio: meData.bio,
    socials: meData.socials, statusMessage: meData.statusMessage,
    statusEmoji: meData.statusEmoji
  }));
  res.json({ ok: true });
});

app.get("/api/profile/:username", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const target = req.params.username.toLowerCase();
  const user = await getUser(target);
  if (!user) return res.status(404).json({ error: "Nicht gefunden." });
  res.json({
    username: target,
    avatar: user.avatar || "",
    bio: user.bio || "",
    socials: user.socials || {},
    statusMessage: user.statusMessage || "",
    statusEmoji: user.statusEmoji || "🟢",
    online: onlineUsers.has(target),
    publicKey: user.publicKey || null
  });
});

app.post("/api/settings", async (req, res) => {
  const { token, settings } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const meData = await getUser(me);
  const newSettings = { ...(meData.settings || {}), ...settings };
  await usersCol.doc(me).set({ settings: newSettings }, { merge: true });
  res.json({ ok: true });
});

// Öffentlichen Verschlüsselungs-Schlüssel hochladen/aktualisieren
app.post("/api/keys", async (req, res) => {
  const { token, publicKey } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  await usersCol.doc(me).set({ publicKey: publicKey || null }, { merge: true });
  res.json({ ok: true });
});

app.get("/api/contacts", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const meData = await getUser(me);
  const contactUsernames = meData.contacts || [];
  const list = await Promise.all(contactUsernames.map(async (c) => {
    const cData = await getUser(c);
    return {
      username: c,
      avatar: cData?.avatar || "",
      online: onlineUsers.has(c),
      statusMessage: cData?.statusMessage || "",
      statusEmoji: cData?.statusEmoji || "🟢",
      publicKey: cData?.publicKey || null
    };
  }));
  res.json({ contacts: list });
});

// Freundschaftsanfragen
app.post("/api/friends/request", async (req, res) => {
  const { token, to } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const target = (to || "").trim().toLowerCase();
  const targetUser = await getUser(target);
  if (!targetUser) return res.status(404).json({ error: "Benutzer nicht gefunden." });
  if (target === me) return res.status(400).json({ error: "Kannst dir selbst keine Anfrage senden." });
  const meData = await getUser(me);
  if ((meData.contacts || []).includes(target)) return res.status(400).json({ error: "Ihr seid schon Freunde." });

  const [fwdSnap, revSnap] = await Promise.all([
    friendRequestsCol.where("from", "==", me).where("to", "==", target).limit(1).get(),
    friendRequestsCol.where("from", "==", target).where("to", "==", me).limit(1).get()
  ]);
  if (!fwdSnap.empty || !revSnap.empty) return res.status(400).json({ error: "Anfrage bereits gesendet." });

  const entry = { from: me, to: target, time: Date.now() };
  const docRef = await friendRequestsCol.add(entry);
  sendTo(target, { type: "friendRequest", request: { id: docRef.id, ...entry } });
  res.json({ ok: true });
});

app.get("/api/friends/requests", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const snap = await friendRequestsCol.where("to", "==", me).get();
  res.json({ requests: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

app.post("/api/friends/respond", async (req, res) => {
  const { token, requestId, accept } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const docRef = friendRequestsCol.doc(requestId);
  const doc = await docRef.get();
  if (!doc.exists || doc.data().to !== me) return res.status(404).json({ error: "Anfrage nicht gefunden." });
  const request = doc.data();
  await docRef.delete();
  if (accept) {
    await usersCol.doc(me).set({ contacts: admin.firestore.FieldValue.arrayUnion(request.from) }, { merge: true });
    await usersCol.doc(request.from).set({ contacts: admin.firestore.FieldValue.arrayUnion(me) }, { merge: true });
    const meData = await getUser(me);
    const fromData = await getUser(request.from);
    sendTo(request.from, { type: "friendAccepted", by: me, avatar: meData?.avatar || "" });
    sendTo(me, { type: "friendAccepted", by: request.from, avatar: fromData?.avatar || "" });
  }
  res.json({ ok: true });
});

app.post("/api/friends/remove", async (req, res) => {
  const { token, username } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const target = (username || "").trim().toLowerCase();
  await usersCol.doc(me).set({ contacts: admin.firestore.FieldValue.arrayRemove(target) }, { merge: true });
  await usersCol.doc(target).set({ contacts: admin.firestore.FieldValue.arrayRemove(me) }, { merge: true });
  res.json({ ok: true });
});

// Nachrichten
app.get("/api/messages", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const withUser = (req.query.with || "").trim().toLowerCase();
  const key = conversationKey(me, withUser);
  const doc = await messagesCol.doc(key).get();
  res.json({ messages: doc.exists ? (doc.data().list || []) : [] });
});

app.post("/api/messages/read", async (req, res) => {
  const { token, with: withUser } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const key = conversationKey(me, withUser);
  const docRef = messagesCol.doc(key);
  const doc = await docRef.get();
  if (doc.exists) {
    const list = doc.data().list || [];
    let changed = false;
    list.forEach(msg => {
      if (msg.from !== me && !(msg.readBy || []).includes(me)) {
        if (!msg.readBy) msg.readBy = [];
        msg.readBy.push(me);
        changed = true;
      }
    });
    if (changed) await docRef.set({ list }, { merge: true });
  }
  sendTo(withUser, { type: "messagesRead", by: me });
  res.json({ ok: true });
});

app.post("/api/messages/delete", async (req, res) => {
  const { token, with: withUser, messageId } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const key = conversationKey(me, withUser);
  const docRef = messagesCol.doc(key);
  const doc = await docRef.get();
  if (doc.exists) {
    const list = doc.data().list || [];
    const msg = list.find(m => m.id === messageId);
    if (msg && msg.from === me) {
      msg.deleted = true;
      msg.ct = "";
      msg.iv = "";
      await docRef.set({ list }, { merge: true });
      sendTo(withUser, { type: "messageDeleted", messageId, with: me });
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: "Nachricht nicht gefunden oder keine Berechtigung." });
});

app.post("/api/messages/react", async (req, res) => {
  const { token, with: withUser, messageId, emoji } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const key = conversationKey(me, withUser);
  const docRef = messagesCol.doc(key);
  const doc = await docRef.get();
  if (!doc.exists) return res.status(404).json({ error: "Nachricht nicht gefunden." });
  const list = doc.data().list || [];
  const msg = list.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: "Nachricht nicht gefunden." });
  if (!msg.reactions) msg.reactions = {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  const idx = msg.reactions[emoji].indexOf(me);
  if (idx === -1) msg.reactions[emoji].push(me);
  else msg.reactions[emoji].splice(idx, 1);
  if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
  await docRef.set({ list }, { merge: true });
  sendTo(withUser, { type: "reaction", messageId, emoji, reactions: msg.reactions, chatUser: me });
  sendTo(me, { type: "reaction", messageId, emoji, reactions: msg.reactions, chatUser: withUser });
  res.json({ ok: true, reactions: msg.reactions });
});

// Gruppen
//
// Jedes Gruppen-Dokument enthält ein "keys"-Feld: { username: {wrappedKey, iv} }.
// Das ist der zufällige AES-Gruppenschlüssel, einzeln für jedes Mitglied per ECDH
// verschlüsselt ("eingepackt"). Der Server darf NIEMALS die Pakete anderer Mitglieder
// an ein Mitglied herausgeben - groupForMember() entfernt "keys" komplett und ersetzt
// es durch nur das eigene Paket des Empfängers ("myWrappedKey").
function groupForMember(group, username) {
  const { keys, ...rest } = group;
  return { ...rest, myWrappedKey: (keys && keys[username]) || null };
}
function notifyGroupMembers(group, type, extra) {
  (group.members || []).forEach(m => sendTo(m, { type, group: groupForMember(group, m), ...(extra || {}) }));
}

app.post("/api/groups/create", async (req, res) => {
  const { token, name, members, wrappedKeys } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const groupId = "g_" + makeToken().substring(0, 12);
  const allMembers = [...new Set([me, ...(members || [])])];
  // Nur Pakete für tatsächliche Mitglieder übernehmen, alles andere ignorieren.
  const keys = {};
  if (wrappedKeys && typeof wrappedKeys === "object") {
    for (const u of allMembers) {
      const w = wrappedKeys[u];
      // "from" wird serverseitig gesetzt (nicht vom Client übernommen!), damit der
      // Empfänger später weiß, mit wessen ECDH-Shared-Key er entpacken muss.
      if (w && typeof w.wrappedKey === "string" && typeof w.iv === "string") keys[u] = { wrappedKey: w.wrappedKey, iv: w.iv, from: me };
    }
  }
  const group = { id: groupId, name: name || "Neue Gruppe", members: allMembers, messages: [], createdBy: me, avatar: "", time: Date.now(), keys };
  await groupsCol.doc(groupId).set(group);
  notifyGroupMembers(group, "groupCreated");
  res.json({ ok: true, groupId, group: groupForMember(group, me) });
});

app.get("/api/groups", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const snap = await groupsCol.where("members", "array-contains", me).get();
  res.json({ groups: snap.docs.map(d => groupForMember(d.data(), me)) });
});

app.get("/api/groups/messages", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const doc = await groupsCol.doc(req.query.groupId).get();
  if (!doc.exists || !doc.data().members.includes(me)) return res.status(403).json({ error: "Kein Zugriff." });
  res.json({ messages: doc.data().messages || [] });
});

app.post("/api/groups/update", async (req, res) => {
  const { token, groupId, name, avatar } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const docRef = groupsCol.doc(groupId);
  const doc = await docRef.get();
  if (!doc.exists || !doc.data().members.includes(me)) return res.status(403).json({ error: "Kein Zugriff auf diese Gruppe." });
  if (avatar !== undefined && !isValidImageValue(avatar))
    return res.status(400).json({ error: "Ungültiges Gruppenbild (zu groß oder falsches Format)." });
  const updates = {};
  if (name !== undefined && name.trim().length > 0) updates.name = name.trim().substring(0, 50);
  if (avatar !== undefined) updates.avatar = avatar;
  await docRef.set(updates, { merge: true });
  const updated = (await docRef.get()).data();
  notifyGroupMembers(updated, "groupUpdated");
  res.json({ ok: true, group: groupForMember(updated, me) });
});

// Einmalige Nachrüstung für Gruppen, die vor der Verschlüsselung erstellt wurden und
// deshalb noch kein "keys"-Feld haben. Wer zuerst schreibt, erzeugt einen neuen
// Gruppenschlüssel und verteilt ihn an alle aktuellen Mitglieder.
//
// WICHTIG: Läuft als Firestore-Transaktion, nicht als einfaches read-then-write.
// Ohne Transaktion können zwei Mitglieder, die fast gleichzeitig beitreten/öffnen,
// jeweils ihren eigenen Schlüssel erzeugen und gegenseitig überschreiben - dann hat
// jeder einen anderen Gruppenschlüssel und kann die Nachrichten des anderen nicht
// mehr entschlüsseln. Die Transaktion stellt sicher, dass wirklich nur eine einzige
// Initialisierung jemals gewinnt, egal wie knapp die Anfragen zeitlich beieinanderliegen.
app.post("/api/groups/keys/init", async (req, res) => {
  const { token, groupId, wrappedKeys } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const docRef = groupsCol.doc(groupId);
  try {
    const updated = await db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      if (!doc.exists || !doc.data().members.includes(me)) {
        const err = new Error("Kein Zugriff auf diese Gruppe.");
        err.status = 403;
        throw err;
      }
      const group = doc.data();
      if (group.keys && Object.keys(group.keys).length > 0) {
        return group; // schon initialisiert (von wem auch immer zuerst) - nichts überschreiben
      }
      const keys = {};
      if (wrappedKeys && typeof wrappedKeys === "object") {
        for (const u of group.members) {
          const w = wrappedKeys[u];
          if (w && typeof w.wrappedKey === "string" && typeof w.iv === "string") keys[u] = { wrappedKey: w.wrappedKey, iv: w.iv, from: me };
        }
      }
      const next = { ...group, keys };
      tx.set(docRef, { keys }, { merge: true });
      return next;
    });
    notifyGroupMembers(updated, "groupUpdated");
    res.json({ ok: true, group: groupForMember(updated, me) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Fehler bei der Schlüssel-Initialisierung." });
  }
});

app.post("/api/groups/members/add", async (req, res) => {
  const { token, groupId, usernames, newWrappedKeys } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const docRef = groupsCol.doc(groupId);
  const doc = await docRef.get();
  if (!doc.exists || !doc.data().members.includes(me)) return res.status(403).json({ error: "Kein Zugriff auf diese Gruppe." });
  const group = doc.data();
  const validUsers = [];
  for (const u of (usernames || [])) {
    const uname = u.trim().toLowerCase();
    if (uname && await getUser(uname)) validUsers.push(uname);
  }
  const reallyNew = validUsers.filter(u => !group.members.includes(u));
  if (reallyNew.length === 0) return res.status(400).json({ error: "Keine neuen, gültigen Benutzer zum Hinzufügen gefunden." });
  const newMembers = [...group.members, ...reallyNew];
  // Der Client, der hinzufügt, hat den Gruppenschlüssel bereits entschlüsselt und packt
  // ihn hier für jedes neue Mitglied per ECDH neu ein. Nur Pakete für wirklich neue,
  // gültige Mitglieder übernehmen - alles andere wird ignoriert.
  const keys = { ...(group.keys || {}) };
  if (newWrappedKeys && typeof newWrappedKeys === "object") {
    for (const u of reallyNew) {
      const w = newWrappedKeys[u];
      if (w && typeof w.wrappedKey === "string" && typeof w.iv === "string") keys[u] = { wrappedKey: w.wrappedKey, iv: w.iv, from: me };
    }
  }
  await docRef.set({ members: newMembers, keys }, { merge: true });
  const updated = { ...group, members: newMembers, keys };
  notifyGroupMembers(updated, "groupUpdated");
  reallyNew.forEach(m => sendTo(m, { type: "groupCreated", group: groupForMember(updated, m) }));
  res.json({ ok: true, group: groupForMember(updated, me) });
});

app.post("/api/groups/members/remove", async (req, res) => {
  const { token, groupId, username } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const docRef = groupsCol.doc(groupId);
  const doc = await docRef.get();
  if (!doc.exists || !doc.data().members.includes(me)) return res.status(403).json({ error: "Kein Zugriff auf diese Gruppe." });
  const group = doc.data();
  const target = (username || "").trim().toLowerCase();
  if (!group.members.includes(target)) return res.status(400).json({ error: "Diese Person ist nicht in der Gruppe." });
  const newMembers = group.members.filter(m => m !== target);
  const keys = { ...(group.keys || {}) };
  delete keys[target]; // entfernte Person bekommt keine künftigen Gruppenschlüssel mehr
  await docRef.set({ members: newMembers, keys }, { merge: true });
  const updated = { ...group, members: newMembers, keys };
  notifyGroupMembers(updated, "groupUpdated");
  sendTo(target, { type: "removedFromGroup", groupId });
  res.json({ ok: true, group: groupForMember(updated, me) });
});

// ===== WebSocket Server =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  let myUsername = null;

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }

    if (data.type === "auth") {
      const uname = getUserFromToken(data.token);
      if (!uname) { ws.send(JSON.stringify({ type: "authError", text: "Sitzung ungültig." })); ws.close(); return; }
      myUsername = uname;
      onlineUsers.set(myUsername, ws);
      ws.send(JSON.stringify({ type: "authOk", username: myUsername }));
      const meData = await getUser(myUsername);
      (meData?.contacts || []).forEach(c => sendTo(c, { type: "userOnline", username: myUsername }));
      return;
    }

    if (!myUsername) return;

    // 1:1 Nachricht - Text, Bild, Sprachnachricht und "Antwort auf" stecken alle
    // gemeinsam in einem clientseitig per AES-GCM verschlüsselten Payload (ct/iv).
    // Der Server sieht nur noch: wer, an wen, wann - niemals den Inhalt.
    if (data.type === "message") {
      const to = (data.to || "").trim().toLowerCase();
      const ct = data.ct || "";
      const iv = data.iv || "";
      if (!ct || !iv) return;
      const toUser = await getUser(to);
      if (!toUser) return;
      const entry = {
        id: makeToken().substring(0, 10),
        from: myUsername, ct, iv,
        time: Date.now(), readBy: [], reactions: {}
      };
      const key = conversationKey(myUsername, to);
      await messagesCol.doc(key).set({ list: admin.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
      sendTo(to, { type: "message", ...entry, to });
      ws.send(JSON.stringify({ type: "message", ...entry, to }));
      const tKey = myUsername + ":" + to;
      if (typingTimers.has(tKey)) { clearTimeout(typingTimers.get(tKey)); typingTimers.delete(tKey); }
      sendTo(to, { type: "typing", from: myUsername, isTyping: false });
    }

    if (data.type === "typing") {
      const to = (data.to || "").trim().toLowerCase();
      const tKey = myUsername + ":" + to;
      sendTo(to, { type: "typing", from: myUsername, isTyping: data.isTyping });
      if (data.isTyping) {
        if (typingTimers.has(tKey)) clearTimeout(typingTimers.get(tKey));
        typingTimers.set(tKey, setTimeout(() => {
          sendTo(to, { type: "typing", from: myUsername, isTyping: false });
          typingTimers.delete(tKey);
        }, 4000));
      }
    }

    if (data.type === "groupMessage") {
      const docRef = groupsCol.doc(data.groupId);
      const doc = await docRef.get();
      if (!doc.exists) return;
      const group = doc.data();
      const ct = data.ct || "";
      const iv = data.iv || "";
      if (!group.members.includes(myUsername) || !ct || !iv) return;
      const entry = { id: makeToken().substring(0, 10), from: myUsername, ct, iv, time: Date.now(), readBy: [], reactions: {} };
      await docRef.set({ messages: admin.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
      group.members.forEach(m => sendTo(m, { type: "groupMessage", groupId: data.groupId, message: entry }));
    }

    if (data.type === "groupTyping") {
      const doc = await groupsCol.doc(data.groupId).get();
      if (!doc.exists) return;
      const group = doc.data();
      if (!group.members.includes(myUsername)) return;
      group.members.filter(m => m !== myUsername).forEach(m =>
        sendTo(m, { type: "groupTyping", groupId: data.groupId, from: myUsername, isTyping: data.isTyping })
      );
    }

    // ===== WebRTC Signaling (unverändert, braucht keine Datenbank) =====
    if (data.type === "callOffer") {
      const callerData = await getUser(myUsername);
      sendTo(data.to, { type: "callOffer", from: myUsername, offer: data.offer, video: data.video, screen: data.screen, callerAvatar: callerData?.avatar || "" });
    }
    if (data.type === "callAnswer") sendTo(data.to, { type: "callAnswer", from: myUsername, answer: data.answer });
    if (data.type === "callReject") sendTo(data.to, { type: "callReject", from: myUsername });
    if (data.type === "callEnd") sendTo(data.to, { type: "callEnd", from: myUsername });
    if (data.type === "iceCandidate") sendTo(data.to, { type: "iceCandidate", from: myUsername, candidate: data.candidate });
    if (data.type === "screenShareToggle") sendTo(data.to, { type: "screenShareToggle", from: myUsername, active: data.active });
    if (data.type === "mediaToggle") sendTo(data.to, { type: "mediaToggle", from: myUsername, audio: data.audio, video: data.video });
  });

  ws.on("close", async () => {
    if (myUsername) {
      onlineUsers.delete(myUsername);
      const meData = await getUser(myUsername);
      (meData?.contacts || []).forEach(c => sendTo(c, { type: "userOffline", username: myUsername }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ MeinMessenger (mit Firestore) läuft! http://localhost:${PORT}`);
});

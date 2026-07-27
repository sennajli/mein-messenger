const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = "antichatcontrol";

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

const app = express();
app.use(express.static("public"));
app.use(express.json({ limit: "20mb" }));

function conversationKey(a, b) { return [a, b].sort().join("|"); }

let sessions = new Map(); // token -> username
function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function getUserFromToken(token) { return sessions.get(token) || null; }

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

app.post("/api/check-access", (req, res) => {
  res.json({ ok: req.body.code === ACCESS_CODE });
});

app.post("/api/register", async (req, res) => {
  const { code, username, password } = req.body;
  if (code !== ACCESS_CODE) return res.status(403).json({ error: "Falscher Zugangscode." });
  if (!username || !password || username.length < 3 || password.length < 4)
    return res.status(400).json({ error: "Name (min. 3) und Passwort (min. 4 Zeichen) nötig." });
  const uname = username.trim().toLowerCase();
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

app.post("/api/login", async (req, res) => {
  const { code, username, password } = req.body;
  if (code !== ACCESS_CODE) return res.status(403).json({ error: "Falscher Zugangscode." });
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
  const updates = {};
  if (avatar !== undefined) updates.avatar = avatar;
  if (bio !== undefined) updates.bio = bio.substring(0, 300);
  if (socials !== undefined) updates.socials = socials;
  if (statusMessage !== undefined) updates.statusMessage = statusMessage.substring(0, 100);
  if (statusEmoji !== undefined) updates.statusEmoji = statusEmoji;
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
    online: onlineUsers.has(target)
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
      statusEmoji: cData?.statusEmoji || "🟢"
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

  const allFRSnap = await friendRequestsCol.get();
  const existing = allFRSnap.docs.find(d => {
    const r = d.data();
    return (r.from === me && r.to === target) || (r.from === target && r.to === me);
  });
  if (existing) return res.status(400).json({ error: "Anfrage bereits gesendet." });

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
      msg.text = "";
      msg.image = "";
      msg.audio = "";
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
app.post("/api/groups/create", async (req, res) => {
  const { token, name, members } = req.body;
  const me = getUserFromToken(token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const groupId = "g_" + makeToken().substring(0, 12);
  const allMembers = [...new Set([me, ...(members || [])])];
  const group = { id: groupId, name: name || "Neue Gruppe", members: allMembers, messages: [], createdBy: me, avatar: "", time: Date.now() };
  await groupsCol.doc(groupId).set(group);
  allMembers.forEach(m => sendTo(m, { type: "groupCreated", group }));
  res.json({ ok: true, groupId, group });
});

app.get("/api/groups", async (req, res) => {
  const me = getUserFromToken(req.query.token);
  if (!me) return res.status(401).json({ error: "Nicht eingeloggt." });
  const snap = await groupsCol.where("members", "array-contains", me).get();
  res.json({ groups: snap.docs.map(d => d.data()) });
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
  const updates = {};
  if (name !== undefined && name.trim().length > 0) updates.name = name.trim().substring(0, 50);
  if (avatar !== undefined) updates.avatar = avatar;
  await docRef.set(updates, { merge: true });
  const updated = (await docRef.get()).data();
  updated.members.forEach(m => sendTo(m, { type: "groupUpdated", group: updated }));
  res.json({ ok: true, group: updated });
});

app.post("/api/groups/members/add", async (req, res) => {
  const { token, groupId, usernames } = req.body;
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
  await docRef.set({ members: newMembers }, { merge: true });
  const updated = { ...group, members: newMembers };
  updated.members.forEach(m => sendTo(m, { type: "groupUpdated", group: updated }));
  reallyNew.forEach(m => sendTo(m, { type: "groupCreated", group: updated }));
  res.json({ ok: true, group: updated });
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
  await docRef.set({ members: newMembers }, { merge: true });
  const updated = { ...group, members: newMembers };
  updated.members.forEach(m => sendTo(m, { type: "groupUpdated", group: updated }));
  sendTo(target, { type: "removedFromGroup", groupId });
  res.json({ ok: true, group: updated });
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

    // 1:1 Nachricht (Text, Bild, Sprachnachricht, Antwort auf Nachricht)
    if (data.type === "message") {
      const to = (data.to || "").trim().toLowerCase();
      const text = (data.text || "").trim();
      const image = data.image || "";
      const audio = data.audio || "";
      const duration = data.duration || 0;
      const replyTo = data.replyTo || null;
      if (!text && !image && !audio) return;
      const toUser = await getUser(to);
      if (!toUser) return;
      const entry = {
        id: makeToken().substring(0, 10),
        from: myUsername, text, image, audio, duration, replyTo,
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
      const text = (data.text || "").trim();
      const image = data.image || "";
      const audio = data.audio || "";
      const duration = data.duration || 0;
      const replyTo = data.replyTo || null;
      if (!group.members.includes(myUsername) || (!text && !image && !audio)) return;
      const entry = { id: makeToken().substring(0, 10), from: myUsername, text, image, audio, duration, replyTo, time: Date.now(), readBy: [], reactions: {} };
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

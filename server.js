// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
require("dotenv").config();

// -------- Helpers --------
function parseOrigins(str) {
  if (!str || str.trim() === "*") return "*";
  return str.split(",").map(o => o.trim()).filter(Boolean);
}

const PORT = process.env.PORT || 5000;
const CORS_ORIGINS = parseOrigins(process.env.CORS_ORIGINS || "*");

// -------- App & HTTP Server --------
const app = express();
app.set("trust proxy", true);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(cors({
  origin: CORS_ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true
}));

const server = http.createServer(app);

// -------- MongoDB --------
mongoose.set("strictQuery", true);
mongoose
  .connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB || undefined })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err?.message || err);
    process.exitCode = 1;
  });

const messageSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true },
  senderId: { type: String, required: true, index: true },
  recipientId: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

const Message = mongoose.model("Message", messageSchema);

// -------- Socket.IO --------
const io = new Server(server, {
  path: process.env.SOCKET_PATH || "/socket.io",
  cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 20000,
});

let users = {}; // userId -> socketId

io.on("connection", (socket) => {
  console.log(`🔌 connected ${socket.id}`);

  socket.on("join", async (userId) => {
    if (!userId) return;
    users[userId] = socket.id;
    socket.join(userId);
    io.emit("update-user-list", Object.keys(users));

    try {
      const userMessages = await Message.find({
        $or: [{ senderId: userId }, { recipientId: userId }],
      })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean();

      socket.emit("load-messages", userMessages.reverse());
    } catch (err) {
      console.error("Fetch messages failed:", err?.message || err);
      socket.emit("error", { message: "Failed to load messages" });
    }
  });

  socket.on("send-message", async ({ recipientId, text, senderId }) => {
    if (!recipientId || !senderId || !text) return;

    try {
      const saved = await new Message({ text, senderId, recipientId }).save();
      // deliver to both parties (rooms named by userId)
      io.to(recipientId).emit("new-message", saved);
      io.to(senderId).emit("new-message", saved);
    } catch (err) {
      console.error("Save message failed:", err?.message || err);
      socket.emit("error", { message: "Message not saved" });
    }
  });

  // ---------- WebRTC signaling ----------
  socket.on("call-user", ({ toUserId, fromUserId, offer }) => {
    const sid = users[toUserId];
    if (!sid) return socket.emit("user-offline", { toUserId });
    io.to(sid).emit("incoming-call", { fromUserId, offer });
  });

  socket.on("answer-call", ({ toUserId, fromUserId, answer }) => {
    const sid = users[toUserId];
    if (!sid) return;
    io.to(sid).emit("call-answered", { fromUserId, answer });
  });

  socket.on("ice-candidate", ({ toUserId, fromUserId, candidate }) => {
    const sid = users[toUserId];
    if (!sid) return;
    io.to(sid).emit("ice-candidate", { fromUserId, candidate });
  });

  socket.on("end-call", ({ toUserId }) => {
    const sid = users[toUserId];
    if (!sid) return;
    io.to(sid).emit("call-ended");
  });

  socket.on("disconnect", () => {
    const left = Object.keys(users).find(k => users[k] === socket.id);
    if (left) {
      delete users[left];
      io.emit("update-user-list", Object.keys(users));
    }
    console.log(`🔥 disconnected ${socket.id}`);
  });
});

// -------- Health & Base Routes --------
app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "chat-backend", time: new Date().toISOString() });
});

app.get("/healthz", (_req, res) => res.sendStatus(200));

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// -------- Start --------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on :${PORT}`);
});

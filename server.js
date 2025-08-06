const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();

// --- App & Server Setup ---
const app = express();
app.use(cors());
const server = http.createServer(app);

// --- Database Connection ---
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected successfully."))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// --- Mongoose Schema for Messages ---
const messageSchema = new mongoose.Schema({
  text: String,
  senderId: String,
  recipientId: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: "*", // In production, restrict this to your frontend's URL
    methods: ["GET", "POST"],
  },
});

let users = {}; // Store userId -> socketId mapping

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // --- User & Chat Handling ---
  socket.on("join", async (userId) => {
    users[userId] = socket.id;
    socket.join(userId);
    console.log(`User ${userId} joined with socket ID ${socket.id}`);

    io.emit("update-user-list", Object.keys(users));

    try {
      const userMessages = await Message.find({
        $or: [{ senderId: userId }, { recipientId: userId }],
      })
        .sort({ timestamp: -1 })
        .limit(100);
      socket.emit("load-messages", userMessages.reverse());
    } catch (error) {
      console.error("Error fetching messages:", error);
    }
  });

  socket.on("send-message", async (data) => {
    const { recipientId, text, senderId } = data;
    const message = new Message({ text, senderId, recipientId });

    try {
      const savedMessage = await message.save();
      io.to(recipientId).emit("new-message", savedMessage);
      io.to(senderId).emit("new-message", savedMessage);
    } catch (error) {
      console.error("Error saving message:", error);
    }
  });

  // --- Disconnect Handling ---
  socket.on("disconnect", () => {
    console.log(`🔥 User disconnected: ${socket.id}`);
    const disconnectedUserId = Object.keys(users).find(
      (key) => users[key] === socket.id
    );
    if (disconnectedUserId) {
      delete users[disconnectedUserId];
      io.emit("update-user-list", Object.keys(users));
    }
  });
});

// --- Server Listen ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`🚀 Server is listening on port ${PORT}`)
);

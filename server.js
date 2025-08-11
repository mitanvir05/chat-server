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
    socket.join(userId); // Join a room with the user's own ID
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
      // Emit to the recipient's room and the sender's room
      io.to(recipientId).emit("new-message", savedMessage);
      io.to(senderId).emit("new-message", savedMessage);
    } catch (error) {
      console.error("Error saving message:", error);
    }
  });

  // --- WebRTC Signaling ---
  // The frontend emits 'call-user', we listen for it and forward the offer
  socket.on("call-user", ({ toUserId, fromUserId, offer }) => {
    const recipientSocketId = users[toUserId];
    console.log(`📞 Relaying call from ${fromUserId} to ${toUserId}`);
    io.to(recipientSocketId).emit("incoming-call", { fromUserId, offer });
  });

  // The callee answers the call and emits 'answer-call'
  socket.on("answer-call", ({ toUserId, fromUserId, answer }) => {
    const originalCallerSocketId = users[toUserId];
    console.log(`📣 Relaying answer from ${fromUserId} to ${toUserId}`);
    io.to(originalCallerSocketId).emit("call-answered", { fromUserId, answer });
  });

  // A peer has a new ICE candidate, relay it
  socket.on("ice-candidate", ({ toUserId, fromUserId, candidate }) => {
    const recipientSocketId = users[toUserId];
    // console.log(`🧊 Relaying ICE candidate from ${fromUserId} to ${toUserId}`); // This can be very noisy
    io.to(recipientSocketId).emit("ice-candidate", { fromUserId, candidate });
  });

  // A peer has ended the call
  socket.on("end-call", ({ toUserId }) => {
    const recipientSocketId = users[toUserId];
    console.log(`🛑 Relaying end-call to ${toUserId}`);
    io.to(recipientSocketId).emit("call-ended");
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

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

// --- App & Server Setup ---
const app = express();
app.use(cors());
const server = http.createServer(app);

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected successfully.'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Mongoose Schema for Messages (FIXED) ---
const messageSchema = new mongoose.Schema({
    text: String,
    senderId: String,
    recipientId: String, // Added recipientId to know who the message is for
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);


// --- Socket.IO Setup ---
const io = new Server(server, {
    cors: {
        origin: '*', // In production, restrict this to your frontend's URL
        methods: ['GET', 'POST']
    }
});

let users = {}; // Store socketId -> userId mapping

io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // --- User & Chat Handling ---
    socket.on('join', async (userId) => {
        users[socket.id] = userId;
        // Each user joins a room with their own ID to receive private messages
        socket.join(userId);
        console.log(`User ${userId} joined with socket ID ${socket.id}`);
        
        // Broadcast updated user list to all clients
        io.emit('update-user-list', Object.values(users));

        // Fetch and send recent messages where this user is either the sender or recipient (FIXED)
        try {
            const userMessages = await Message.find({
                $or: [{ senderId: userId }, { recipientId: userId }]
            }).sort({ timestamp: -1 }).limit(100);
            socket.emit('load-messages', userMessages.reverse());
        } catch (error) {
            console.error("Error fetching messages:", error);
        }
    });

    socket.on('send-message', async (data) => {
        const { recipientId, text, senderId } = data;
        
        // Create a new message object with the recipientId (FIXED)
        const message = new Message({ text, senderId, recipientId });
        
        try {
            const savedMessage = await message.save();
            // Send the message to the recipient's private room (FIXED)
            io.to(recipientId).emit('new-message', savedMessage);
            // Also send the message back to the sender for UI update (FIXED)
            io.to(senderId).emit('new-message', savedMessage);
        } catch (error) {
            console.error("Error saving message:", error);
        }
    });


    // --- WebRTC Signaling ---
    socket.on('call-user', (data) => {
        console.log(`📞 Call attempt from ${users[socket.id]} to ${data.userToCall}`);
        io.to(data.userToCall).emit('incoming-call', {
            signal: data.signalData,
            from: users[socket.id]
        });
    });

    socket.on('answer-call', (data) => {
        console.log(`✅ Call answered by ${users[socket.id]}`);
        io.to(data.to).emit('call-accepted', data.signal);
    });
    
    socket.on('ice-candidate', (data) => {
        io.to(data.to).emit('ice-candidate', data.candidate);
    });

    socket.on('end-call', (data) => {
        io.to(data.to).emit('call-ended');
    });


    // --- Disconnect Handling ---
    socket.on('disconnect', () => {
        console.log(`🔥 User disconnected: ${socket.id}`);
        const disconnectedUser = users[socket.id];
        delete users[socket.id];
        // Broadcast updated user list
        io.emit('update-user-list', Object.values(users));
    });
});


// --- Server Listen ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server is listening on port ${PORT}`));

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8 // 100MB for file transfers
});

const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 4;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// Store rooms: { roomId: { users: Map<socketId, {name, socketId}> } }
const rooms = {};

// File upload endpoint
app.post('/upload/:roomId', upload.single('file'), (req, res) => {
  const { roomId } = req.params;
  const { senderName } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileInfo = {
    id: uuidv4(),
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype,
    url: `/uploads/${req.file.filename}`,
    sender: senderName || 'Someone',
    timestamp: new Date().toISOString()
  };

  // Notify room about new file
  io.to(roomId).emit('file-shared', fileInfo);

  res.json({ success: true, file: fileInfo });
});

// Create room endpoint
app.post('/create-room', (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms[roomId] = { users: new Map() };
  res.json({ roomId });
});

// Socket.io signaling server
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join room
  socket.on('join-room', ({ roomId, userName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'اتاق پیدا نشد!' });
      return;
    }

    const room = rooms[roomId];

    if (room.users.size >= MAX_USERS_PER_ROOM) {
      socket.emit('error', { message: 'اتاق پر است! (حداکثر ۴ نفر)' });
      return;
    }

    // Leave any previous room
    socket.rooms.forEach(r => {
      if (r !== socket.id) socket.leave(r);
    });

    socket.join(roomId);
    socket.currentRoom = roomId;
    socket.userName = userName;

    const userInfo = { socketId: socket.id, name: userName };
    room.users.set(socket.id, userInfo);

    // Send existing users to the new joiner
    const existingUsers = Array.from(room.users.values()).filter(u => u.socketId !== socket.id);
    socket.emit('room-joined', {
      roomId,
      users: existingUsers,
      yourId: socket.id
    });

    // Notify others
    socket.to(roomId).emit('user-joined', userInfo);

    console.log(`${userName} joined room ${roomId}. Total: ${room.users.size}`);
  });

  // WebRTC signaling
  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { fromId: socket.id, fromName: socket.userName, offer });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { fromId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  // Chat message
  socket.on('chat-message', ({ roomId, message }) => {
    const msgData = {
      id: uuidv4(),
      text: message,
      sender: socket.userName,
      senderId: socket.id,
      timestamp: new Date().toISOString()
    };
    io.to(roomId).emit('chat-message', msgData);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.currentRoom;
    if (roomId && rooms[roomId]) {
      rooms[roomId].users.delete(socket.id);
      socket.to(roomId).emit('user-left', { socketId: socket.id, name: socket.userName });

      if (rooms[roomId].users.size === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 TeamLink Server running on http://localhost:${PORT}\n`);
});

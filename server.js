const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data storage
const channels = new Map();
const users = new Map(); // Maps socket.id -> { username, channel }

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join-channel', ({ username, channel }) => {
    if (!username || !channel) {
      return socket.emit('error', { message: 'Username and channel are required' });
    }

    // Leave any previous channel
    const previousUser = users.get(socket.id);
    if (previousUser) {
      leaveChannel(socket, previousUser.channel);
    }
    
    // Create channel if it doesn't exist
    if (!channels.has(channel)) {
      channels.set(channel, { users: new Map(), typingUsers: new Map() });
    }
    const channelData = channels.get(channel);

    // Add user to channel and user map
    channelData.users.set(socket.id, { username });
    users.set(socket.id, { username, channel });
    socket.join(channel);

    // Notify user they have joined
    socket.emit('joined-channel', { username, channel });

    // Notify everyone in the channel (including sender) about the current state
    io.to(channel).emit('channel-info', {
        channel,
        userCount: channelData.users.size,
        users: Array.from(channelData.users.values()).map(u => u.username)
    });

    // Notify others in the channel that a new user joined
    socket.to(channel).emit('user-joined', { username, userCount: channelData.users.size });
    
    console.log(`${username} (${socket.id}) joined channel: ${channel}`);
  });

  socket.on('send-message', ({ message }) => {
    const user = users.get(socket.id);
    if (!user || !message || message.trim() === '') {
      return;
    }
    const messageData = {
      id: Date.now().toString(),
      username: user.username,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      channel: user.channel
    };
    
    // FIX: Changed to io.to().emit() to send to everyone in the room (including sender) once.
    io.to(user.channel).emit('new-message', messageData);

    console.log(`Message in #${user.channel} from ${user.username}: ${message}`);
  });
  
  socket.on('typing', ({ isTyping }) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const channelData = channels.get(user.channel);
    if (!channelData) return;
    
    if (isTyping) {
        channelData.typingUsers.set(user.username, Date.now());
    } else {
        channelData.typingUsers.delete(user.username);
    }
    
    // Broadcast the map of currently typing users
    io.to(user.channel).emit('user-typing', { 
      typingUsers: Object.fromEntries(channelData.typingUsers)
    });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      leaveChannel(socket, user.channel);
      console.log(`${user.username} disconnected from #${user.channel}`);
    }
    console.log('User disconnected:', socket.id);
  });
});

function leaveChannel(socket, channelName) {
    const user = users.get(socket.id);
    const channelData = channels.get(channelName);
    
    if (!user || !channelData) return;

    socket.leave(channelName);
    channelData.users.delete(socket.id);
    channelData.typingUsers.delete(user.username);
    users.delete(socket.id);

    if (channelData.users.size > 0) {
      // Notify remaining users
      io.to(channelName).emit('user-left', {
        username: user.username,
        userCount: channelData.users.size,
      });
      // Also update typing indicator in case the user was typing
      io.to(channelName).emit('user-typing', {
        typingUsers: Object.fromEntries(channelData.typingUsers)
      });
    } else {
      // Remove empty channel
      channels.delete(channelName);
      console.log(`Channel #${channelName} is empty and has been removed.`);
    }
}

server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
});

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active users and channels in memory
const channels = new Map();
const users = new Map();

// Serve the main chat page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get channel info
app.get('/api/channels/:channelName', (req, res) => {
  const channelName = req.params.channelName;
  const channel = channels.get(channelName);
  
  if (channel) {
    res.json({
      name: channelName,
      userCount: channel.users.size,
      users: Array.from(channel.users.values()).map(user => user.username)
    });
  } else {
    res.json({
      name: channelName,
      userCount: 0,
      users: []
    });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Handle user joining a channel
  socket.on('join-channel', ({ username, channel }) => {
    if (!username || !channel) {
      socket.emit('error', { message: 'Username and channel are required' });
      return;
    }

    // Leave previous channel if any
    if (users.has(socket.id)) {
      const prevUser = users.get(socket.id);
      leaveChannel(socket.id, prevUser.channel);
    }

    // Join new channel
    joinChannel(socket.id, username, channel);
    
    // Send confirmation to user
    socket.emit('joined-channel', { 
      username, 
      channel,
      message: `Welcome to #${channel}!` 
    });

    console.log(`${username} joined channel: ${channel}`);
  });

  // Handle sending messages
  socket.on('send-message', ({ message }) => {
    const user = users.get(socket.id);
    
    if (!user) {
      socket.emit('error', { message: 'You must join a channel first' });
      return;
    }

    if (!message || message.trim() === '') {
      socket.emit('error', { message: 'Message cannot be empty' });
      return;
    }

    const messageData = {
      id: Date.now().toString(),
      username: user.username,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      channel: user.channel
    };

    // Send message to all users in the channel
    socket.to(user.channel).emit('new-message', messageData);
    socket.emit('new-message', messageData);

    console.log(`Message in #${user.channel} from ${user.username}: ${message}`);
  });

  // Handle typing indicators
  socket.on('typing', ({ isTyping }) => {
    const user = users.get(socket.id);
    if (user) {
      socket.to(user.channel).emit('user-typing', {
        username: user.username,
        isTyping
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      leaveChannel(socket.id, user.channel);
      console.log(`${user.username} disconnected from #${user.channel}`);
    }
    console.log('User disconnected:', socket.id);
  });

  // Helper function to join a channel
  function joinChannel(socketId, username, channelName) {
    // Create channel if it doesn't exist
    if (!channels.has(channelName)) {
      channels.set(channelName, {
        name: channelName,
        users: new Map(),
        createdAt: new Date()
      });
    }

    const channel = channels.get(channelName);
    
    // Add user to channel
    channel.users.set(socketId, { username, socketId });
    users.set(socketId, { username, channel: channelName });
    
    // Join socket room
    socket.join(channelName);
    
    // Notify other users in channel
    socket.to(channelName).emit('user-joined', {
      username,
      message: `${username} joined the channel`,
      userCount: channel.users.size,
      users: Array.from(channel.users.values()).map(u => u.username)
    });

    // Send current channel info to new user
    socket.emit('channel-info', {
      channel: channelName,
      userCount: channel.users.size,
      users: Array.from(channel.users.values()).map(u => u.username)
    });
  }

  // Helper function to leave a channel
  function leaveChannel(socketId, channelName) {
    const user = users.get(socketId);
    if (!user || !channels.has(channelName)) return;

    const channel = channels.get(channelName);
    channel.users.delete(socketId);
    users.delete(socketId);
    
    socket.leave(channelName);
    
    // Notify other users
    if (channel.users.size > 0) {
      socket.to(channelName).emit('user-left', {
        username: user.username,
        message: `${user.username} left the channel`,
        userCount: channel.users.size,
        users: Array.from(channel.users.values()).map(u => u.username)
      });
    } else {
      // Remove empty channel
      channels.delete(channelName);
    }
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
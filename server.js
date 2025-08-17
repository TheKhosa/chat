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
const users = new Map(); // Maps socket.id -> { username, channel, color }
const messageHistory = new Map(); // Maps channel -> Array of messages (limited history)

// Configuration
const MAX_MESSAGE_HISTORY = 100; // Keep last 100 messages per channel
const MAX_MESSAGE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 20;
const MIN_USERNAME_LENGTH = 2;

// Custom emotes and GIFs (same as client for validation)
const customEmotes = {
  'Kappa': 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0',
  'PogChamp': 'https://static-cdn.jtvnw.net/emoticons/v2/88/default/dark/1.0',
  'KEKW': 'https://cdn.7tv.app/emote/60a57218eca3e55c5e6e9cd3/1x.webp',
  'LUL': 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/1.0',
  'MonkaS': 'https://cdn.7tv.app/emote/60a57218eca3e55c5e6e9cd0/1x.webp',
  'EZ': 'https://cdn.7tv.app/emote/60a5722dec18e05c5e6e9cdf/1x.webp',
};

const gifEmotes = {
  'PepeParty': 'https://cdn.7tv.app/emote/60b07b34a632b9b67b3f4862/1x.gif',
  'CatJAM': 'https://cdn.7tv.app/emote/60b07b34a632b9b67b3f4851/1x.gif',
  'EzDance': 'https://cdn.7tv.app/emote/60b07b34a632b9b67b3f485f/1x.gif',
  'PartyParrot': 'https://cdn.7tv.app/emote/60b07b34a632b9b67b3f4865/1x.gif',
};

// User color classes for consistent coloring
const userColors = [
  'user-red', 'user-orange', 'user-yellow', 'user-green',
  'user-blue', 'user-purple', 'user-pink', 'user-cyan',
  'user-lime', 'user-indigo', 'user-teal', 'user-amber'
];

// Generate consistent user color based on username
function getUserColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return userColors[Math.abs(hash) % userColors.length];
}

// Validate and sanitize input
function validateMessage(message) {
  if (!message || typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) return null;
  
  // Basic profanity filter (you can expand this)
  const profanityWords = ['spam', 'scam']; // Add more as needed
  const lowerMessage = trimmed.toLowerCase();
  for (const word of profanityWords) {
    if (lowerMessage.includes(word)) {
      return null; // or return censored version
    }
  }
  
  return trimmed;
}

function validateEmotes(message) {
  // Count custom emotes to prevent spam
  const allEmotes = { ...customEmotes, ...gifEmotes };
  let emoteCount = 0;
  
  Object.keys(allEmotes).forEach(emoteName => {
    const regex = new RegExp(`:${emoteName}:`, 'g');
    const matches = message.match(regex);
    if (matches) {
      emoteCount += matches.length;
    }
  });
  
  // Limit to 10 emotes per message
  return emoteCount <= 10;
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const trimmed = username.trim();
  if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) return null;
  // Remove any potentially harmful characters
  return trimmed.replace(/[<>]/g, '');
}

function validateChannelName(channel) {
  if (!channel || typeof channel !== 'string') return null;
  const trimmed = channel.trim();
  if (trimmed.length === 0) return null;
  // Allow alphanumeric, underscore, dash
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
}

// Add message to history
function addMessageToHistory(channelName, messageData) {
  if (!messageHistory.has(channelName)) {
    messageHistory.set(channelName, []);
  }
  
  const history = messageHistory.get(channelName);
  history.push(messageData);
  
  // Keep only the last MAX_MESSAGE_HISTORY messages
  if (history.length > MAX_MESSAGE_HISTORY) {
    history.splice(0, history.length - MAX_MESSAGE_HISTORY);
  }
}

// Get recent message history for a channel
function getMessageHistory(channelName, limit = 50) {
  const history = messageHistory.get(channelName) || [];
  return history.slice(-limit);
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join-channel', ({ username, channel }) => {
    const validUsername = validateUsername(username);
    const validChannel = validateChannelName(channel);
    
    if (!validUsername) {
      return socket.emit('error', { message: 'Invalid username. Must be 2-20 characters.' });
    }
    
    if (!validChannel) {
      return socket.emit('error', { message: 'Invalid channel name.' });
    }

    // Leave any previous channel
    const previousUser = users.get(socket.id);
    if (previousUser) {
      leaveChannel(socket, previousUser.channel);
    }
    
    // Create channel if it doesn't exist
    if (!channels.has(validChannel)) {
      channels.set(validChannel, { 
        users: new Map(), 
        typingUsers: new Map(),
        createdAt: new Date().toISOString()
      });
    }
    const channelData = channels.get(validChannel);

    // Check if username is already taken in this channel
    const existingUser = Array.from(channelData.users.values())
      .find(user => user.username.toLowerCase() === validUsername.toLowerCase());
    
    if (existingUser) {
      return socket.emit('error', { message: 'Username already taken in this channel.' });
    }

    // Add user to channel and user map
    const userColor = getUserColor(validUsername);
    const userData = { 
      username: validUsername, 
      color: userColor,
      joinedAt: new Date().toISOString()
    };
    
    channelData.users.set(socket.id, userData);
    users.set(socket.id, { 
      username: validUsername, 
      channel: validChannel, 
      color: userColor 
    });
    socket.join(validChannel);

    // Send recent message history to the joining user
    const history = getMessageHistory(validChannel);
    if (history.length > 0) {
      socket.emit('message-history', { messages: history });
    }

    // Notify user they have joined
    socket.emit('joined-channel', { 
      username: validUsername, 
      channel: validChannel,
      color: userColor
    });

    // Notify everyone in the channel (including sender) about the current state
    io.to(validChannel).emit('channel-info', {
      channel: validChannel,
      userCount: channelData.users.size,
      users: Array.from(channelData.users.values()).map(u => ({
        username: u.username,
        color: u.color
      }))
    });

    // Notify others in the channel that a new user joined
    socket.to(validChannel).emit('user-joined', { 
      username: validUsername, 
      userCount: channelData.users.size,
      color: userColor
    });
    
    console.log(`${validUsername} (${socket.id}) joined channel: ${validChannel}`);
  });

  socket.on('send-message', ({ message, replyTo }) => {
    const user = users.get(socket.id);
    const validMessage = validateMessage(message);
    
    if (!user || !validMessage) {
      return socket.emit('error', { message: 'Invalid message or user not in channel.' });
    }
    
    // Validate emote usage
    if (!validateEmotes(validMessage)) {
      return socket.emit('error', { message: 'Too many emotes in message. Limit: 10 per message.' });
    }

    // Validate replyTo data if provided
    let validReplyTo = null;
    if (replyTo && typeof replyTo === 'object') {
      const replyUsername = validateUsername(replyTo.username);
      const replyMessage = validateMessage(replyTo.messageContent);
      
      if (replyUsername && replyMessage) {
        validReplyTo = {
          username: replyUsername,
          messageContent: replyMessage.substring(0, 100), // Limit reply preview
          color: getUserColor(replyUsername)
        };
      }
    }

    const messageData = {
      id: `${Date.now()}-${socket.id}`,
      username: user.username,
      message: validMessage,
      timestamp: new Date().toISOString(),
      channel: user.channel,
      color: user.color,
      replyTo: validReplyTo
    };
    
    // Add to message history
    addMessageToHistory(user.channel, messageData);
    
    // Send to everyone in the channel
    io.to(user.channel).emit('new-message', messageData);

    console.log(`Message in #${user.channel} from ${user.username}: ${validMessage}${validReplyTo ? ` (reply to ${validReplyTo.username})` : ''}`);
  });
  
  socket.on('typing', ({ isTyping }) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const channelData = channels.get(user.channel);
    if (!channelData) return;
    
    if (isTyping && typeof isTyping === 'boolean') {
      if (isTyping) {
        channelData.typingUsers.set(user.username, {
          timestamp: Date.now(),
          color: user.color
        });
      } else {
        channelData.typingUsers.delete(user.username);
      }
      
      // Clean up old typing indicators (older than 5 seconds)
      const now = Date.now();
      for (const [username, data] of channelData.typingUsers.entries()) {
        if (now - data.timestamp > 5000) {
          channelData.typingUsers.delete(username);
        }
      }
      
      // Broadcast the map of currently typing users
      const typingData = {};
      for (const [username, data] of channelData.typingUsers.entries()) {
        typingData[username] = { color: data.color };
      }
      
      io.to(user.channel).emit('user-typing', { 
        typingUsers: typingData
      });
    }
  });

  // Handle message reactions (future feature)
  socket.on('add-reaction', ({ messageId, emoji }) => {
    const user = users.get(socket.id);
    if (!user || !messageId || !emoji) return;
    
    // Basic validation for emoji (simple approach)
    if (typeof emoji !== 'string' || emoji.length > 4) return;
    
    // For now, just broadcast the reaction
    io.to(user.channel).emit('message-reaction', {
      messageId,
      emoji,
      username: user.username,
      color: user.color,
      timestamp: new Date().toISOString()
    });
  });

  // Handle user mention requests
  socket.on('get-users', () => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const channelData = channels.get(user.channel);
    if (!channelData) return;
    
    const userList = Array.from(channelData.users.values()).map(u => ({
      username: u.username,
      color: u.color
    }));
    
    socket.emit('users-list', { users: userList });
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
      color: user.color
    });
    
    // Update typing indicator in case the user was typing
    const typingData = {};
    for (const [username, data] of channelData.typingUsers.entries()) {
      typingData[username] = { color: data.color };
    }
    
    io.to(channelName).emit('user-typing', {
      typingUsers: typingData
    });
    
    // Update channel info
    io.to(channelName).emit('channel-info', {
      channel: channelName,
      userCount: channelData.users.size,
      users: Array.from(channelData.users.values()).map(u => ({
        username: u.username,
        color: u.color
      }))
    });
  } else {
    // Remove empty channel and its message history after a delay
    setTimeout(() => {
      if (channels.has(channelName) && channels.get(channelName).users.size === 0) {
        channels.delete(channelName);
        messageHistory.delete(channelName);
        console.log(`Channel #${channelName} is empty and has been removed.`);
      }
    }, 60000); // Wait 1 minute before removing empty channel
  }
}

// Cleanup old typing indicators periodically
setInterval(() => {
  const now = Date.now();
  for (const [channelName, channelData] of channels.entries()) {
    let hasChanges = false;
    
    for (const [username, data] of channelData.typingUsers.entries()) {
      if (now - data.timestamp > 10000) { // 10 seconds timeout
        channelData.typingUsers.delete(username);
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      const typingData = {};
      for (const [username, data] of channelData.typingUsers.entries()) {
        typingData[username] = { color: data.color };
      }
      
      io.to(channelName).emit('user-typing', {
        typingUsers: typingData
      });
    }
  }
}, 5000); // Check every 5 seconds

// API endpoint for available emotes
app.get('/api/emotes', (req, res) => {
  res.json({
    custom: customEmotes,
    gifs: gifEmotes,
    categories: [
      { id: 'custom', name: 'Custom Emotes', count: Object.keys(customEmotes).length },
      { id: 'gifs', name: 'Animated', count: Object.keys(gifEmotes).length }
    ]
  });
});

// API endpoint for health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    channels: channels.size,
    totalUsers: users.size
  });
});

// API endpoint for channel stats
app.get('/api/channels', (req, res) => {
  const channelStats = [];
  for (const [name, data] of channels.entries()) {
    channelStats.push({
      name,
      userCount: data.users.size,
      createdAt: data.createdAt
    });
  }
  res.json({ channels: channelStats });
});

server.listen(PORT, () => {
  console.log(`Enhanced chat server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});

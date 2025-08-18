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

// FFZ Emote cache and API management
const ffzEmoteCache = new Map(); // Cache for FFZ API responses
const FFZ_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

// Custom emote cache (your existing emotes)
let customEmotesCache = new Map(); // Map emote name to URL
let customEmotesLastFetch = 0;
const CUSTOM_EMOTES_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

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

// Fetch custom emotes from your existing external API
async function fetchCustomEmotesFromAPI() {
  try {
    console.log('Fetching custom emotes from external API...');
    
    // Try to use global fetch first (Node.js 18+)
    let response;
    if (typeof fetch !== 'undefined') {
      response = await fetch('https://stream.0domain.click/emotes.json');
    } else {
      // Fallback to https module for older Node.js versions
      const https = require('https');
      const responseData = await new Promise((resolve, reject) => {
        const req = https.get('https://stream.0domain.click/emotes.json', (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
      
      // Process the data directly for https fallback
      console.log(`Loaded ${responseData.length} custom emotes from API`);
      customEmotesCache.clear();
      responseData.forEach(emote => {
        if (emote.Name && emote.ImageUrl) {
          customEmotesCache.set(emote.Name, emote.ImageUrl);
        }
      });
      customEmotesLastFetch = Date.now();
      return responseData;
    }
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const emotesData = await response.json();
    console.log(`Loaded ${emotesData.length} custom emotes from API`);
    
    // Clear and rebuild cache
    customEmotesCache.clear();
    emotesData.forEach(emote => {
      if (emote.Name && emote.ImageUrl) {
        customEmotesCache.set(emote.Name, emote.ImageUrl);
      }
    });
    
    customEmotesLastFetch = Date.now();
    return emotesData;
    
  } catch (error) {
    console.error('Failed to fetch custom emotes from API:', error);
    return [];
  }
}

// Fetch FFZ emotes from their API
async function fetchFFZEmotes(searchQuery = '', page = 1, perPage = 50, sort = 'count-desc') {
  try {
    // Create cache key
    const cacheKey = `${searchQuery || 'all'}-${page}-${perPage}-${sort}`;
    
    // Check cache first
    const cached = ffzEmoteCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < FFZ_CACHE_DURATION) {
      console.log('Serving FFZ emotes from cache:', cacheKey);
      return cached.data;
    }
    
    // Build FFZ API URL
    const params = new URLSearchParams({
      page: page.toString(),
      per_page: perPage.toString(),
      sort
    });
    
    if (searchQuery) {
      params.append('q', searchQuery);
    }
    
    const ffzUrl = `https://api.frankerfacez.com/v1/emoticons?${params}`;
    console.log('Fetching from FFZ API:', ffzUrl);
    
    // Use fetch or https module
    let response;
    if (typeof fetch !== 'undefined') {
      response = await fetch(ffzUrl, {
        headers: {
          'User-Agent': 'ChatApp/1.0 (Educational Purpose)',
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`FFZ API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Transform the data to include direct image URLs
      const transformedData = {
        ...data,
        emoticons: data.emoticons.map(emote => ({
          id: emote.id,
          name: emote.name,
          owner: emote.owner,
          urls: emote.urls,
          // Add direct URL for easy access
          imageUrl: emote.urls['1'] ? `https:${emote.urls['1']}` : 
                   emote.urls['2'] ? `https:${emote.urls['2']}` : 
                   emote.urls['4'] ? `https:${emote.urls['4']}` : null,
          width: emote.width,
          height: emote.height,
          public: emote.public
        }))
      };
      
      // Cache the result
      ffzEmoteCache.set(cacheKey, {
        data: transformedData,
        timestamp: Date.now()
      });
      
      return transformedData;
      
    } else {
      // Fallback for older Node.js
      const https = require('https');
      const url = require('url');
      const parsedUrl = url.parse(ffzUrl);
      
      const data = await new Promise((resolve, reject) => {
        const req = https.get({
          hostname: parsedUrl.hostname,
          path: parsedUrl.path,
          headers: {
            'User-Agent': 'ChatApp/1.0 (Educational Purpose)',
            'Accept': 'application/json'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
      
      // Transform data and cache
      const transformedData = {
        ...data,
        emoticons: data.emoticons.map(emote => ({
          id: emote.id,
          name: emote.name,
          owner: emote.owner,
          urls: emote.urls,
          imageUrl: emote.urls['1'] ? `https:${emote.urls['1']}` : 
                   emote.urls['2'] ? `https:${emote.urls['2']}` : 
                   emote.urls['4'] ? `https:${emote.urls['4']}` : null,
          width: emote.width,
          height: emote.height,
          public: emote.public
        }))
      };
      
      ffzEmoteCache.set(cacheKey, {
        data: transformedData,
        timestamp: Date.now()
      });
      
      return transformedData;
    }
    
  } catch (error) {
    console.error('Failed to fetch FFZ emotes:', error);
    throw error;
  }
}

// Get custom emotes with caching
async function getCustomEmotes() {
  const now = Date.now();
  
  // Check if cache is expired or empty
  if (customEmotesCache.size === 0 || (now - customEmotesLastFetch) > CUSTOM_EMOTES_CACHE_DURATION) {
    await fetchCustomEmotesFromAPI();
  }
  
  return customEmotesCache;
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

async function validateEmotes(message) {
  // Get current custom emotes from cache
  const customEmotes = await getCustomEmotes();
  let emoteCount = 0;
  
  // Count custom emotes in message (format :emoteName:)
  for (const [emoteName] of customEmotes) {
    const regex = new RegExp(`:${emoteName}:`, 'g');
    const matches = message.match(regex);
    if (matches) {
      emoteCount += matches.length;
    }
  }
  
  // Count FFZ emotes (they're used directly by name, like "Pog", "KEKW", etc.)
  // For now, we'll do a simple word count that could be FFZ emotes
  const words = message.split(/\s+/);
  const potentialFFZEmotes = words.filter(word => 
    word.length >= 3 && 
    word.length <= 25 && 
    /^[a-zA-Z0-9_]+$/.test(word) &&
    (word[0] === word[0].toUpperCase() || word.includes('pepe') || word.includes('monka'))
  );
  emoteCount += potentialFFZEmotes.length;
  
  // Limit to 10 emotes per message
  return emoteCount <= 15; // Slightly higher limit for FFZ emotes
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

// Socket.io connection handling (keeping all your existing functionality)
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

  socket.on('send-message', async ({ message, replyTo }) => {
    const user = users.get(socket.id);
    const validMessage = validateMessage(message);
    
    if (!user || !validMessage) {
      return socket.emit('error', { message: 'Invalid message or user not in channel.' });
    }
    
    // Validate emote usage
    const emotesValid = await validateEmotes(validMessage);
    if (!emotesValid) {
      return socket.emit('error', { message: 'Too many emotes in message. Limit: 15 per message.' });
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

// ========== NEW FFZ API ENDPOINTS ==========

// FFZ API proxy endpoint
app.get('/api/ffz/emoticons', async (req, res) => {
  try {
    const { q, page = 1, per_page = 50, sort = 'count-desc' } = req.query;
    
    const data = await fetchFFZEmotes(q, parseInt(page), parseInt(per_page), sort);
    res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
    res.json(data);
    
  } catch (error) {
    console.error('FFZ API proxy error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch emotes from FrankerFaceZ',
      message: error.message 
    });
  }
});

// Get popular FFZ emotes (curated list)
app.get('/api/ffz/popular', async (req, res) => {
  try {
    // Get the first page of most popular emotes
    const data = await fetchFFZEmotes('', 1, 20, 'count-desc');
    res.setHeader('Cache-Control', 'public, max-age=600'); // Cache for 10 minutes
    res.json(data);
    
  } catch (error) {
    console.error('Error fetching popular FFZ emotes:', error);
    
    // Fallback to hardcoded popular emotes
    const popularEmotes = {
      emoticons: [
        { name: 'OMEGALUL', imageUrl: 'https://cdn.frankerfacez.com/emoticon/128054/1', id: 128054 },
        { name: 'Pog', imageUrl: 'https://cdn.frankerfacez.com/emoticon/210748/1', id: 210748 },
        { name: 'PepeHands', imageUrl: 'https://cdn.frankerfacez.com/emoticon/59765/1', id: 59765 },
        { name: 'LULW', imageUrl: 'https://cdn.frankerfacez.com/emoticon/134240/1', id: 134240 },
        { name: 'KEKW', imageUrl: 'https://cdn.frankerfacez.com/emoticon/381875/1', id: 381875 },
        { name: 'monkaW', imageUrl: 'https://cdn.frankerfacez.com/emoticon/229486/1', id: 229486 },
        { name: '5Head', imageUrl: 'https://cdn.frankerfacez.com/emoticon/274406/1', id: 274406 },
        { name: 'POGGERS', imageUrl: 'https://cdn.frankerfacez.com/emoticon/214129/1', id: 214129 },
        { name: 'monkaS', imageUrl: 'https://cdn.frankerfacez.com/emoticon/130762/1', id: 130762 },
        { name: 'PepeLaugh', imageUrl: 'https://cdn.frankerfacez.com/emoticon/263056/1', id: 263056 }
      ]
    };
    
    res.status(200).json(popularEmotes);
  }
});

// Clear FFZ cache endpoint (for development)
app.post('/api/ffz/clear-cache', (req, res) => {
  ffzEmoteCache.clear();
  res.json({ message: 'FFZ cache cleared' });
});

// ========== EXISTING API ENDPOINTS (Updated) ==========

// API endpoint to serve emotes.json (your existing custom emotes)
app.get('/emotes.json', async (req, res) => {
  try {
    const emotesData = await fetchCustomEmotesFromAPI();
    res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
    res.json(emotesData);
  } catch (error) {
    console.error('Error serving custom emotes:', error);
    res.status(500).json({ error: 'Failed to fetch custom emotes' });
  }
});

// API endpoint for available custom emotes
app.get('/api/emotes', async (req, res) => {
  try {
    const customEmotes = await getCustomEmotes();
    const emotesArray = Array.from(customEmotes.entries()).map(([name, url]) => ({
      name,
      url,
      isAnimated: url.includes('.gif')
    }));
    
    res.json({
      emotes: emotesArray,
      count: emotesArray.length,
      lastUpdated: new Date(customEmotesLastFetch).toISOString()
    });
  } catch (error) {
    console.error('Error serving custom emotes API:', error);
    res.status(500).json({ error: 'Failed to fetch custom emotes' });
  }
});

// API endpoint for health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    channels: channels.size,
    totalUsers: users.size,
    customEmotesLoaded: customEmotesCache.size,
    customEmotesLastFetch: customEmotesLastFetch ? new Date(customEmotesLastFetch).toISOString() : null,
    ffzCacheSize: ffzEmoteCache.size
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

// Initialize custom emotes cache on startup
(async () => {
  console.log('Initializing custom emotes cache...');
  await fetchCustomEmotesFromAPI();
  console.log(`Custom emotes cache initialized with ${customEmotesCache.size} emotes`);
  
  console.log('Testing FFZ API connection...');
  try {
    await fetchFFZEmotes('', 1, 5);
    console.log('FFZ API connection successful');
  } catch (error) {
    console.log('FFZ API connection failed, will use fallback emotes');
  }
})();

server.listen(PORT, () => {
  console.log(`Enhanced chat server with FFZ integration running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`Custom emotes endpoint available at http://localhost:${PORT}/emotes.json`);
  console.log(`FFZ emotes proxy available at http://localhost:${PORT}/api/ffz/emoticons`);
  console.log(`Popular FFZ emotes available at http://localhost:${PORT}/api/ffz/popular`);
});

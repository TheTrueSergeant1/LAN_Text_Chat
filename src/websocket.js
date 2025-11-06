const WebSocket = require('ws');
const crypto = require('crypto');
const db = require('./db');
require('dotenv').config();

const MESSAGE_EDIT_TTL_MS = parseInt(process.env.MESSAGE_EDIT_TTL_MS, 10) || (24 * 60 * 60 * 1000); // 24 hours default
const FALLBACK_CHANNEL = '#general';

// --- Core Data Structures (Centralized State) ---
// Role hierarchy for granular permissions checks
const ROLE_HIERARCHY = { 'Admin': 3, 'Moderator': 2, 'User': 1, 'Guest': 0 };
const clients = new Map();
const typingUsers = new Map();
const bannedUsers = new Set();


// --- Utility Functions ---

function getDmRoomName(id1, id2) {
    // Ensure deterministic room naming for 1:1 DMs
    return `DM:${[id1, id2].sort().join('-')}`;
}

function sendToClient(ws, eventType, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: eventType, ...data }));
        } catch (e) {
            console.error('Error sending message to client:', e.message);
        }
    }
}

function broadcast(roomName, eventType, data, senderId = null) {
    clients.forEach((client, clientId) => {
        if (client.channel === roomName && clientId !== senderId) {
            sendToClient(client.ws, eventType, data);
        }
    });
}

/** Generates a simple, short invite code. */
function generateInviteCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 characters
}

/** * Checks if a user has a minimum role level (RBAC). 
 * @param {string} userRole The client's role.
 * @param {string} requiredRole The minimum role required.
 * @returns {boolean} True if user role is sufficient.
 */
function hasPermission(userRole, requiredRole) {
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/** Fetches all channels the given user is authorized to see. */
async function getAuthorizedChannels(userId) {
    try {
        // 1. Get all public channels and their metadata
        const publicChannels = await db.query(
            'SELECT channel_name AS name, is_private, invite_code FROM channels WHERE is_private = 0'
        );
        
        // 2. Get all private channels the user is explicitly a member of
        const privateChannels = await db.query(
            `SELECT c.channel_name AS name, c.is_private, c.invite_code, c.created_by FROM channels c
             JOIN channel_members cm ON c.channel_name = cm.channel_name
             WHERE cm.user_id = ? AND c.is_private = 1`,
            [userId]
        );
        
        // Process SQL results
        const processChannels = (channels) => channels.map(c => ({
            name: c.name,
            is_private: c.is_private === 1,
            invite_code: c.invite_code || null,
            created_by: c.created_by
        }));

        // Combine and return
        return [...processChannels(publicChannels), ...processChannels(privateChannels)];
    } catch (e) {
        console.error("DB ERROR in getAuthorizedChannels:", e.message, e);
        return [{ name: FALLBACK_CHANNEL, is_private: false, invite_code: null }]; 
    }
}


/** Retrieves messages and pinned status from the DB, including threading context. */
async function getRoomData(roomName) {
    const isDM = roomName.startsWith('DM:');
    
    if (isDM) {
        // NOTE: DM messages are assumed to be volatile or handled by another secure storage layer.
        return { messages: [], pinnedMessage: null };
    }

    try {
        // Select all message data including new threading columns
        let messages = await db.query(
            `SELECT id, channel_name, author_id, author_username AS author, content, timestamp, edited, edited_timestamp, attachment_metadata, is_system as system, parent_message_id, is_thread_root
             FROM messages 
             WHERE channel_name = ?
             ORDER BY timestamp ASC`,
            [roomName]
        );

        const metadata = await db.query(
            'SELECT pinned_message_id FROM channels WHERE channel_name = ?',
            [roomName]
        );

        let pinnedMessage = null;
        if (metadata[0]?.pinned_message_id) {
            let pinnedMsg = await db.query('SELECT id, author_username, content FROM messages WHERE id = ?', [metadata[0].pinned_message_id]);
            if (pinnedMsg.length > 0) {
                pinnedMessage = {
                    id: pinnedMsg[0].id,
                    author: pinnedMsg[0].author_username,
                    content: pinnedMsg[0].content,
                };
            }
        }

        // Process messages: parse attachment metadata, fetch reactions, clean booleans
        for (const msg of messages) {
    // FIX: Safely parse attachment_metadata. Check if it's a non-null string before parsing.
    // If it's already an object (due to driver settings), use it directly.
    if (typeof msg.attachment_metadata === 'string') {
        // If it's a string, attempt to parse it (assuming DB stores it as JSON string)
        try {
            msg.attachment = JSON.parse(msg.attachment_metadata);
        } catch (e) {
            console.error('Error parsing JSON attachment_metadata:', msg.attachment_metadata, e.message);
            msg.attachment = null;
        }
    } else if (msg.attachment_metadata !== null && typeof msg.attachment_metadata === 'object') {
        // If the driver already parsed it into an object, use it directly
        msg.attachment = msg.attachment_metadata;
    } else {
        msg.attachment = null;
    }
    delete msg.attachment_metadata;
            
            // FIX: Ensure boolean values are correctly interpreted from DB int (1/0)
            msg.edited = msg.edited === 1;
            msg.system = msg.system === 1;
            msg.is_thread_root = msg.is_thread_root === 1;

            const reactions = await db.query('SELECT user_id, emoji FROM reactions WHERE message_id = ?', [msg.id]);
            msg.reactions = reactions.reduce((acc, { user_id, emoji }) => {
                acc[emoji] = acc[emoji] || [];
                acc[emoji].push(user_id);
                return acc;
            }, {});
        }

        return { messages, pinnedMessage };
    } catch (e) {
        console.error("DB ERROR in getRoomData:", e.message, e);
        return { messages: [], pinnedMessage: null };
    }
}


function getActiveUsersInRoom(roomName) {
    const activeUsers = [];
    clients.forEach((client, clientId) => {
        if (client.channel === roomName) {
            activeUsers.push({ id: clientId, username: client.username, role: client.role, status: client.status });
        }
    });
    return activeUsers;
}

function broadcastPresence(roomName) {
    const activeUsers = getActiveUsersInRoom(roomName);
    const data = { channel: roomName, users: activeUsers };
    clients.forEach((client) => {
        if (client.channel === roomName) {
            sendToClient(client.ws, 'user_presence', data);
        }
    });
}

// --- Command Handlers ---
async function handleCommand(command, args, client, userId, ws) {
    const roomName = client.channel;
    const [targetUsername, ...restArgs] = args;
    
    switch (command) {
        case '/pin':
            const messageIdToPin = restArgs[0];
            if (!hasPermission(client.role, 'Admin')) { sendToClient(ws, 'error', { message: 'Permission denied. Requires Admin role.' }); return; }
            if (!messageIdToPin) { sendToClient(ws, 'error', { message: 'Usage: /pin [messageId]' }); return; }
            try {
                const messages = await db.query('SELECT id, author_username, content FROM messages WHERE id = ? AND channel_name = ?', [messageIdToPin, roomName]);
                if (messages.length === 0) { sendToClient(ws, 'error', { message: 'Message not found in this channel.' }); return; }
                
                await db.query('UPDATE channels SET pinned_message_id = ? WHERE channel_name = ?', [messageIdToPin, roomName]);
                const pinnedMessage = { id: messages[0].id, author: messages[0].author_username, content: messages[0].content };
                broadcast(roomName, 'update_pinned_message', { message: pinnedMessage });
                sendToClient(ws, 'notification', { message: 'Message pinned successfully.' });
            } catch (e) {
                console.error('Pin message DB error:', e);
                sendToClient(ws, 'error', { message: 'DB Error pinning message.' });
            }
            break;
            
        case '/unpin':
            if (!hasPermission(client.role, 'Admin')) { sendToClient(ws, 'error', { message: 'Permission denied. Requires Admin role.' }); return; }
            await db.query('UPDATE channels SET pinned_message_id = NULL WHERE channel_name = ?', [roomName]);
            broadcast(roomName, 'update_pinned_message', { message: null });
            sendToClient(ws, 'notification', { message: 'Message unpinned.' });
            break;
            
        case '/kick':
        case '/ban':
            // Moderation: Requires Admin or Moderator role (simplified to Admin here)
            if (!hasPermission(client.role, 'Admin') || !targetUsername) { sendToClient(ws, 'error', { message: `Permission denied or missing username. Usage: ${command} [username]` }); return; }
            
            let targetClient, targetId;
            clients.forEach((c, id) => { if (c.username === targetUsername) { targetClient = c; targetId = id; } });

            if (targetClient?.role === 'Admin') { sendToClient(ws, 'error', { message: 'Cannot moderate another Admin.' }); return; }
            
            if (command === '/ban') {
                bannedUsers.add(targetUsername);
                const reason = restArgs.slice(1).join(' ') || 'Banned by Admin command.';
                // Update DB ban status (Schema feature)
                await db.query('UPDATE users SET is_banned = TRUE, ban_reason = ? WHERE username = ?', [reason, targetUsername]);
                sendToClient(ws, 'notification', { message: `User ${targetUsername} is now permanently banned.` });
            }
            
            if (targetClient) {
                const action = command === '/ban' ? 'banned' : 'kicked';
                const message = command === '/ban' ? 'permanently banned' : 'kicked';
                broadcast(roomName, 'channel_message', { 
                    author: 'Server', content: `${targetUsername} has been ${message} by ${client.username}.`, timestamp: Date.now(), system: true
                });
                sendToClient(targetClient.ws, action, { reason: `You were ${action} from the server.` });
                // Log action (Schema feature)
                await db.query('INSERT INTO audit_logs (action_type, actor_id, target_id, details) VALUES (?, ?, ?, ?)', 
                    [`USER_${command.substring(1).toUpperCase()}`, userId, targetId, JSON.stringify({ targetUsername, room: roomName })]);

                targetClient.ws.close(1000, action);
                clients.delete(targetId); 
                broadcastPresence(roomName);
            } else if (command === '/kick') {
                sendToClient(ws, 'error', { message: `User ${targetUsername} not found or already disconnected.` });
            }
            break;
            
        case '/status':
            const newStatus = args[0] ? args[0].toLowerCase() : 'online';
            const allowedStatuses = ['online', 'away', 'dnd'];
            if (!allowedStatuses.includes(newStatus)) { sendToClient(ws, 'error', { message: 'Invalid status. Use: online, away, or dnd.' }); return; }
            client.status = newStatus;
            await db.query('UPDATE users SET current_status = ? WHERE user_id = ?', [newStatus, userId]);
            broadcastPresence(roomName);
            sendToClient(ws, 'notification', { message: `Your status is now set to ${newStatus}.` });
            break;

        default:
            sendToClient(ws, 'error', { message: `Unknown command: ${command}.` });
    }
}


// --- Main WebSocket Logic ---

function setupWebSocket(server) {
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        let currentUserId = null;

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                
                // IMPORTANT: In the login block, this variable is updated to persist the ID.
                // We ensure it is set correctly on the WS object for use in the 'close' handler.
                ws.currentUserId = currentUserId;

                if (data.type === 'login') {
                    const userId = data.userId;
                    const inputUsername = data.username.substring(0, 20);
                    currentUserId = userId; // FIX: Ensure currentUserId is set correctly here
                    ws.currentUserId = currentUserId; // FIX: Also ensure it is set on the ws object

                    const users = await db.query('SELECT * FROM users WHERE user_id = ?', [userId]);
                    const persistentUser = users[0];

                    if (!persistentUser) { sendToClient(ws, 'error', { message: 'Invalid User ID. Please register.' }); ws.close(1000, 'Invalid Auth'); return; }
                    // Check against in-memory ban list AND DB status
                    if (bannedUsers.has(persistentUser.username) || persistentUser.is_banned) { sendToClient(ws, 'banned', { reason: persistentUser.ban_reason || 'You are banned from this server.' }); ws.close(1000, 'Banned'); return; }
                    if (clients.has(userId)) { sendToClient(clients.get(userId).ws, 'kicked', { reason: 'Another connection established with your user ID.' }); clients.get(userId).ws.close(1000, 'Duplicate Login'); clients.delete(userId); }
                    
                    const clientData = {
                        ws: ws,
                        username: inputUsername, 
                        channel: persistentUser.last_seen_channel,
                        role: persistentUser.user_role,
                        status: persistentUser.current_status
                    };
                    clients.set(userId, clientData);
                    
                    const authorizedChannels = await getAuthorizedChannels(userId);
                    const isChannelAccessible = authorizedChannels.some(c => c.name === clientData.channel);
                    
                    // If the user's last seen channel is no longer accessible, switch them to the fallback.
                    if (!isChannelAccessible) {
                        clientData.channel = FALLBACK_CHANNEL;
                        await db.query('UPDATE users SET last_seen_channel = ? WHERE user_id = ?', [FALLBACK_CHANNEL, userId]);
                    }

                    const { messages, pinnedMessage } = await getRoomData(clientData.channel);

                    // Send authorized channels list and initial history
                    sendToClient(ws, 'initial_state', { currentChannel: clientData.channel, availableChannels: authorizedChannels });
                    sendToClient(ws, 'message_history', { channel: clientData.channel, messages: messages, pinned: pinnedMessage });
                    
                    // Notify room of arrival
                    if (!clientData.channel.startsWith('DM:')) {
                        broadcast(clientData.channel, 'channel_message', { 
                            id: crypto.randomUUID(), author: 'Server', content: `${clientData.username} has joined ${clientData.channel}.`, timestamp: Date.now(), system: true
                        }, userId);
                    }
                    broadcastPresence(clientData.channel); 
                    sendToClient(ws, 'login_success', { username: clientData.username, role: clientData.role });
                    return;
                }

                if (!currentUserId || !clients.has(currentUserId)) { sendToClient(ws, 'error', { message: 'Authentication required.' }); return; }
                const client = clients.get(currentUserId);

                switch (data.type) {
                    case 'send_message':
                    case 'send_dm': 
                        const content = data.content ? data.content.trim() : '';
                        const targetRoom = data.type === 'send_dm' ? data.channel : client.channel;
                        const isDM = targetRoom.startsWith('DM:');
                        const attachment = data.attachment || null; 
                        
                        // Check for slash command before content check
                        if (content.startsWith('/')) {
                            const parts = content.substring(1).split(' ');
                            await handleCommand(parts[0].toLowerCase(), parts.slice(1), client, currentUserId, ws);
                            break;
                        }

                        if (content.length > 0 || attachment) {
                            // Threading: Set parent and thread root flags
                            const parentId = data.parent_message_id || null;
                            // FIX: A message is a thread root if it's NOT a reply (i.e., it has no parentId)
                            const isThreadRoot = parentId ? false : true; 

                            const messageData = {
                                id: crypto.randomUUID(),
                                author: client.username,
                                authorId: currentUserId,
                                content: content,
                                timestamp: Date.now(),
                                channel: targetRoom, 
                                system: false,
                                edited: false,
                                editedTimestamp: null,
                                reactions: {},
                                attachment: attachment,
                                parent_message_id: parentId,
                                is_thread_root: isThreadRoot
                            };
                            
                            if (!isDM) {
                                const attachmentJson = attachment ? JSON.stringify(attachment) : null;
                                await db.query(
                                    'INSERT INTO messages (id, channel_name, author_id, author_username, content, timestamp, attachment_metadata, parent_message_id, is_thread_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                    [messageData.id, targetRoom, currentUserId, client.username, content, messageData.timestamp, attachmentJson, parentId, isThreadRoot ? 1 : 0]
                                );
                            }
                            
                            sendToClient(ws, 'channel_message', messageData);
                            broadcast(targetRoom, 'channel_message', messageData, currentUserId); 
                        }
                        break;
                        
                    case 'create_channel':
                        let newChannelName = data.channel;
                        const isPrivate = !!data.isPrivate;

                        if (newChannelName.length > 50 || newChannelName.length < 2) {
                            sendToClient(ws, 'error', { message: 'Channel name is too short or too long.' });
                            return;
                        }
                        
                        let inviteCode = null;
                        if (isPrivate) {
                            inviteCode = generateInviteCode();
                        }

                        try {
                            // 1. Create Channel
                            await db.query(
                                'INSERT INTO channels (channel_name, is_private, invite_code, created_by) VALUES (?, ?, ?, ?)',
                                [newChannelName, isPrivate ? 1 : 0, inviteCode, currentUserId]
                            );
                            
                            // 2. Add creator to membership if private
                            if (isPrivate) {
                                await db.query(
                                    'INSERT INTO channel_members (channel_name, user_id) VALUES (?, ?)',
                                    [newChannelName, currentUserId]
                                );
                            }

                            // 3. Notify user and make them join
                            if (inviteCode) {
                                sendToClient(ws, 'notification', { message: `Private Channel ${newChannelName} created! Invite code: ${inviteCode}` });
                            } else {
                                sendToClient(ws, 'notification', { message: `Public Channel ${newChannelName} created!` });
                            }
                            
                            // 4. Update client channel lists (for all clients)
                            wss.clients.forEach(c => {
                                // FIX: Use c.currentUserId, which is set in the login handler
                                if (c.readyState === WebSocket.OPEN && c.currentUserId) {
                                    getAuthorizedChannels(c.currentUserId).then(channels => {
                                        sendToClient(c, 'channel_list_update', { availableChannels: channels });
                                    }).catch(err => console.error("Error updating public channel list for client:", err));
                                }
                            });
                            
                            // 5. Immediately join the new channel by triggering the join logic
                            setTimeout(() => {
                                const joinMessage = JSON.stringify({ type: 'join_channel', channel: newChannelName });
                                ws.emit('message', joinMessage);
                            }, 50);

                        } catch (e) {
                            if (e.code === 'ER_DUP_ENTRY') {
                                sendToClient(ws, 'error', { message: `Channel ${newChannelName} already exists.` });
                            } else {
                                console.error("Channel creation error:", e);
                                sendToClient(ws, 'error', { message: 'Failed to create channel due to server error.' });
                            }
                        }
                        break;
                        
                    case 'delete_channel':
                        const channelToDelete = data.channel;
                        const channelInfo = (await db.query('SELECT created_by FROM channels WHERE channel_name = ?', [channelToDelete]))[0];

                        if (!channelInfo || channelToDelete === FALLBACK_CHANNEL) {
                            sendToClient(ws, 'error', { message: 'Cannot delete default or nonexistent channel.' });
                            return;
                        }
                        // FIX: Added Moderator to the permission check for channel deletion
                        const isChannelCreator = channelInfo.created_by === currentUserId;
                        const canDeleteChannel = hasPermission(client.role, 'Admin') || isChannelCreator;

                        if (!canDeleteChannel) {
                            sendToClient(ws, 'error', { message: 'Permission denied. Only the creator or an Admin can delete this channel.' });
                            return;
                        }
                        
                        try {
                            // 1. Move all users in that channel to #general and send channel change
                            const usersToMove = [];
                            clients.forEach((c, id) => {
                                if (c.channel === channelToDelete) {
                                    c.channel = FALLBACK_CHANNEL;
                                    clients.set(id, c);
                                    usersToMove.push(c);
                                }
                            });
                            
                            // 2. Delete channel (cascades to messages/members/reactions)
                            await db.query('DELETE FROM channels WHERE channel_name = ?', [channelToDelete]);

                            // 3. Send channel change to affected clients
                            const fallbackRoomData = await getRoomData(FALLBACK_CHANNEL);
                            usersToMove.forEach(c => {
                                getAuthorizedChannels(c.ws.currentUserId).then(channels => {
                                    sendToClient(c.ws, 'channel_change', { 
                                        newChannel: FALLBACK_CHANNEL, 
                                        history: fallbackRoomData.messages, 
                                        pinned: fallbackRoomData.pinnedMessage,
                                        availableChannels: channels
                                    });
                                });
                            });
                            
                            // 4. Broadcast updated channel list to all
                            wss.clients.forEach(c => {
                                if (c.readyState === WebSocket.OPEN && c.currentUserId) {
                                    getAuthorizedChannels(c.currentUserId).then(channels => {
                                        sendToClient(c, 'channel_list_update', { availableChannels: channels });
                                    }).catch(err => console.error("Error updating channel list after delete:", err));
                                }
                            });
                            
                            broadcastPresence(channelToDelete); 
                            broadcastPresence(FALLBACK_CHANNEL); 
                            
                            sendToClient(ws, 'notification', { message: `Channel ${channelToDelete} deleted successfully.` });

                        } catch (e) {
                            console.error("Channel deletion error:", e);
                            sendToClient(ws, 'error', { message: 'Failed to delete channel due to server error.' });
                        }
                        break;
                        
                    case 'join_channel_by_code':
                        const code = data.code;
                        const channelResult = (await db.query('SELECT channel_name, is_private FROM channels WHERE invite_code = ?', [code]))[0];

                        if (!channelResult) {
                            sendToClient(ws, 'error', { message: 'Invalid or expired invite code.' });
                            return;
                        }

                        if (channelResult.is_private) {
                            // 1. Add user to channel_members table
                            await db.query(
                                'INSERT IGNORE INTO channel_members (channel_name, user_id) VALUES (?, ?)',
                                [channelResult.channel_name, currentUserId]
                            );
                            
                            sendToClient(ws, 'notification', { message: `Successfully joined private channel ${channelResult.channel_name}.` });
                            
                            // 2. Refresh client's channel list
                            const channelList = await getAuthorizedChannels(currentUserId);
                            sendToClient(ws, 'channel_list_update', { availableChannels: channelList });
                        } else {
                            sendToClient(ws, 'error', { message: 'This code is for a public channel. Use the channel list.' });
                            return;
                        }
                        
                        // 3. Attempt to join the channel
                        const joinMessage = JSON.stringify({ type: 'join_channel', channel: channelResult.channel_name });
                        ws.emit('message', joinMessage); // Use emit to trigger internal handler
                        break;

                    case 'typing_update':
                        const isTyping = !!data.isTyping;
                        const typingSet = typingUsers.get(client.channel) || new Set();
                        if (isTyping && !typingSet.has(client.username)) { typingSet.add(client.username); } 
                        else if (!isTyping) { typingSet.delete(client.username); }
                        typingUsers.set(client.channel, typingSet);
                        const currentTyping = Array.from(typingSet);
                        broadcast(client.channel, 'typing_status', { channel: client.channel, typingUsers: currentTyping }, currentUserId);
                        sendToClient(ws, 'typing_status', { channel: client.channel, typingUsers: currentTyping });
                        break;
                        
                    case 'edit_message':
                        const messageIdToEdit = data.id;
                        const newContent = data.content ? data.content.trim() : '';
                        const msgToEditResults = await db.query('SELECT * FROM messages WHERE id = ? AND channel_name = ?', [messageIdToEdit, client.channel]);
                        const messageToEdit = msgToEditResults[0];

                        // Permission Check: User is author OR is an Admin/Moderator (RBAC)
                        const canEdit = messageToEdit && (messageToEdit.author_id === currentUserId || hasPermission(client.role, 'Moderator'));
                        
                        if (canEdit && newContent.length > 0) {
                            // TTL Check (feature) - Only applies to the original author
                            if (messageToEdit.author_id === currentUserId && Date.now() > (messageToEdit.timestamp + MESSAGE_EDIT_TTL_MS)) {
                                sendToClient(ws, 'error', { message: 'Message is too old to edit (TTL exceeded).' }); 
                                return;
                            }
                            
                            const newTimestamp = Date.now();
                            await db.query(
                                'UPDATE messages SET content = ?, edited = 1, edited_timestamp = ? WHERE id = ?',
                                [newContent, newTimestamp, messageIdToEdit]
                            );
                            
                            const updatedMsg = { 
                                ...messageToEdit, 
                                content: newContent, 
                                edited: true, 
                                editedTimestamp: newTimestamp,
                                attachment: messageToEdit.attachment_metadata ? JSON.parse(messageToEdit.attachment_metadata) : null
                            };
                            broadcast(client.channel, 'message_edited', updatedMsg);
                            sendToClient(ws, 'message_edited', updatedMsg);
                        } else { sendToClient(ws, 'error', { message: 'Permission denied or content empty.' }); }
                        break;

                    case 'delete_message':
                        const messageIdToDelete = data.id;
                        // FIX: Also select content for the audit log
                        const msgToDeleteResults = await db.query('SELECT author_id, content FROM messages WHERE id = ? AND channel_name = ?', [messageIdToDelete, client.channel]);
                        const messageToDelete = msgToDeleteResults[0];
                        
                        // Permission Check: User is author OR Moderator/Admin
                        const canDelete = messageToDelete && (messageToDelete.author_id === currentUserId || hasPermission(client.role, 'Moderator'));

                        if (canDelete) {
                            await db.query('DELETE FROM messages WHERE id = ?', [messageIdToDelete]);
                            await db.query('UPDATE channels SET pinned_message_id = NULL WHERE channel_name = ? AND pinned_message_id = ?', [client.channel, messageIdToDelete]);

                            broadcast(client.channel, 'message_deleted', { id: messageIdToDelete, channel: client.channel });
                            sendToClient(ws, 'message_deleted', { id: messageIdToDelete, channel: client.channel });
                            
                            // Log action (Schema feature)
                            await db.query('INSERT INTO audit_logs (action_type, actor_id, target_id, details) VALUES (?, ?, ?, ?)', 
                                ['MESSAGE_DELETE', currentUserId, messageIdToDelete, JSON.stringify({ room: client.channel, content: messageToDelete.content.substring(0, 50) + '...' })]);

                        } else { sendToClient(ws, 'error', { message: 'Permission denied to delete this message.' }); }
                        break;

                    case 'add_reaction':
                    case 'remove_reaction':
                        const messageIdReaction = data.id;
                        const emoji = data.emoji;

                        if (data.type === 'add_reaction') {
                            await db.query('INSERT IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [messageIdReaction, currentUserId, emoji]);
                        } else if (data.type === 'remove_reaction') {
                            await db.query('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageIdReaction, currentUserId, emoji]);
                        }
                        
                        // Fetch updated reactions
                        const reactionResults = await db.query('SELECT user_id, emoji FROM reactions WHERE message_id = ?', [messageIdReaction]);
                        const updatedReactions = reactionResults.reduce((acc, { user_id, emoji }) => {
                            acc[emoji] = acc[emoji] || [];
                            acc[emoji].push(user_id);
                            return acc;
                        }, {});

                        broadcast(client.channel, 'message_reacted', { id: messageIdReaction, reactions: updatedReactions });
                        sendToClient(ws, 'message_reacted', { id: messageIdReaction, reactions: updatedReactions });
                        break;


                    case 'join_channel':
                    case 'start_dm':
                        let newRoom;
                        const oldRoom = client.channel;
                        
                        if (data.type === 'join_channel') {
                            const targetChannel = data.channel;
                            const authorizedChannels = await getAuthorizedChannels(currentUserId);
                            const channelExists = authorizedChannels.some(c => c.name === targetChannel);

                            if (!channelExists) {
                                sendToClient(ws, 'error', { message: `Channel ${targetChannel} is private or does not exist.` });
                                return;
                            }
                            newRoom = targetChannel;
                        } else if (data.type === 'start_dm' && data.targetUserId) {
                            newRoom = getDmRoomName(currentUserId, data.targetUserId);
                        }

                        if (!newRoom || newRoom === oldRoom) break;

                        // Notify old room of departure
                        if (!oldRoom.startsWith('DM:')) { 
                            broadcast(oldRoom, 'channel_message', { id: crypto.randomUUID(), author: 'Server', content: `${client.username} has left the chat.`, timestamp: Date.now(), system: true });
                        }
                        const oldTypingSet = typingUsers.get(oldRoom);
                        if (oldTypingSet && oldTypingSet.delete(client.username)) { broadcast(oldRoom, 'typing_status', { channel: oldRoom, typingUsers: Array.from(oldTypingSet) }); }
                        
                        // Update client state
                        client.channel = newRoom;
                        clients.set(currentUserId, client);
                        await db.query('UPDATE users SET last_seen_channel = ? WHERE user_id = ?', [newRoom, currentUserId]);

                        const newRoomData = await getRoomData(newRoom);
                        
                        const channelList = await getAuthorizedChannels(currentUserId);
                        sendToClient(ws, 'channel_change', { newChannel: newRoom, history: newRoomData.messages, pinned: newRoomData.pinnedMessage, availableChannels: channelList });

                        // Notify new room of arrival
                        if (!newRoom.startsWith('DM:')) { 
                            broadcast(newRoom, 'channel_message', { id: crypto.randomUUID(), author: 'Server', content: `${client.username} has joined ${newRoom}.`, timestamp: Date.now(), system: true });
                        }
                        broadcastPresence(oldRoom);
                        broadcastPresence(newRoom);
                        break;

                    default:
                        console.log(`Unknown message type received: ${data.type}`);
                }
            } catch (e) {
                console.error('Error processing WebSocket message:', e.message, e);
                sendToClient(ws, 'error', { message: 'Internal error processing request.' });
            }
        });

        ws.on('close', () => {
            const userId = ws.currentUserId; 
            const client = clients.get(userId);
            
            if (client) {
                const disconnectedChannel = client.channel;
                // Notify room of departure
                if (!disconnectedChannel.startsWith('DM:')) {
                    broadcast(disconnectedChannel, 'channel_message', { id: crypto.randomUUID(), author: 'Server', content: `${client.username} has disconnected.`, timestamp: Date.now(), system: true });
                }
                // Clear typing status
                const typingSet = typingUsers.get(disconnectedChannel);
                if (typingSet && typingSet.delete(client.username)) { broadcast(disconnectedChannel, 'typing_status', { channel: disconnectedChannel, typingUsers: Array.from(typingSet) }); }
                
                clients.delete(userId);
                broadcastPresence(disconnectedChannel); 
            }
        });
        ws.on('error', (error) => { console.error('WebSocket Error:', error); });
    });
}

module.exports = setupWebSocket;
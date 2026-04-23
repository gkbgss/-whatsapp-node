const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    isLidUser,
    isPnUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const bootTime = new Date().toISOString();

const LARAVEL_API_URL = process.env.LARAVEL_API_URL || 'https://quickmed.technoderivation.com/technochain/api';
const LARAVEL_API_ROUTES = {
    sessionsQrStore: `${LARAVEL_API_URL}/sessions/qr`,
    accountStatusUpdate: (accountId) => `${LARAVEL_API_URL}/accounts/${accountId}/status`,
    accountProfileSync: (accountId) => `${LARAVEL_API_URL}/accounts/${accountId}/sync-profile`,
    chatHistorySync: `${LARAVEL_API_URL}/sync-history`,
    chatReceiveMessage: `${LARAVEL_API_URL}/receive-message`
};

// Store active sessions (accountId -> socket)
const sessions = new Map();
// Dedup auto-replies so one incoming message gets one AI reply.
const autoReplyDedup = new Map();

/**
 * Helper: Extract text or label from complex message objects
 */
const getMessageText = (m) => {
    const msg = m.message;
    if (!msg) return null;

    // 1. Direct Conversation
    if (msg.conversation) return msg.conversation;

    // 2. Extended Text (links, formatting)
    if (msg.extendedTextMessage) return msg.extendedTextMessage.text;

    // 3. Image Message
    if (msg.imageMessage) {
        return msg.imageMessage.caption ? `📷 ${msg.imageMessage.caption}` : '📷 [PHOTO]';
    }

    // 4. Video Message
    if (msg.videoMessage) {
        return msg.videoMessage.caption ? `🎥 ${msg.videoMessage.caption}` : '🎥 [VIDEO]';
    }

    // 5. Audio Message
    if (msg.audioMessage) return '🎵 [AUDIO]';

    // 6. Document Message
    if (msg.documentMessage) {
        return msg.documentMessage.fileName ? `📄 ${msg.documentMessage.fileName}` : '📄 [DOCUMENT]';
    }

    // 7. Sticker Message
    if (msg.stickerMessage) return '😜 [STICKER]';

    // 8. View Once Messages
    if (msg.viewOnceMessageV2?.message?.imageMessage) return '📷 [VIEW ONCE PHOTO]';
    if (msg.viewOnceMessageV2?.message?.videoMessage) return '🎥 [VIEW ONCE VIDEO]';

    return '[Media/Other]';
};

/**
 * Helper: Simple async delay
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Build LID → phone JID map from history contacts (phoneNumber + lid) and message keys.
 * History often lists chats by @lid before getPNForLID is populated; contacts carry the real number.
 */
function buildLidToPhoneMap(contacts, messages, historyChats = []) {
    const map = new Map();
    const addPair = (lidJid, pnJid) => {
        if (!lidJid || !pnJid) return;
        const l = jidNormalizedUser(lidJid);
        let p = pnJid;
        if (p && !String(p).includes('@')) {
            const digits = String(p).replace(/\D/g, '');
            if (digits) p = `${digits}@s.whatsapp.net`;
        } else if (p) {
            p = jidNormalizedUser(p);
        }
        if (l && p && isLidUser(l) && isPnUser(p)) map.set(l, p);
    };
    // Baileys history: each chat may have id (often @lid), lidJid, pnJid (real phone JID)
    for (const ch of historyChats || []) {
        if (!ch?.pnJid) continue;
        if (ch.lidJid) addPair(ch.lidJid, ch.pnJid);
        if (ch.id && isLidUser(jidNormalizedUser(ch.id))) addPair(ch.id, ch.pnJid);
    }
    for (const c of contacts || []) {
        if (!c.phoneNumber) continue;
        if (c.lid) addPair(c.lid, c.phoneNumber);
        if (c.id && isLidUser(jidNormalizedUser(c.id))) addPair(c.id, c.phoneNumber);
    }
    for (const m of messages || []) {
        if (!m.key) continue;
        const r = m.key.remoteJid ? jidNormalizedUser(m.key.remoteJid) : '';
        const ra = m.key.remoteJidAlt ? jidNormalizedUser(m.key.remoteJidAlt) : '';
        if (r && ra) {
            if (isLidUser(r) && isPnUser(ra)) addPair(r, ra);
            if (isLidUser(ra) && isPnUser(r)) addPair(ra, r);
        }
    }
    return map;
}

function pnFromLidMap(lidToPnMap, jid) {
    if (!jid || !lidToPnMap) return null;
    const n = jidNormalizedUser(jid);
    if (!n || !isLidUser(n)) return null;
    const pn = lidToPnMap.get(n);
    return pn ? jidNormalizedUser(pn) : null;
}

/**
 * Stable DB key for 1:1 chats: always prefer phone JID (@s.whatsapp.net).
 * WhatsApp often sends LID in remoteJid but the phone in remoteJidAlt — same as WhatsApp Web.
 */
async function canonicalUserJidFromParts(socket, remoteJid, remoteJidAlt, lidToPnMap = null) {
    const mapped =
        pnFromLidMap(lidToPnMap, remoteJid) || pnFromLidMap(lidToPnMap, remoteJidAlt);
    if (mapped) return mapped;

    const a = remoteJid ? jidNormalizedUser(remoteJid) : '';
    const b = remoteJidAlt ? jidNormalizedUser(remoteJidAlt) : '';
    if (a && isPnUser(a)) return a;
    if (b && isPnUser(b)) return b;
    if (a && isLidUser(a)) {
        try {
            const pn = await socket.signalRepository.lidMapping.getPNForLID(a);
            if (pn) return jidNormalizedUser(pn);
        } catch (e) {
            console.warn('[JID] getPNForLID failed for remoteJid:', e.message);
        }
    }
    if (b && isLidUser(b)) {
        try {
            const pn = await socket.signalRepository.lidMapping.getPNForLID(b);
            if (pn) return jidNormalizedUser(pn);
        } catch (e) {
            console.warn('[JID] getPNForLID failed for remoteJidAlt:', e.message);
        }
    }
    return a || b || remoteJid;
}

/** When only one jid is known (e.g. chat list id). */
async function toCanonicalDmJid(socket, jid, lidToPnMap = null) {
    return canonicalUserJidFromParts(socket, jid, undefined, lidToPnMap);
}

/**
 * Helper: Simulate human behavior (Typing... -> Wait -> Send)
 */
const sendWithTyping = async (socket, jid, text, type = 'composing', typingDelayOverrideMs = null) => {
    // 1. Show presence (typing...) if supported by current Baileys build
    try {
        if (typeof socket.presenceObserve === 'function') {
            await socket.presenceObserve(jid);
        }
        if (typeof socket.sendPresenceUpdate === 'function') {
            await socket.sendPresenceUpdate(type, jid);
        }
    } catch (e) {
        console.warn(`[AUTO-REPLY] Presence simulation skipped: ${e.message}`);
    }
    
    // 2. Human-like wait (based on text length)
    const waitTime = typingDelayOverrideMs === null
        ? Math.min(Math.max(text.length * 50, 2000), 7000)
        : Math.max(0, Number(typingDelayOverrideMs) || 0);
    await delay(waitTime);
    
    // 3. Stop presence (best effort)
    try {
        if (typeof socket.sendPresenceUpdate === 'function') {
            await socket.sendPresenceUpdate('paused', jid);
        }
    } catch (e) {}
    
    // 4. Send Message
    return await socket.sendMessage(jid, { text });
};

/**
 * Initialize a WhatsApp session for a specific account
 */
async function initSession(sessionId) {
    console.log(`[SESSION] Initializing for account: ${sessionId}`);
    
    // Session persistence per account
    const sessionDir = path.join(__dirname, 'sessions', sessionId.toString());
    
    // Ensure sessions directory exists
    if (!fs.existsSync(path.join(__dirname, 'sessions'))) {
        fs.mkdirSync(path.join(__dirname, 'sessions'));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, // Keep it true for terminal debugging too
        logger: pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '11.0.0']
    });

    sessions.set(sessionId.toString(), socket);

    // Save credentials whenever they are updated
    socket.ev.on('creds.update', saveCreds);

    // Monitor connection status
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[QR] Generated for account ${sessionId}. Sending to Laravel...`);
            // Broadcast QR to Laravel so it can show it on the dashboard
            try {
                await axios.post(LARAVEL_API_ROUTES.sessionsQrStore, {
                    account_id: sessionId,
                    qr: qr
                });
                console.log(`[QR] Successfully sent to Laravel for ${sessionId}`);
            } catch (err) {
                console.error(`[QR] FAILED to send to Laravel for ${sessionId}:`, err.message);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut : true;
            
            console.log(`Connection for ${sessionId} closed. Reconnecting:`, shouldReconnect);
            
            if (shouldReconnect) {
                initSession(sessionId);
            } else {
                console.log(`Account ${sessionId} logged out. Cleaning up...`);
                sessions.delete(sessionId.toString());
                
                // Update Laravel status to 'disconnected'
                try {
                    await axios.patch(LARAVEL_API_ROUTES.accountStatusUpdate(sessionId), {
                        status: 'disconnected',
                        phone_number: null
                    });
                } catch (err) {
                    console.error(`Failed to update logout status for ${sessionId}:`, err.message);
                }
            }
        } else if (connection === 'open') {
            console.log(`WhatsApp account ${sessionId} opened successfully!`);
            
            // Get own info
            const me = socket.user.id.split(':')[0];
            const myName = socket.user.name || null;
            let myAvatar = null;

            try {
                myAvatar = await socket.profilePictureUrl(socket.user.id, 'image').catch(() => null);
            } catch (e) {
                console.log(`[PROFILE] Could not fetch own avatar for ${sessionId}`);
            }

            // Sync full profile metadata with Laravel
            try {
                await axios.post(LARAVEL_API_ROUTES.accountProfileSync(sessionId), {
                    phone: me,
                    user_name: myName,
                    avatar_url: myAvatar
                });
                console.log(`[PROFILE] Synced own identity for ${sessionId}: ${myName || me}`);
            } catch (err) {
                console.error(`[PROFILE] FAILED to sync identity for ${sessionId}:`, err.message);
            }
        }
    });
    
    // Listen for initial history sync (past chats and messages)
    socket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        console.log(`[HISTORY] Received ${chats.length} chats, ${contacts.length} contacts, and ${messages.length} messages`);
        
        // Build a name map from the contacts provided (key by id, LID, and phone JID)
        const contactMap = new Map();
        contacts.forEach(c => {
            const name = c.name || c.notify || c.verifiedName || null;
            if (!name) return;
            contactMap.set(c.id, name);
            if (c.phoneNumber) {
                const pn = String(c.phoneNumber).includes('@')
                    ? jidNormalizedUser(c.phoneNumber)
                    : `${String(c.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`;
                contactMap.set(pn, name);
            }
        });

        const lidToPnMap = buildLidToPhoneMap(contacts, messages, chats);

        // SORT CHATS by conversationTimestamp (most recent first) and LIMIT to top 50
        const sortedChats = chats
            .filter(c => !c.id.includes('status@broadcast')) // Ignore status updates
            .sort((a, b) => (Number(b.conversationTimestamp || 0)) - (Number(a.conversationTimestamp || 0)))
            .slice(0, 50);

        console.log(`[HISTORY] Processing top ${sortedChats.length} most recent chats...`);

        // Pre-resolve using remoteJid + remoteJidAlt + contact LID map (LID/PN pairs)
        const canonicalByRemote = new Map();
        for (const m of messages) {
            const r = jidNormalizedUser(m.key.remoteJid);
            if (!r || canonicalByRemote.has(r)) continue;
            const c = await canonicalUserJidFromParts(socket, m.key.remoteJid, m.key.remoteJidAlt, lidToPnMap);
            canonicalByRemote.set(r, c);
        }

        const syncData = await Promise.all(sortedChats.map(async (chat) => {
            const cn = jidNormalizedUser(chat.id);
            const sampleMsg = messages.find(m => {
                const r = jidNormalizedUser(m.key.remoteJid);
                const ra = m.key.remoteJidAlt ? jidNormalizedUser(m.key.remoteJidAlt) : '';
                return (r && r === cn) || (ra && ra === cn);
            });

            const canonicalChatId = await canonicalUserJidFromParts(
                socket,
                chat.id,
                sampleMsg?.key?.remoteJidAlt,
                lidToPnMap
            );

            const resolvedName =
                contactMap.get(chat.id) ||
                contactMap.get(canonicalChatId) ||
                (sampleMsg && contactMap.get(jidNormalizedUser(sampleMsg.key.remoteJid))) ||
                chat.name ||
                null;

            // Prefer phone JID for profile picture (same as WhatsApp Web)
            let avatarUrl = null;
            try {
                avatarUrl = await socket.profilePictureUrl(canonicalChatId, 'image').catch(() => null);
                if (!avatarUrl) {
                    avatarUrl = await socket.profilePictureUrl(chat.id, 'image').catch(() => null);
                }
            } catch (e) {}

            const chatMessages = messages
                .filter(m => {
                    const r = jidNormalizedUser(m.key.remoteJid);
                    const canonMsg = canonicalByRemote.get(r);
                    return canonMsg === canonicalChatId;
                })
                .map(m => {
                    return {
                        id: m.key.id,
                        fromMe: m.key.fromMe || false,
                        text: getMessageText(m) || "[Media/Other]",
                        timestamp: m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now() / 1000)
                    };
                })
                .sort((a, b) => b.timestamp - a.timestamp) // Sort descending (newest first)
                .slice(0, 100);

            // DETERMINE PREVIEW TEXT (Match WhatsApp Web priority)
            // 1. Newest from history messages array
            // 2. Fallback to Baileys chat.lastMessage property
            // 3. Last fallback to "New Conversation"
            let previewText = "New Conversation";
            if (chatMessages.length > 0) {
                previewText = chatMessages[0].text;
            } else if (chat.lastMessage) {
                previewText = getMessageText(chat.lastMessage) || "History Syncing...";
            }

            // Use conversationTimestamp as fallback if no messages found
            const fallbackTs = chat.conversationTimestamp ? Number(chat.conversationTimestamp) : Math.floor(Date.now() / 1000);

            const origChatId = cn;
            const legacyChatIds =
                origChatId && canonicalChatId && origChatId !== canonicalChatId ? [origChatId] : [];

            return {
                id: canonicalChatId,
                legacy_chat_ids: legacyChatIds,
                name: resolvedName,
                avatar_url: avatarUrl,
                messages: chatMessages,
                last_message_preview: previewText, // Pass this explicitly to Laravel
                latestMessageTimestamp: chatMessages.length > 0 ? chatMessages[0].timestamp : fallbackTs
            };
        }));

        // Merge rows that normalized to the same canonical JID (LID + PN duplicates)
        const mergedMap = new Map();
        for (const row of syncData.sort((a, b) => b.latestMessageTimestamp - a.latestMessageTimestamp)) {
            const id = row.id;
            if (!mergedMap.has(id)) {
                mergedMap.set(id, row);
                continue;
            }
            const prev = mergedMap.get(id);
            const seen = new Set(prev.messages.map(m => m.id));
            for (const m of row.messages) {
                if (!seen.has(m.id)) {
                    prev.messages.push(m);
                    seen.add(m.id);
                }
            }
            prev.messages.sort((a, b) => b.timestamp - a.timestamp);
            if (prev.messages.length > 100) prev.messages = prev.messages.slice(0, 100);
            if (row.latestMessageTimestamp > prev.latestMessageTimestamp) {
                prev.latestMessageTimestamp = row.latestMessageTimestamp;
                prev.last_message_preview = row.last_message_preview;
            }
            if (row.name && !prev.name) prev.name = row.name;
            if (row.avatar_url && !prev.avatar_url) prev.avatar_url = row.avatar_url;
            const leg = [...new Set([...(prev.legacy_chat_ids || []), ...(row.legacy_chat_ids || [])])];
            prev.legacy_chat_ids = leg;
        }
        const finalSync = Array.from(mergedMap.values()).sort((a, b) => b.latestMessageTimestamp - a.latestMessageTimestamp);

        try {
            await axios.post(LARAVEL_API_ROUTES.chatHistorySync, {
                account_id: sessionId,
                conversations: finalSync
            });
            console.log(`[HISTORY] Successfully synced ${finalSync.length} conversations for account ${sessionId}`);
        } catch (err) {
            console.error(`[HISTORY] Sync failed for account ${sessionId}:`, err.message);
        }
    });

    // Listen for incoming and outgoing messages
    socket.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        // Listen for all notify type messages (even from self)
        if (m.type === 'notify') {
            const rawJid = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            
            // IGNORE Status updates, groups, etc.
            if (rawJid === 'status@broadcast' || rawJid.includes('@g.us')) {
                return;
            }

            const text = getMessageText(msg);

            if (text) {
                const senderJid = await canonicalUserJidFromParts(
                    socket,
                    msg.key.remoteJid,
                    msg.key.remoteJidAlt
                );
                const pushName = msg.pushName || null;
                let avatarUrl = null;

                // Only fetch avatar for incoming messages; use phone JID first (works with privacy settings)
                if (!isFromMe) {
                    try {
                        avatarUrl = await socket.profilePictureUrl(senderJid, 'image').catch(() => null);
                        if (!avatarUrl) {
                            avatarUrl = await socket.profilePictureUrl(rawJid, 'image').catch(() => null);
                        }
                    } catch (e) {}
                }

                const tsSec = msg.messageTimestamp != null
                    ? Number(msg.messageTimestamp)
                    : Math.floor(Date.now() / 1000);

                console.log(`[SYNC] Account ${sessionId} | ${isFromMe ? 'SENT' : 'RECEIVE'} | JID: ${senderJid} (raw ${rawJid}) | Msg: ${text}`);

                try {
                    // Send to Laravel
                    const response = await axios.post(LARAVEL_API_ROUTES.chatReceiveMessage, {
                        account_id: sessionId,
                        phone: senderJid,
                        jid_raw: rawJid,
                        contact_name: pushName,
                        avatar_url: avatarUrl,
                        message: text,
                        whatsapp_id: msg.key.id,
                        message_timestamp: tsSec,
                        is_from_me: isFromMe // Identify who sent it
                    });

                    // ONLY Handle AI Auto-reply IF NOT from Me
                    if (!isFromMe && response.data.ai_reply) {
                        const aiReply = response.data.ai_reply;
                        const incomingMsgId = msg?.key?.id
                            ? String(msg.key.id)
                            : `${rawJid}:${tsSec}:${text}`;
                        const dedupKey = `${sessionId}:${incomingMsgId}`;
                        const now = Date.now();

                        // Remove expired keys (15 min TTL) to keep memory bounded.
                        for (const [key, expiresAt] of autoReplyDedup.entries()) {
                            if (expiresAt <= now) {
                                autoReplyDedup.delete(key);
                            }
                        }
                        if (autoReplyDedup.has(dedupKey)) {
                            console.log(`[AUTO-REPLY] Skip duplicate trigger for ${dedupKey}`);
                            return;
                        }
                        autoReplyDedup.set(dedupKey, now + (15 * 60 * 1000));
                        
                        // --- RISK MITIGATION / HUMAN BEHAVIOR ---
                        
                        // 1. Mark as Read (Presence)
                        await socket.readMessages([msg.key]);
                        
                        // 2. Fixed response delay as requested: 10 seconds.
                        await delay(10000);
                        
                        console.log(`[AUTO-REPLY] Sending to ${senderJid}: ${aiReply}`);
                        
                        // 3. Send with typing indicator but no extra delay (already waited 10s).
                        // Always send to canonical phone JID so mirrored fromMe event
                        // maps back to the same conversation in Laravel/UI.
                        const sentAuto = await sendWithTyping(socket, senderJid, aiReply, 'composing', 0);

                        // 4. Persist immediately in Laravel so UI shows AI reply even if
                        // fromMe mirror upsert arrives late or is skipped by provider behavior.
                        try {
                            const persistRes = await axios.post(LARAVEL_API_ROUTES.chatReceiveMessage, {
                                account_id: sessionId,
                                phone: senderJid,
                                // Keep original raw jid so Laravel can merge any lingering
                                // @lid duplicate conversation into canonical phone thread.
                                jid_raw: rawJid,
                                contact_name: pushName,
                                avatar_url: avatarUrl,
                                message: aiReply,
                                whatsapp_id: sentAuto?.key?.id || null,
                                message_timestamp: Math.floor(Date.now() / 1000),
                                is_from_me: true
                            });
                            console.log(`[AUTO-REPLY] Persisted in Laravel for ${senderJid} (status ${persistRes.status})`);
                        } catch (persistErr) {
                            console.error('[AUTO-REPLY] Persist failed:', persistErr.message);
                        }
                    } else if (!isFromMe) {
                        const reason = response?.data?.ai_skip_reason || 'none';
                        console.log(`[AUTO-REPLY] Not generated for ${senderJid} (reason: ${reason})`);
                    }
                } catch (error) {
                    console.error('[SYNC] Laravel Error:', error.message);
                }
            }
        }
    });

    return socket;
}

/**
 * Endpoint: Initialize/Start session
 */
app.post('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    
    if (sessions.has(sessionId)) {
        return res.json({ status: 'active', message: 'Session already running' });
    }

    try {
        await initSession(sessionId);
        res.json({ status: 'initializing', message: 'Session initialization started' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * Endpoint: Delete/Stop session and cleanup files
 */
app.delete('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    console.log(`[DELETE] Request to cleanup session: ${sessionId}`);
    
    const socket = sessions.get(sessionId.toString());
    if (socket) {
        try {
            socket.logout(); // This also triggers connection.update with loggedOut
            sessions.delete(sessionId.toString());
        } catch (e) { console.error(`[DELETE] Error logging out socket: ${e.message}`); }
    }

    // Permanently remove the session directory
    const sessionDir = path.join(__dirname, 'sessions', sessionId.toString());
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`[DELETE] Session directory removed for ${sessionId}`);
        } catch (e) { console.error(`[DELETE] Error removing directory: ${e.message}`); }
    }

    res.json({ status: 'success', message: `Session ${sessionId} deleted and cleaned up` });
});

/**
 * Endpoint: Send message
 */
app.post('/send-message', async (req, res) => {
    let { account_id, phone, message } = req.body;
    
    const socket = sessions.get(account_id.toString());
    if (!socket) {
        console.error(`[SEND] FAILED: Account ${account_id} not running`);
        return res.status(404).json({ error: `Account ${account_id} is not running. Please start it.` });
    }

    // Determine the correct JID (prefer real phone @s.whatsapp.net over @lid from stale UI state)
    let jid = String(phone || '').trim();
    if (!jid.includes('@')) {
        const cleanPhone = jid.replace(/\D/g, '');
        jid = `${cleanPhone}@s.whatsapp.net`;
    } else {
        jid = jidNormalizedUser(jid);
        if (isLidUser(jid)) {
            const resolved = await canonicalUserJidFromParts(socket, jid, undefined, null);
            if (resolved && isPnUser(resolved)) {
                jid = resolved;
            }
        }
    }

    console.log(`[SEND] Final JID for account ${account_id}: ${jid}`);
    
    try {
        const sent = await socket.sendMessage(jid, { text: message });
        const messageId = sent?.key?.id || null;
        const timestamp = Math.floor(Date.now() / 1000);
        console.log(`[SEND] SUCCESS for account ${account_id} -> ${jid}`);
        res.json({ status: 'success', jid, message_id: messageId, timestamp });
    } catch (error) {
        console.error(`[SEND] ERROR for account ${account_id}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Endpoint: Get sessions status
 */
app.get('/sessions', (req, res) => {
    const status = {};
    for (const [id, socket] of sessions) {
        status[id] = 'active';
    }
    res.json(status);
});

/**
 * Quick browser check endpoint
 */
app.get('/', (req, res) => {
    res.status(200).send('whatsapp-node is running');
});

/**
 * Health checks for Render and uptime monitoring
 */
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'whatsapp-node',
        active_sessions: sessions.size
    });
});

app.get('/healthz', (req, res) => {
    res.status(200).send('ok');
});

/**
 * Detailed runtime status endpoint
 */
app.get('/status', (req, res) => {
    res.status(200).json({
        status: 'running',
        service: 'whatsapp-node',
        boot_time: bootTime,
        now: new Date().toISOString(),
        active_sessions: sessions.size,
        uptime_seconds: Math.floor(process.uptime())
    });
});

// Start Express Server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, async () => {
    console.log(`Multi-Session WhatsApp Bridge running on port ${PORT}`);
    
    // AUTO-RESUME: Reconnect all accounts found in the sessions directory
    const sessionsDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        for (const folder of folders) {
            console.log(`[BOOT] Auto-resuming session: ${folder}`);
            await initSession(folder);
        }
    }
});

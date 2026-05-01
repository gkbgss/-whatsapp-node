/**
 * WhatsApp Multi-Session Bridge
 * Complete LID resolution fix — event-driven, not timed.
 *
 * Strategy:
 *  1. Persistent lidMap per session (never discarded)
 *  2. contacts.upsert is the PRIMARY source of LID→PN pairs (fires reliably after key exchange)
 *  3. History sync stores chats under @lid as placeholders, contacts.upsert patches them
 *  4. Live messages also patch the lidMap and trigger deferred placeholder resolution
 *  5. Multiple retry waves: 5s, 15s, 30s, 60s after history sync
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    isLidUser,
    isPnUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express  = require('express');
const axios    = require('axios');
const pino     = require('pino');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(express.json());
const bootTime = new Date().toISOString();


const LARAVEL_API_URL = process.env.LARAVEL_API_URL || 'https://myaibusinessagent.in/whatsapp-inbox/api';
const API = {
    qrStore:        `${LARAVEL_API_URL}/sessions/qr`,
    statusUpdate:   (id) => `${LARAVEL_API_URL}/accounts/${id}/status`,
    profileSync:    (id) => `${LARAVEL_API_URL}/accounts/${id}/sync-profile`,
    historySync:    `${LARAVEL_API_URL}/sync-history`,
    receiveMessage: `${LARAVEL_API_URL}/receive-message`,
    messageStatus:  `${LARAVEL_API_URL}/message-status`,
};

// ── Global stores ────────────────────────────────────────────────────────────
const sessions       = new Map();  // sessionId → socket
const autoReplyDedup = new Map();  // dedupKey  → expiresAt

// PERSISTENT LID→PN map per session. Never recreated, only grows.
// KEY INSIGHT: contacts.upsert is the most reliable source — it fires
// after WhatsApp completes key exchange and contains proper phone numbers.
const lidMaps = new Map(); // sessionId → Map<normalizedLidJid, normalizedPnJid>

// Unresolved @lid chat placeholders waiting to be patched when contacts arrive
const lidPlaceholders = new Map(); // sessionId → Map<lidJid, chatRowData>
const historyReady = new Set();    // sessionId that completed first history sync

// Retry timers for each session
const retryTimers = new Map(); // sessionId → [timeoutId, ...]
const syncFallbackTimers = new Map(); // sessionId -> timeoutId

function getLidMap(sid) {
    const k = String(sid);
    if (!lidMaps.has(k)) lidMaps.set(k, new Map());
    return lidMaps.get(k);
}
function getLidPlaceholders(sid) {
    const k = String(sid);
    if (!lidPlaceholders.has(k)) lidPlaceholders.set(k, new Map());
    return lidPlaceholders.get(k);
}
function clearRetryTimers(sid) {
    const k = String(sid);
    const timers = retryTimers.get(k) || [];
    timers.forEach(t => clearTimeout(t));
    retryTimers.delete(k);
}
function addRetryTimer(sid, fn, ms) {
    const k = String(sid);
    if (!retryTimers.has(k)) retryTimers.set(k, []);
    retryTimers.get(k).push(setTimeout(fn, ms));
}
function clearSyncFallbackTimer(sid) {
    const k = String(sid);
    const timer = syncFallbackTimers.get(k);
    if (timer) clearTimeout(timer);
    syncFallbackTimers.delete(k);
}
function scheduleSyncFallback(sessionId, sid, phoneNumber) {
    clearSyncFallbackTimer(sid);
    const timer = setTimeout(async () => {
        // If history callback did not arrive, still move out of syncing.
        if (historyReady.has(sid) || !sessions.has(sid)) return;
        try {
            await axios.patch(API.statusUpdate(sessionId), { status: 'active', phone_number: phoneNumber || null });
            historyReady.add(sid);
            console.log(`[STATUS] ${sid}: fallback activated, account marked active`);
        } catch (e) {
            console.error(`[STATUS] ${sid}: fallback active update failed - ${e.message}`);
        } finally {
            syncFallbackTimers.delete(sid);
        }
    }, 25000);
    syncFallbackTimers.set(String(sid), timer);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

const getMessageText = (m) => {
    const msg = m?.message;
    if (!msg) return null;
    if (msg.conversation)                             return msg.conversation;
    if (msg.extendedTextMessage)                      return msg.extendedTextMessage.text;
    if (msg.imageMessage)                             return msg.imageMessage.caption ? `📷 ${msg.imageMessage.caption}` : '📷 [PHOTO]';
    if (msg.videoMessage)                             return msg.videoMessage.caption ? `🎥 ${msg.videoMessage.caption}` : '🎥 [VIDEO]';
    if (msg.audioMessage)                             return '🎵 [AUDIO]';
    if (msg.documentMessage)                          return msg.documentMessage.fileName ? `📄 ${msg.documentMessage.fileName}` : '📄 [DOCUMENT]';
    if (msg.stickerMessage)                           return '😜 [STICKER]';
    if (msg.viewOnceMessageV2?.message?.imageMessage) return '📷 [VIEW ONCE PHOTO]';
    if (msg.viewOnceMessageV2?.message?.videoMessage) return '🎥 [VIEW ONCE VIDEO]';
    if (msg.reactionMessage)                          return `${msg.reactionMessage.text || '👍'} [REACTION]`;
    if (msg.pollCreationMessage)                      return `📊 [POLL] ${msg.pollCreationMessage.name || ''}`;
    if (msg.ephemeralMessage)                         return getMessageText({ message: msg.ephemeralMessage.message });
    if (msg.viewOnceMessage)                          return getMessageText({ message: msg.viewOnceMessage.message });
    return '[Media/Other]';
};

function safeNorm(jid) {
    if (!jid) return '';
    try { return jidNormalizedUser(jid); } catch (_) { return ''; }
}

function toPhoneJid(raw) {
    if (!raw) return null;
    const s = String(raw);
    if (s.includes('@')) return safeNorm(s);
    const d = s.replace(/\D/g, '');
    return d ? `${d}@s.whatsapp.net` : null;
}

/**
 * Feed LID↔PN pairs into the shared persistent map from any source.
 * Safe to call multiple times — just keeps adding/updating entries.
 */
function feedLidMap(lidMap, { contacts = [], messages = [], chats = [] }) {
    const add = (lid, pn) => {
        if (!lid || !pn) return;
        try {
            const l = safeNorm(lid);
            const p = toPhoneJid(pn);
            if (l && p && isLidUser(l) && isPnUser(p)) lidMap.set(l, p);
        } catch (_) {}
    };

    // Chats: pnJid field is the most authoritative source
    for (const ch of chats) {
        if (!ch) continue;
        if (ch.pnJid) {
            if (ch.lidJid) add(ch.lidJid, ch.pnJid);
            const id = safeNorm(ch.id || '');
            if (id && isLidUser(id)) add(ch.id, ch.pnJid);
        }
    }
    // Contacts: phoneNumber field
    for (const c of contacts) {
        if (!c?.phoneNumber) continue;
        if (c.lid) add(c.lid, c.phoneNumber);
        const id = safeNorm(c.id || '');
        if (id && isLidUser(id)) add(c.id, c.phoneNumber);
    }
    // Messages: remoteJid vs remoteJidAlt cross-pairing
    for (const m of messages) {
        if (!m?.key) continue;
        try {
            const r  = safeNorm(m.key.remoteJid    || '');
            const ra = safeNorm(m.key.remoteJidAlt || '');
            if (r && ra) {
                if (isLidUser(r)  && isPnUser(ra)) add(r, ra);
                if (isLidUser(ra) && isPnUser(r))  add(ra, r);
            }
        } catch (_) {}
    }
}

function resolveFromMap(lidMap, jid) {
    if (!jid) return null;
    try {
        const n = safeNorm(jid);
        if (!n || !isLidUser(n)) return null;
        const v = lidMap.get(n);
        return v || null;
    } catch (_) { return null; }
}

/**
 * THE main JID resolver.
 * Priority: persistent map → already a PN JID → signalRepository → give up (still @lid)
 */
async function resolveJid(socket, jid, jidAlt, lidMap) {
    // 1. Persistent map (O(1), covers 99% of cases after contacts arrive)
    const fromMap = resolveFromMap(lidMap, jid) || resolveFromMap(lidMap, jidAlt);
    if (fromMap) return fromMap;

    // 2. Already a phone JID
    const a = safeNorm(jid    || '');
    const b = safeNorm(jidAlt || '');
    if (a && isPnUser(a)) return a;
    if (b && isPnUser(b)) return b;

    // 3. signalRepository.lidMapping (async, may fail if called too early)
    for (const lid of [a, b]) {
        if (!lid || !isLidUser(lid)) continue;
        try {
            const pn = await socket.signalRepository.lidMapping.getPNForLID(lid);
            if (pn) {
                const resolved = safeNorm(pn);
                if (lidMap && isPnUser(resolved)) {
                    lidMap.set(lid, resolved); // cache back
                }
                return resolved;
            }
        } catch (_) {}
    }

    // 4. Still @lid — caller decides what to do
    return a || b || jid;
}

/**
 * POST a batch of conversations to Laravel, chunked to avoid huge payloads.
 */
async function postHistoryBatch(sessionId, conversations) {
    if (!conversations.length) return;
    const CHUNK = 50;
    for (let i = 0; i < conversations.length; i += CHUNK) {
        const chunk = conversations.slice(i, i + CHUNK);
        try {
            await axios.post(API.historySync, { account_id: sessionId, conversations: chunk });
        } catch (e) {
            console.error(`[HISTORY] batch post failed (chunk ${i}):`, e.message);
        }
    }
}

/**
 * Resolve all pending @lid placeholders using the current lidMap state.
 * Called on each retry wave and also when contacts.upsert fires.
 */
async function flushLidPlaceholders(sessionId, socket) {
    const placeholders = getLidPlaceholders(sessionId);
    if (!placeholders.size) return 0;

    const lidMap  = getLidMap(sessionId);
    const flushed = [];

    for (const [rawLid, row] of placeholders.entries()) {
        let resolved = resolveFromMap(lidMap, rawLid);

        if (!resolved) {
            // Try signalRepository on this flush attempt
            try {
                const pn = await socket.signalRepository.lidMapping.getPNForLID(rawLid).catch(() => null);
                if (pn) {
                    resolved = safeNorm(pn);
                    if (resolved && isPnUser(resolved)) {
                        lidMap.set(safeNorm(rawLid), resolved);
                    } else {
                        resolved = null;
                    }
                }
            } catch (_) {}
        }

        if (!resolved) continue; // still unresolved — leave in map

        // Fetch avatar now that we have the real JID
        let avatarUrl = row.avatar_url;
        if (!avatarUrl) {
            avatarUrl = await socket.profilePictureUrl(resolved, 'image').catch(() => null);
        }

        // Patch the row with the real JID
        const legacyIds = [...new Set([...(row.legacy_chat_ids || []), safeNorm(rawLid)])].filter(Boolean);
        flushed.push({ ...row, id: resolved, avatar_url: avatarUrl, legacy_chat_ids: legacyIds });
        placeholders.delete(rawLid);
    }

    if (flushed.length) {
        console.log(`[LID-FLUSH] Resolved ${flushed.length} placeholder(s) for session ${sessionId}`);
        await postHistoryBatch(sessionId, flushed);
    }

    return flushed.length;
}

// ── Session initialiser ───────────────────────────────────────────────────────
async function initSession(sessionId) {
    const sid = String(sessionId);
    console.log(`[SESSION] Initialising: ${sid}`);

    const sessionDir = path.join(__dirname, 'sessions', sid);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version }          = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger:  pino({ level: 'silent' }),
        browser: ['Windows', 'Chrome', '124.0.0'],
        getMessage: async () => undefined,
        syncFullHistory: true,
    });

    sessions.set(sid, socket);
    socket.ev.on('creds.update', saveCreds);

    // ── connection.update ────────────────────────────────────────────────────
    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log(`[QR] ${sid}`);
            try {
                await axios.post(API.qrStore, { account_id: sessionId, qr }, { timeout: 15000 });
                console.log(`[QR] Stored in Laravel for account ${sid}`);
            } catch (e) {
                const status = e?.response?.status ?? 'no-status';
                const body = e?.response?.data ?? e.message;
                console.error(`[QR] Failed to store for account ${sid} -> ${API.qrStore} | ${status} | ${JSON.stringify(body)}`);
            }
        }

        if (connection === 'close') {
            clearRetryTimers(sid);
            clearSyncFallbackTimer(sid);
            historyReady.delete(sid);
            const code = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error?.output?.statusCode : null;
            const reconnect = code !== DisconnectReason.loggedOut;
            console.log(`[SESSION] Closed ${sid}. Code: ${code}. Reconnect: ${reconnect}`);

            if (reconnect) {
                await delay(3000);
                initSession(sessionId);
            } else {
                sessions.delete(sid);
                lidMaps.delete(sid);
                lidPlaceholders.delete(sid);
                const dir = path.join(__dirname, 'sessions', sid);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
                try {
                    await axios.patch(API.statusUpdate(sessionId), { status: 'disconnected', phone_number: null });
                } catch (_) {}
            }
        } else if (connection === 'open') {
            console.log(`[SESSION] Connected: ${sid}`);
            const meJid = socket?.user?.id ? String(socket.user.id) : null;
            if (!meJid) {
                // Rare race after reconnect: connection opens before socket.user is hydrated.
                console.warn(`[SESSION] ${sid}: connected but user JID not ready; skipping profile sync.`);
                return;
            }
            const me = meJid.split(':')[0];
            const myName = socket?.user?.name || null;
            const myAvatar = await socket.profilePictureUrl(meJid, 'image').catch(() => null);
            try {
                await axios.post(API.profileSync(sessionId), { phone: me, user_name: myName, avatar_url: myAvatar });
                // Keep UI in "syncing" until first history batch lands.
                await axios.patch(API.statusUpdate(sessionId), { status: 'syncing', phone_number: me });
                scheduleSyncFallback(sessionId, sid, me);
            } catch (e) { console.error('[PROFILE]', e.message); }
        }
    });

    // ── contacts.upsert ──────────────────────────────────────────────────────
    // PRIMARY LID resolver. WhatsApp sends proper phone numbers here AFTER
    // the session key exchange is complete. This patches all @lid placeholders.
    socket.ev.on('contacts.upsert', async (contacts) => {
        const lidMap = getLidMap(sid);
        const before = lidMap.size;
        feedLidMap(lidMap, { contacts });
        const added = lidMap.size - before;

        console.log(`[CONTACTS] ${sid}: ${contacts.length} contacts upserted, +${added} new LID pairs. Total: ${lidMap.size}`);

        if (added > 0 || contacts.length > 0) {
            const flushed = await flushLidPlaceholders(sid, socket);
            if (flushed > 0) {
                console.log(`[CONTACTS] Flushed ${flushed} @lid chat(s) to real phone JIDs`);
            }
        }
    });

    // ── contacts.update ──────────────────────────────────────────────────────
    socket.ev.on('contacts.update', async (contacts) => {
        feedLidMap(getLidMap(sid), { contacts });
        await flushLidPlaceholders(sid, socket);
    });

    // ── chats.upsert ─────────────────────────────────────────────────────────
    socket.ev.on('chats.upsert', async (chats) => {
        feedLidMap(getLidMap(sid), { chats });
        await flushLidPlaceholders(sid, socket);
    });

    // ── chats.update ─────────────────────────────────────────────────────────
    socket.ev.on('chats.update', async (chats) => {
        feedLidMap(getLidMap(sid), { chats });
        await flushLidPlaceholders(sid, socket);
    });

    // ── messaging-history.set ────────────────────────────────────────────────
    socket.ev.on('messaging-history.set', async ({ chats, contacts, messages } = {}) => {

        const lidMap = getLidMap(sid);

        // Phase 1: Feed everything we have into the LID map
        feedLidMap(lidMap, { chats, contacts, messages });
        console.log(`[HISTORY] LID map: ${lidMap.size} entries after initial feed`);

        // Build name lookup table
        const nameMap = new Map();
        for (const c of contacts) {
            const name = c.name || c.notify || c.verifiedName || null;
            if (!name) continue;
            const id = safeNorm(c.id || '');
            if (id) nameMap.set(id, name);
            if (c.lid) nameMap.set(safeNorm(c.lid), name);
            const pn = toPhoneJid(c.phoneNumber);
            if (pn) nameMap.set(pn, name);
        }
        for (const ch of chats) {
            if (ch.name && ch.id) nameMap.set(safeNorm(ch.id), ch.name);
        }

        // Phase 2: Pre-resolve all message JIDs in batches
        const resolvedJidCache = new Map();
        const msgJids = [...new Set(messages.map(m => m?.key?.remoteJid).filter(Boolean))];
        for (let i = 0; i < msgJids.length; i += 20) {
            await Promise.all(msgJids.slice(i, i + 20).map(async (rawJid) => {
                const norm = safeNorm(rawJid);
                if (resolvedJidCache.has(norm)) return;
                const m = messages.find(x => x?.key?.remoteJid === rawJid);
                const canon = await resolveJid(socket, rawJid, m?.key?.remoteJidAlt, lidMap);
                resolvedJidCache.set(norm, canon);
            }));
        }

        // Phase 3: Group messages by canonical chat JID
        const msgsByCanon = new Map();
        for (const m of messages) {
            if (!m?.key?.remoteJid) continue;
            const norm  = safeNorm(m.key.remoteJid);
            const canon = resolvedJidCache.get(norm) || norm;
            if (!msgsByCanon.has(canon)) msgsByCanon.set(canon, []);
            msgsByCanon.get(canon).push(m);
        }

        // Phase 4: Process each DM chat
        const resolved   = [];
        const placeholds = [];

        const filteredChats = chats.filter(c =>
            c?.id &&
            !c.id.includes('status@broadcast') &&
            !c.id.includes('@newsletter') &&
            !c.id.includes('@broadcast')
        ).sort((a, b) => Number(b.conversationTimestamp || 0) - Number(a.conversationTimestamp || 0));

        for (const chat of filteredChats) {
            let canonId  = await resolveJid(socket, chat.id, undefined, lidMap);
            const chatNorm = safeNorm(chat.id);

            // Extra direct attempt via signalRepository
            if (isLidUser(safeNorm(canonId))) {
                try {
                    const pn = await socket.signalRepository.lidMapping.getPNForLID(chat.id).catch(() => null);
                    if (pn) {
                        canonId = safeNorm(pn);
                        lidMap.set(chatNorm, canonId);
                    }
                } catch (_) {}
            }

            const stillLid = isLidUser(safeNorm(canonId));

            // Collect messages
            const chatMsgs = [];
            const seen     = new Set();
            const allMsgs  = [
                ...(msgsByCanon.get(canonId)  || []),
                ...(msgsByCanon.get(chatNorm) || []),
            ];
            for (const m of allMsgs) {
                if (!m?.key?.id || seen.has(m.key.id)) continue;
                seen.add(m.key.id);
                chatMsgs.push({
                    id:        m.key.id,
                    fromMe:    m.key.fromMe || false,
                    text:      getMessageText(m) || '[Media/Other]',
                    timestamp: m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now() / 1000),
                });
            }
            chatMsgs.sort((a, b) => b.timestamp - a.timestamp);
            const topMsgs = chatMsgs.slice(0, 100);

            if (!topMsgs.length) {
                topMsgs.push({
                    id:        `placeholder-${chat.id}-${Date.now()}`,
                    fromMe:    false,
                    text:      chat.lastMessage ? (getMessageText(chat.lastMessage) || '[History syncing…]') : '[No messages synced]',
                    timestamp: chat.conversationTimestamp ? Number(chat.conversationTimestamp) : Math.floor(Date.now() / 1000),
                });
            }

            const latestTs = topMsgs[0].timestamp;
            const preview  = topMsgs[0].text;
            const legacyIds = (chatNorm && chatNorm !== canonId) ? [chatNorm] : [];

            // Skip avatar fetch for @lid (fetch when flushed, after we have the real JID)
            let avatarUrl = null;
            if (!stillLid) {
                avatarUrl = await socket.profilePictureUrl(canonId, 'image')
                    .catch(() => socket.profilePictureUrl(chat.id, 'image').catch(() => null));
            }

            const resolvedName = nameMap.get(chatNorm) || nameMap.get(canonId) || chat.name || chat.subject || null;

            const row = {
                id:                     canonId,
                legacy_chat_ids:        legacyIds,
                name:                   resolvedName,
                avatar_url:             avatarUrl,
                messages:               topMsgs,
                last_message_preview:   preview,
                latestMessageTimestamp: latestTs,
            };

            if (stillLid) {
                getLidPlaceholders(sid).set(chatNorm, row);
                placeholds.push(row);
            } else {
                resolved.push(row);
            }
        }

        // Merge duplicate canonical JIDs
        const mergeMap = new Map();
        for (const row of resolved.sort((a, b) => b.latestMessageTimestamp - a.latestMessageTimestamp)) {
            if (!mergeMap.has(row.id)) { mergeMap.set(row.id, row); continue; }
            const prev   = mergeMap.get(row.id);
            const seenMs = new Set(prev.messages.map(m => m.id));
            for (const m of row.messages) if (!seenMs.has(m.id)) { prev.messages.push(m); seenMs.add(m.id); }
            prev.messages.sort((a, b) => b.timestamp - a.timestamp);
            if (prev.messages.length > 100) prev.messages = prev.messages.slice(0, 100);
            if (row.latestMessageTimestamp > prev.latestMessageTimestamp) {
                prev.latestMessageTimestamp = row.latestMessageTimestamp;
                prev.last_message_preview   = row.last_message_preview;
            }
            if (row.name && !prev.name)             prev.name       = row.name;
            if (row.avatar_url && !prev.avatar_url) prev.avatar_url = row.avatar_url;
            prev.legacy_chat_ids = [...new Set([...(prev.legacy_chat_ids || []), ...(row.legacy_chat_ids || [])])];
        }

        const finalResolved = Array.from(mergeMap.values())
            .sort((a, b) => b.latestMessageTimestamp - a.latestMessageTimestamp);

        console.log(`[HISTORY] Posting: ${finalResolved.length} resolved | ${placeholds.length} @lid placeholders pending`);

        if (finalResolved.length) await postHistoryBatch(sessionId, finalResolved);

        // Mark active only after first history sync; this prevents empty UI right after QR.
        if (!historyReady.has(sid)) {
            historyReady.add(sid);
            clearSyncFallbackTimer(sid);
            try {
                const me = socket?.user?.id ? String(socket.user.id).split(':')[0] : null;
                await axios.patch(API.statusUpdate(sessionId), { status: 'active', phone_number: me });
                console.log(`[HISTORY] ${sid}: first sync done, account marked active`);
            } catch (e) {
                console.error(`[HISTORY] ${sid}: failed to mark active - ${e.message}`);
            }
        }

        // Schedule MULTIPLE retry waves for @lid placeholders
        if (placeholds.length) {
            console.log(`[LID-RETRY] ${placeholds.length} @lid chats queued. Retry waves: 5s, 15s, 30s, 60s`);
            const wave = (label) => async () => {
                const n = await flushLidPlaceholders(sid, socket);
                const rem = getLidPlaceholders(sid).size;
                console.log(`[LID-RETRY ${label}] Flushed: ${n} | Remaining: ${rem}`);
            };
            addRetryTimer(sid, wave('5s'),  5_000);
            addRetryTimer(sid, wave('15s'), 15_000);
            addRetryTimer(sid, wave('30s'), 30_000);
            addRetryTimer(sid, wave('60s'), 60_000);
        }
    });

    // ── messages.upsert ──────────────────────────────────────────────────────
    socket.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg    = m.messages[0];
        const rawJid = msg?.key?.remoteJid;
        if (!rawJid) return;
        if (rawJid === 'status@broadcast'  ||
            rawJid.includes('@newsletter') ||
            rawJid.includes('@broadcast'))  return;

        const text = getMessageText(msg);
        if (!text) return;

        const isFromMe = msg.key.fromMe;
        const isGroupChat = rawJid.includes('@g.us');
        const lidMap   = getLidMap(sid);

        // Cross-pair remoteJid/remoteJidAlt from this live message
        feedLidMap(lidMap, { messages: [msg] });

        const senderJid = await resolveJid(socket, msg.key.remoteJid, msg.key.remoteJidAlt, lidMap);

        // If this live message resolved an @lid, update map and flush placeholders
        const rawNorm = safeNorm(rawJid);
        if (isLidUser(rawNorm) && isPnUser(safeNorm(senderJid))) {
            lidMap.set(rawNorm, safeNorm(senderJid));
            flushLidPlaceholders(sid, socket).catch(() => {});
        }

        const pushName = msg.pushName || null;
        const effectiveContactName = (!isFromMe && !isGroupChat) ? pushName : null;
        let avatarUrl  = null;
        if (!isFromMe) {
            avatarUrl = await socket.profilePictureUrl(senderJid, 'image')
                .catch(() => socket.profilePictureUrl(rawJid, 'image').catch(() => null));
        }

        const tsSec = msg.messageTimestamp != null
            ? Number(msg.messageTimestamp)
            : Math.floor(Date.now() / 1000);

        console.log(`[MSG] ${sid} | ${isFromMe ? 'OUT' : 'IN'} | ${senderJid} | "${text.substring(0, 60)}"`);

        try {
            const response = await axios.post(API.receiveMessage, {
                account_id:        sessionId,
                phone:             senderJid,
                jid_raw:           rawJid,
                contact_name:      effectiveContactName,
                avatar_url:        avatarUrl,
                message:           text,
                whatsapp_id:       msg.key.id,
                message_timestamp: tsSec,
                is_from_me:        isFromMe,
            });

            // AI auto-reply
            if (!isFromMe && response.data.ai_reply) {
                const aiReply  = response.data.ai_reply;
                const dedupKey = `${sid}:${msg?.key?.id || `${rawJid}:${tsSec}`}`;
                const now      = Date.now();
                for (const [k, exp] of autoReplyDedup) if (exp <= now) autoReplyDedup.delete(k);
                if (autoReplyDedup.has(dedupKey)) return;
                autoReplyDedup.set(dedupKey, now + 15 * 60_000);

                await socket.readMessages([msg.key]);
                await delay(Math.min(Math.max(aiReply.length * 40, 3000), 8000));
                console.log(`[AUTO-REPLY] → ${senderJid}`);

                try { if (typeof socket.presenceObserve   === 'function') await socket.presenceObserve(senderJid); }   catch (_) {}
                try { if (typeof socket.sendPresenceUpdate === 'function') await socket.sendPresenceUpdate('composing', senderJid); } catch (_) {}
                await delay(Math.min(Math.max(aiReply.length * 50, 2000), 7000));
                try { if (typeof socket.sendPresenceUpdate === 'function') await socket.sendPresenceUpdate('paused', senderJid); } catch (_) {}

                const sentMsg = await socket.sendMessage(senderJid, { text: aiReply });

                try {
                    await axios.post(API.receiveMessage, {
                        account_id:        sessionId,
                        phone:             senderJid,
                        jid_raw:           rawJid,
                        contact_name:      effectiveContactName,
                        avatar_url:        avatarUrl,
                        message:           aiReply,
                        whatsapp_id:       sentMsg?.key?.id || null,
                        message_timestamp: Math.floor(Date.now() / 1000),
                        is_from_me:        true,
                    });
                } catch (e) { console.error('[AUTO-REPLY] persist failed:', e.message); }
            } else if (!isFromMe) {
                console.log(`[AUTO-REPLY] Skipped (${response?.data?.ai_skip_reason || 'none'})`);
            }
        } catch (err) {
            console.error('[MSG] Laravel error:', err.message);
        }
    });

    // ── messages.update (delivery/read receipts) ─────────────────────────────
    socket.ev.on('messages.update', async (updates) => {
        for (const update of updates || []) {
            const waId = update?.key?.id;
            if (!waId) continue;

            // Baileys status can come as numeric update.status/update.update?.status
            const rawAck =
                typeof update?.status === 'number'
                    ? update.status
                    : (typeof update?.update?.status === 'number' ? update.update.status : null);
            if (rawAck === null) continue;

            const ack = Math.max(0, Math.min(4, Number(rawAck)));
            try {
                await axios.post(API.messageStatus, {
                    account_id: sessionId,
                    whatsapp_id: waId,
                    ack,
                }, { timeout: 15000 });
            } catch (e) {
                console.error(`[ACK] Failed for ${waId}:`, e?.response?.data || e.message);
            }
        }
    });

    // ── Heartbeat ────────────────────────────────────────────────────────────
    const hb = setInterval(async () => {
        try { if (socket.user) await socket.groupFetchAllParticipating().catch(() => {}); } catch (_) {}
    }, 60_000);
    socket.ev.on('connection.update', ({ connection }) => {
        if (connection === 'close') clearInterval(hb);
    });

    return socket;
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.post('/sessions/:id', async (req, res) => {
    const id = req.params.id;
    if (sessions.has(id)) return res.json({ status: 'active', message: 'Already running' });
    try {
        await initSession(id);
        res.json({ status: 'initializing', message: 'Session started' });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.delete('/sessions/:id', async (req, res) => {
    const id   = req.params.id;
    const sock = sessions.get(id);
    if (sock) { try { sock.logout(); } catch (_) {} sessions.delete(id); }
    lidMaps.delete(id);
    lidPlaceholders.delete(id);
    clearRetryTimers(id);
    clearSyncFallbackTimer(id);
    historyReady.delete(id);
    const dir = path.join(__dirname, 'sessions', id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    res.json({ status: 'success', message: `Session ${id} deleted` });
});

app.post('/send-message', async (req, res) => {
    const { account_id, phone, message } = req.body;
    const sid = String(account_id);
    let socket = sessions.get(sid);
    if (!socket) {
        // Auto-recover: if in-memory session is missing, re-initialize from saved creds.
        try {
            await initSession(String(account_id));
            socket = sessions.get(String(account_id));
        } catch (e) {
            return res.status(500).json({ error: `Failed to recover session ${account_id}: ${e.message}` });
        }
    }
    if (!socket) {
        return res.status(503).json({ error: `Session ${account_id} is initializing. Please retry in a few seconds.` });
    }

    let jid = String(phone || '').trim();
    if (!jid.includes('@')) {
        jid = `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
    } else {
        jid = safeNorm(jid);
        if (isLidUser(jid)) {
            const r = await resolveJid(socket, jid, undefined, getLidMap(account_id));
            if (r && isPnUser(safeNorm(r))) jid = r;
        }
    }

    try {
        const sent = await socket.sendMessage(jid, { text: message });
        res.json({ status: 'success', jid, message_id: sent?.key?.id || null, timestamp: Math.floor(Date.now() / 1000) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Force-flush any remaining @lid placeholders
app.post('/sessions/:id/resync', async (req, res) => {
    const id   = req.params.id;
    const sock = sessions.get(id);
    if (!sock) return res.status(404).json({ error: 'Session not running' });
    const n = await flushLidPlaceholders(id, sock);
    res.json({ status: 'ok', flushed: n, remaining: getLidPlaceholders(id).size });
});

// Debug: inspect current LID map
app.get('/sessions/:id/lid-map', (req, res) => {
    const map = getLidMap(req.params.id);
    const out = {};
    for (const [k, v] of map) out[k] = v;
    res.json({ size: map.size, entries: out });
});

// Debug: inspect pending @lid placeholders
app.get('/sessions/:id/placeholders', (req, res) => {
    const pmap = getLidPlaceholders(req.params.id);
    const out  = [];
    for (const [k, v] of pmap) out.push({ lid: k, name: v.name, preview: v.last_message_preview });
    res.json({ count: pmap.size, placeholders: out });
});

app.get('/sessions', (req, res) => {
    const out = {};
    for (const [id] of sessions) out[id] = 'active';
    res.json(out);
});

app.get('/',        (_, res) => res.status(200).send('whatsapp-node is running'));
app.get('/health',  (_, res) => res.status(200).json({ status: 'ok', active_sessions: sessions.size }));
app.get('/healthz', (_, res) => res.status(200).send('ok'));
app.get('/status',  (_, res) => res.status(200).json({
    status: 'running', service: 'whatsapp-node',
    boot_time: bootTime, now: new Date().toISOString(),
    active_sessions: sessions.size, uptime_seconds: Math.floor(process.uptime()),
}));

// ── Boot ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, async () => {
    console.log(`[BOOT] WhatsApp Bridge on port ${PORT}`);
    const sessDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessDir)) {
        const folders = fs.readdirSync(sessDir)
            .filter(f => fs.statSync(path.join(sessDir, f)).isDirectory());
        for (const folder of folders) {
            console.log(`[BOOT] Resuming session: ${folder}`);
            await initSession(folder);
            await delay(2000);
        }
    }
});

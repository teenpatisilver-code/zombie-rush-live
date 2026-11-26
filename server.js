// Zombie Rush Live — bridge server
// Connects to your TikTok LIVE and forwards gifts / taps / follows / shares
// to the game page over WebSocket. Also serves the game from /public.
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// Coin values used if TikTok doesn't send the price with the gift.
const GIFT_COINS = { 'Rose': 1, 'TikTok': 1, 'Finger Heart': 5, 'Doughnut': 30, 'Hand Hearts': 100, 'Hand Heart': 100, 'Heart Me': 1, 'Money Gun': 500, 'Galaxy': 1000, 'Lion': 29999 };

const app = express();
const fs = require('fs');
// index.html can sit in /public or next to server.js (easier to upload from a phone)
const gamePage = () => { const p = path.join(__dirname, 'public', 'index.html'); return fs.existsSync(p) ? p : path.join(__dirname, 'index.html'); };
const findFile = name => { const p = path.join(__dirname, 'public', name); return fs.existsSync(p) ? p : path.join(__dirname, name); };
// Game menu is the home page; each game has its own address
app.get(['/', '/games', '/games.html'], (req, res) => res.sendFile(findFile('games.html')));
app.get(['/zombie', '/index.html'], (req, res) => res.sendFile(gamePage()));
app.get(['/race', '/race.html'], (req, res) => res.redirect('/'));
app.get(['/plinko', '/plinko.html'], (req, res) => res.sendFile(findFile('plinko.html')));
app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Natural commander voice (Google Cloud Text-to-Speech) ----------
// Set GOOGLE_TTS_KEY in Render > Environment. Optional TTS_VOICE (comma list, first that works is used).
const TTS_KEY = process.env.GOOGLE_TTS_KEY || '';
const TTS_VOICES = (process.env.TTS_VOICE || 'en-US-Chirp3-HD-Charon,en-US-Neural2-J,en-US-Wavenet-D').split(',').map(v => v.trim()).filter(Boolean);
const ttsCache = new Map();
let goodVoice = null;
// FREE default: Microsoft Edge "Read Aloud" neural voices (no key, no card; unofficial, may stop working someday)
const EDGE_VOICE = process.env.EDGE_VOICE || 'en-US-GuyNeural';
let edgeLib = null, edgeFails = 0;
const xmlEsc = t => t.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
async function edgeSpeak(text) {
  if (!edgeLib) edgeLib = await import('msedge-tts');
  const { MsEdgeTTS, OUTPUT_FORMAT } = edgeLib.MsEdgeTTS ? edgeLib : (edgeLib.default || edgeLib);
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const out = await tts.toStream(xmlEsc(text));
  const stream = out && out.audioStream ? out.audioStream : out;
  const buf = await new Promise((resolve, reject) => {
    const parts = []; const t = setTimeout(() => reject(new Error('edge timeout')), 10000);
    stream.on('data', d => parts.push(d));
    stream.on('close', () => { clearTimeout(t); resolve(Buffer.concat(parts)); });
    stream.on('end', () => { clearTimeout(t); resolve(Buffer.concat(parts)); });
    stream.on('error', e => { clearTimeout(t); reject(e); });
  });
  try { tts.close && tts.close(); } catch (e) {}
  if (!buf.length) throw new Error('edge returned no audio');
  return buf;
}
const ttsOn = () => !!TTS_KEY || edgeFails < 5;
app.get('/tts/status', (req, res) => res.json({ enabled: ttsOn(), voice: TTS_KEY ? (goodVoice || TTS_VOICES[0]) : EDGE_VOICE + ' (free)' }));
app.get('/tts', async (req, res) => {
  if (!ttsOn()) return res.status(404).end();
  const text = String(req.query.text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!text) return res.status(400).end();
  const send = buf => { res.set('Content-Type', 'audio/mpeg'); res.set('Cache-Control', 'public, max-age=86400'); res.send(buf); };
  if (ttsCache.has(text)) return send(ttsCache.get(text));
  const remember = buf => { if (ttsCache.size > 400) ttsCache.delete(ttsCache.keys().next().value); ttsCache.set(text, buf); };
  if (!TTS_KEY) {
    try { const buf = await edgeSpeak(text); edgeFails = 0; remember(buf); return send(buf); }
    catch (e) { edgeFails++; console.log('Free voice failed (' + edgeFails + '):', e.message); return res.status(502).end(); }
  }
  for (const name of (goodVoice ? [goodVoice] : TTS_VOICES)) {
    try {
      const languageCode = name.split('-').slice(0, 2).join('-');
      const audioConfig = { audioEncoding: 'MP3' };
      if (!/Chirp/i.test(name)) audioConfig.speakingRate = 1.05;
      const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(TTS_KEY), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text }, voice: { languageCode, name }, audioConfig })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.audioContent) { console.log('TTS voice failed:', name, j.error && j.error.message); continue; }
      goodVoice = name;
      const buf = Buffer.from(j.audioContent, 'base64');
      if (ttsCache.size > 400) ttsCache.delete(ttsCache.keys().next().value);
      ttsCache.set(text, buf);
      return send(buf);
    } catch (e) { console.log('TTS error:', e.message); }
  }
  res.status(502).end();
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let lib = null;          // tiktok-live-connector, loaded once
let tiktok = null;
let tiktokUser = '';
let connecting = false;
let lastAttempt = 0;
let giftList = [];       // official gift pictures from TikTok
const giftImg = {};
const imgOf = g => { const u = g?.giftImage?.giftPictureUrl || g?.giftPictureUrl || g?.image?.url_list?.[0] || g?.image?.urlList?.[0] || g?.icon?.url_list?.[0] || ''; return /^https:\/\//.test(u) ? u : ''; };
let lastStatus = { type: 'status', ok: false, msg: 'Bridge ready. Not connected to TikTok yet.' };

function broadcast(obj) {
  const s = JSON.stringify(obj);
  if (obj.type !== 'status' && obj.type !== 'join') console.log('EVENT', obj.type, obj.user || '', obj.giftName || '', obj.likeCount || '', '-> games open:', wss.clients.size);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
}
function status(ok, msg) {
  lastStatus = { type: 'status', ok, msg };
  console.log(msg);
  broadcast(lastStatus);
}
const pic = d => {
  const u = d.user || d, pp = u.profilePicture || u.avatarThumb || {};
  const v = (Array.isArray(pp.url) && pp.url[0]) || (Array.isArray(pp.urls) && pp.urls[0]) || (Array.isArray(pp.urlList) && pp.urlList[0]) || (Array.isArray(pp.url_list) && pp.url_list[0]) || (typeof pp.url === 'string' && pp.url) || u.profilePictureUrl || d.profilePictureUrl || '';
  return /^https:\/\//.test(v) ? v : '';
};
const who = d => ({ user: d.user?.uniqueId || d.uniqueId || '', nickname: d.user?.nickname || d.nickname || d.user?.uniqueId || 'Viewer', avatar: pic(d) });

async function connectTikTok(username) {
  username = String(username || '').replace(/^@/, '').trim();
  if (!username) return status(false, 'Enter your TikTok username.');
  // Already connected to this LIVE? Don't reconnect (saves sign-server quota).
  if (tiktok && tiktokUser === username) return status(true, `Already connected to @${username} LIVE. Gifts are on!`);
  if (connecting) return status(false, 'Connecting… please wait.');
  const wait = 20000 - (Date.now() - lastAttempt);
  if (wait > 0) return status(false, `Please wait ${Math.ceil(wait / 1000)} s before trying again (avoids the rate limit).`);
  lastAttempt = Date.now(); connecting = true;
  if (!lib) lib = await import('tiktok-live-connector');
  const L = lib.TikTokLiveConnection ? lib : (lib.default || lib);
  const TikTokLiveConnection = L.TikTokLiveConnection || L.WebcastPushConnection;
  const WE = L.WebcastEvent || {}, CE = L.ControlEvent || {};
  const ev = { gift: WE.GIFT || 'gift', like: WE.LIKE || 'like', follow: WE.FOLLOW || 'follow', share: WE.SHARE || 'share', chat: WE.CHAT || 'chat', end: WE.STREAM_END || 'streamEnd', disc: CE.DISCONNECTED || 'disconnected', err: CE.ERROR || 'error' };
  console.log('Event names:', JSON.stringify(ev));
  if (tiktok) { try { tiktok.disconnect(); } catch (e) {} tiktok = null; }

  status(false, `Connecting to @${username}… (you must be LIVE right now)`);
  const conn = new TikTokLiveConnection(username, {
    signApiKey: process.env.SIGN_API_KEY || undefined,
    enableExtendedGiftInfo: false // the gift-list download needs Euler's paid plan, so it stays off
  });
  try {
    const state = await conn.connect();
    tiktok = conn; tiktokUser = username; connecting = false;
    status(true, `Connected to @${username} LIVE (room ${state.roomId}). Gifts are on!`);
    // Gift pictures arrive with each gift and are collected as viewers send them.
  } catch (err) {
    connecting = false;
    return status(false, 'Could not connect: ' + (err && err.message ? err.message : err));
  }

  conn.on(ev.gift, d => {
    const giftType = d.giftDetails?.giftType ?? d.giftType;
    // Streak gifts (like Rose) fire many times; only count the final one.
    if (giftType === 1 && !d.repeatEnd) return;
    const giftName = d.giftDetails?.giftName || d.extendedGiftInfo?.name || d.giftName || 'Gift';
    const coins = d.giftDetails?.diamondCount || d.extendedGiftInfo?.diamond_count || d.diamondCount || GIFT_COINS[giftName] || 1;
    const img = imgOf(d.giftDetails) || imgOf(d) || giftImg[giftName] || '';
    if (img && !giftImg[giftName]) { giftImg[giftName] = img; giftList.push({ name: giftName, coins, img }); broadcast({ type: 'giftlist', gifts: giftList }); }
    broadcast({ type: 'gift', ...who(d), giftName, giftId: d.giftId, repeatCount: d.repeatCount || 1, diamondCount: coins, img });
  });
  conn.on(ev.like, d => broadcast({ type: 'like', ...who(d), likeCount: d.likeCount || 1 }));
  conn.on(ev.follow, d => broadcast({ type: 'follow', ...who(d) }));
  conn.on(ev.share, d => broadcast({ type: 'share', ...who(d) }));
  conn.on(WE.MEMBER || 'member', d => broadcast({ type: 'join', ...who(d) }));
  conn.on(ev.chat, d => broadcast({ type: 'chat', ...who(d), comment: String(d.comment || '').slice(0, 80) }));
  // Diagnostics: count every message type TikTok sends (shows if likes arrive at all)
  const seen = {};
  conn.on(CE.RAW_DATA || 'rawData', (type) => { seen[type] = (seen[type] || 0) + 1; });
  const tick = setInterval(() => { if (tiktok !== conn) return clearInterval(tick); const k = Object.keys(seen); if (k.length) { console.log('TikTok messages (last 30 s):', JSON.stringify(seen)); k.forEach(x => delete seen[x]); } }, 30000);
  conn.on(ev.err, e => console.log('TikTok error:', e && (e.message || e.info || e)));
  conn.on(ev.end, () => { tiktok = null; tiktokUser = ''; status(false, 'Your LIVE ended.'); });
  conn.on(ev.disc, () => { if (tiktok === conn) { tiktok = null; tiktokUser = ''; } status(false, 'Disconnected from TikTok. Tap Connect LIVE again.'); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify(lastStatus));
  if (giftList.length) ws.send(JSON.stringify({ type: 'giftlist', gifts: giftList }));
  ws.on('message', m => {
    try {
      const o = JSON.parse(m);
      if (o.type === 'ping') return; // heartbeat from the game keeps free hosts awake
      if (o.type === 'connect') connectTikTok(o.username).catch(e => status(false, 'Error: ' + e.message));
    } catch (e) {}
  });
});

if (process.env.TIKTOK_USERNAME) connectTikTok(process.env.TIKTOK_USERNAME).catch(e => status(false, 'Error: ' + e.message));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Zombie Rush Live running on port ' + PORT));

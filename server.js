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
app.get(['/', '/index.html'], (req, res) => res.sendFile(gamePage()));
app.get('/healthz', (req, res) => res.send('ok'));
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
  if (obj.type !== 'status') console.log('EVENT', obj.type, obj.user || '', obj.giftName || '', obj.likeCount || '', '-> games open:', wss.clients.size);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(s); });
}
function status(ok, msg) {
  lastStatus = { type: 'status', ok, msg };
  console.log(msg);
  broadcast(lastStatus);
}
const who = d => ({ user: d.user?.uniqueId || d.uniqueId || '', nickname: d.user?.nickname || d.nickname || d.user?.uniqueId || 'Viewer' });

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
  conn.on(ev.chat, d => broadcast({ type: 'chat', ...who(d), comment: String(d.comment || '').slice(0, 80) }));
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

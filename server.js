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
let giftList = [];       // official gift pictures from TikTok
const giftImg = {};
const imgOf = g => { const u = g?.image?.url_list?.[0] || g?.image?.urlList?.[0] || g?.icon?.url_list?.[0] || ''; return /^https:\/\//.test(u) ? u : ''; };
let lastStatus = { type: 'status', ok: false, msg: 'Bridge ready. Not connected to TikTok yet.' };

function broadcast(obj) {
  const s = JSON.stringify(obj);
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
  if (!lib) lib = await import('tiktok-live-connector');
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;
  if (tiktok) { try { tiktok.disconnect(); } catch (e) {} tiktok = null; }

  status(false, `Connecting to @${username}… (you must be LIVE right now)`);
  const conn = new TikTokLiveConnection(username, {
    signApiKey: process.env.SIGN_API_KEY || undefined,
    enableExtendedGiftInfo: true
  });
  try {
    const state = await conn.connect();
    tiktok = conn;
    status(true, `Connected to @${username} LIVE (room ${state.roomId}). Gifts are on!`);
    try {
      const fetchGifts = conn.fetchAvailableGifts || conn.getAvailableGifts;
      const list = fetchGifts ? await fetchGifts.call(conn) : [];
      giftList = (Array.isArray(list) ? list : []).map(g => ({ name: g.name, coins: g.diamond_count ?? g.diamondCount, img: imgOf(g) })).filter(g => g.name && g.img);
      giftList.forEach(g => { giftImg[g.name] = g.img; });
      broadcast({ type: 'giftlist', gifts: giftList });
      console.log(`Loaded ${giftList.length} gift pictures from TikTok`);
    } catch (e) { console.log('Could not load gift pictures: ' + e.message); }
  } catch (err) {
    return status(false, 'Could not connect: ' + (err && err.message ? err.message : err));
  }

  conn.on(WebcastEvent.GIFT, d => {
    const giftType = d.giftDetails?.giftType ?? d.giftType;
    // Streak gifts (like Rose) fire many times; only count the final one.
    if (giftType === 1 && !d.repeatEnd) return;
    const giftName = d.giftDetails?.giftName || d.extendedGiftInfo?.name || d.giftName || 'Gift';
    const coins = d.giftDetails?.diamondCount || d.extendedGiftInfo?.diamond_count || d.diamondCount || GIFT_COINS[giftName] || 1;
    const img = imgOf(d.extendedGiftInfo) || imgOf(d.giftDetails) || giftImg[giftName] || '';
    broadcast({ type: 'gift', ...who(d), giftName, giftId: d.giftId, repeatCount: d.repeatCount || 1, diamondCount: coins, img });
  });
  conn.on(WebcastEvent.LIKE, d => broadcast({ type: 'like', ...who(d), likeCount: d.likeCount || 1 }));
  conn.on(WebcastEvent.FOLLOW, d => broadcast({ type: 'follow', ...who(d) }));
  conn.on(WebcastEvent.SHARE, d => broadcast({ type: 'share', ...who(d) }));
  conn.on(WebcastEvent.STREAM_END, () => status(false, 'Your LIVE ended.'));
  conn.on(ControlEvent.DISCONNECTED, () => status(false, 'Disconnected from TikTok. Tap Connect LIVE again.'));
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

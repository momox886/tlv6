// Vue 2D : reçoit le flux, le décode et l'affiche, avec un tableau de bord de latence.
// C'est l'outil de diagnostic : si cette page est fluide et à faible latence, le
// casque le sera aussi (même code de réception).

import { LowLatencyPlayer } from './player.js';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false });

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const logEl = el('log');

function log(message) {
  const line = `${new Date().toLocaleTimeString()}  ${message}\n`;
  logEl.textContent = (line + logEl.textContent).slice(0, 4000);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `pill ${kind}`;
}

// Deux buffers annexes pour le mode anaglyphe (rouge/cyan).
const leftBuf = document.createElement('canvas');
const rightBuf = document.createElement('canvas');
const leftCtx = leftBuf.getContext('2d');
const rightCtx = rightBuf.getContext('2d');

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const player = new LowLatencyPlayer(`${wsProtocol}//${location.host}/ws`, { onFrame: draw });

let mode = 'sbs';

function draw(frame) {
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  const half = Math.round(w / 2);

  if (mode === 'sbs') {
    setCanvasSize(w, h);
    ctx.drawImage(frame, 0, 0, w, h);
    return;
  }

  if (mode === 'left' || mode === 'right') {
    setCanvasSize(half, h);
    const sx = mode === 'left' ? 0 : half;
    ctx.drawImage(frame, sx, 0, half, h, 0, 0, half, h);
    return;
  }

  if (mode === 'anaglyphe') {
    setCanvasSize(half, h);
    // Gauche en rouge, droite en cyan, puis addition : là où les deux se
    // superposent l'image paraît neutre, sinon on perçoit le décalage -> relief.
    tint(leftBuf, leftCtx, frame, 0, '#ff0000');
    tint(rightBuf, rightCtx, frame, half, '#00ffff');
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(leftBuf, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(rightBuf, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function tint(buffer, bufferCtx, frame, sx, color) {
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  const half = Math.round(w / 2);
  if (buffer.width !== half || buffer.height !== h) {
    buffer.width = half;
    buffer.height = h;
  }
  bufferCtx.globalCompositeOperation = 'source-over';
  bufferCtx.drawImage(frame, sx, 0, half, h, 0, 0, half, h);
  bufferCtx.globalCompositeOperation = 'multiply';
  bufferCtx.fillStyle = color;
  bufferCtx.fillRect(0, 0, half, h);
  bufferCtx.globalCompositeOperation = 'source-over';
}

function setCanvasSize(w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

// ---------- Événements du lecteur ----------

player.addEventListener('open', () => {
  setStatus('connecté', 'ok');
  log('WebSocket connecté');
});
player.addEventListener('close', () => {
  setStatus('déconnecté', 'bad');
  log('WebSocket fermé — rechargez la page');
});
player.addEventListener('configured', (e) => {
  const { codec, width, height, fps, stereo } = e.detail;
  el('codec').textContent = codec;
  el('size').textContent = `${width}×${height} @ ${fps}`;
  el('stereo').textContent = stereo === 'sbs' ? 'côte à côte' : 'mono';
  setStatus('flux actif', 'ok');
  log(`Décodeur configuré : ${codec} ${width}×${height}`);
});
player.addEventListener('decodeerror', (e) => log('Erreur de décodage : ' + (e.detail?.message ?? e.detail)));
player.addEventListener('fatal', (e) => {
  setStatus('erreur', 'bad');
  log('Fatal : ' + e.detail);
});
player.addEventListener('drop', () => {
  /* comptabilisé dans le tableau de bord */
});

el('eye').addEventListener('change', (e) => {
  mode = e.target.value;
});
el('resync').addEventListener('click', () => {
  player.requestKeyframe();
  log('Image clé demandée');
});

setInterval(() => {
  el('oneWay').textContent = player.oneWayMs.toFixed(1);
  el('rtt').textContent = player.rttMs.toFixed(1);
  el('present').textContent = player.presentMs.toFixed(1);
  el('fps').textContent = player.fps.toFixed(1);
  el('dropped').textContent = String(player.framesDropped);
  el('errors').textContent = String(player.decodeErrors);
}, 250);

player.connect().catch((err) => {
  setStatus('erreur', 'bad');
  log(String(err.message ?? err));
});

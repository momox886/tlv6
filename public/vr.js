// Immersion VR : le flux stéréo est décodé par WebCodecs puis projeté dans une
// scène WebXR. Chaque œil reçoit sa moitié de l'image -> sensation de relief.

import { LowLatencyPlayer } from './player.js';
import { StereoRenderer } from './vr-renderer.js';
import { identity, perspective } from './xr-math.js';

const canvas = document.getElementById('canvas');
const overlay = document.getElementById('overlay');
const el = (id) => document.getElementById(id);
const logEl = el('log');

function log(message) {
  logEl.textContent = `${new Date().toLocaleTimeString()}  ${message}\n` + logEl.textContent.slice(0, 4000);
}
function setStatus(text, kind) {
  el('status').textContent = text;
  el('status').className = `pill ${kind}`;
}

// WebCodecs et WebXR n'existent que dans un « contexte sécurisé ».
if (!window.isSecureContext) {
  log(
    `Origine NON sécurisée (${location.origin}) : WebCodecs et WebXR sont bloqués. ` +
      'Passez en HTTPS (ou http://localhost).',
  );
}

const renderer = new StereoRenderer(canvas, { mode: 'screen', vfovDeg: 60, distance: 2, stereo: 'sbs' });

let player = null;
let xrSession = null;
let xrRefSpace = null;
let framebufferScale = 1;

// ---------- Rendu hors casque (aperçu sur l'écran du PC) ----------

function resizePreview() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(640, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(360, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function renderPreview() {
  if (xrSession || !renderer.hasFrame) return;
  resizePreview();
  const gl = renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  renderer.clear();

  const eyeWidth = canvas.width / 2;
  const aspect = eyeWidth / canvas.height;
  const projection = perspective((renderer.settings.vfovDeg * Math.PI) / 180, aspect, 0.01, 100);
  const view = identity();

  gl.viewport(0, 0, eyeWidth, canvas.height);
  renderer.renderEye('left', projection, view);
  gl.viewport(eyeWidth, 0, eyeWidth, canvas.height);
  renderer.renderEye('right', projection, view);
}

function loopPreview() {
  renderPreview();
  requestAnimationFrame(loopPreview);
}

// ---------- Boucle WebXR ----------

function onXRFrame(time, frame) {
  xrSession.requestAnimationFrame(onXRFrame);
  const pose = frame.getViewerPose(xrRefSpace);
  const layer = xrSession.renderState.baseLayer;

  const gl = renderer.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  renderer.clear();

  if (!pose) return;

  for (const view of pose.views) {
    const viewport = layer.getViewport(view);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.renderEye(view.eye, view.projectionMatrix, view.transform.matrix);
  }
}

// ---------- Session immersive ----------

async function checkXrSupport() {
  if (!navigator.xr) {
    el('enterVr').disabled = true;
    el('overlayHint').textContent =
      "WebXR indisponible. Ouvre la page en HTTPS (certificat auto-signé) ou autorise cette origine via chrome://flags sur le casque.";
    return false;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-vr');
  if (!supported) {
    el('enterVr').disabled = true;
    el('overlayHint').textContent = "Ce casque/navigateur ne propose pas de session immersive-vr.";
  }
  return supported;
}

async function enterVR() {
  try {
    xrSession = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'layers'],
    });

    await renderer.gl.makeXRCompatible();
    xrSession.updateRenderState({
      baseLayer: new XRWebGLLayer(xrSession, renderer.gl, { framebufferScaleFactor: framebufferScale }),
    });

    xrRefSpace = await xrSession.requestReferenceSpace('local');
    xrSession.addEventListener('end', onSessionEnd);
    xrSession.requestAnimationFrame(onXRFrame);

    overlay.classList.add('hidden');
    log('Session VR démarrée');
  } catch (err) {
    log('Entrée en VR impossible : ' + err.message);
  }
}

function onSessionEnd() {
  xrSession = null;
  xrRefSpace = null;
  overlay.classList.remove('hidden');
  log('Session VR terminée');
}

// ---------- Contrôles ----------

el('enterVr').addEventListener('click', enterVR);

el('mode').addEventListener('change', (e) => {
  renderer.setSettings({ mode: e.target.value });
});
el('vfov').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  el('vfovValue').textContent = `${value}°`;
  renderer.setSettings({ vfovDeg: value });
});
el('distance').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  el('distanceValue').textContent = `${value.toFixed(1)} m`;
  renderer.setSettings({ distance: value });
});
el('stereo').addEventListener('change', (e) => {
  renderer.setSettings({ stereo: e.target.value });
});
el('swapEyes').addEventListener('change', (e) => {
  renderer.setSettings({ swapEyes: e.target.checked });
});
el('scale').addEventListener('input', (e) => {
  framebufferScale = Number(e.target.value);
  el('scaleValue').textContent = framebufferScale.toFixed(1);
  if (xrSession) {
    xrSession.updateRenderState({
      baseLayer: new XRWebGLLayer(xrSession, renderer.gl, { framebufferScaleFactor: framebufferScale }),
    });
  }
});

// ---------- Flux ----------

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
player = new LowLatencyPlayer(`${wsProtocol}//${location.host}/ws`, {
  onFrame: (frame) => {
    renderer.updateFrame(frame);
    if (xrSession) return; // en VR, c'est la boucle XR qui dessine
  },
});

player.addEventListener('open', () => setStatus('connecté', 'ok'));
player.addEventListener('close', () => setStatus('déconnecté', 'bad'));
player.addEventListener('configured', (e) => {
  setStatus('flux actif', 'ok');
  log(`Décodeur : ${e.detail.codec} ${e.detail.width}×${e.detail.height} — ${e.detail.stereo}`);
  renderer.setSettings({ stereo: e.detail.stereo });
});
player.addEventListener('fatal', (e) => {
  setStatus('erreur', 'bad');
  log('Fatal : ' + e.detail);
});
player.addEventListener('decodeerror', (e) => log('Erreur décodage : ' + (e.detail?.message ?? e.detail)));
player.addEventListener('fatal', (e) => {
  setStatus('erreur', 'bad');
  log('Fatal : ' + e.detail);
});

// Même diagnostic que la vue 2D, mais affiché dans le casque.
player.addEventListener('stalled', async (e) => {
  setStatus('aucune image', 'bad');
  log("Rien ne s'affiche — " + e.detail);
  try {
    const s = await (await fetch('/stats')).json();
    log(`Côté serveur : ${s.frames} image(s), codec=${s.codec ?? 'inconnu'}, clients=${s.clients}`);
  } catch {
    /* sans importance */
  }
});

setInterval(() => {
  el('oneWay').textContent = player.oneWayMs.toFixed(1);
  el('rtt').textContent = player.rttMs.toFixed(1);
  el('present').textContent = player.presentMs.toFixed(1);
  el('fps').textContent = player.fps.toFixed(1);
  el('dropped').textContent = String(player.framesDropped);
  el('latencyBadge').textContent =
    `${player.oneWayMs.toFixed(0)} ms + ${player.presentMs.toFixed(0)} ms = ` +
    `${(player.oneWayMs + player.presentMs).toFixed(0)} ms`;
}, 250);

checkXrSupport();
loopPreview();
player.connect().catch((err) => {
  setStatus('erreur', 'bad');
  log(String(err.message ?? err));
});

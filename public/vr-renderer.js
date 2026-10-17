// Rendu stéréo : une seule image décodée (côte-à-côte) est envoyée à la carte
// graphique, puis chaque œil échantillonne SA moitié.
//
// Deux géométries disponibles :
//   - « screen » : un grand écran plan devant vous. Le plus fidèle si la caméra
//     n'est pas grand-angle ;
//   - « vr180 »  : un dôme de 180° (projection équirectangulaire) : on peut
//     tourner la tête pour regarder autour, comme dans une vidéo VR180.

import { identity, multiply, translationScale } from './xr-math.js';

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec2 aUv;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTexture;
uniform vec4 uWindow;   // x, y, largeur, hauteur (dans l'image côte-à-côte)
varying vec2 vUv;
void main() {
  vec2 uv = uWindow.xy + vUv * uWindow.zw;
  gl_FragColor = vec4(texture2D(uTexture, uv).rgb, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Compilation du shader : ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}

/** Quad unitaire dans le plan XY, centré sur l'origine. */
function quadGeometry() {
  const pos = [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0];
  const uv = [0, 0, 1, 0, 0, 1, 1, 1];
  const idx = [0, 2, 1, 1, 2, 3];
  return { pos, uv, idx };
}

/** Dôme / calotte sphérique : projection équirectangulaire sur `hfovDeg` × `vfovDeg`. */
function domeGeometry(radius, hfovDeg, vfovDeg, segU = 64, segV = 32) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j <= segV; j++) {
    const v = j / segV;
    const lat = ((vfovDeg / 2) * (1 - 2 * v) * Math.PI) / 180;
    const y = Math.sin(lat);
    const r = Math.cos(lat);
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const lon = ((u - 0.5) * hfovDeg * Math.PI) / 180;
      pos.push(r * Math.sin(lon) * radius, y * radius, -r * Math.cos(lon) * radius);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + 1;
      const c = a + segU + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { pos, uv, idx };
}

export class StereoRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    const attributes = { xrCompatible: true, alpha: false, antialias: false, depth: false };
    this.gl = canvas.getContext('webgl2', attributes) || canvas.getContext('webgl', attributes);
    if (!this.gl) throw new Error('WebGL indisponible dans ce navigateur.');

    this.settings = {
      mode: options.mode ?? 'screen',
      vfovDeg: options.vfovDeg ?? 60,
      distance: options.distance ?? 2,
      stereo: options.stereo ?? 'sbs',
      swapEyes: options.swapEyes ?? false,
    };

    this.aspect = 2; // (largeur/2) / hauteur — mis à jour à la première image
    this.hasFrame = false;
    this._initProgram();
    this._initTexture();
    this._buildMeshes();
  }

  _initProgram() {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Édition de liens du programme : ' + gl.getProgramInfoLog(program));
    }
    this.program = program;
    this.attributes = {
      position: gl.getAttribLocation(program, 'aPosition'),
      uv: gl.getAttribLocation(program, 'aUv'),
    };
    this.uniforms = {
      projection: gl.getUniformLocation(program, 'uProjection'),
      view: gl.getUniformLocation(program, 'uView'),
      model: gl.getUniformLocation(program, 'uModel'),
      texture: gl.getUniformLocation(program, 'uTexture'),
      window: gl.getUniformLocation(program, 'uWindow'),
    };
  }

  _initTexture() {
    const gl = this.gl;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // CLAMP_TO_EDGE + LINEAR : indispensable, la texture est NPOT (2560×960).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _buildMeshes() {
    this.quad = this._uploadMesh(quadGeometry());
    this.dome = this._uploadMesh(domeGeometry(12, 180, 90, 96, 48));
    this.mesh = this.settings.mode === 'vr180' ? this.dome : this.quad;
  }

  _uploadMesh({ pos, uv, idx }) {
    const gl = this.gl;
    const position = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);

    const texCoord = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoord);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);

    const index = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

    return { position, texCoord, index, count: idx.length };
  }

  setSettings(partial) {
    Object.assign(this.settings, partial);
    this.mesh = this.settings.mode === 'vr180' ? this.dome : this.quad;
  }

  updateFrame(frame) {
    const gl = this.gl;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    this.aspect = width / 2 / height;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    this.hasFrame = true;
  }

  _modelMatrix() {
    if (this.settings.mode === 'vr180') return identity();
    const distance = this.settings.distance;
    const halfHeight = distance * Math.tan((this.settings.vfovDeg * Math.PI) / 360);
    const height = halfHeight * 2;
    const width = height * this.aspect;
    return translationScale(0, 0, -distance, width, height, 1);
  }

  _bindMesh() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.position);
    gl.enableVertexAttribArray(this.attributes.position);
    gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh.texCoord);
    gl.enableVertexAttribArray(this.attributes.uv);
    gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.mesh.index);
  }

  /** Dessine un œil ('left' | 'right') dans le viewport courant. */
  renderEye(eye, projection, view) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.projection, false, projection);
    gl.uniformMatrix4fv(this.uniforms.view, false, view);
    gl.uniformMatrix4fv(this.uniforms.model, false, this._modelMatrix());

    const single = this.settings.stereo !== 'sbs';
    // L'ordre des yeux dans une image côte-à-côte varie d'un fabricant à l'autre :
    // d'où l'option `swapEyes`.
    const isRightEye = eye === 'right';
    const useRightHalf = this.settings.swapEyes ? !isRightEye : isRightEye;
    const x = single || !useRightHalf ? 0 : 0.5;
    gl.uniform4f(this.uniforms.window, x, 0, 0.5, 1);

    gl.uniform1i(this.uniforms.texture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    this._bindMesh();
    gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0.02, 0.02, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

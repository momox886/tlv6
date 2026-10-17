// ---------------------------------------------------------------------------
// Analyse d'un flux H.264 brut « Annex B ».
//
// Rappel : en Annex B, chaque unité NAL (Network Abstraction Layer) est précédée
// d'un « start code » valant 00 00 01 ou 00 00 00 01. Une image complète (appelée
// « access unit », AU) regroupe plusieurs NAL : SPS, PPS, éventuellement SEI, puis
// une (ou plusieurs) tranche(s) de macroblocs (VCL).
//
// Le navigateur (WebCodecs) attend exactement une AU par EncodedVideoChunk.
// Ce module transforme donc le flux continu de ffmpeg en une suite d'AU.
// ---------------------------------------------------------------------------

export const NAL = { SLICE: 1, IDR: 5, SEI: 6, SPS: 7, PPS: 8, AUD: 9 };

/** Repère tous les « start codes » d'un buffer. */
export function findStartCodes(buf) {
  const out = [];
  const n = buf.length;
  for (let i = 0; i + 3 <= n; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1) {
      out.push({ start: i, codeLen: 3 });
      i += 2;
      continue;
    }
    if (i + 4 <= n && buf[i + 2] === 0 && buf[i + 3] === 1) {
      out.push({ start: i, codeLen: 4 });
      i += 3;
    }
  }
  return out;
}

/** Retire les octets anti-émulation (00 00 03 -> 00 00). */
function toRbsp(data) {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out[n++] = 0;
      out[n++] = 0;
      i += 2;
      continue;
    }
    out[n++] = data[i];
  }
  return out.subarray(0, n);
}

/**
 * Lit `first_mb_in_slice` (code Exp-Golomb non signé) au début d'une tranche.
 * Vaut 0 lorsqu'on commence une nouvelle image : c'est le signal de découpage
 * de secours quand le flux ne contient pas de délimiteur d'AU (NAL type 9).
 */
function readFirstMbInSlice(nalWithHeader) {
  const b = toRbsp(nalWithHeader.subarray(1)); // on saute l'octet d'en-tête NAL
  const totalBits = b.length * 8;
  const nextBit = (i) => (b[i >> 3] >> (7 - (i & 7))) & 1;
  let bit = 0;
  let zeros = 0;
  while (bit < totalBits && nextBit(bit) === 0) {
    zeros++;
    bit++;
  }
  if (bit >= totalBits) return 0; // flux tronqué : on considère que c'est le début
  bit++; // on consomme le « 1 » du code
  let val = 0;
  for (let k = 0; k < zeros; k++) {
    val = (val << 1) | nextBit(bit);
    bit++;
  }
  return (1 << zeros) - 1 + val;
}

/**
 * Découpe un flux Annex B en access units.
 * @param {(au: Buffer) => void} onAccessUnit appelé pour chaque image complète.
 */
export class AnnexBSplitter {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit;
    this.buffer = Buffer.alloc(0);
    this.current = [];
    this.usesAud = false;
    this.hasVcl = false;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, buf]) : buf;

    const codes = findStartCodes(this.buffer);
    if (codes.length === 0) return;

    // On ne peut émettre que les NAL *suivis* d'un autre start code : le dernier
    // est potentiellement incomplet, on le garde pour le prochain `push`.
    for (let i = 1; i < codes.length; i++) {
      this.#nal(this.buffer.subarray(codes[i - 1].start, codes[i].start), codes[i - 1].codeLen);
    }
    this.buffer = this.buffer.subarray(codes[codes.length - 1].start);
  }

  #nal(nal, codeLen) {
    const type = nal[codeLen] & 0x1f;

    if (type === NAL.AUD) {
      this.usesAud = true;
      this.#flush();
      this.current.push(nal);
      return;
    }

    // Découpage de secours si le flux n'embarque pas de délimiteur d'AU.
    if (!this.usesAud && this.hasVcl) {
      const newPicture =
        type === NAL.SPS ||
        type === NAL.PPS ||
        type === NAL.SEI ||
        (type >= 1 && type <= 5 && readFirstMbInSlice(nal.subarray(codeLen)) === 0);
      if (newPicture) this.#flush();
    }

    if (type >= 1 && type <= 5) this.hasVcl = true;
    this.current.push(nal);
  }

  /**
   * Force l'émission de l'image en cours. Utile en fin de flux (lecture d'un
   * fichier) : la toute dernière image reste sinon dans le tampon, faute de
   * start code suivant pour la délimiter.
   */
  flush() {
    this.#flush();
    this.buffer = Buffer.alloc(0);
  }

  #flush() {
    if (this.current.length === 0) return;
    const au = Buffer.concat(this.current);
    this.current = [];
    this.hasVcl = false;
    this.onAccessUnit(au);
  }
}

/**
 * Analyse une access unit : est-ce une image clé ? Quel est le codec exact ?
 * Le codec est déduit du SPS (profile_idc / contraintes / level_idc) et sert à
 * construire la chaîne `avc1.PPCCLL` attendue par WebCodecs.
 */
export function scanAccessUnit(au) {
  const codes = findStartCodes(au);
  let isKey = false;
  let codec = null;

  for (let i = 0; i < codes.length; i++) {
    const { start, codeLen } = codes[i];
    const end = i + 1 < codes.length ? codes[i + 1].start : au.length;
    const type = au[start + codeLen] & 0x1f;

    if (type === NAL.IDR) {
      isKey = true;
    } else if (type === NAL.SPS && !codec && end - start >= codeLen + 4) {
      const profile = au[start + codeLen + 1];
      const constraints = au[start + codeLen + 2];
      const level = au[start + codeLen + 3];
      codec =
        'avc1.' +
        [profile, constraints, level].map((v) => v.toString(16).padStart(2, '0')).join('');
    }
  }
  return { isKey, codec };
}

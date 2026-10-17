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

/** Profils pour lesquels le SPS contient les champs chroma/bit-depth. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Lecteur de bits pour l'analyse Exp-Golomb du SPS. */
class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  bit() {
    const byte = this.bytes[this.pos >> 3] ?? 0;
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  /** Entier non signé Exp-Golomb. */
  ue() {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return ((1 << zeros) - 1) + this.u(zeros);
  }
  /** Entier signé Exp-Golomb. */
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

/** Consomme une « scaling list » du SPS (présente seulement en profils élevés). */
function skipScalingList(r, size) {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      nextScale = (lastScale + r.se() + 256) % 256;
    }
    if (nextScale !== 0) lastScale = nextScale;
  }
}

/**
 * Extrait les dimensions RÉELLES de l'image depuis un SPS.
 *
 * C'est indispensable : le serveur ne doit pas annoncer au navigateur la taille
 * demandée dans `.env`, mais celle que ffmpeg a réellement obtenue. Si la caméra
 * négocie une autre résolution, une config incohérente (niveau H.264 trop bas pour
 * la taille annoncée) fait échouer `VideoDecoder.isConfigSupported` — symptôme :
 * « Codec non supporté » alors que le codec l'est parfaitement.
 *
 * @param {Uint8Array} nal NAL complet, octet d'en-tête inclus.
 * @returns {{profile:number,constraints:number,level:number,width:number,height:number}|null}
 */
export function parseSps(nal) {
  try {
    const r = new BitReader(toRbsp(nal.subarray(1)));

    const profile = r.u(8);
    const constraints = r.u(8);
    const level = r.u(8);
    r.ue(); // seq_parameter_set_id

    let chromaFormatIdc = 1; // 4:2:0 par défaut
    let separateColourPlane = 0;
    if (HIGH_PROFILES.has(profile)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.u(1); // qpprime_y_zero_transform_bypass_flag
      if (r.u(1)) {
        // seq_scaling_matrix_present_flag
        const count = chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < count; i++) {
          if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }

    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue(); // pic_order_cnt_type
    if (pocType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      r.u(1); // delta_pic_order_always_zero_flag
      r.se(); // offset_for_non_ref_pic
      r.se(); // offset_for_top_to_bottom_field
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }

    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed_flag

    const widthMbs = r.ue() + 1; // pic_width_in_mbs_minus1
    const heightMapUnits = r.ue() + 1; // pic_height_in_map_units_minus1
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
    r.u(1); // direct_8x8_inference_flag

    let cropL = 0;
    let cropR = 0;
    let cropT = 0;
    let cropB = 0;
    if (r.u(1)) {
      // frame_cropping_flag
      cropL = r.ue();
      cropR = r.ue();
      cropT = r.ue();
      cropB = r.ue();
    }

    let width = widthMbs * 16;
    let height = (frameMbsOnly ? 1 : 2) * heightMapUnits * 16;

    // Le recadrage (cropping) retire les pixels de bord : sans lui, 1080p
    // s'annoncerait 1088 (68 macroblocs de haut).
    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    const fieldFactor = frameMbsOnly ? 1 : 2;
    let unitX;
    let unitY;
    if (chromaArrayType === 0) {
      unitX = 1;
      unitY = fieldFactor;
    } else {
      const subWidthC = chromaArrayType === 3 ? 1 : 2;
      const subHeightC = chromaArrayType === 1 ? 2 : 1;
      unitX = subWidthC;
      unitY = subHeightC * fieldFactor;
    }
    width -= unitX * (cropL + cropR);
    height -= unitY * (cropT + cropB);

    if (width <= 0 || height <= 0) return null;
    return { profile, constraints, level, width, height };
  } catch {
    return null; // SPS tronqué : on préfère ne rien annoncer plutôt qu'un faux
  }
}

/**
 * Analyse une access unit : est-ce une image clé ? Quel est le codec exact ?
 * Le codec est déduit du SPS (profile_idc / contraintes / level_idc) et sert à
 * construire la chaîne `avc1.PPCCLL` attendue par WebCodecs. On en profite pour
 * remonter les dimensions réelles, que le SPS contient aussi.
 */
export function scanAccessUnit(au) {
  const codes = findStartCodes(au);
  let isKey = false;
  let codec = null;
  let width = 0;
  let height = 0;

  for (let i = 0; i < codes.length; i++) {
    const { start, codeLen } = codes[i];
    const end = i + 1 < codes.length ? codes[i + 1].start : au.length;
    const type = au[start + codeLen] & 0x1f;

    if (type === NAL.IDR) {
      isKey = true;
    } else if (type === NAL.SPS && !codec && end - start >= codeLen + 4) {
      // parseSps attend le NAL seul, octet d'en-tête en tête, SANS le start code.
      const sps = parseSps(au.subarray(start + codeLen, end));
      if (sps) {
        codec =
          'avc1.' +
          [sps.profile, sps.constraints, sps.level]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('');
        width = sps.width;
        height = sps.height;
      } else {
        // Repli : au moins l'ancienne extraction, qui ne lit que 3 octets.
        const base = start + codeLen;
        codec =
          'avc1.' +
          [au[base + 1], au[base + 2], au[base + 3]]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('');
      }
    }
  }
  return { isKey, codec, width, height };
}

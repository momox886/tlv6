// Test des fonctions mathématiques et de la géométrie (aucune dépendance).
// On vérifie les propriétés qui, si elles sont fausses, donnent une image
// déformée ou invisible dans le casque.

import { identity, multiply, translationScale, perspective } from '../public/xr-math.js';

function approx(a, b, eps = 1e-5) {
  return Math.abs(a - b) <= eps;
}

function approxArray(a, b, eps = 1e-5) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!approx(a[i], b[i], eps)) return false;
  return true;
}

const results = [];
const check = (label, pass) => results.push([label, !!pass]);

// identity * m = m
const m = translationScale(1, 2, 3, 4, 5, 6);
check('identity × m = m', approxArray(multiply(identity(), m), m));

// m * identity = m
check('m × identity = m', approxArray(multiply(m, identity()), m));

// translationScale : la translation est dans la 4e colonne
const t = translationScale(1, 2, 3, 1, 1, 1);
check('translation en colonne 4', approx(t[12], 1) && approx(t[13], 2) && approx(t[14], 3));

// perspective : la matrice a la bonne forme (m[11] = -1, m[15] = 0)
const p = perspective(Math.PI / 3, 1.5, 0.01, 100);
check('perspective : m[11] = -1', approx(p[11], -1));
check('perspective : m[15] = 0', approx(p[15], 0));
check('perspective : f/aspect en m[0]', approx(p[0], 1 / Math.tan(Math.PI / 6) / 1.5));

// Vecteur (0,0,-2) projeté : doit atterrir dans le cube [-1,1]
function project(mat, v) {
  const out = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    out[r] = mat[0 * 4 + r] * v[0] + mat[1 * 4 + r] * v[1] + mat[2 * 4 + r] * v[2] + mat[3 * 4 + r] * v[3];
  }
  return out;
}
const clip = project(p, [0, 0, -2, 1]);
check('point devant la caméra dans le frustum', clip[3] > 0 && Math.abs(clip[0] / clip[3]) <= 1 && Math.abs(clip[1] / clip[3]) <= 1);

console.log('');
let ok = true;
for (const [label, pass] of results) {
  console.log(`  ${pass ? '✅' : '❌'} ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? '\n✅ MATHÉMATIQUES OK' : '\n❌ ÉCHEC');
process.exit(ok ? 0 : 1);

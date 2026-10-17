// Tests unitaires du détection des adresses Tailscale.
// Tailscale utilise 100.64.0.0/10 (CGNAT) et fd7a:115c:a1e0::/48.

import { isTailscaleAddress } from '../server/network.js';

const tests = [
  ['direct', '192.168.1.10', false],
  ['loopback', '127.0.0.1', false],
  ['tailscale', '100.64.0.1', true],
  ['tailscale', '100.127.255.254', true],
  ['borne', '100.63.255.255', false], // juste en dessous
  ['borne', '100.128.0.0', false],    // juste au-dessus
  ['IPv4 mappée IPv6', '::ffff:100.64.0.5', true],
  ['IPv6 Tailscale', 'fd7a:115c:a1e0:0:0:0:0:1', true],
  ['IPv6 normal', '2001:db8::1', false],
  ['invalide', '', false],
  ['invalide', 'inconnu', false],
];

let ok = true;
for (const [label, addr, expect] of tests) {
  const r = isTailscaleAddress(addr);
  if (r !== expect) {
    console.log(`  ❌ ${label} ${addr} -> ${r} (attendu ${expect})`);
    ok = false;
  } else {
    console.log(`  ✅ ${label} ${addr} -> ${r}`);
  }
}
console.log(ok ? '\n✅ DÉTECTION TAILSCALE OK' : '\n❌ ÉCHEC');
process.exit(ok ? 0 : 1);

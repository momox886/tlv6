// Petits utilitaires réseau partagés.

// Tailscale attribue ses adresses dans 100.64.0.0/10 (plage CGNAT, RFC 6598) et
// dans le préfixe IPv6 fd7a:115c:a1e0::/48.
//
// Savoir qu'un client arrive par ce tunnel est précieux : le débit utile y est
// souvent plus faible qu'en réseau local, surtout quand le trafic est relayé par
// un DERP. Le serveur s'en sert uniquement pour prévenir l'utilisateur — il ne
// change rien tout seul.
//
// @param {string|undefined} address adresse distante, éventuellement IPv4
//        encapsulée en IPv6 (« ::ffff:100.64.0.1 »).
export function isTailscaleAddress(address) {
  if (!address) return false;
  const addr = address.replace(/^::ffff:/, '');

  if (addr.startsWith('fd7a:115c:a1e0:')) return true;

  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10
}

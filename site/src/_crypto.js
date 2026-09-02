/* Injected by site/build.py from src/_crypto.js.
   Shared with verify.html rather than copied into it: two blake2b
   implementations is one that can drift, and both pages exist to be believed. */
/* ---- blake2b-256, enough of it to check a Merkle path ----------------- */
  /* Inlined rather than imported: this page's whole claim is that YOU can    */
  /* verify the refusal, and a claim that depends on fetching a script from   */
  /* someone else's CDN is a weaker claim.                                    */
  var IV = new Uint32Array([
    0xf3bcc908,0x6a09e667, 0x84caa73b,0xbb67ae85, 0xfe94f82b,0x3c6ef372, 0x5f1d36f1,0xa54ff53a,
    0xade682d1,0x510e527f, 0x2b3e6c1f,0x9b05688c, 0xfb41bd6b,0x1f83d9ab, 0x137e2179,0x5be0cd19]);
  var SIGMA = [
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
    [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],[7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
    [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
    [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
    [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],[10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0],
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3]];
  var v = new Uint32Array(32), m = new Uint32Array(32);

  function add64(a, b, c, d) { // v[a] += v[b], 64-bit little-endian halves
    var lo = (v[a] >>> 0) + (v[b] >>> 0);
    v[a] = lo >>> 0;
    v[a + 1] = (v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0)) >>> 0;
  }
  function rot(a, bits) {
    var lo = v[a], hi = v[a + 1], nl, nh;
    if (bits === 32) { nl = hi; nh = lo; }
    else if (bits < 32) { nl = (lo >>> bits) ^ (hi << (32 - bits)); nh = (hi >>> bits) ^ (lo << (32 - bits)); }
    else { var b2 = bits - 32; nl = (hi >>> b2) ^ (lo << (32 - b2)); nh = (lo >>> b2) ^ (hi << (32 - b2)); }
    v[a] = nl >>> 0; v[a + 1] = nh >>> 0;
  }
  function xorInto(a, b) { v[a] = (v[a] ^ v[b]) >>> 0; v[a + 1] = (v[a + 1] ^ v[b + 1]) >>> 0; }
  function G(r, i, a, b, c, d) {
    var x = SIGMA[r][2 * i], y = SIGMA[r][2 * i + 1];
    add64(a, b); v[a] = (v[a] + m[2 * x]) >>> 0;
    if ((v[a] >>> 0) < (m[2 * x] >>> 0)) v[a + 1] = (v[a + 1] + 1) >>> 0;
    v[a + 1] = (v[a + 1] + m[2 * x + 1]) >>> 0;
    xorInto(d, a); rot(d, 32);
    add64(c, d); xorInto(b, c); rot(b, 24);
    add64(a, b); v[a] = (v[a] + m[2 * y]) >>> 0;
    if ((v[a] >>> 0) < (m[2 * y] >>> 0)) v[a + 1] = (v[a + 1] + 1) >>> 0;
    v[a + 1] = (v[a + 1] + m[2 * y + 1]) >>> 0;
    xorInto(d, a); rot(d, 16);
    add64(c, d); xorInto(b, c); rot(b, 63);
  }

  function blake2b256(input) {
    var h = new Uint32Array(IV);
    h[0] ^= 0x01010000 ^ 32;              // no key, 32-byte digest
    var block = new Uint8Array(128), dv = new DataView(block.buffer);
    var t = 0, i, off = 0;
    function compress(last) {
      for (i = 0; i < 32; i++) m[i] = dv.getUint32(i * 4, true);
      for (i = 0; i < 16; i++) v[i] = h[i];
      for (i = 0; i < 16; i++) v[i + 16] = IV[i];
      v[24] = (v[24] ^ (t >>> 0)) >>> 0;
      v[25] = (v[25] ^ Math.floor(t / 0x100000000)) >>> 0;
      if (last) { v[28] = (~v[28]) >>> 0; v[29] = (~v[29]) >>> 0; }
      for (var r = 0; r < 12; r++) {
        G(r,0,0,8,16,24); G(r,1,2,10,18,26); G(r,2,4,12,20,28); G(r,3,6,14,22,30);
        G(r,4,0,10,20,30); G(r,5,2,12,22,24); G(r,6,4,14,16,26); G(r,7,6,8,18,28);
      }
      for (i = 0; i < 16; i++) h[i] = (h[i] ^ v[i] ^ v[i + 16]) >>> 0;
    }
    while (input.length - off > 128) {
      block.set(input.subarray(off, off + 128)); t += 128; off += 128; compress(false);
    }
    block.fill(0); block.set(input.subarray(off)); t += input.length - off; compress(true);
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { new DataView(out.buffer).setUint32(i * 4, h[i], true); }
    return out;
  }

  /* ---- bech32m, to read a kaspa address --------------------------------- */
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  function decodeAddress(addr) {
    var i = addr.indexOf(":");
    if (i < 0) return null;
    var data = addr.slice(i + 1);
    // The checksum is the last EIGHT FIVE-BIT GROUPS — 40 bits, five bytes —
    // not eight bytes. Reading it as eight bytes leaves the payload short and
    // every address looks malformed, which is exactly how this first failed.
    if (data.length < 9) return null;
    var body = data.slice(0, -8), bits = 0, acc = 0, out = [];
    for (var k = 0; k < body.length; k++) {
      var vv = CHARSET.indexOf(body[k].toLowerCase());
      if (vv < 0) return null;
      acc = (acc << 5) | vv; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
    }
    // byte 0 is the address version; a 32-byte payload follows.
    if (out.length < 33) return null;
    return new Uint8Array(out.slice(1, 33));
  }

  function fromHex(h) {
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function toHex(b) {
    var s = "";
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  }
  function cat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }

  
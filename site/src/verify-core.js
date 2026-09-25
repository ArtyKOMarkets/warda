
  /* ---- address encoding: kaspa's bech32 variant ------------------------- */
  /* The checksum is 8 characters rather than 6, and the polymod uses a BCH
     generator set of its own. Ported from src/address.ts and checked against
     the template's own address vectors on every page load — see the banner. */
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  var GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

  function polymod(values) {
    var c = 1n;
    for (var k = 0; k < values.length; k++) {
      var c0 = c >> 35n;
      c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(values[k]);
      for (var i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
    }
    return c ^ 1n;
  }
  function prefixToFive(p) {
    var out = [];
    for (var i = 0; i < p.length; i++) out.push(p.charCodeAt(i) & 0x1f);
    return out;
  }
  function conv8to5(bytes) {
    var out = [], buff = 0, bits = 0;
    for (var i = 0; i < bytes.length; i++) {
      buff = (buff << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { bits -= 5; out.push((buff >> bits) & 0x1f); buff &= (1 << bits) - 1; }
    }
    if (bits > 0) out.push((buff << (5 - bits)) & 0x1f);
    return out;
  }
  function encodeAddress(prefix, version, payload) {
    var five = conv8to5([version].concat(Array.from(payload)));
    var sum = polymod(prefixToFive(prefix).concat([0], five, [0,0,0,0,0,0,0,0]));
    var sumBytes = new Uint8Array(5);
    for (var i = 0; i < 5; i++) sumBytes[4 - i] = Number((sum >> BigInt(i * 8)) & 0xffn);
    var body = five.concat(conv8to5(sumBytes)).map(function (c) { return CHARSET[c]; }).join("");
    return prefix + ":" + body;
  }

  /* ---- the splice ------------------------------------------------------- */
  /* A grant's address is blake2b-256 of the covenant bytecode with the grant's
     own values written into fixed offsets. Every occurrence, not the first:
     several fields appear more than once in the compiled script. */
  function i64le(v) {
    var out = new Uint8Array(8), x = BigInt(v);
    for (var i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }
  function bytecodeFor(tpl, authority, state) {
    var out = fromHex(tpl.baselineHex);
    if (out.length !== tpl.bytecodeLen) throw new Error("baseline is " + out.length + " bytes, declared " + tpl.bytecodeLen);
    for (var i = 0; i < tpl.fields.length; i++) {
      var f = tpl.fields[i];
      var src = f.group === "authority" ? authority : state;
      var value = src[f.name];
      if (value === undefined || value === null) throw new Error("missing " + f.group + " field " + f.name);
      var bytes = f.kind === "bytes32" ? fromHex(String(value)) : i64le(value);
      if (bytes.length !== f.width) throw new Error(f.name + ": expected " + f.width + " bytes, got " + bytes.length);
      for (var j = 0; j < f.offsets.length; j++) out.set(bytes, f.offsets[j]);
    }
    return out;
  }
  function addressFor(tpl, authority, state, prefix) {
    return encodeAddress(prefix, 8, blake2b256(bytecodeFor(tpl, authority, state)));
  }

  /* Which covenant a template IS: blake2b-256 over the ASCII of its baseline
     hex, first eight bytes. The same definition as templateFingerprint in the
     SDK, and it has to be — a manifest records that string and this page
     compares against it. */
  function fingerprintOf(tpl) {
    var hex = tpl.baselineHex, bytes = new Uint8Array(hex.length), i;
    for (i = 0; i < hex.length; i++) bytes[i] = hex.charCodeAt(i) & 0xff;
    var d = blake2b256(bytes), out = "";
    for (i = 0; i < 8; i++) out += d[i].toString(16).padStart(2, "0");
    return out;
  }

  /* The template a manifest was issued under, out of the ones this page holds.
     
     The page carried ONE — whichever covenant was current — and derived every
     address from it. That is correct for exactly as long as one covenant has
     live grants under it. With two, a v4 manifest answered from a v5 template
     derives an address that is well-formed, on the right network, holds
     nothing, and reads as a grant that was never funded.
     
     A manifest with no `covenant` field gets the current one: manifests
     predate the field. A manifest naming a covenant this page does not carry
     THROWS, because the alternative is answering it from the nearest template,
     and a verifier that guesses is not verifying. */
  function pickTemplate(tpls, m) {
    if (!m || !m.covenant) return tpls[0];
    for (var i = 0; i < tpls.length; i++) {
      if (fingerprintOf(tpls[i]) === m.covenant) return tpls[i];
    }
    var have = [];
    for (i = 0; i < tpls.length; i++) have.push(fingerprintOf(tpls[i]));
    throw new Error(
      "this manifest was issued under covenant " + m.covenant + ", and this page carries " +
      have.join(", ") + ". An address derived from another covenant would be a valid address " +
      "for the wrong bytecode \u2014 not an error, a wrong answer."
    );
  }

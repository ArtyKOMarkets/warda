#!/usr/bin/env python3
"""
Records what your node actually says, using nothing but the standard library.

There is a TypeScript twin of this (tools/capture-rpc.ts) that does the same
job in eight fewer screens. This exists because the machine running the node
is not always the machine with a package manager on it, and a capture that
needs an install first is a capture that does not happen.

Everything here is a throwaway: three read-only calls, no writes to the chain,
no key. The output is a fixture the real client gets built and tested against.

    python3 tools/capture_rpc.py kaspatest:pp... > rpc-capture.json

The JSON wRPC port is separate from the Borsh one (testnet: 18210 vs 17210)
and only listens if kaspad was started with --rpclisten-json.
"""

import base64
import json
import os
import socket
import struct
import sys
from urllib.parse import urlparse


def handshake(host, port, path="/"):
    """Opens a WebSocket. Enough of RFC 6455 to hold one short conversation."""
    sock = socket.create_connection((host, port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode())

    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("the server closed the connection during the handshake")
        buf += chunk
    head = buf.split(b"\r\n\r\n", 1)[0].decode(errors="replace")
    if "101" not in head.split("\r\n")[0]:
        raise RuntimeError("server refused the websocket upgrade:\n" + head)
    return sock, buf.split(b"\r\n\r\n", 1)[1]


def send_text(sock, text):
    """A client frame must be masked; a server frame must not be. Only this direction is masked."""
    payload = text.encode()
    header = bytearray([0x81])  # FIN + text opcode
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    mask = os.urandom(4)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def recv_frame(sock, carry):
    """Returns (text, leftover). Control frames are answered or skipped, not returned."""

    def need(n, carry):
        while len(carry) < n:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError("the server closed the connection")
            carry += chunk
        return carry

    while True:
        carry = need(2, carry)
        b0, b1 = carry[0], carry[1]
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        at = 2

        if length == 126:
            carry = need(4, carry)
            length = struct.unpack(">H", carry[2:4])[0]
            at = 4
        elif length == 127:
            carry = need(10, carry)
            length = struct.unpack(">Q", carry[2:10])[0]
            at = 10

        if masked:
            carry = need(at + 4, carry)
            mask = carry[at : at + 4]
            at += 4
        else:
            mask = None

        carry = need(at + length, carry)
        payload = carry[at : at + length]
        carry = carry[at + length :]
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        if opcode == 0x8:  # close
            raise RuntimeError("the server closed the connection")
        if opcode == 0x9:  # ping — answer it and keep waiting
            sock.sendall(b"\x8a\x80" + os.urandom(4))
            continue
        if opcode == 0xA:  # pong
            continue
        return payload.decode(errors="replace"), carry


def main():
    url = os.environ.get("WARDA_RPC_JSON", "ws://127.0.0.1:18210")
    address = sys.argv[1] if len(sys.argv) > 1 else None

    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 18210

    try:
        sock, carry = handshake(host, port, parsed.path or "/")
    except (ConnectionRefusedError, OSError) as e:
        sys.stderr.write(
            f"cannot reach {url} ({e}).\n"
            "The JSON wRPC port is separate from the Borsh one (testnet: 18210 vs 17210)\n"
            "and only listens if kaspad was started with --rpclisten-json. Add that flag\n"
            "and restart, or set WARDA_RPC_JSON to the right address.\n"
        )
        return 1

    calls = [
        ("getInfo", {}, "readiness — is it synced, is the utxo index on"),
        ("getBlockDagInfo", {}, "the current DAA score"),
        (
            "getUtxosByAddresses",
            {"addresses": [address] if address else []},
            "a real grant UTXO, including its covenant id"
            if address
            else "shape only — pass a grant address to capture a covenant-bearing entry",
        ),
    ]

    captured = {}
    for i, (method, params, why) in enumerate(calls, start=1):
        # The response carries its result in `params`, not `result` — wRPC
        # reuses the field. Reading it as JSON-RPC 2.0 finds every reply empty.
        send_text(sock, json.dumps({"id": i, "method": method, "params": params}))
        while True:
            text, carry = recv_frame(sock, carry)
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == i:
                break  # anything else is a notification or another call's reply
        captured[method] = {"why": why, "request": params, "reply": msg}
        sys.stderr.write(
            f"{method}: {'ERROR ' + json.dumps(msg['error']) if msg.get('error') else 'ok'}\n"
        )

    sock.close()

    # A covenant-aware node reports `covenantId` on a UTXO entry. A node built
    # before covenants omits the field entirely, and a client that shrugged at
    # that would build spends with no binding — valid-looking, always refused.
    entries = (captured["getUtxosByAddresses"]["reply"].get("params") or {}).get("entries") or []
    first = entries[0].get("utxoEntry") if entries else None
    if not address:
        verdict = "not checked — no address given"
    elif not first:
        verdict = "no UTXO found at that address; cannot tell"
    elif "covenantId" in first:
        verdict = "present — this node is covenant-aware"
    else:
        verdict = "ABSENT — this node predates covenants, or the field was dropped in transit"
    captured["_covenantAwareness"] = {"verdict": verdict, "sampledEntry": first}
    sys.stderr.write(f"covenant awareness: {verdict}\n")

    json.dump({"url": url, "address": address, "captured": captured}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

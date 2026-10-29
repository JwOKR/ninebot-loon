#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ninebot_decrypt.py — 九号密文 payload 解密工具

用法：
  python ninebot_decrypt.py --har <har文件>                 # 分析结构，列出所有密文
  python ninebot_decrypt.py --har <har> --key <KEY> --iv <IV>  # 用KEY/IV尝试解密
  python ninebot_decrypt.py --b64 <base64字符串> --key <K> --iv <IV>

KEY/IV 支持三种写法：
  16字节明文（如 "1234567890abcdef"）
  32个hex字符（如 "00112233445566778899aabbccddeeff"）
  base64

自动尝试：AES-128/192/256 × CBC/ECB × 多个起始偏移(0/16/24/25/28/32/44)，
并自动识别解密结果是否为 JSON / gzip / zlib / 纯文本。

依赖：仅标准库 + openssl 命令行（Windows Git Bash 自带）
"""

import argparse, base64, json, subprocess, sys, tempfile, os, binascii

# ---------- 基础工具 ----------

def norm_key(s):
    """把 KEY/IV 字符串规范成 bytes"""
    if s is None:
        return None
    if isinstance(s, bytes):
        return s
    # 32/48/64 位 hex
    if len(s) in (32, 48, 64) and all(c in "0123456789abcdefABCDEF" for c in s):
        return bytes.fromhex(s)
    # base64
    try:
        b = base64.b64decode(s, validate=True)
        if len(b) in (16, 24, 32):
            return b
    except Exception:
        pass
    # 明文
    return s.encode("utf-8")


def openssl_aes(data, key, iv, mode, decrypt=True):
    """调用 openssl 做 AES 单块解密/加密，返回 bytes 或 None"""
    args = ["openssl", "enc", "-aes-%d-%s" % (len(key) * 8, mode), "-K", key.hex()]
    if mode == "cbc":
        if iv is None or len(iv) != 16:
            return None
        args += ["-iv", iv.hex()]
    if decrypt:
        args.append("-d")
    args += ["-nopad"]

    with tempfile.NamedTemporaryFile(delete=False) as fi:
        fi.write(data)
        inpath = fi.name
    try:
        p = subprocess.run(args + ["-in", inpath], capture_output=True)
        if p.returncode != 0:
            return None
        return p.stdout
    finally:
        os.unlink(inpath)


def unpad_pkcs7(b):
    if not b:
        return None
    n = b[-1]
    if 1 <= n <= 16 and b[-n:] == bytes([n]) * n:
        return b[:-n]
    return None


def looks_good(b):
    """判断解密结果像什么"""
    if not b:
        return None
    if b[:2] == b"\x1f\x8b":
        return "gzip"
    if b[:2] in (b"\x78\x9c", b"\x78\x01", b"\x78\xda"):
        return "zlib"
    if b[:2] == b"PK":
        return "zip"
    s = b.lstrip()
    if s[:1] in (b"{", b"["):
        try:
            json.loads(s.decode("utf-8"))
            return "json"
        except Exception:
            return "json-ish"
    # 可打印比例
    pr = sum(1 for x in b[:200] if 32 <= x <= 126 or x in (9, 10, 13)) / min(len(b), 200)
    if pr > 0.9:
        return "text(%.0f%%)" % (pr * 100)
    return None


# ---------- HAR 解析 ----------

def load_blobs_from_har(path):
    with open(path, "rb") as f:
        d = json.load(f)
    out = []
    for e in d["log"]["entries"]:
        url = e["request"]["url"]
        if "ninebot" not in url:
            continue
        try:
            body = base64.b64decode(e["response"]["content"].get("text", "")).decode("utf-8")
            j = json.loads(body)
        except Exception:
            continue
        if isinstance(j, dict) and "a" in j:
            out.append({"url": url, "blob": base64.b64decode(j["a"]), "raw_body": body})
    return out


def show_structure(blobs):
    print("=" * 78)
    print("密文结构分析（%d 条）" % len(blobs))
    print("=" * 78)
    for b in blobs:
        x = b["blob"]
        n = int.from_bytes(x[:4], "little")
        print("%-52s len=%6d u32_0=%6d (len-16=%s)" %
              (b["url"].split("/")[-1][:52], len(x), n, len(x) - 16))
        print("   hdr :", x[:16].hex(" "))
        print("   body:", x[16:48].hex(" "))
        print()


# ---------- 解密尝试 ----------

OFFSETS = [16, 24, 25, 28, 32, 44, 48]


def try_decrypt(blob, key, iv):
    results = []
    for off in OFFSETS:
        data = blob[off:]
        if len(data) < 16:
            continue
        data = data[: len(data) - (len(data) % 16)]  # 截齐16字节块
        for mode in ("cbc", "ecb"):
            pt = openssl_aes(data, key, iv if mode == "cbc" else None, mode)
            if pt is None:
                continue
            for cand, name in ((unpad_pkcs7(pt), "pkcs7"), (pt, "raw")):
                if cand is None:
                    continue
                tag = looks_good(cand)
                if tag:
                    results.append((off, mode, name, tag, cand))
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--har")
    ap.add_argument("--b64")
    ap.add_argument("--key")
    ap.add_argument("--iv")
    a = ap.parse_args()

    if a.har:
        blobs = load_blobs_from_har(a.har)
    elif a.b64:
        j = json.loads(base64.b64decode(a.b64).decode("utf-8"))
        blobs = [{"url": "<b64>", "blob": base64.b64decode(j["a"])}]
    else:
        ap.error("需要 --har 或 --b64")

    if not blobs:
        print("没有找到加密 payload")
        return

    if not a.key:
        show_structure(blobs)
        print("提示：带上 --key/--iv 可自动尝试解密")
        return

    key = norm_key(a.key)
    iv = norm_key(a.iv) if a.iv else None
    print("KEY =", key.hex() if key else None, "(%d字节)" % (len(key) if key else 0))
    print("IV  =", iv.hex() if iv else None)
    print()

    hits = 0
    for b in blobs:
        rs = try_decrypt(b["blob"], key, iv)
        label = b["url"].split("/")[-1][:40]
        if not rs:
            print("[--] %-40s 无匹配" % label)
            continue
        hits += 1
        for off, mode, pad, tag, pt in rs:
            print("[OK] %-40s offset=%d aes-%d-%s %s -> %s" %
                  (label, off, len(key) * 8, mode.upper(), pad, tag))
            print("     ", pt[:300].decode("utf-8", "replace").replace("\n", " "))
    print()
    print("命中 %d / %d" % (hits, len(blobs)))


if __name__ == "__main__":
    main()

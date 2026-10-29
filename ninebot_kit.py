#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
九号出行 (Ninebot/Segway) 离线分析工具包
=========================================

逆向自 九号出行 6.10.11 (官方原版 APK)，已验证可用。

已还原的能力：
  1. 从 APK 的 libnativesecrets.so 中提取 DYNAMIC_CONF 的 KEY / IV
     （该常量按字节 XOR 混淆存储，反汇编 nativeDynamicConfigKey 可还原）
  2. 解密 assets/*.nb 资源文件 → 明文 JSON / Hermes 字节码包
  3. 导出 RN 动态配置：全部 65 个业务模块的下载 URL + 各自的 AES key/iv
  4. 下载并解密任意 RN 业务模块（如 TrackNew 轨迹模块）的 Hermes 字节码包

安全/合规声明：
  本工具只做**本地离线数据解析**，不触碰车辆固件、不改限速、不伪造上行指令。
  用于查看自己的骑行数据与理解自有设备的数据格式。请勿用于非法用途。

依赖：pip install cryptography capstone
"""
import argparse
import base64
import hashlib
import io
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:
    sys.exit("缺少依赖，请先执行: pip install cryptography")


# --------------------------------------------------------------------------
# 核心：AES-128-CBC 解密 .nb 容器
# --------------------------------------------------------------------------
def decrypt_nb(data: bytes, key: bytes, iv: bytes = None) -> bytes:
    """
    .nb 容器格式：明文 base64 文本 -> AES-128-CBC(key, iv=key) -> PKCS7 去填充
    """
    iv = iv if iv is not None else key
    raw = data
    # 容忍带换行 / 带空白的 base64
    stripped = bytes(c for c in raw if not c in b"\r\n\t ")
    try:
        ct = base64.b64decode(stripped)
    except Exception:
        ct = raw
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    pt = dec.update(ct) + dec.finalize()
    if len(pt) >= 16 and 1 <= pt[-1] <= 16:
        pad = pt[-1]
        if pt[-pad:] == bytes([pad]) * pad:
            pt = pt[:-pad]
    return pt


# --------------------------------------------------------------------------
# 从 libnativesecrets.so 提取 DYNAMIC_CONF KEY/IV
# --------------------------------------------------------------------------
class ELF:
    def __init__(self, data: bytes):
        self.d = data
        if data[:4] != b"\x7fELF":
            raise ValueError("不是 ELF 文件")
        e_shoff, = struct.unpack_from("<Q", data, 0x28)
        e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", data, 0x3A)
        secs = []
        for i in range(e_shnum):
            o = e_shoff + i * e_shentsize
            f = struct.unpack_from("<IIQQQQIIQQ", data, o)
            secs.append(dict(zip(
                "name typ flags addr off size link info align entsize".split(), f)))
        shstr = secs[e_shstrndx]

        def nm(tab, x):
            b = data[tab["off"] + x:]
            return b[:b.index(b"\0")].decode("utf8", "replace")
        for s in secs:
            s["nm"] = nm(shstr, s["name"])
        self.secs = secs

    def section(self, name):
        return next((s for s in self.secs if s["nm"] == name), None)

    def vaddr_to_offset(self, v):
        for s in self.secs:
            if s["addr"] and s["addr"] <= v < s["addr"] + s["size"] and s["typ"] != 8:
                return s["off"] + (v - s["addr"])
        return None

    def symbols(self):
        dynstr = self.section(".dynstr")
        out = {}
        for s in self.secs:
            if s["nm"] != ".dynsym":
                continue
            for i in range(s["size"] // s["entsize"]):
                o = s["off"] + i * s["entsize"]
                st_name, st_info, _o, st_shndx, st_value, st_size = struct.unpack_from(
                    "<IBBHQQ", self.d, o)
                b = self.d[dynstr["off"] + st_name:]
                name = b[:b.index(b"\0")].decode("utf8", "replace")
                out[name] = st_value
        return out


def extract_dynamic_conf_secret(so_bytes: bytes, verbose=False):
    """
    还原 nativeDynamicConfigKey / nativeDynamicConfigIV 返回的 16 字节常量。

    混淆形式（arm64）：
        strb   w_first, [ss, #1]        ; 首字符
        adrp   x10, #page  ; add x10, x10, #off1     -> 密文表 A
        adrp   x11, #page  ; add x11, x11, #off2     -> 掩码表 M(8字节)
      loop i = 1..15:
        w13 = A[i]
        w14 = M[i & 7]
        ss[i] = w13 ^ w14
      => 结果 s = chr(first) + [ A[i] ^ M[i&7] for i in 1..15 ]
    """
    try:
        import capstone
    except ImportError:
        sys.exit("缺少 capstone，请执行: pip install capstone")

    elf = ELF(so_bytes)
    syms = elf.symbols()
    target = next((v for k, v in syms.items()
                   if k.endswith("nativeDynamicConfigKey")), None)
    ivsym = next((v for k, v in syms.items()
                  if k.endswith("nativeDynamicConfigIV")), None)
    if target is None:
        return None, None

    def recover(addr):
        off = elf.vaddr_to_offset(addr)
        if off is None:
            return None
        md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_LITTLE_ENDIAN)
        md.detail = True
        code = so_bytes[off:off + 512]
        ins_list = list(md.disasm(code, addr))

        # --- 精确追踪： strb Rn, [Xb, #1]  <-  mov Rn, #imm  (字符串首字符) ---
        # 同一函数里还有一个 mov #imm 存到 [Xb] 的是 SSO 长度头，必须排除，
        # 所以显式匹配偏移 #1 并回溯该寄存器最近一次 mov 立即数。
        def reg_name(r):
            return ins_list and md.reg_name(r)

        first_char = None
        for i, ins in enumerate(ins_list[:40]):
            ops = ins.operands
            if ins.mnemonic == "strb" and len(ops) == 2 and \
               ops[0].type == capstone.arm64.ARM64_OP_REG and \
               ops[1].type == capstone.arm64.ARM64_OP_MEM:
                mem = ops[1].mem
                if mem.disp == 1:
                    want = ops[0].reg
                    for prv in reversed(ins_list[:i]):
                        if prv.mnemonic == "mov" and len(prv.operands) == 2 and \
                           prv.operands[0].reg == want and \
                           prv.operands[1].type == capstone.arm64.ARM64_OP_IMM:
                            imm = prv.operands[1].imm
                            if 0x20 <= imm <= 0x7E:
                                first_char = imm
                            break
            if first_char is not None:
                break

        # --- adrp + add -> 各寄存器的虚拟地址表（看齐要足够远） ---
        reg_addr = {}
        mask_bits = 7
        for idx, ins in enumerate(ins_list[:80]):
            if ins.mnemonic == "adrp":
                base = ins.operands[0].reg
                page = ins.operands[1].imm
                for nxt in ins_list[idx + 1: idx + 9]:
                    if nxt.mnemonic == "add" and len(nxt.operands) == 3 and \
                       nxt.operands[0].reg == base and \
                       nxt.operands[1].reg == base and \
                       nxt.operands[2].type == capstone.arm64.ARM64_OP_IMM:
                        reg_addr[base] = page + nxt.operands[2].imm
                        break
            if ins.mnemonic == "and" and len(ins.operands) == 3 and \
               ins.operands[2].type == capstone.arm64.ARM64_OP_IMM:
                mask_bits = ins.operands[2].imm

        # --- 区分 密文表(A) 与 掩码表(M)：
        #     循环体里 ldrb Rd, [Rn, Ri]，其中 Ri 是被 and 掩码过的那个 -> Rn 是 M
        masked_reg = None
        for idx, ins in enumerate(ins_list[:80]):
            if ins.mnemonic == "and" and len(ins.operands) == 3:
                masked_reg = ins.operands[0].reg
                break
        A_reg = M_reg = None
        for ins in ins_list[:80]:
            if ins.mnemonic == "ldrb" and len(ins.operands) == 2 and \
               ins.operands[1].type == capstone.arm64.ARM64_OP_MEM:
                mem = ins.operands[1].mem
                base, idxr = mem.base, mem.index
                if base not in reg_addr:
                    continue
                if masked_reg is not None and idxr == masked_reg:
                    M_reg = base
                elif mem.disp == 0:
                    A_reg = base
        if A_reg is None and len(reg_addr) >= 2:
            regs = list(reg_addr)
            A_reg, M_reg = regs[0], regs[1]
        if first_char is None or A_reg is None or M_reg is None:
            return None
        A_off = elf.vaddr_to_offset(reg_addr[A_reg])
        M_off = elf.vaddr_to_offset(reg_addr[M_reg])
        if A_off is None or M_off is None:
            return None
        A = so_bytes[A_off:A_off + 32]
        M = so_bytes[M_off:M_off + 16]
        s = bytearray([first_char])
        for i in range(1, 16):
            s.append(A[i] ^ M[i & mask_bits])
        if verbose:
            print(f"    首字符=0x{first_char:02x} 密文表@{hex(reg_addr[A_reg])} "
                  f"掩码表@{hex(reg_addr[M_reg])} mask={mask_bits}")
            print(f"    掩码原文={M[:mask_bits + 1]!r}")
        return bytes(s)

    key = recover(target)
    iv = recover(ivsym) if ivsym else None
    if key and iv and _identical(so_bytes, key, iv):
        pass
    return key, iv


def decrypt_nb_auto(data: bytes, key: bytes, iv: bytes = None) -> bytes:
    """
    自动择优 IV。已知情况：
      - assets/backup_config.nb  : IV == KEY
      - RN 模块包 (.nb)          : IV 取自动态配置中的 iv 字段
    依次尝试 [传入iv, key, 全零]，用"解出来是否像有效内容"打分。
    """
    def score(p):
        if p[:2] == b'{"' or p[:2] == b'[{' or p[:8] == bytes.fromhex("c61fbc03c103191f"):
            return 1000
        return sum(1 for c in p[:256] if 32 <= c < 127 or c in (9, 10, 13))

    cands = [iv if iv is not None else key, key, bytes(16)]
    best, bestscore = None, -1
    for ivv in dict.fromkeys(cands):
        if not ivv or len(ivv) != 16:
            continue
        try:
            p = decrypt_nb(data, key, ivv)
        except Exception:
            continue
        s = score(p)
        if s > bestscore:
            best, bestscore = p, s
    return best


def _identical(so_bytes, key, iv):
    return key == iv


# --------------------------------------------------------------------------
# APK 操作
# --------------------------------------------------------------------------
def apk_read(apk: Path, member: str) -> bytes:
    with zipfile.ZipFile(apk) as z:
        return z.read(member)


def cmd_key(args):
    print("[*] 打开 APK:", args.apk)
    with zipfile.ZipFile(args.apk) as z:
        nat = next((n for n in z.namelist()
                    if n.endswith("libnativesecrets.so") and "arm64" in n), None)
        if not nat:
            sys.exit("! 未找到 arm64 版 libnativesecrets.so")
        print("[*] 读取:", nat, z.getinfo(nat).file_size, "bytes")
        so = z.read(nat)
    print("[*] 反汇编 nativeDynamicConfigKey / IV ...")
    key, iv = extract_dynamic_conf_secret(so, verbose=True)
    if not key:
        sys.exit("! 提取失败")
    print()
    print("    DYNAMIC_CONF KEY =", key.decode(errors="replace"))
    print("    DYNAMIC_CONF IV  =", (iv or key).decode(errors="replace"))
    print("    KEY hex:", key.hex())

    # 自校验：拿 APK 里的 assets/backup_config.nb 验证 key/iv 组合
    try:
        with zipfile.ZipFile(args.apk) as z:
            nb = z.read("assets/backup_config.nb")
        print("[*] 自校验：尝试解开 assets/backup_config.nb")
        for label, ivv in (("IV=KEY", key), ("IV=提取值", iv if iv else key)):
            try:
                pt = decrypt_nb(nb, key, ivv)
                ok = pt[:2] == b'{"'
                print(f"    {label:10} -> {'成功 ✓' if ok else '失败'}  {pt[:46]!r}")
            except Exception as e:
                print(f"    {label:10} -> 异常 {e}")
    except KeyError:
        pass


def cmd_nb(args):
    key = args.key.encode() if args.key else None
    iv = args.iv.encode() if args.iv else key
    data = Path(args.file).read_bytes()
    pt = decrypt_nb_auto(data, key, iv)
    out = Path(args.out) if args.out else Path(args.file).with_suffix(".dec")
    out.write_bytes(pt)
    print(f"[+] 解密完成 -> {out}  ({len(pt)} bytes)")
    head = pt[:120]
    try:
        print("    内容预览:", head.decode("utf-8")[:200])
    except UnicodeDecodeError:
        print("    内容预览(hex):", pt[:32].hex(" "))
    if pt[:8] == bytes.fromhex("c61fbc03c103191f"):
        print("    检测到 Hermes 字节码包，可用 strings 提取内部字符串")


def cmd_rnconfig(args):
    print("[*] 打开 APK:", args.apk)
    key, iv = None, None
    if args.key:
        key = args.key.encode()
        iv = args.iv.encode() if args.iv else key
    else:
        with zipfile.ZipFile(args.apk) as z:
            nat = next((n for n in z.namelist()
                        if n.endswith("libnativesecrets.so") and "arm64" in n), None)
            so = z.read(nat)
        key, iv = extract_dynamic_conf_secret(so)
        print("[*] 自动提取 KEY/IV:", key.decode(errors="replace"))
    nb = apk_read(Path(args.apk), "assets/backup_config.nb")
    cfg = json.loads(decrypt_nb_auto(nb, key, iv).decode("utf-8"))
    out = Path(args.out or "dynamic_config.json")
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    mods = [m for g in cfg["rn"] for m in g.get("detail", [])]
    print(f"[+] 配置已导出 -> {out}   共 {len(mods)} 个 RN 模块")
    print()
    print(f"{'模块名':<28}{'版本':<8}{'下载地址'}")
    print("-" * 100)
    for m in mods:
        print(f"{m.get('moduleName',''):<28}{m.get('version',''):<8}{m.get('rnUrl','')[:62]}")
    print()
    print("通用模块密钥: KEY=%s  IV=%s" % (mods[0].get("key"), mods[0].get("iv")))


def cmd_fetch(args):
    import urllib.request
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    mods = [m for g in cfg["rn"] for m in g.get("detail", [])]
    hit = [m for m in mods if m.get("moduleName") == args.module]
    if not hit:
        sys.exit(f"! 未找到模块 {args.module}。可用模块见 ninebot_kit.py rnconfig")
    m = hit[0]
    url = m["rnUrl"]
    if args.ios:
        url = url.replace("_android_", "_ios_")
    print("[*] 下载:", url)
    zp = Path(f"{args.module}.zip")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    zp.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    print(f"[+] 已保存 {zp} ({zp.stat().st_size} bytes)")
    with zipfile.ZipFile(zp) as z:
        nbname = next((n for n in z.namelist() if n.endswith(".nb")), None)
        if not nbname:
            sys.exit("! zip 内无 .nb 文件")
        raw = z.read(nbname)
    key = (args.key or m["key"]).encode()
    iv = (args.iv or m["iv"]).encode()
    pt = decrypt_nb_auto(raw, key, iv)
    out = Path(f"{args.module}.hbc")
    out.write_bytes(pt)
    print(f"[+] 解密完成 -> {out} ({len(pt)} bytes)")
    print("    magic:", pt[:8].hex(), "(Hermes)" if pt[:8] == bytes.fromhex("c61fbc03c103191f") else "")
    if args.strings:
        sfile = Path(f"{args.module}_strings.txt")
        strs = sorted({s.decode() for s in re.findall(rb"[\x20-\x7e]{3,}", pt)})
        sfile.write_text("\n".join(strs), encoding="utf-8")
        print(f"[+] 字符串已提取 -> {sfile} ({len(strs)} 条)")


def main():
    ap = argparse.ArgumentParser(
        description="九号出行离线分析工具包",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("key", help="从 APK 提取 DYNAMIC_CONF KEY/IV")
    p.add_argument("apk")
    p.set_defaults(func=cmd_key)

    p = sub.add_parser("nb", help="解密单个 .nb 文件")
    p.add_argument("file")
    p.add_argument("--key", required=True)
    p.add_argument("--iv")
    p.add_argument("--out")
    p.set_defaults(func=cmd_nb)

    p = sub.add_parser("rnconfig", help="导出 RN 动态配置(模块URL+key/iv)")
    p.add_argument("apk")
    p.add_argument("--key")
    p.add_argument("--iv")
    p.add_argument("--out")
    p.set_defaults(func=cmd_rnconfig)

    p = sub.add_parser("fetch", help="下载并解密指定 RN 模块")
    p.add_argument("module")
    p.add_argument("--config", default="dynamic_config.json")
    p.add_argument("--ios", action="store_true", help="下载 iOS 版包")
    p.add_argument("--key")
    p.add_argument("--iv")
    p.add_argument("--strings", action="store_true", help="同时导出包内字符串")
    p.set_defaults(func=cmd_fetch)

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()

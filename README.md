# 九号出行 · 逆向分析报告与离线工具包

针对「新版九号出行 APP 电动自行车轨迹不显示实际速度」问题的完整逆向分析。
分析对象：**九号出行 6.10.11 官方原版 APK**（arm64）。

---

## 一、结论速览

| 目标 | 结果 |
|---|---|
| **网络层 MITM 注入（Loon 改写响应）** | ❌ **不可行**，业务接口是会话级加密，每条消息密钥不同 |
| **解开 APP 内置资源 `.nb`** | ✅ **已破解**，AES-128-CBC，`KEY=IV=TOGfX#qkYm@0t{83}` |
| **解开 RN 业务模块包** | ✅ **已破解**，key/iv 存于动态配置，65 个模块共用一套 |
| **速度 UI 是否还在** | ✅ **还在**，TrackNew v905 里速度曲线代码完整，无隐藏开关 |
| **服务端是否还下发速度** | ⚠️ 未证实，用本仓库探针插件可验证 |

**核心判断**：速度显示的开关不在客户端 UI，而在服务端下发的数据里。
这正是「降级到 6.6.8 就恢复显示」现象的最合理解释——旧版 APP 请求到的响应里**有**速度字段。

---

## 二、九号的四层结构（与各层是否已破解）

```
[第0层] HTTPS / TLS
        └ 常规，可 MITM

[第1层] 业务接口传输加密            ❌ 未破解
        POST https://cnnx-omsgw.ninebot.com/app-api/travel/v1/travel/query-info
        响应体 {"a":"<base64>"}
        └ base64 后为自定义二进制信封 + 会话密钥加密（见 §3）

[第2层] APP 内置资源 assets/*.nb     ✅ 已破解
        AES-128-CBC, KEY=IV=TOGfX#qkYm@0t{83}

[第3层] RN 业务模块包 *.nb           ✅ 已破解
        key=",]Q&STDIg@ZcQ.6t"  iv="bCGRM{TR&UHzC-2r"
        └ 解出来是 Hermes 字节码包（含全部 JS 字符串）
```

---

## 三、第1层：为什么网络注入不可行

### 3.1 信封结构（12 条样本全部吻合）

```
偏移  0..3    载荷长度 u32(LE)   —— 恒等于 len(body) - 16
偏移  4..7    0
偏移  8..11   0x20 (=32)
偏移 12       0x01（版本/算法标记）
偏移 13..15   随机
偏移 16..47   32 字节（疑似会话密钥材料）
偏移 48..     载荷
```

### 3.2 判定依据

- **是流密码**：载荷长度 `((len-16)-32) % 16` 在各条之间取不同值（0/2/3/6/10/12/13/15），
  不是 16 的倍数 ⇒ 不是 AES-CBC/ECB（那必然是 16 的倍数），而是 **RC4 类流密码**。
- **每条密钥不同**：对两条响应做异或，无长段零区 ⇒ 不是复用 keystream，
  无法做多密文复用攻击（此路已试，全乱码）。
- **不是压缩**：base64 后无 gzip / zlib 头，无可读字符串。

### 3.3 该层密码归谁管

`libnbenc_ffi.so` / `libnbcrypto.so`（Rust 编写），关键导出符号：

```
crypto_init / crypto_setAuthParam / crypto_encrypt / crypto_decrypt
nb_encrypt(crypto_param_t*, u8*, u16, u8*)   nb_decrypt(...)
Key_rule_analysis(u8*, u8*, key_rule_t*)     ← 每消息密钥派生
AES_init_ctx / AES_ECB_encrypt / AES_ECB_decrypt   (tiny-AES)
Encryption::rc4 / rc4_init / rc4_setup / rc4_crypt  ← 载荷流加密
MD5::encode / MD5::decode, mbedtls_sha1*
Java_cn_ninebot_nbcrypto_NbEncryption_crypto_{init,setKey,setAuthParam,encrypt,decrypt}
```

会话密钥由 `setAuthParam` 协商 + `Key_rule_analysis` 派生，**框架内的 32 字节即每次的密钥材料**。
要解密必须完整逆出该函数——属于多日工作量，且逆出来后还需逐包提取密钥材料。

### 3.4 顺带确认：另一套「版本+时间戳」加密（非此层）

`cn.ninebot.lib.authcenter.utils.SignatureUtil` 有另一套，供登录/鉴权类接口使用：

```java
key    = SHA256(app_version + timestamp + os)[0:16]     // 三个值都在明文请求头里
cipher = AES/ECB/PKCS5Padding(Base64(Base64(plaintext)))
输出   = Base64(Base64(ciphertext))
```

这套**不是** `cnnx-omsgw` 轨迹接口用的（已实测不符），记录在此备用。

---

## 四、第2层：`.nb` 资源文件 —— 已破解

### 4.1 在哪里

`assets/backup_config.nb`（215 KB）以及从服务端下发的 RN 模块包。

格式：**明文 base64 文本 → AES-128-CBC → PKCS7 去填充**

### 4.2 KEY / IV 怎么来的

藏在 `lib/arm64-v8a/libnativesecrets.so` 的 JNI 函数里：

```
Java_cn_ninebot_nativesecrets_NativeSecrets_nativeDynamicConfigKey   @0x15c88
Java_cn_ninebot_nativesecrets_NativeSecrets_nativeDynamicConfigIV    @0x15d80
```

常量**不是**明文字符串，而是逐字节 XOR 混淆后由 ADRP 指向的两张表。反汇编后是一个循环：

```asm
strb   w12, [sp, #1]          ; 字符串首字符 0x54 ('T')
adrp   x10, #0xd000; add x10, x10, #0x9d0   ; 密文表 A @0xd9d0
adrp   x11, #0xd000; add x11, x11, #0xb8f   ; 掩码表 M @0xdb8f
loop i = 1..15:
    w13 = A[i]
    w14 = M[i & 7]
    ss[i] = w13 ^ w14
```

掩码表原文恰好是 **`N9BotSec`**（8 字节），可作为解对与否的自校验。

还原结果：

```
KEY = IV = TOGfX#qkYm@0t{83        (hex: 544f47665823716b596d4030747b3833)
```

> **这就是传说中「6.10.11 这一版特有的坑」**：常量不再以明文字符串形式存放，
> 而是按字节 XOR 打散进立即数与两张地址表，常规 `strings` 扫不出来。

### 4.3 解开后是什么

`assets/backup_config.nb` 解出来是 RN 动态配置 JSON，含 3 个顶层键：`rn` / `pkg` / `searchConfig`，
其中 `rn` 下是 **65 个业务模块**的下载 URL、版本号，以及各自的 key/iv（65 个模块共用一套）：

```
key = ",]Q&STDIg@ZcQ.6t"
iv  = "bCGRM{TR&UHzC-2r"
```

`searchConfig` 里还标明了车型归类：

```json
"assisted_ebike": { "host": "https://cnnx-omsgw.ninebot.com" }   ← 电助力车走这个网关
```

---

## 五、第3层：RN 业务模块 —— 已破解，且是决定性证据

以轨迹模块 `TrackNew` v905 为例（下载 URL 公开，无需鉴权）：

```
https://oms-oss-public.ninebot.com/device-config/rn/1789710796587_TrackNew_android_v905_inland.zip
```

解开后是 **Hermes 字节码包**（magic `C61FBC03C103191F`），含 15967 条 JS 字符串。
在其中检索到以下**全部存在**：

| 证据 | 含义 |
|---|---|
| `speedChartData` | 速度曲线数据源仍在 |
| `TrackDetail.speedHigh / speedMidHigh / speedMid / speedLow` | 速度分档标签文案仍在 |
| `TrackDetail.speedDashLine` | 速度虚线（参考线）仍在 |
| `TrackDetail.ridingSpeedHighestSpeed / ridingSpeedMidHigh / ridingSpeedMidLow` | 骑行速度档位文案仍在 |
| `TrackDetail.fastLabel / slowLabel` | 快/慢标签仍在 |
| `averageSpeedLineColorDark/Light`、`averageSpeedTextColorDark/Light` | 平均速度曲线主题配色仍在 |
| `avgLineColorDark`、`avgTextColorDark` | 平均速度图例仍在 |
| `TrackDetail.avgSpeed`、`TrackDetail.shareAvgSpeed` | 详情页与分享卡速度文案仍在 |
| `config.restSpeedThreshold` | 静止速度阈值配置仍在 |

同时**检索不到任何客户端隐藏开关**：`showSpeed` / `isSpeed` / `hideSpeed` /
`speedSwitch` / `compliance` / `nationalStandard` **全部 0 命中**。

### ⇒ 结论

**新 APP 的客户端代码完全没有删除速度功能。** 既然 UI 俱全却看不到速度，
只能说明：**服务端没有下发速度字段**。这个问题在 APP 侧、通过网络层是改不出来的。

---

## 六、下一步：验证「服务端按 APP 版本下发」

既然客户端没开关，社区反馈「降级到 6.6.8 就恢复」就有了另一种解释——
**旧版 APP 的请求头让服务端返回了完整数据**（很可能依据 `app-version` / `client-ver` / `ninebot-version`）。

这些请求头都是**明文**的，Loon 完全可以改写 ⇒ 不需要破解加密。

本仓库提供 `ninebot-probe.plugin` 做这个验证：

1. 先设 `SPOOF = false` 跑一次，记录 `travel/query-info` 的响应字节数（基线）
2. 再设 `SPOOF = true`（伪装旧版版本号）跑一次
3. **若同一接口响应明显变大 ⇒ 假设成立**，调版本常量直到拿到含速度的响应
4. 若完全不变 ⇒ 服务端不按版本区分，需另找条件（车型 / region）

因为响应是加密的，**唯一可观测信号就是长度变化**，但这已足够判定。

### 如何确定旧版版本号

需要一份 6.6.8 的 APK：安装后抓包看它的 `app-version` / `client-ver` 值，
或直接用本仓库的 `ninebot_kit.py key <旧版APK>` 走同一流程。

---

## 七、工具包用法

```bash
pip install cryptography capstone

# 1) 从 APK 提取 DYNAMIC_CONF 的 KEY/IV（含自校验）
python ninebot_kit.py key 九号出行_6.10.11_官方原版.apk

# 2) 导出 RN 动态配置：65 个模块的 URL + key/iv
python ninebot_kit.py rnconfig 九号出行_6.10.11_官方原版.apk

# 3) 下载并解密指定 RN 模块，顺带导出包内 JS 字符串
python ninebot_kit.py fetch TrackNew --strings

# 4) 单独解密某个 .nb 文件
python ninebot_kit.py nb backup_config.nb --key 'TOGfX#qkYm@0t{83}'
```

实测输出：

```
DYNAMIC_CONF KEY = TOGfX#qkYm@0t{83}
自校验：assets/backup_config.nb -> IV=KEY 成功 ✓ {"rn":[{"applyRegion":["bj"],"detail":[{"modul
```

---

## 七之二、两代 API 之别（探针实测更新）

**伪装 app-version 请求头的探针实测：响应字节数无变化 ⇒ 服务端不按 APP 版本下发。**

真正的原因是新旧 RN 模块用了**两代不同的 API**（解密两个 bundle 后对比得出）：

| | 旧模块 `Track v774` | 新模块 `TrackNew v905` |
|---|---|---|
| 详情 | `/app-api/travel/**v6**/travel-**info**` | `/app-api/travel/**v1**/travel/**query-info**` |
| 列表 | `/app-api/travel/v6/travel-list-v2` | `/app-api/travel/v1/travel/query-list` |
| 合并 | `/app-api/travel/v6/combine-travel` | `/app-api/travel/v1/travel/update` |
| 删除 | `/app-api/travel/v6/deleteItem` | `/app-api/travel/v1/travel/deleteItems` |

⇒ **降级 APP 到 6.6.8 之所以能显示速度，不是因为服务端看版本号，而是因为旧 APP 调的是老 v6 接口**，
而老接口大概率还没做合规剔除。

### 验证方法：`ninebot-probe.plugin` v2（改道探针）

把 `http-request` 的 URL 改成老接口路径，Loon 会沿用原加密请求体原样转发（`requires-body` 无需开启），
再用 `http-response` 比对状态码与字节数。每打开一次轨迹详情页自动轮换下一个候选，跑 3 次即可定性。

```
https://cdn.jsdelivr.net/gh/JwOKR/ninebot-loon@e1510de/ninebot-probe.plugin
```

| 观测结果 | 结论 |
|---|---|
| 改道后 **200 且响应明显大于基线** | 老接口活着且返回更多字段，速度数据就在里面 |
| 改道后 **200 但响应很小** | 接口活着但参数结构不兼容，需要进一步对齐入参 |
| 改道后 **404 / 4xx / 5xx** | 老接口已下线，网络层彻底无解 |
| 与基线一致 | 服务端按接口版本而非请求头区分，仍需解码才能确认 |

改道期间 APP 大概率会报错或显示异常，属预期现象。

---

## 八、文件清单

| 文件 | 说明 |
|---|---|
| `ninebot_kit.py` | 离线分析工具包（提取KEY / 解密.nb / 导出RN配置 / 下载解密模块） |
| `ninebot-probe.plugin` | Loon 探针插件 v2：把 v1 请求改道给 v6 老接口 + 响应体积对比 |
| `probe-v6.js` | `http-request` 脚本：轮换候选地把新接口请求改道到老接口 |
| `probe-size.js` | `http-response` 脚本：记录状态码与字节数，通知里直接出对比 |
| `probe-spoof.js` | 上一版：伪装旧版 APP 请求头（已证实无效，保留作记录） |
| `ninebot-speed.plugin` | 早期版本的速度注入插件（因第1层加密不可行，保留作记录） |
| `ninebot-debug.js` / `ninebot-speed.js` | 早期捕获与 GPS 算速注入脚本（同上，保留作记录） |

---

## 九、合规声明

本仓库只做**本地离线数据解析**，用于理解自有设备的数据格式。
不涉及车辆固件修改、不限速解除、不伪造上行控制指令（那才是违法改装）。
请勿将本工具用于违反厂商服务条款或法律法规的用途。

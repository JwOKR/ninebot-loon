# 九号 business-type 枚举（反编译自 classes14.dex）

类：`cn.ninebot.commonlibs.nbnet.BusinessType`
请求头：`business-type`（值 = 十进制数字字符串）

| 常量 | 值 | 说明 |
|---|---|---|
| `TYPE_UNKNOWN` | 0 | 未知 |
| `TYPE_MOTOR_STEELDUST` | **1** | 电动摩托/电自 steeldust 类目（唯一确认下发轨迹速度） |
| `TYPE_MOTOR_EBIKE` | **2** | 九号电动主流类目（无速度） |
| `TYPE_ASSISTED_EBIKE` | 3 | 电助力 |
| `TYPE_ARMOR` / `TYPE_BALANCE` / `TYPE_CUBE` / `TYPE_KART` / `TYPE_SCOOTER` / `TYPE_SPEAKER` / `TYPE_UNICYCLE` | 4 | 共用同一值（旧品类兼容） |
| `TYPE_ORV` | 5 | 全地形车 |

相关：`CommonHttpClient#getServerCode(String)` 按 business-type 决定 server code，
与动态配置 `hosts.host_key -> host` 映射一致（客户端用它选网关）。

实测样本：用户车 `client-ver=610123841`（6.10.12）、`rn-module=TrackNew`、`rn-ver=910`、
`net-version=1.0.13`、`business-type=2`、`host=cnnx-omsgw.ninebot.com`。

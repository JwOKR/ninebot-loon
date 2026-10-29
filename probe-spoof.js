// ============================================================
// 九号出行 · 速度数据下发条件探针
// ============================================================
// 逆向结论：TrackNew v905 的 RN 包里，速度曲线 UI 代码完整存在
//   (speedChartData / TrackDetail.speedHigh / averageSpeedLineColorDark ...)
//   且没有任何 "showSpeed / hideSpeed / compliance" 之类的客户端开关。
// => 最可能的情况是：服务端按某种条件（很可能是 APP 版本 / 车辆类目）
//    决定是否下发 speed 相关字段。
//
// 本插件用「伪造成旧版 APP 的请求头」来验证这个假设：
//   1) 先关掉 SPOOF 跑一次，记录 track 接口的响应字节数（基线）
//   2) 打开 SPOOF 再跑一次，若同一接口响应明显变大 => 服务端确实按版本下发，
//      此时把 SPOOF_APP_VERSION 调到能拿到速度的那个版本即可。
// ============================================================

var SPOOF = true;                 // true = 伪装成旧版 APP
var SPOOF_APP_VERSION = '606008000'; // 旧版 APP 版本号位（6.6.8 -> 6 06 008 xxx 结构，需按实测调整）
var SPOOF_CLIENT_VER  = '606008000';
var SPOOF_NINEBOT_VER = '3';      // 旧版协议版本，当前 new app 为 4
var BASELINE_KEY = 'nb_probe_baseline';

function out(o) { $done(o); }

(function () {
  var TARGET = /cnnx-omsgw\.ninebot\.com\/app-api\/travel/;

  try {
    if (typeof $request === 'undefined') {
      if (typeof $notification !== 'undefined') {
        $notification.post('九号速度探针', '缺少请求上下文', '请通过真实请求触发，勿点运行按钮');
      }
      return;
    }

    var url = ($request.url || '');
    if (!TARGET.test(url)) return out({});

    var headers = $request.headers || {};

    if (SPOOF) {
      if (headers['app-version']) headers['app-version'] = SPOOF_APP_VERSION;
      if (headers['client-ver']) headers['client-ver'] = SPOOF_CLIENT_VER;
      if (headers['ninebot-version']) headers['ninebot-version'] = SPOOF_NINEBOT_VER;
    }

    out({ headers: headers });
  } catch (e) {
    out({});
  }
})();

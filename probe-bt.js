// ============================================================
// 九号出行 · business-type 数值伪装探针 v9
// ============================================================
// v8 实测：请求头 business-type 的值是【数字】"2"，不是类目名字符串。
//
// 从 classes14.dex 反编译 cn.ninebot.commonlibs.nbnet.BusinessType 拿到的枚举：
//   TYPE_MOTOR_STEELDUST   = 1   ← 唯一确认会显示轨迹速度的类目
//   TYPE_MOTOR_EBIKE       = 2   ← 用户当前值（无速度）
//   TYPE_ASSISTED_EBIKE    = 3
//   TYPE_ARMOR/BALANCE/CUBE/KART/SCOOTER/SPEAKER/UNICYCLE = 4
//   TYPE_ORV               = 5
//   TYPE_UNKNOWN           = 0
//
// 策略：只改 business-type 的数值，其余请求头与加密请求体原样不动。
//      轮次 0 不改（读出真实值）；之后依次 1 / 3 / 4 / 5 / 0。
//
// 判读：字节数 ≈15556B = 该类目同样无速度；
//      明显变大 = 命中；明文 code = 网关拒绝跨类目。
// ============================================================

var CANDIDATES = [
  null,   // 0 基线：不改，读出真实值
  1,      // 1 TYPE_MOTOR_STEELDUST ★核心目标
  3,      // 2 TYPE_ASSISTED_EBIKE
  4,      // 3 其它小类（滑板车/平衡车/卡丁车…）
  5,      // 4 TYPE_ORV
  0       // 5 TYPE_UNKNOWN
];

var LABEL = {
  '0': 'UNKNOWN',
  '1': 'MOTOR_STEELDUST',
  '2': 'MOTOR_EBIKE',
  '3': 'ASSISTED_EBIKE',
  '4': 'OTHER(armor/balance/cube/kart/scooter/speaker/unicycle)',
  '5': 'ORV'
};

var STORE_ROUND = 'nb_bt_round_v9';
var STORE_ROUTE = 'nb_bt_last';

function label(v) {
  var s = String(v);
  return s + ' (' + (LABEL[s] || '?') + ')';
}

(function () {
  try {
    if (typeof $request === 'undefined' || !$request || !$request.url) {
      if (typeof $notification !== 'undefined') {
        $notification.post('九号伪装探针', '缺少请求上下文', '请通过真实请求触发，不要点「运行」按钮');
      }
      return $done({});
    }

    var url = String($request.url);
    if (url.indexOf('/app-api/travel/v1/travel/query-info') < 0) return $done({});

    var headers = $request.headers || {};

    var btKey = null;
    for (var k in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
      if (String(k).toLowerCase().replace(/[_-]/g, '') === 'businesstype') { btKey = k; break; }
    }
    var btOrig = btKey ? String(headers[btKey]) : '(不存在)';

    var round = 0;
    try { round = parseInt($persistentStore.read(STORE_ROUND) || '0', 10); } catch (e) {}
    if (isNaN(round) || round < 0) round = 0;
    var idx = round % CANDIDATES.length;
    try { $persistentStore.write(String(round + 1), STORE_ROUND); } catch (e) {}

    var cand = CANDIDATES[idx];

    if (cand === null) {
      try { $persistentStore.write('BASE', STORE_ROUTE); } catch (e) {}
      if (typeof $notification !== 'undefined') {
        $notification.post(
          '九号伪装 · 0/5 基线',
          '当前真实类目 = ' + label(btOrig),
          'rn-module: ' + (headers['rn-module'] || '') +
          '\nclient-ver: ' + (headers['client-ver'] || '') +
          '\n下一步将伪装 1(MOTOR_STEELDUST)'
        );
      }
      return $done({});
    }

    if (btKey) headers[btKey] = String(cand);
    else headers['business-type'] = String(cand);

    try { $persistentStore.write('BT|' + label(cand), STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post(
        '九号伪装 · ' + idx + '/5 改类目',
        btOrig + '  →  ' + label(cand),
        cand === 1 ? '★重点：steeldust 类目下发了速度'
                   : '对照轮次'
      );
    }

    // 只回写 headers，不传 body => 加密请求体原样沿用
    $done({ headers: headers });
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

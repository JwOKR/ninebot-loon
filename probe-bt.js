// ============================================================
// 九号出行 · business-type 伪装探针 v8
// ============================================================
// 依据（v7 导出 30 个请求头）：
//   business-type, cookie, rn-version, uid, net-version, host, priority,
//   access-token, rn-module, client-ver, content-length, device-id,
//   request-id, sys-language, access_token, accept-encoding, accept,
//   rn-ver, login-country, user-agent, platform, service-time, ...
//
// business-type 就是【业务线 / 车型类目】标识，也就是动态配置里的 host_key
// （steeldust / ebike / os_ebike / assisted_ebike ...）。
// 它是明文请求头 => 可以被改写。而环境维度已被证伪（6 个网关同库同数据）。
//
// 策略：每轮把 business-type 换成一个候选类目，其余头与加密请求体原样不动，
//      看响应字节数是否明显变大（>16000 说明多下发了字段）。
//      轮次 0 = 不动，用来读出你当前的真实类目值。
//
// 判读：
//   某轮字节数 ≈ 15500  → 该类目同样无速度
//   某轮字节数 明显更大 → 命中！该类目下发了速度字段
//   明文 code 错误      → 网关拒绝了不属于该业务线的车（也是有效信息）
// ============================================================

var CANDIDATES = [
  null,             // 0 基线：不改，只读出当前 business-type 真实值
  'steeldust',      // 1 唯一确认会显示速度的类目
  'STEELDUST',
  'steeldust-os',
  'ebike',
  'os_ebike',
  'assisted_ebike'
];

var STORE_ROUND = 'nb_bt_round';
var STORE_ROUTE = 'nb_bt_last';

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

    // 找出头里 business-type 的原始值（大小写/短横线可能有变体）
    var btKey = null;
    for (var k in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
      var norm = String(k).toLowerCase().replace(/[_-]/g, '');
      if (norm === 'businesstype') { btKey = k; break; }
    }
    var btOrig = btKey ? String(headers[btKey]) : '(头中不存在)';
    var hostOrig = headers['host'] || headers['Host'] || '';
    var rnModule = headers['rn-module'] || '';
    var rnVer = headers['rn-ver'] || headers['rn-version'] || '';
    var clientVer = headers['client-ver'] || '';
    var netVer = headers['net-version'] || '';

    var round = 0;
    try { round = parseInt($persistentStore.read(STORE_ROUND) || '0', 10); } catch (e) {}
    if (isNaN(round) || round < 0) round = 0;
    var idx = round % CANDIDATES.length;
    try { $persistentStore.write(String(round + 1), STORE_ROUND); } catch (e) {}

    var cand = CANDIDATES[idx];
    var brief = 'business-type: ' + btOrig +
                '\nrn-module: ' + rnModule +
                '\nrn-ver: ' + rnVer +
                '\nclient-ver: ' + clientVer +
                '\nnet-version: ' + netVer +
                '\nhost: ' + hostOrig;

    if (!cand) {
      try { $persistentStore.write('BASE', STORE_ROUTE); } catch (e) {}
      if (typeof $notification !== 'undefined') {
        $notification.post('九号伪装 · 0/6 基线', '读出当前真实类目', brief);
      }
      return $done({});
    }

    // 改写 business-type（保留原 key 的写法；若原头不存在则用标准写法补上）
    if (btKey) headers[btKey] = cand;
    else headers['business-type'] = cand;

    // 不改道，只改类目头；host 头保持原样
    try { $persistentStore.write('BT|' + cand, STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post(
        '九号伪装 · ' + idx + '/6 改类目',
        btOrig + '  →  ' + cand,
        brief
      );
    }

    // 只回写 headers，不传 body => 加密请求体原样沿用
    $done({ headers: headers });
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

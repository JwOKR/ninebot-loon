// ============================================================
// 九号出行 · 网关改道探针 v5
// ============================================================
// 逆向新发现（动态配置 hosts 表）：
//   assisted_ebike      -> https://cnnx-omsgw.ninebot.com        <- 你当前打的
//   assisted_ebike_os   -> https://fra-oms-gateway.ninebot.com   <- 欧洲区孪生
//   ebike               -> https://ebike.ninebot.com
//   os_ebike            -> https://ebike-os.ninebot.com
//   steeldust           -> https://steeldust.ninebot.com
// 你的车属 assisted_ebike 组（仅 5 款电助力：Xyber/Xafari/MUXI/Myon/Xyber Air），
// 走的是独立后端，很可能该后端的轨迹接口就没有实现速度下发。
//
// 本脚本每次触发轮换一个候选网关，只替换 scheme+host，路径和 query 原样保留。
// 轮次 0 = 基线原样放行；之后依次改道到欧区 / ebike / os_ebike / steeldust。
// 配合 probe-dump.js 观察：状态码、字节数、响应体是明文错误还是加密信封。
// 判断标准：某个网关返回 200 且字节数明显大于基线 => 那套后端返回了更多字段。
// ============================================================

var CANDIDATES = [
  null,                                   // 轮次0：基线，原样放行
  'https://fra-oms-gateway.ninebot.com',  // 欧区 assisted_ebike_os
  'https://ebike.ninebot.com',
  'https://ebike-os.ninebot.com',
  'https://steeldust.ninebot.com'
];

var STORE_ROUND = 'nb_probe_round2';
var STORE_ROUTE = 'nb_probe_last_route';

(function () {
  try {
    if (typeof $request === 'undefined' || !$request || !$request.url) {
      if (typeof $notification !== 'undefined') {
        $notification.post('九号网关探针', '缺少请求上下文', '请通过真实请求触发，不要点「运行」按钮');
      }
      return $done({});
    }

    var origin = String($request.url);
    if (origin.indexOf('/app-api/travel/v1/travel/query-info') < 0) return $done({});

    var round = 0;
    try { round = parseInt($persistentStore.read(STORE_ROUND) || '0', 10); } catch (e) {}
    if (isNaN(round) || round < 0) round = 0;
    var idx = round % CANDIDATES.length;
    try { $persistentStore.write(String(round + 1), STORE_ROUND); } catch (e) {}

    if (!CANDIDATES[idx]) {
      try { $persistentStore.write('PASS|' + origin, STORE_ROUTE); } catch (e) {}
      if (typeof $notification !== 'undefined') {
        $notification.post('九号网关探针', '基线 · 原样放行', 'cnnx-omsgw 原样，记录真实响应大小');
      }
      return $done({});
    }

    var schemeEnd = origin.indexOf('//');
    var slashAfterHost = origin.indexOf('/', schemeEnd + 2);
    var pathQuery = slashAfterHost >= 0 ? origin.slice(slashAfterHost) : '/';
    var newUrl = CANDIDATES[idx] + pathQuery;

    try { $persistentStore.write('H' + idx + '|' + newUrl, STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post('九号网关探针', '轮次' + idx + ' · 改道', CANDIDATES[idx]);
    }

    // 不传 body / headers => 沿用原加密请求体与原请求头
    $done({ url: newUrl });
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

// ============================================================
// 九号出行 · OMS 网关环境改道探针 v6
// ============================================================
// 本轮修正（重要）：
//   上一版把 cnnx-omsgw 当成 assisted_ebike 专属网关，是错的。
//   实际它是【中国区 OMS 出行网关】，同族还有 dev/test3/eu/fra/sg 等环境，
//   所有车型的轨迹(travel)接口统一走 OMS。
//   已实测（本地直连 GET）：
//     cnnx-omsgw / cn-dev-oms-gateway / cn-test3-oms-gateway
//     eu-oms-gateway / fra-oms-gateway / sg-test1 / sg-uat
//        => 全部 HTTP 200，93 字节，明文 {"code":500001,"desc":"Service error..."}
//     steeldust / ebike / ebike-os
//        => HTTP 404 "request not found!"（车型网关根本没有 travel 接口）
//   => 所以本版只轮换 OMS 同族网关，车型网关已剔除。
//
// 为什么值得再试一枪：
//   新国标速度剔除、以及响应体加密，通常只在【生产环境】开启；
//   dev / test3 / 欧区环境常常关闭这两项。
//   请求体我们原样沿用（加密体不改），只要目标网关用同一套密钥，
//   就能解密入库查到同一条轨迹；若那套环境返回明文 JSON，
//   我们就能直接看到完整字段，判断是否含速度。
//
// 判断标准（看「九号响应体」通知）：
//   HTTP 200 + 93B      = 服务错误，请求没被接受（无效）
//   HTTP 200 + 万级字节 = 命中！看是明文还是信封
//   ★明文 JSON          = 最大成功，通知里直接贴出字段
//   加密信封 a=...      = 该环境也加密，继续轮换
// ============================================================

var CANDIDATES = [
  null,                                       // 0 基线：cnnx-omsgw 原样
  'https://cn-dev-oms-gateway.ninebot.com',   // 1 开发环境（最可能关加密/关合规）
  'https://cn-test3-oms-gateway.ninebot.com', // 2 测试环境
  'https://eu-oms-gateway.ninebot.com',       // 3 欧洲区
  'https://fra-oms-gateway.ninebot.com',      // 4 欧区 assisted_ebike_os
  'https://sg-test1-oms-gateway.ninebot.com', // 5 新加坡测试
  'https://sg-uat-oms-gateway.ninebot.com'    // 6 新加坡 UAT
];

var STORE_ROUND = 'nb_probe_round3';
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
        $notification.post('九号网关探针', '0/6 基线 · 原样放行', 'cnnx-omsgw 原样，记录真实响应大小');
      }
      return $done({});
    }

    var schemeEnd = origin.indexOf('//');
    var slashAfterHost = origin.indexOf('/', schemeEnd + 2);
    var pathQuery = slashAfterHost >= 0 ? origin.slice(slashAfterHost) : '/';
    var newUrl = CANDIDATES[idx] + pathQuery;

    try { $persistentStore.write('H|' + newUrl, STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post(
        '九号网关探针',
        idx + '/' + (CANDIDATES.length - 1) + ' · 改道',
        CANDIDATES[idx].replace('https://', '')
      );
    }

    // 不传 body / headers => 沿用原加密请求体与原请求头
    $done({ url: newUrl });
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

// ============================================================
// 九号出行 · 改道探针 v4（基线 / 改道 交替）
// ============================================================
// 逆向结论回顾：
//   旧模块 Track v774    -> /app-api/travel/v6/travel-info
//   新模块 TrackNew v905 -> /app-api/travel/v1/travel/query-info
// 新版 APP 只调 v1，v1 不返回速度字段。
//
// 本脚本每次触发时在两种模式间交替：
//   偶数次 -> PASS：原样放行，拿到真实 v1 响应（对照基线）
//   奇数次 -> V6  ：改道到老接口 /app-api/travel/v6/travel-info
//
// 配合 probe-dump.js 观察：状态码 / 字节数 / 响应体是明文错误还是加密信封。
// 每打开一次「轨迹详情」就前进一格，点两次即可拿到对照。
// 注意：改道那次 APP 大概率报错，属正常现象。
// ============================================================

var V6_PATH = '/app-api/travel/v6/travel-info';
var STORE_ROUND = 'nb_probe_round';
var STORE_ROUTE = 'nb_probe_last_route';

(function () {
  try {
    if (typeof $request === 'undefined' || !$request || !$request.url) {
      if (typeof $notification !== 'undefined') {
        $notification.post('九号改道探针', '缺少请求上下文', '请通过真实请求触发，不要点「运行」按钮');
      }
      return $done({});
    }

    var origin = String($request.url);
    // 只针对新版「轨迹详情」接口，其余一律不动
    if (origin.indexOf('/app-api/travel/v1/travel/query-info') < 0) return $done({});

    var round = 0;
    try { round = parseInt($persistentStore.read(STORE_ROUND) || '0', 10); } catch (e) {}
    if (isNaN(round) || round < 0) round = 0;
    try { $persistentStore.write(String(round + 1), STORE_ROUND); } catch (e) {}

    var isBaseline = (round % 2 === 0);

    if (isBaseline) {
      try { $persistentStore.write('PASS|' + origin, STORE_ROUTE); } catch (e) {}
      if (typeof $notification !== 'undefined') {
        $notification.post('九号改道探针', '基线 · 原样放行', '记录真实 v1 响应，下一次自动改道 v6');
      }
      return $done({});
    }

    // 只替换 path，保留 query
    var qpos = origin.indexOf('?');
    var query = qpos >= 0 ? origin.slice(qpos) : '';
    var schemeEnd = origin.indexOf('//');
    var slashAfterHost = origin.indexOf('/', schemeEnd + 2);
    var prefix = slashAfterHost >= 0 ? origin.slice(0, slashAfterHost) : origin;
    var newUrl = prefix + V6_PATH + query;

    try { $persistentStore.write('V6|' + newUrl, STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post('九号改道探针', '改道 v6', V6_PATH);
    }

    // 不传 body / headers => 沿用原加密请求体与原请求头
    $done({ url: newUrl });
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

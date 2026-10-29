// ============================================================
// 九号出行 · 响应探针（配合 probe-v6.js 改道探针使用）
// ============================================================
// 响应体是 nbcrypto 加密的，唯一可观测的信号是「状态码 + 字节数」。
// 每次 Together with 改道探针轮换候选，这里把结果记录下来：
//
//   老接口 200 且响应明显大于基线  => 老接口还活着且返回更多字段（大概率含速度）
//   老接口 200 但响应很小          => 接口活着但参数不兼容（缺字段/报错 JSON）
//   老接口 404 / 4xx / 5xx        => 已下线，改道路线走不通
//   两者都差不多                  => 服务端确实按数据结构而非版本区分
// ============================================================

var SIZE_KEY = 'nb_probe_sizes_v2';
var ROUTE_KEY = 'nb_probe_last_route';

(function () {
  try {
    if (typeof $request === 'undefined' || typeof $response === 'undefined') return $done({});

    var url = $request.url || '';
    if (!/ninebot\.com\/app-api\/travel/.test(url)) return $done({});

    var body = $response.body;
    var len = body ? body.length : 0;
    var status = $response.status || 0;
    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    var label = '原样';
    try {
      var r = $persistentStore.read(ROUTE_KEY);
      if (r && r.indexOf('|') > 0) {
        var idx = r.split('|')[0];
        label = (idx === 'BASELINE' || idx === '0') ? '轮次0基线' : ('轮次' + idx + '改道');
      }
    } catch (e) {}

    var store = {};
    try { store = JSON.parse($persistentStore.read(SIZE_KEY) || '{}'); } catch (e) { store = {}; }

    var key = label + ' ' + path.slice(-45);
    var prev = store[key];
    var msg = 'HTTP ' + status + ' · ' + len + ' 字节';
    if (prev && typeof prev === 'number') {
      var diff = len - prev;
      if (diff > 0) msg += ' (+' + diff + ' ⬆ 变大)';
      else if (diff < 0) msg += ' (' + diff + ' ⬇ 变小)';
      else msg += ' (与上次一致)';
    }
    store[key] = len;
    try { $persistentStore.write(JSON.stringify(store), SIZE_KEY); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post('九号速度探针', key, msg);
    }
    $done({});
  } catch (e) {
    $done({});
  }
})();

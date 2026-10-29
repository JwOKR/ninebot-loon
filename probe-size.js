// ============================================================
// 九号出行 · 响应体大小探针（配合 probe-spoof.js 使用）
// ============================================================
// 统计同一接口在「原版请求头」与「伪装旧版请求头」下的加密响应字节数。
// 因为响应体是加密的，唯一可观测的信号就是长度变化：
//   变长 => 服务端多下发了字段（很可能就是 speed 相关字段）
//   不变 => 服务端不按 APP 版本区分，需换思路
// 结果通过 $notification 弹出，并写入 $persistentStore。
// ============================================================

var KEY = 'nb_probe_sizes';

(function () {
  try {
    if (typeof $request === 'undefined' || typeof $response === 'undefined') return $done({});

    var url = $request.url || '';
    if (!/cnnx-omsgw\.ninebot\.com\/app-api\/travel/.test(url)) return $done({});

    var body = $response.body;
    var len = body ? body.length : 0;
    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    var store = {};
    try { store = JSON.parse($persistentStore.read(KEY) || '{}'); } catch (e) { store = {}; }

    var prev = store[path];
    var msg;
    if (!prev) {
      msg = '首次记录 ' + len + ' 字节';
    } else {
      var diff = len - prev.best;
      msg = '上次 ' + prev.best + ' -> 本次 ' + len + ' 字节 (' +
            (diff > 0 ? '+' : '') + diff + ')';
      if (len > prev.best) msg += ' ⬆ 变大了';
      else if (len < prev.best) msg += ' ⬇ 变小了';
      else msg += ' 无变化';
    }
    store[path] = { best: Math.max(prev ? prev.best : 0, len), last: len };
    try { $persistentStore.write(JSON.stringify(store), KEY); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post('九号速度探针', path.slice(-40), msg);
    }
    $done({});
  } catch (e) {
    $done({});
  }
})();

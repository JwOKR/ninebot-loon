// ============================================================
// 九号出行 · 响应体判读探针 v6
// ============================================================
// 匹配【原始请求 URL】（v1/travel/query-info），不受请求改写影响。
// 输出：当前模式 / HTTP 状态码 / 字节数 / 响应体性质。
//
// 判读表：
//   ┌ HTTP 200 + ~93B  + code:500001  → 服务错误，请求未被接受（该网关无效）
//   ├ HTTP 200 + 万级字节 + {"a":"…"} → 加密信封，该环境也加密
//   ├ HTTP 200 + 万级字节 + ★明文JSON → 命中！直接看字段里有没有速度
//   └ 其他                             → 网关拒绝
// 明文时会自动检索 speed / maxSpeed / avgSpeed 等关键字并报告是否出现。
// ============================================================

(function () {
  try {
    if (typeof $response === 'undefined') return $done({});

    var url = '';
    if (typeof $request !== 'undefined' && $request && $request.url) url = String($request.url);
    var status = $response.status || 0;
    var body = $response.body;
    var s = (typeof body === 'string') ? body : '';
    s = s.replace(/^\s+/, '');

    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    var mode = '未知';
    try {
      var r = $persistentStore.read('nb_probe_last_route') || '';
      if (r.indexOf('PASS') === 0) mode = '基线 cnnx-omsgw';
      else if (r.indexOf('V6') === 0) mode = '改道 v6';
      else if (r.indexOf('H|') === 0) {
        var h = r.split('|')[1] || '';
        mode = '改道 ' + h.replace(/^https?:\/\//, '').split('/')[0];
      }
    } catch (e) {}

    var title = mode + ' · HTTP ' + status + ' · ' + s.length + 'B';
    var info = '';
    var big = false;

    if (!s) {
      info = '空响应体';
    } else if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      var parsed = null;
      try { parsed = JSON.parse(s); } catch (e2) {}
      if (!parsed) {
        info = '类JSON但解析失败: ' + s.slice(0, 200);
      } else if (parsed && typeof parsed.a === 'string') {
        info = '加密信封 a=' + parsed.a.length + ' 字符\n' + s.slice(0, 50);
      } else {
        var flat = JSON.stringify(parsed);
        var code = (parsed.code !== undefined) ? String(parsed.code) : '';
        if (code === '500001' || code === '404' || code === '401' || code === '403') {
          info = '✗ 业务拒绝 code=' + code + '\n' + flat.slice(0, 240);
        } else {
          big = true;
          info = '★★明文JSON★★\n' + flat.slice(0, 700);
          var keys = ['speed', 'Speed', 'maxSpeed', 'avgSpeed', 'velocity'];
          var found = [];
          for (var i = 0; i < keys.length; i++) {
            if (flat.indexOf(keys[i]) >= 0) found.push(keys[i]);
          }
          info += '\n【速度字段】' + (found.length ? '命中 ' + found.join(',') : '未出现');
        }
      }
    } else if (s.charAt(0) === '<') {
      info = 'HTML/网关页: ' + s.slice(0, 150);
    } else {
      info = '非JSON: ' + s.slice(0, 200);
    }

    var ct = '';
    try {
      if ($response.headers) {
        ct = $response.headers['Content-Type'] || $response.headers['content-type'] || '';
      }
    } catch (e3) {}

    if (typeof $notification !== 'undefined') {
      $notification.post(
        big ? '★九号响应体·明文' : '九号响应体',
        title + (ct ? ' · ' + ct.split(';')[0] : ''),
        info + '\n' + path
      );
    }

    $done({});
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

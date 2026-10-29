// ============================================================
// 九号出行 · 响应体 + 字节数 一体探针 (v4)
// ============================================================
// 修复 v3 的致命 bug：
//   Loon 的 http-response 脚本是按【原始请求 URL】匹配的，
//   请求改写（$done({url})) 只改变实际发出去的地址，不改匹配依据。
//   所以 v3 里匹配 .../travel/v6 的 nb-body 一次都没被触发过。
//   现在改为：请求脚本周转 0=基线原样放行 / 1=改道 v6，
//   响应脚本固定匹配原始 URL（v1/travel/query-info），同时输出
//   状态码、字节数、以及响应体前半段内容。
//
// 三种结果的含义：
//   1) 明文 JSON 带 code/msg   => 拿到 v6 失败的确切原因，可以判定是否还有救
//   2) 仍是 {"a":"..."} 信封   => v6 也走同一套业务加密，此路不通
//   3) 空 / 非 JSON / HTML     => 网关直接拒绝，此路不通
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

    // 当前处于哪个模式（由 probe-route.js 写入）
    var mode = '未知';
    try {
      var r = $persistentStore.read('nb_probe_last_route') || '';
      if (r.indexOf('PASS') === 0) mode = '基线原样';
      else if (r.indexOf('V6') === 0) mode = '改道v6';
      else if (r.indexOf('H') === 0) {
        var h = r.split('|')[1] || '';
        var host = h.replace(/^https?:\/\//, '').split('/')[0];
        mode = '改道 ' + host;
      }
    } catch (e) {}

    var info;
    if (!s) {
      info = '空响应体';
    } else if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      var ok = false;
      try {
        var j = JSON.parse(s);
        ok = true;
        if (j && typeof j.a === 'string') {
          info = '加密信封 a=' + j.a.length + ' 字符\n' + s.slice(0, 60);
        } else {
          info = '★明文 ' + JSON.stringify(j).slice(0, 320);
        }
      } catch (e2) {
        ok = false;
      }
      if (!ok) info = '类JSON但解析失败: ' + s.slice(0, 220);
    } else if (s.charAt(0) === '<') {
      info = 'HTML/网关页: ' + s.slice(0, 180);
    } else {
      info = '非JSON: ' + s.slice(0, 220);
    }

    var ct = '';
    try {
      if ($response.headers) {
        ct = $response.headers['Content-Type'] || $response.headers['content-type'] || '';
      }
    } catch (e3) {}

    if (typeof $notification !== 'undefined') {
      $notification.post(
        '九号响应体',
        mode + ' · HTTP ' + status + ' · ' + s.length + 'B' + (ct ? ' · ' + ct.split(';')[0] : ''),
        info + '\n' + path
      );
    }

    $done({});
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

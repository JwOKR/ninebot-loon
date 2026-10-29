// ============================================================
// 九号出行 · 响应体内容探测（配合 probe-v6.js 改道使用）
// ============================================================
// 目的：把改道后 v6 接口返回的那 336 字节内容直接读出来。
//
// 判断依据：
//   业务错误（参数不兼容 / 解密失败）通常由网关或 Spring 直接返回**明文 JSON**，
//   不受业务层加密约束。只要能读到明文，就能确定改道失败的确切原因。
//
// 三种可能：
//   1) 明文 JSON 带 code/msg  => 拿到确切失败原因，可判定是否还有救
//   2) 仍是 {"a":"..."} 信封   => 说明 v6 也走同一套加密，读不到内容
//   3) 空 / 非 JSON           => 网关直接拒绝
// ============================================================

(function () {
  try {
    if (typeof $response === 'undefined') return $done({});

    var url = $request.url || '';
    // 只看改道后的 v6 请求；如需连 v1 一起看，把下面的 if 注释掉
    if (!/\/v6\/travel/.test(url)) return $done({});

    var body = $response.body;
    var s = (typeof body === 'string') ? body : '';
    var status = $response.status || 0;
    var info;

    if (!s) {
      info = '空响应';
    } else if (/^[\s]*\{/.test(s)) {
      try {
        var j = JSON.parse(s);
        if (j && j.a) {
          info = '加密信封 a=' + String(j.a).length + ' 字符（v6 也加密）';
        } else {
          var flat = JSON.stringify(j);
          info = '明文: ' + flat.slice(0, 220);
        }
      } catch (e) {
        info = 'JSON 解析失败: ' + s.slice(0, 180);
      }
    } else {
      info = '非 JSON: ' + s.slice(0, 180);
    }

    if (typeof $notification !== 'undefined') {
      $notification.post('九号响应体 v6', 'HTTP ' + status + ' · ' + s.length + 'B', info);
    }
    $done({});
  } catch (e) {
    $done({});
  }
})();

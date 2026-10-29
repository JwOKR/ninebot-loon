// ============================================================
// 九号出行 · 明文响应探针 v10（关闭响应加密）
// ============================================================
// 逆向新发现（classes14.dex, cn.ninebot.commonlibs.nbnet.CommonHttpClientKt）：
//
//   encodeResponseHeader():
//     返回 Pair("debug", v)
//     若 isEncryptResponse()==true -> v = "0"    （响应加密）
//     否则                          -> v = "1"    （响应不加密）
//   而 isEncryptResponse() 硬编码 return true
//   => 实际发出的头是  debug: 0
//   => 把它改成       debug: 1   <-- 极可能直接拿到明文 JSON
//
//   另有 Ninebot-Version 头：isNewEncrypt() ? "4" : "2"（VERSION_NEW=4）
//   老版本 "2" 也可能是不加密的老协议。
//
// 轮次安排（每次触发轮换一次）：
//   0 基线：不改，导出完整请求头（确认 debug / Ninebot-Version 是否存在及其值）
//   1 debug=1                      ★核心
//   2 debug=1 + business-type=1    ★双管齐下（明文 steeldust 类目）
//   3 business-type=1
//   4 Ninebot-Version=2
//   5 debug=1 + Ninebot-Version=2
//
// 判读：出现「★★明文JSON★★」即成功；dump 脚本会自动检索 speed 字段。
// ============================================================

var MODES = [
  { tag: 'BASE', dbg: null, bt: null, nv: null },
  { tag: 'debug=1', dbg: '1', bt: null, nv: null },
  { tag: 'debug=1+bt=1', dbg: '1', bt: '1', nv: null },
  { tag: 'bt=1(steeldust)', dbg: null, bt: '1', nv: null },
  { tag: 'NBVer=2', dbg: null, bt: null, nv: '2' },
  { tag: 'debug=1+NBVer=2', dbg: '1', bt: null, nv: '2' }
];

var STORE_ROUND = 'nb_dbg_round';
var STORE_ROUTE = 'nb_bt_last';

function findKey(headers, norm) {
  for (var k in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
    if (String(k).toLowerCase() === norm) return k;
  }
  return null;
}

(function () {
  try {
    if (typeof $request === 'undefined' || !$request || !$request.url) {
      if (typeof $notification !== 'undefined') {
        $notification.post('九号明文探针', '缺少请求上下文', '请通过真实请求触发，不要点「运行」按钮');
      }
      return $done({});
    }

    var url = String($request.url);
    if (url.indexOf('/app-api/travel/v1/travel/query-info') < 0) return $done({});

    var headers = $request.headers || {};

    var dbgKey = findKey(headers, 'debug');
    var btKey = null;
    for (var k2 in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, k2)) continue;
      if (String(k2).toLowerCase().replace(/[_-]/g, '') === 'businesstype') { btKey = k2; break; }
    }
    var nvKey = findKey(headers, 'ninebot-version');

    var round = 0;
    try { round = parseInt($persistentStore.read(STORE_ROUND) || '0', 10); } catch (e) {}
    if (isNaN(round) || round < 0) round = 0;
    var idx = round % MODES.length;
    try { $persistentStore.write(String(round + 1), STORE_ROUND); } catch (e) {}

    var m = MODES[idx];
    var dbgOrig = dbgKey ? String(headers[dbgKey]) : '(无此头)';
    var btOrig = btKey ? String(headers[btKey]) : '(无此头)';
    var nvOrig = nvKey ? String(headers[nvKey]) : '(无此头)';

    if (m.tag === 'BASE') {
      var names = [];
      for (var k3 in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k3)) names.push(k3);
      }
      var brief = 'debug=' + dbgOrig +
                  '\nbusiness-type=' + btOrig +
                  '\nNinebot-Version=' + nvOrig +
                  '\nclient-ver=' + String(headers['client-ver'] || '') +
                  '\n--- 全部头名 ---\n' + names.join(', ');
      try { $persistentStore.write('BASE', STORE_ROUTE); } catch (e) {}
      if (typeof $notification !== 'undefined') {
        $notification.post('九号明文 · 0/5 基线', '导出请求头（重点 debug）', brief);
      }
      return $done({});
    }

    if (m.dbg !== null) {
      if (dbgKey) headers[dbgKey] = m.dbg;
      else headers['debug'] = m.dbg;
    }
    if (m.bt !== null) {
      if (btKey) headers[btKey] = m.bt;
      else headers['business-type'] = m.bt;
    }
    if (m.nv !== null) {
      if (nvKey) headers[nvKey] = m.nv;
      else headers['Ninebot-Version'] = m.nv;
    }

    try { $persistentStore.write('BT|' + m.tag, STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post(
        '九号明文 · ' + idx + '/5',
        m.tag,
        (m.dbg === '1' ? '★尝试关闭响应加密\n' : '') +
        '原 debug=' + dbgOrig +
        '\n原 business-type=' + btOrig +
        '\n原 Ninebot-Version=' + nvOrig
      );
    }

    $done({ headers: headers });
  } catch (e) {
    try { $done({}); } catch (e2) {}
  }
})();

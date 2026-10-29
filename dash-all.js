/*
 * 九号出行 · 请求嗅探 v2（Loon http-response）
 *
 * 修正
 * ----
 * 1. 上一版 HTTP 状态恒为 0：Loon 的字段是 $response.status，不是 statusCode
 * 2. 上一版对每条 ninebot 请求都弹通知，噪音大；本版分级：
 *    ★★★ 配置/仪表文件类（device-config / .nb / .sign / sign-content）→ 必报
 *    ★    主题/动态/OTA 类（theme / dynamic / dashboard / device_ui / ota）→ 报
 *    普通  业务接口 → 只有出错（status>=400）才报
 * 3. 命中配置文件时把完整 URL 记进 persistentStore，便于后续替换时取用
 */

(function () {
  function notify(title, sub, body) {
    try {
      if (typeof $notification !== 'undefined') $notification.post(title, sub, body);
    } catch (e) {}
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  try {
    var url = ($request && $request.url) || '';
    var res = $response || {};
    var st = typeof res.status === 'number' ? res.status : (typeof res.statusCode === 'number' ? res.statusCode : -1);
    var body = res.body || '';

    var pm = url.match(/^https?:\/\/([^\/]+)([^?#]*)/);
    var host = pm ? pm[1] : '';
    var path = pm ? pm[2] : url;

    var isFile = /device-config|sign-content|\.nb$|\.sign$/i.test(path);
    var isSoft = /theme|dynamic|dashboard|device_ui|ota|resource|zip/i.test(path);

    if (isFile) {
      try { $persistentStore.write(url, 'nb_cfg_url'); } catch (e) {}
    }

    // 普通业务接口：静默（除非出错）
    if (!isFile && !isSoft && st >= 0 && st < 400) return $done({});

    // 去重（每天）
    var raw = null, store = null;
    try { raw = $persistentStore.read('nb_seen'); } catch (e) {}
    try { store = raw ? JSON.parse(raw) : null; } catch (e) { store = null; }
    if (!store || store.d !== today()) store = { d: today(), p: [] };
    if (store.p.indexOf(path) >= 0) return $done({});
    if (store.p.length >= 40) return $done({});
    store.p.push(path);
    try { $persistentStore.write(JSON.stringify(store), 'nb_seen'); } catch (e) {}

    var file = path.split('/').pop() || '(目录)';
    var size = body.length;
    var enc = '空';
    if (size > 0) {
      if (/^\s*\{\s*"a"\s*:/.test(body)) enc = '加密信封';
      else if (/^\s*[\{\[]/.test(body)) enc = '明文JSON';
      else if (/^[A-Za-z0-9+\/=]{40,}$/.test(body.slice(0, 200))) enc = 'base64';
      else enc = '其他';
    }

    var mark = isFile ? '★★★九号配置文件' : (isSoft ? '★九号配置' : '九号请求(异常)');
    var shortPath = path.length > 200 ? path.slice(0, 96) + '…' + path.slice(-96) : path;

    notify(mark, file, 'HTTP ' + st + ' · ' + size + 'B · ' + enc + '\n' + host + '\n' + shortPath);
  } catch (e) {
    notify('九号嗅探异常', '', String(e));
  }

  $done({});
})();

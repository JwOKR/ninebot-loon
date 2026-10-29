/*
 * 九号出行 · 全量请求嗅探（Loon http-response）
 *
 * 用途
 * ----
 * 上一版只盯 device-config / .nb / sign 三类地址，结果一条都没命中。
 * 这说明：要么 iOS 端用的域名不在列表里，要么它根本不发这些请求。
 * 本脚本改成「凡是 ninebot / segway 域名的请求，全部记录」，
 * 用来回答一个最基础的问题：九号 iOS 端到底在跟哪些服务器说话。
 *
 * 规则
 * ----
 * - 同一路径只报一次（去重），每天自动重置
 * - 疑似配置/仪表相关的打 ★，且配额更高（30 条）
 * - 其余普通请求最多报 12 条，避免通知轰炸
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
    var st = ($response && $response.statusCode) || 0;
    var body = ($response && $response.body) || '';

    var pm = url.match(/^https?:\/\/([^\/]+)(\/[^?#]*)/);
    var host = pm ? pm[1] : '';
    var path = pm ? pm[2] : url;

    var interesting =
      /device-config|sign-content|dynamic|dashboard|device_ui|\.nb$|\.sign$|theme|resource|ota|zip/i.test(path);

    var raw = null;
    try { raw = $persistentStore.read('nb_all_seen'); } catch (e) {}
    var store = null;
    try { store = raw ? JSON.parse(raw) : null; } catch (e) { store = null; }
    if (!store || store.d !== today()) store = { d: today(), hot: [], cold: [] };

    var bucket = interesting ? 'hot' : 'cold';
    var limit = interesting ? 30 : 12;

    if (store[bucket].indexOf(path) >= 0) return $done({});
    if (store[bucket].length >= limit) return $done({});
    store[bucket].push(path);
    try { $persistentStore.write(JSON.stringify(store), 'nb_all_seen'); } catch (e) {}

    var file = path.split('/').pop() || '(目录)';
    var short = path.length > 70 ? path.slice(0, 34) + '…' + path.slice(-32) : path;

    var size = body.length;
    var enc = '空';
    if (size > 0) {
      if (/^\s*\{\s*"a"\s*:/.test(body)) enc = '加密信封';
      else if (/^\s*[\{\[]/.test(body)) enc = '明文JSON';
      else if (/^[A-Za-z0-9+\/=]{40,}$/.test(body.slice(0, 200))) enc = 'base64';
      else enc = '其他';
    }

    notify(
      (interesting ? '★九号请求 ' : '九号请求 ') + host,
      file,
      'HTTP ' + st + ' · ' + size + 'B · ' + enc +
        (interesting ? '\n★疑似配置/仪表相关' : '') +
        '\n' + short
    );
  } catch (e) {
    notify('九号嗅探异常', '', String(e));
  }

  $done({});
})();

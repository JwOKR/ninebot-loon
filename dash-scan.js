/*
 * 九号出行 · 动态配置下载扫描（Loon http-response）
 *
 * 背景
 * ----
 * 6.10.x 起，部分车型的仪表界面配置 device_ui_dashboard.nb 被服务端换成
 * 「不含时速」的版本。酷安方案是：替换本地文件 + Hook 掉 mCheckSign（Android）。
 * Loon 改不了本地文件，但这些配置文件与其配套的 sign 文件都是【从服务器下载的】
 * （路径 /device-config/.../code/*.nb 与 /device-config/sign-content），
 * 因此可以在网络层把新版本换成旧版本。
 *
 * 本脚本只做侦察：把每一次配置/签名文件下载的地址、状态码、体积、内容开头报出来，
 * 用来确认真实 URL 模板、以及响应是明文还是加密信封。
 */

(function () {
  function notify(title, sub, body) {
    try {
      if (typeof $notification !== 'undefined') $notification.post(title, sub, body);
    } catch (e) {}
  }

  try {
    var url = ($request && $request.url) || '';
    var st = ($response && $response.statusCode) || 0;
    var body = ($response && $response.body) || '';

    var pm = url.match(/^https?:\/\/([^\/]+)(\/[^?#]*)/);
    var host = pm ? pm[1] : '';
    var path = pm ? pm[2] : url;
    var file = path.split('/').pop() || '(目录)';

    var short =
      path.length > 76 ? path.slice(0, 38) + '…' + path.slice(-34) : path;

    var kind = '配置相关';
    if (/\.nb$/i.test(path)) kind = '配置文件.nb';
    if (/device_ui_dashboard/i.test(path)) kind = '★仪表配置';
    if (/\/sign\//i.test(path) || /\.sign$/i.test(path)) kind = '★签名文件';
    if (/sign-content/i.test(path)) kind = '★签名接口';

    var size = body.length;
    var enc = '未知';
    if (size === 0) enc = '空响应';
    else if (/^\s*\{\s*"a"\s*:/.test(body)) enc = '加密信封{"a":}';
    else if (/^\s*[\{\[]/.test(body)) enc = '明文JSON';
    else if (/^[A-Za-z0-9+\/=]{40,}$/.test(body.slice(0, 200))) enc = 'base64文本';
    else if (/^\s*</.test(body)) enc = 'XML/HTML';
    else enc = '二进制';

    var head = body.slice(0, 120).replace(/\s+/g, ' ').trim();

    // 命中仪表配置时把地址记下来，便于后续替换
    if (/device_ui_dashboard/i.test(path)) {
      try { $persistentStore.write(url, 'nb_dash_url'); } catch (e) {}
    }
    if (/\.sign$/i.test(path) || /\/sign\//i.test(path) || /sign-content/i.test(path)) {
      try { $persistentStore.write(url, 'nb_sign_url'); } catch (e) {}
    }

    notify(
      '九号配置 · ' + kind,
      file,
      'HTTP ' + st + ' · ' + size + 'B · ' + enc + '\n' + host + '\n' + short +
        (head ? '\n---\n' + head : '')
    );
  } catch (e) {
    notify('九号配置扫描异常', '', String(e));
  }

  $done({});
})();

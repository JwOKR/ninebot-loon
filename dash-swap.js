/*
 * 九号出行 · 仪表配置替换引擎（Loon http-response）
 *
 * 作用
 * ----
 * 在 APP 从服务器下载仪表/UI 配置的瞬间，把响应替换成【旧版本】内容，
 * 从而让仪表恢复显示时速。
 *
 * 为什么成套替换才有效
 * --------------------
 * APP 会用 sign 文件（或 sign-content 接口返回值）校验 .nb 的签名，
 * 校验失败返回错误码 108 并重新拉取官方新版。所以只换 .nb 不行，
 * 必须 .nb 与它的 sign 是【同一份旧版本的配套文件】——服务端当年签发的
 * 旧签名对旧文件依然有效，校验自然通过。
 *
 * 怎么用
 * ------
 * 1. 先用 dash-scan.js 侦察，拿到真实的 code/*.nb 与 sign 地址。
 * 2. 取到旧版文件（酷安资源包 / 旧版 APP 抓包 / 你自己此前的备份），
 *    把内容填进下面的 SWAPS。
 * 3. .nb 填 base64 文本（就是文件原文），sign 填签名文本。
 * 4. 未填写时本脚本原样放行，不做任何改动。
 *
 * 注意：只替换 URL 里出现 match 关键字的请求；match 用文件名关键字，
 *       例如 device_ui_dashboard。sign 用 sign 或 .sign 结尾匹配。
 */

var SWAPS = [
  /*
  {
    match: 'device_ui_dashboard',          // 命中这个关键字（URL）才替换
    body:  '这里粘贴旧版 .nb 文件的完整 base64 文本'
  },
  {
    match: 'device_ui_dashboard',          // 配套的旧签名（URL 含 sign）
    sign:  true,
    body:  '这里粘贴旧版 sign 文件内容'
  }
  */
];

(function () {
  function notify(title, sub, body) {
    try {
      if (typeof $notification !== 'undefined') $notification.post(title, sub, body);
    } catch (e) {}
  }

  try {
    var url = ($request && $request.url) || '';

    if (!SWAPS || SWAPS.length === 0) {
      try {
        if ($persistentStore.read('nb_swap_hint') !== '1') {
          $persistentStore.write('1', 'nb_swap_hint');
          notify(
            '九号替换引擎已装载',
            '尚未配置旧版文件',
            '先用扫描插件抓到真实下载地址，再把旧版 .nb 与 sign 填进 dash-swap.js 的 SWAPS'
          );
        }
      } catch (e) {}
      return $done({});
    }

    var isSignUrl = /\/sign\//i.test(url) || /\.sign$/i.test(url) || /sign-content/i.test(url);

    for (var i = 0; i < SWAPS.length; i++) {
      var s = SWAPS[i];
      if (!s || !s.body) continue;
      var wantSign = !!s.sign;
      if (wantSign !== isSignUrl) continue;
      if (url.indexOf(s.match) === -1) continue;

      notify(
        '九号替换已生效',
        isSignUrl ? '签名文件' : '配置文件',
        (s.match.length > 40 ? s.match.slice(0, 40) + '…' : s.match) +
          '\n替换 ' + s.body.length + ' 字节'
      );
      return $done({ body: s.body });
    }
  } catch (e) {
    notify('九号替换异常', '', String(e));
  }

  $done({});
})();

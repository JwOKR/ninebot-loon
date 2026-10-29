// ============================================================
// 九号出行 · 老接口改道探针 v2
// ============================================================
// 逆向发现（关键）：新旧两个 RN 模块用的是两代完全不同的 API
//   旧模块 Track v774    -> /app-api/travel/v6/travel-info
//   新模块 TrackNew v905 -> /app-api/travel/v1/travel/query-info
// 因此"降级 APP 有效"的真正原因很可能是：旧 APP 调的是老的 v6 接口，
// 而老接口仍返回完整速度数据；新接口 v1 按合规要求剔除了速度字段。
//
// 本脚本把新版 APP 的 v1 请求改道到老候选接口，用来验证：
//   老接口是否还活着？返回体是否明显更大（=> 含速度数据）？
//
// 用法：反复打开九号的「轨迹详情」页，每打开一次自动轮换下一个候选，
//       配合 nb-size 通知观察 状态码 + 响应字节数。跑满 3 次即可定性。
// 注意：改道后 APP 很可能报错或显示异常，这是正常的，不是坏了。
// ============================================================

// 已实测：v6/travel-info 返回 200 但只有 336 字节（说明路由存活、入参不兼容）。
// 现在固定改道到它，配合 nb-body 脚本把响应内容直接读出来定性。
var CANDIDATES = [
  '/app-api/travel/v6/travel-info'
];

var STORE_ROUND = 'nb_probe_round';
var STORE_ROUTE = 'nb_probe_last_route';

(function () {
  try {
    if (typeof $request === 'undefined') {
      if (typeof $notification !== 'undefined') {
        $notification.post('九号改道探针', '缺少请求上下文', '请通过真实请求触发，勿点运行按钮');
      }
      return $done({});
    }

    var url = $request.url || '';
    // 只针对新版"轨迹详情"接口
    if (!/\/app-api\/travel\/v1\/travel\/query-info/.test(url)) return $done({});

    var round = 0;
    try { round = parseInt($persistentStore.read(STORE_ROUND) || '0', 10); } catch (e) {}
    if (isNaN(round)) round = 0;
    var idx = round % CANDIDATES.length;
    var cand = CANDIDATES[idx];

    // 轮到下一位，供下次使用
    try { $persistentStore.write(String(round + 1), STORE_ROUND); } catch (e) {}

    if (!cand) {
      try { $persistentStore.write('BASELINE|' + url, STORE_ROUTE); } catch (e) {}
      if (typeof $notification !== 'undefined') {
        $notification.post('九号改道探针', '轮次0 · 基线', '本次原样放行，记录原始响应大小');
      }
      return $done({});
    }

    // 保留 query string，只替换 path
    var origin = $request.url;
    var qpos = origin.indexOf('?');
    var query = qpos >= 0 ? origin.slice(qpos) : '';
    var newUrl = '';
    if (/^https?:\/\//.test(origin)) {
      newUrl = origin.slice(0, origin.indexOf('/', origin.indexOf('//') + 2)) + cand + query;
    } else {
      newUrl = cand + query;
    }

    try { $persistentStore.write(idx + '|' + newUrl, STORE_ROUTE); } catch (e) {}

    if (typeof $notification !== 'undefined') {
      $notification.post('九号改道探针', '轮次' + idx + ' · 已改道', cand);
    }

    // 不传 body / headers => 沿用原加密请求体与原请求头
    $done({ url: newUrl });
  } catch (e) {
    $done({});
  }
})();

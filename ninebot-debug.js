/**
 * ninebot-debug.js — 九号轨迹接口捕获脚本（阶段1，发现模式）
 *
 * 触发方式：Loon http-response，匹配 cn-cbu-gateway.ninebot.com 全域名。
 * 用途：打开APP「骑行记录 → 轨迹详情」时，抓取响应并判断：
 *   1. 服务端是否仍返回速度字段
 *   2. 轨迹点数组的字段名（经纬度/时间戳）
 *
 * 结果输出三处：
 *   - iOS 本地通知
 *   - $persistentStore（键 nb_track_capture）
 *   - 抛异常写入 Loon 脚本日志（LOG_VIA_EXCEPTION=true 时，通知被拦截也能看到）
 *
 * 不要用插件详情页的"运行"按钮执行（无请求上下文）。
 */

var STORE_KEY = 'nb_track_capture';
var MAX_KEEP = 20;
var LOG_VIA_EXCEPTION = true;   // 发现阶段保持 true，定稿后改 false
var INTEREST_RE = /(ride|track|trail|trip|trajectory|driv|run|mileage|travel|behav|gps|journey|sport|record|history|path|point|detail|route|segment)/i;

function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function findSpeedKeys(obj, path, hits, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach(function (v, i) { findSpeedKeys(v, path + '[' + i + ']', hits, depth + 1); });
    return;
  }
  for (var i = 0; i < Object.keys(obj).length; i++) {
    var k = Object.keys(obj)[i];
    var p = path ? path + '.' + k : k;
    if (/speed|veloc|velocity|kmh|km\/h|pace/i.test(k)) {
      hits.push(p + ' = ' + JSON.stringify(obj[k]));
    }
    findSpeedKeys(obj[k], p, hits, depth + 1);
  }
}

function findPointArrays(obj, path, found, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    if (obj.length > 2 && typeof obj[0] === 'object' && obj[0]) {
      var keys = Object.keys(obj[0]).join(',');
      if (/lat/i.test(keys) && /(lng|lon)/i.test(keys)) {
        found.push({ path: path, len: obj.length, keys: keys, sample: JSON.stringify(obj[0]).slice(0, 300) });
      }
    }
    obj.forEach(function (v, i) { findPointArrays(v, path + '[' + i + ']', found, depth + 1); });
    return;
  }
  for (var i = 0; i < Object.keys(obj).length; i++) {
    var k = Object.keys(obj)[i];
    findPointArrays(obj[k], path ? path + '.' + k : k, found, depth + 1);
  }
}

function main() {
  var url = ($request && $request.url) || '';
  var body = ($response && $response.body !== undefined && $response.body !== null) ? String($response.body) : '';
  var json = safeParse(body);

  if (!json) { $done({}); return; }

  var speedHits = [];
  var pointArrays = [];
  findSpeedKeys(json, '', speedHits, 0);
  findPointArrays(json, '', pointArrays, 0);

  var hasSpeed = speedHits.length > 0;
  var summary =
    '速度字段: ' + (hasSpeed ? speedHits.slice(0, 8).join(' | ') : '【无 — 服务端已剔除，需阶段2注入】') +
    '\n轨迹点数组: ' + (pointArrays.length
      ? pointArrays.slice(0, 3).map(function (a) { return a.path + ' len=' + a.len + ' keys=[' + a.keys + ']'; }).join(' | ')
      : '【未发现】');

  // 存档（全部响应都存，最多 MAX_KEEP 条）
  var store = JSON.parse($persistentStore.read(STORE_KEY) || '[]');
  store.unshift({
    time: new Date().toLocaleString(),
    url: url,
    speedHits: speedHits.slice(0, 20),
    pointArrays: pointArrays.slice(0, 5),
    preview: body.slice(0, 3000)
  });
  while (store.length > MAX_KEEP) store.pop();
  $persistentStore.write(JSON.stringify(store), STORE_KEY);
  $persistentStore.write(url + '\n' + summary, 'nb_last_capture');

  // 只提示与骑行/轨迹可能相关的接口，避免广告类噪音刷屏
  var interesting = INTEREST_RE.test(url) || hasSpeed || pointArrays.length > 0;
  if (!interesting) { $done({}); return; }

  $notification.post('九号轨迹捕获',
    hasSpeed ? '发现速度字段！' : '无速度字段（需阶段2注入）',
    summary.slice(0, 400));

  if (LOG_VIA_EXCEPTION) {
    throw new Error('NB_CAPTURE ' + url + '\n' + summary.slice(0, 900));
  }
  $done({});
}

// ---- 环境守卫：手动执行（CRON）时安全退出 ----
if (typeof $request === 'undefined' || typeof $response === 'undefined') {
  try {
    $persistentStore.write('手动执行：无 $request/$response 上下文，请打开APP轨迹详情由真实请求触发', 'nb_last_error');
    $notification.post('九号轨迹捕获', '无请求上下文', '请在APP里打开轨迹详情触发，不要用手动运行按钮');
  } catch (e) {}
  if (typeof $done === 'function') $done({});
} else {
  try {
    main();
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg.indexOf('NB_CAPTURE') === 0) { throw err; }   // 让结果出现在Loon脚本日志
    try { $persistentStore.write('ERROR: ' + msg, 'nb_last_error'); } catch (e) {}
    if (typeof $done === 'function') $done({});
  }
}

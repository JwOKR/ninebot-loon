/**
 * ninebot-debug.js — 九号轨迹接口捕获脚本（阶段1）
 *
 * Loon http-response 脚本。用途：打开APP骑行记录/轨迹详情时，
 * 抓取 cn-cbu-gateway.ninebot.com 轨迹相关接口响应，判断：
 *   1. 服务端是否仍返回速度字段
 *   2. 轨迹点数组的字段名（经纬度/时间戳）
 * 结果写入 $persistentStore（键 nb_track_capture）并发一条本地通知。
 *
 * 注意：不要用插件详情页的"运行"按钮执行本脚本（无请求上下文），
 * 应在APP里打开轨迹详情，由真实请求触发。
 */

const STORE_KEY = 'nb_track_capture';
const MAX_KEEP = 20;
const PATH_RE = /(ride|track|trail|trip|trajectory|driv|run|mileage|travel|behav|gps|journey|sport)/i;

function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function findSpeedKeys(obj, path, hits, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach(function (v, i) { findSpeedKeys(v, path + '[' + i + ']', hits, depth + 1); });
    return;
  }
  for (const k of Object.keys(obj)) {
    const p = path ? path + '.' + k : k;
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
      const keys = Object.keys(obj[0]).join(',');
      if (/lat/i.test(keys) && /(lng|lon)/i.test(keys)) {
        found.push({ path: path, len: obj.length, keys: keys, sample: JSON.stringify(obj[0]).slice(0, 300) });
      }
    }
    obj.forEach(function (v, i) { findPointArrays(v, path + '[' + i + ']', found, depth + 1); });
    return;
  }
  for (const k of Object.keys(obj)) {
    findPointArrays(obj[k], path ? path + '.' + k : k, found, depth + 1);
  }
}

// ---- 环境守卫：手动执行/无请求上下文时安全退出 ----
if (typeof $request === 'undefined' || typeof $response === 'undefined') {
  try {
    $persistentStore.write('手动执行：无 $request/$response 上下文。请打开九号APP轨迹详情，由真实请求触发。', 'nb_last_error');
  } catch (e) {}
  if (typeof $done === 'function') $done({});
} else {
  try {
    const url = $request.url || '';
    const body = ($response.body !== undefined && $response.body !== null) ? String($response.body) : '';

    {
      const json = safeParse(body);
      if (!json) {
        $notification.post('九号轨迹捕获', '响应非JSON或已加密', url.slice(0, 200));
        $done({});
      } else {
        const speedHits = [];
        const pointArrays = [];
        findSpeedKeys(json, '', speedHits, 0);
        findPointArrays(json, '', pointArrays, 0);

        const hasSpeed = speedHits.length > 0;
        const summary =
          '速度字段: ' + (hasSpeed ? speedHits.slice(0, 8).join(' | ') : '【无 — 服务端已剔除，需阶段2注入】') +
          '\n轨迹点数组: ' + (pointArrays.length
            ? pointArrays.slice(0, 3).map(function (a) { return a.path + ' len=' + a.len + ' keys=[' + a.keys + ']'; }).join(' | ')
            : '【未发现】');

        const store = JSON.parse($persistentStore.read(STORE_KEY) || '[]');
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

        $notification.post('九号轨迹捕获',
          hasSpeed ? '发现速度字段！' : '无速度字段（需阶段2注入）',
          summary.slice(0, 400));

        $done({});
      }
    }
  } catch (err) {
    try { $persistentStore.write('ERROR: ' + String(err), 'nb_last_error'); } catch (e) {}
    if (typeof $done === 'function') $done({});
  }
}

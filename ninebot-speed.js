/**
 * ninebot-speed.js — 阶段2：轨迹速度注入（Loon http-response）
 *
 * 原理：服务端即使剔除了速度，轨迹响应里仍保留 GPS 点串
 * （经度/纬度/时间戳）。本脚本拦截响应后：
 *   1. 定位轨迹点数组（自动识别常见字段名）
 *   2. 用相邻两点 Haversine 距离 ÷ 时间差 算出每段真实 GPS 速度
 *   3. 把 speed 数组与 maxSpeed/avgSpeed 注入回响应体
 *   4. APP 拿到含速度字段的响应，按原有渲染逻辑展示
 *
 * 仅做"数据显示还原"，不做任何解限速/改车行为。
 * 不要从插件详情页手动运行（无请求上下文），应由真实请求触发。
 */

const SCRIPT_NAME = '九号速度注入';
const DEBUG_STORE = 'nb_speed_inject_log';

// ---- 字段名候选（阶段1捕获后按实际增删）----
var LAT_KEYS = ['lat', 'latitude', 'y'];
var LNG_KEYS = ['lng', 'lon', 'longitude', 'x'];
var TIME_KEYS = ['time', 'timestamp', 'ts', 'createTime', 'gpsTime', 't'];
var SPEED_OUT_KEYS = ['speed', 'speedList', 'speeds'];
var MAX_OUT_KEYS = ['maxSpeed', 'topSpeed', 'max_speed'];
var AVG_OUT_KEYS = ['avgSpeed', 'averageSpeed', 'avg_speed'];

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function pick(obj, keys) {
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase();
    for (const c of keys) {
      if (lk === c.toLowerCase()) return { key: k, val: obj[k] };
    }
  }
  return null;
}

function findTrackArray(node, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    if (node.length > 2 && typeof node[0] === 'object' && node[0]) {
      if (pick(node[0], LAT_KEYS) && pick(node[0], LNG_KEYS)) return node;
    }
    for (const item of node) {
      const hit = findTrackArray(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(node)) {
    const hit = findTrackArray(node[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toMs(v) {
  if (v === null || v === undefined) return null;
  const n = (typeof v === 'number') ? v : Number(v);
  if (!isNaN(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(String(v).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
  return isNaN(d) ? null : d;
}

function inject(obj, candidates, value) {
  for (const c of candidates) {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === c.toLowerCase()) {
        const cur = obj[k];
        const empty = (cur === null || cur === undefined || cur === 0 ||
          (Array.isArray(cur) && cur.every(function (x) { return x === null; })));
        if (empty) { obj[k] = value; return k; }
        return null;
      }
    }
  }
  obj[candidates[0]] = value;
  return candidates[0];
}

function run() {
  const url = ($request && $request.url) || '';
  const raw = ($response && $response.body) ? String($response.body) : '';
  const json = safeParse(raw);
  if (!json) { $done({}); return; }

  const track = findTrackArray(json, 0);
  if (!track) {
    $notification.post(SCRIPT_NAME, '未找到轨迹点数组', 'URL: ' + url + '（字段名不匹配，需按阶段1捕获结果调整候选表）');
    $done({});
    return;
  }

  // 计算每段速度（km/h），首点补 0
  const speeds = [0];
  let maxV = 0, sumV = 0, cnt = 0;
  for (let i = 1; i < track.length; i++) {
    const p0 = track[i - 1], p1 = track[i];
    const la0 = pick(p0, LAT_KEYS), lo0 = pick(p0, LNG_KEYS), t0 = pick(p0, TIME_KEYS);
    const la1 = pick(p1, LAT_KEYS), lo1 = pick(p1, LNG_KEYS), t1 = pick(p1, TIME_KEYS);
    let v = 0;
    if (la0 && lo0 && la1 && lo1 && t0 && t1) {
      const ms0 = toMs(t0.val), ms1 = toMs(t1.val);
      const dt = (ms0 !== null && ms1 !== null) ? (ms1 - ms0) / 1000 : 0;
      const dk = haversineKm(Number(la0.val), Number(lo0.val), Number(la1.val), Number(lo1.val));
      if (dt > 0) v = Math.round((dk / dt) * 3600 * 10) / 10;
    }
    if (v > maxV) maxV = v;
    sumV += v; cnt++;
    speeds.push(v);
  }
  const avgV = cnt ? Math.round(sumV / cnt * 10) / 10 : 0;

  let injected = [];
  track.forEach(function (p, i) {
    if (p && typeof p === 'object') {
      const k = inject(p, SPEED_OUT_KEYS, speeds[i]);
      if (k) injected.push(k);
    }
  });
  const km1 = inject(json, MAX_OUT_KEYS, maxV);
  const km2 = inject(json, AVG_OUT_KEYS, avgV);

  $notification.post(SCRIPT_NAME, '注入完成',
    '点数: ' + track.length + '\n最高: ' + maxV + ' km/h\n平均: ' + avgV + ' km/h' +
    '\n字段: ' + (injected[0] || '未写入') + ' / ' + (km1 || '-') + ' / ' + (km2 || '-'));

  try {
    const log = JSON.parse($persistentStore.read(DEBUG_STORE) || '[]');
    log.unshift({ time: new Date().toLocaleString(), url: url, maxV: maxV, avgV: avgV, injected: injected });
    $persistentStore.write(JSON.stringify(log.slice(0, 10)), DEBUG_STORE);
  } catch (e) {}

  $done({ body: JSON.stringify(json) });
}

// ---- 环境守卫 ----
if (typeof $request === 'undefined' || typeof $response === 'undefined') {
  try {
    $persistentStore.write('手动执行：无 $request/$response 上下文。请打开九号APP轨迹详情，由真实请求触发。', 'nb_last_error');
    $notification.post(SCRIPT_NAME, '无请求上下文', '请在APP里打开轨迹详情触发，不要用手动运行按钮');
  } catch (e) {}
  if (typeof $done === 'function') $done({});
} else {
  try {
    run();
  } catch (err) {
    try { $persistentStore.write('ERROR: ' + String(err), 'nb_last_error'); } catch (e) {}
    if (typeof $done === 'function') $done({});
  }
}

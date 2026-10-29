/**
 * ninebot-speed.js — 阶段2：轨迹速度注入（Loon http-response）
 *
 * 原理：服务端即使剔除了速度，轨迹响应里仍然保留 GPS 点串
 * （经度/纬度/时间戳）。本脚本拦截响应后：
 *   1. 定位轨迹点数组（自动识别常见字段名）
 *   2. 用相邻两点 Haversine 距离 ÷ 时间差 算出每段真实 GPS 速度
 *   3. 把 speed 数组与 maxSpeed/avgSpeed 注入回响应体
 *   4. APP 拿到含速度字段的响应，按原有渲染逻辑展示
 *
 * 注意：
 * - 字段名以阶段1捕获到的真实响应为准，下方 CANDIDATES 可按需增补
 * - GPS 算速度与仪表速度有 1~3km/h 级别的固有误差
 * - 本脚本只做"数据显示还原"，不做任何解限速/改车行为
 */

const SCRIPT_NAME = '九号速度注入';
const DEBUG_STORE = 'nb_speed_inject_log';

// ---- 字段名候选（阶段1捕获后按实际增删）----
const LAT_KEYS = ['lat', 'latitude', 'y'];
const LNG_KEYS = ['lng', 'lon', 'longitude', 'x'];
const TIME_KEYS = ['time', 'timestamp', 'ts', 'createTime', 'gpsTime', 't'];
const SPEED_OUT_KEYS = ['speed', 'speedList', 'speeds'];       // 注入分段速度的候选键
const MAX_OUT_KEYS = ['maxSpeed', 'topSpeed', 'max_speed'];    // 注入最高速度的候选键
const AVG_OUT_KEYS = ['avgSpeed', 'averageSpeed', 'avg_speed'];

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function pick(obj, keys) {
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase();
    for (const c of keys) if (lk === c.toLowerCase()) return { key: k, val: obj[k] };
  }
  return null;
}

// 在 JSON 里找轨迹点数组：元素含经纬度，长度>2
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
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;      // 秒/毫秒自动判断
  const n = Number(v);
  if (!isNaN(n)) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(String(v).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'));
  return isNaN(d) ? null : d;
}

const url = $request.url || '';
const raw = $response.body || '';
const json = safeParse(raw);
if (!json) { $done({}); return; }

const track = findTrackArray(json, 0);
if (!track) {
  $notify(SCRIPT_NAME, '未找到轨迹点数组', 'URL: ' + url + '（字段名不匹配，需按阶段1捕获结果调整 CANDIDATES）');
  $done({});
  return;
}

// 计算每段速度（km/h）
const speeds = [];
let maxV = 0, sumV = 0, cnt = 0;
speeds.push(0); // 第一个点速度为0，与旧版APP曲线习惯一致
for (let i = 1; i < track.length; i++) {
  const p0 = track[i - 1], p1 = track[i];
  const la0 = pick(p0, LAT_KEYS), lo0 = pick(p0, LNG_KEYS), t0 = pick(p0, TIME_KEYS);
  const la1 = pick(p1, LAT_KEYS), lo1 = pick(p1, LNG_KEYS), t1 = pick(p1, TIME_KEYS);
  let v = 0;
  if (la0 && lo0 && la1 && lo1 && t0 && t1) {
    const dt = (toMs(t1.val) - toMs(t0.val)) / 1000;
    const dk = haversineKm(Number(la0.val), Number(lo0.val), Number(la1.val), Number(lo1.val));
    if (dt > 0) v = Math.round((dk / dt) * 3600 * 10) / 10;
  }
  if (v > maxV) maxV = v;
  sumV += v; cnt++;
  speeds.push(v);
}
const avgV = cnt ? Math.round(sumV / cnt * 10) / 10 : 0;

// 注入：优先写入响应里已存在但为空的键；否则写入第一个候选键
function inject(obj, candidates, value) {
  for (const c of candidates) {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === c.toLowerCase()) {
        if (obj[k] === null || obj[k] === undefined || obj[k] === 0 || (Array.isArray(obj[k]) && obj[k].every(x => x === null))) {
          obj[k] = value; return k;
        }
        return null; // 已有有效数据，不动
      }
    }
  }
  obj[candidates[0]] = value;
  return candidates[0];
}

// 轨迹点逐点注入 speed，再在数组所在层级注入统计值
let injected = [];
track.forEach((p, i) => { const k = inject(p, SPEED_OUT_KEYS, speeds[i]); if (k) injected.push(k); });

// 向上找到容纳统计字段的容器（简单处理：根节点）
const km1 = inject(json, MAX_OUT_KEYS, maxV);
const km2 = inject(json, AVG_OUT_KEYS, avgV);

$notification.post(SCRIPT_NAME, '注入完成',
  '点数: ' + track.length + '\n最高: ' + maxV + ' km/h\n平均: ' + avgV + ' km/h');

// 调试日志（确认稳定后可删除）
const log = JSON.parse($persistentStore.read(DEBUG_STORE) || '[]');
log.unshift({ time: new Date().toLocaleString(), url: url, maxV: maxV, avgV: avgV, injected: injected });
$persistentStore.write(JSON.stringify(log.slice(0, 10)), DEBUG_STORE);

$done({ body: JSON.stringify(json) });

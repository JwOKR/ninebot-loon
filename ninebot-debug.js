/**
 * ninebot-debug.js — 九号轨迹接口捕获脚本（阶段1：摸清数据结构）
 *
 * Loon 用法：http-response 脚本，抓取 cn-cbu-gateway.ninebot.com 上
 * 骑行/轨迹相关接口的原始响应，分析其中是否存在速度字段，
 * 并把响应结构保存到 Loon 持久化存储 + 弹通知。
 *
 * 用途：在 APP 里打开一次"骑行记录/轨迹详情"，然后回 Loon
 * 查看 [工具]->[脚本日志] 或通知，把抓到的 JSON 发给开发者定稿阶段2。
 */

const SCRIPT_NAME = '九号轨迹捕获';
const STORE_KEY = 'nb_track_capture';
const MAX_KEEP = 30;

// 命中这些关键词的 /portal/api/ 路径才会被记录
const PATH_RE = /(ride|track|trail|trip|trajectory|driv|run|mileage|travel|behav|gps|journey|sport)/i;

function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

// 递归找出所有名字带速度含义的字段
function findSpeedKeys(obj, path, hits, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findSpeedKeys(v, path + '[' + i + ']', hits, depth + 1));
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

// 递归找出"轨迹点数组"的候选（元素里同时含经纬度/时间类字段）
function findPointArrays(obj, path, found, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    if (obj.length > 2 && typeof obj[0] === 'object' && obj[0]) {
      const keys = Object.keys(obj[0]).join(',');
      if (/lat/i.test(keys) && (/(lng|lon)/i.test(keys))) {
        found.push({ path: path, len: obj.length, keys: keys, sample: JSON.stringify(obj[0]).slice(0, 300) });
      }
    }
    obj.forEach((v, i) => findPointArrays(v, path + '[' + i + ']', found, depth + 1));
    return;
  }
  for (const k of Object.keys(obj)) {
    findPointArrays(obj[k], path ? path + '.' + k : k, found, depth + 1);
  }
}

const url = $request.url || '';
const body = $response.body || '';

if (!PATH_RE.test(url)) { $done({}); return; }

const json = safeParse(body);
let summary = '';

if (json) {
  const speedHits = [];
  const pointArrays = [];
  findSpeedKeys(json, '', speedHits, 0);
  findPointArrays(json, '', pointArrays, 0);

  summary =
    'URL: ' + url + '\n' +
    '速度字段: ' + (speedHits.length ? '\n' + speedHits.slice(0, 10).join('\n') : '【未发现 —— 服务端疑似已剔除】') + '\n' +
    '轨迹点数组: ' + (pointArrays.length
      ? pointArrays.slice(0, 3).map(a => a.path + ' (len=' + a.len + ') keys=[' + a.keys + ']').join('\n')
      : '【未发现】');

  // 存档最近若干条响应（截断预览）
  const store = JSON.parse($persistentStore.read(STORE_KEY) || '[]');
  store.unshift({
    time: new Date().toLocaleString(),
    url: url,
    speedHits: speedHits.slice(0, 20),
    pointArrays: pointArrays.slice(0, 5).map(a => ({ path: a.path, len: a.len, keys: a.keys, sample: a.sample })),
    preview: body.slice(0, 4000)
  });
  while (store.length > MAX_KEEP) store.pop();
  $persistentStore.write(JSON.stringify(store), STORE_KEY);

  $notify(SCRIPT_NAME,
    speedHits.length ? '发现速度字段！响应可直接还原' : '响应中无速度字段（需阶段2注入计算）',
    summary.slice(0, 500));
} else {
  summary = '响应不是 JSON 或已加密，URL: ' + url;
  $notify(SCRIPT_NAME, '捕获到非JSON响应', summary);
}

console.log('[' + SCRIPT_NAME + ']\n' + summary);
$done({});

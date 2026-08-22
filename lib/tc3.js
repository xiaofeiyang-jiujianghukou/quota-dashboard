// Tencent Cloud API 3.0 (TC3-HMAC-SHA256) 签名实现
// 参考官方文档：https://cloud.tencent.com/document/product/1278/85305
import crypto from 'node:crypto';

/**
 * 对腾讯云 API 3.0 请求做 TC3-HMAC-SHA256 签名并发起请求。
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.action    e.g. "DescribeTokenPlanList"
 * @param {string} opts.version   e.g. "2026-03-22"
 * @param {string} opts.region    e.g. "ap-guangzhou"
 * @param {string} opts.service   e.g. "tokenhub"
 * @param {string} opts.host      e.g. "tokenhub.tencentcloudapi.com"
 * @param {object} opts.payload   请求体 JSON 对象
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>} 解析后的 Response 对象（不含 RequestId 包装）
 */
export async function tc3Request({
  secretId,
  secretKey,
  action,
  version,
  region = '',
  service,
  host,
  payload = {},
  timeoutMs = 20000,
}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const body = JSON.stringify(payload);

  // 1. 拼接规范请求串
  const canonicalHeaders =
    'content-type:application/json; charset=utf-8\n' +
    `host:${host}\n` +
    'x-tc-action:' + action.toLowerCase() + '\n';
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedRequestPayload = sha256Hex(body);
  const canonicalRequest =
    'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedRequestPayload;

  // 2. 拼接待签名字符串
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign =
    'TC3-HMAC-SHA256\n' +
    timestamp +
    '\n' +
    credentialScope +
    '\n' +
    hashedCanonicalRequest;

  // 3. 计算签名
  const secretDate = hmacSha256('TC3' + secretKey, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256Hex(secretSigning, stringToSign);

  // 4. 组装 Authorization
  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Authorization: authorization,
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': version,
  };
  if (region) headers['X-TC-Region'] = region;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`腾讯云 API 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (json.Response && json.Response.Error) {
      const e = json.Response.Error;
      throw new Error(`腾讯云 API 错误 [${e.Code}]: ${e.Message}`);
    }
    if (!json.Response) {
      throw new Error(`腾讯云 API 响应缺少 Response 字段：${text.slice(0, 200)}`);
    }
    return json.Response;
  } finally {
    clearTimeout(timer);
  }
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest();
}

function hmacSha256Hex(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest('hex');
}

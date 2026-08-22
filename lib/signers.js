// 云厂商 OpenAPI 签名器（Node 原生 crypto，零依赖）
// 1) volcSign — 火山引擎签名 V4（open.volcengineapi.com，类似 AWS SigV4）
//    实现参照 CodexBar DoubaoVolcengineSigner（已实测对接 GetCodingPlanUsage / GetAFPUsage）
// 2) acs3Sign — 阿里云 OpenAPI 签名 V3（ACS3-HMAC-SHA256，RPC 风格）
//    实现参照 bailian-cli bailian-cli-core 的签名函数（GenerateCLIAccessToken 用）
import crypto from 'node:crypto';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmacRaw = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();
const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest('hex');

/** RFC3986 百分号编码（与 AWS/火山一致：仅字母数字与 -_.~ 不编码） */
function percentEncode(v, encodeSlash = true) {
  let out = '';
  for (const ch of String(v)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (!encodeSlash && ch === '/')) {
      out += ch;
    } else {
      out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** 规范化查询串：键值各编码后按 key 排序（value 同 key 时按 value） */
function canonicalQuery(params) {
  const pairs = Object.entries(params).map(([k, v]) => [percentEncode(k), percentEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * 火山引擎签名 V4。
 * @returns 请求头（含 Authorization）
 */
export function volcSign({
  action,
  version,
  region,
  accessKeyId,
  secretKey,
  service = 'ark',
  host = 'open.volcengineapi.com',
  method = 'POST',
  body = '',
  queryParams = null,
}) {
  const payloadHash = sha256hex(body);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // yyyyMMdd'T'HHmmss'Z'
  const dateStamp = timestamp.slice(0, 8);
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const query = queryParams
    ? canonicalQuery(queryParams)
    : canonicalQuery({ Action: action, Version: version });

  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [
    method,
    '/',
    query,
    `content-type:${contentType}`,
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${timestamp}`,
    '',
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', timestamp, credentialScope, sha256hex(canonicalRequest)].join('\n');

  const dateKey = hmacRaw(secretKey, dateStamp);
  const regionKey = hmacRaw(dateKey, region);
  const serviceKey = hmacRaw(regionKey, service);
  const signingKey = hmacRaw(serviceKey, 'request');
  const signature = hmacHex(signingKey, stringToSign);

  return {
    'Content-Type': contentType,
    Host: host,
    'X-Date': timestamp,
    'X-Content-Sha256': payloadHash,
    Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * 阿里云 OpenAPI 签名 V3（ACS3-HMAC-SHA256，RPC 风格）。
 * @returns 请求头（含 authorization）
 */
export function acs3Sign({
  method = 'POST',
  host,
  pathname,
  action,
  version,
  body = '',
  queryString = '',
  accessKeyId,
  accessKeySecret,
  securityToken = null,
}) {
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': crypto.randomUUID(),
    'x-acs-content-sha256': sha256hex(body),
    'content-type': 'application/json',
  };
  if (securityToken) headers['x-acs-security-token'] = securityToken;

  const sortedKeys = Object.keys(headers)
    .filter((k) => k === 'host' || k === 'content-type' || k.startsWith('x-acs-'))
    .sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [method, pathname, queryString, canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256hex(canonicalRequest)}`;
  const signature = crypto.createHmac('sha256', accessKeySecret).update(stringToSign, 'utf8').digest('hex');

  headers.authorization = `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}

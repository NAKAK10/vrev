import { createSign } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";

const OAUTH_TOKEN_URI_DEFAULT = "https://oauth2.googleapis.com/token";
const DATASTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const GCLOUD_CACHE_MS = 50 * 60 * 1000;
const GCLOUD_TIMEOUT_MS = 30_000;

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ownObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonCredential(raw, label) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} is not configured`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!ownObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function cachedGetter(now, fetchToken) {
  let cached;
  return async ({ forceRefresh = false } = {}) => {
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.token;
    const { token, ttlMs } = await fetchToken();
    cached = { token, expiresAt: now() + ttlMs };
    return token;
  };
}

function createAccessTokenSource({ env }) {
  const getAccessToken = async () => {
    const token = env.FIREBASE_ACCESS_TOKEN;
    if (!token) {
      const suffix = env.GOOGLE_APPLICATION_CREDENTIALS ? "; GOOGLE_APPLICATION_CREDENTIALS is not supported by this plugin" : "";
      throw new Error(`FIREBASE_ACCESS_TOKEN is required${suffix}`);
    }
    return token;
  };
  return { getAccessToken, projectIdHint: undefined };
}

function createServiceAccountSource({ credentials, fetch, now }) {
  const key = parseJsonCredential(credentials.service_account_key, "service_account_key");
  if (typeof key.client_email !== "string" || !key.client_email) throw new Error("service_account_key is missing client_email");
  if (typeof key.private_key !== "string" || !key.private_key) throw new Error("service_account_key is missing private_key");
  const tokenUri = typeof key.token_uri === "string" && key.token_uri ? key.token_uri : OAUTH_TOKEN_URI_DEFAULT;

  const fetchToken = async () => {
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = issuedAt + 3600;
    const header = { alg: "RS256", typ: "JWT" };
    const claims = { iss: key.client_email, scope: DATASTORE_SCOPE, aud: tokenUri, iat: issuedAt, exp: expiresAt };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signatureBase64 = signer.sign(key.private_key).toString("base64");
    const signature = signatureBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const assertion = `${signingInput}.${signature}`;
    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`service account token request returned a non-JSON response (HTTP ${response.status})`);
    }
    if (!response.ok || typeof value.access_token !== "string") {
      throw new Error(`service account token request failed (HTTP ${response.status})`);
    }
    const ttlSeconds = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) ? value.expires_in : 3600;
    return { token: value.access_token, ttlMs: Math.max(ttlSeconds - 60, 60) * 1000 };
  };

  return {
    getAccessToken: cachedGetter(now, fetchToken),
    projectIdHint: typeof key.project_id === "string" ? key.project_id : undefined,
  };
}

function runGcloud(spawnFn, account) {
  return new Promise((resolve, reject) => {
    const args = ["auth", "print-access-token", ...(account ? ["--account", account] : [])];
    let child;
    try {
      child = spawnFn("gcloud", args, { shell: false, timeout: GCLOUD_TIMEOUT_MS });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(new Error("gcloud CLI was not found on PATH; install the Google Cloud SDK or choose a different auth_mode"));
      } else {
        reject(new Error(`gcloud CLI failed to start: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const firstLine = stderr.trim().split("\n")[0];
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`gcloud auth print-access-token failed (${reason})${firstLine ? `: ${firstLine}` : ""}`));
    });
  });
}

function createGcloudSource({ configuration, spawn, now }) {
  const account = typeof configuration.gcloud_account === "string" && configuration.gcloud_account ? configuration.gcloud_account : undefined;
  const fetchToken = async () => {
    const token = await runGcloud(spawn, account);
    if (!token) throw new Error("gcloud auth print-access-token returned an empty token");
    return { token, ttlMs: GCLOUD_CACHE_MS };
  };
  return { getAccessToken: cachedGetter(now, fetchToken), projectIdHint: undefined };
}

async function parseIdentityResponse(response, label) {
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
  return value;
}

function tokenTtlMs(expiresIn) {
  const seconds = Number(expiresIn);
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  return Math.max(ttl - 60, 60) * 1000;
}

function createFirebaseWebSource({ credentials, fetch, now }) {
  const config = parseJsonCredential(credentials.firebase_web_config, "firebase_web_config");
  if (typeof config.apiKey !== "string" || !config.apiKey) throw new Error("firebase_web_config is missing apiKey");
  let refreshToken;

  const signUp = async () => {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(config.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    const value = await parseIdentityResponse(response, "Firebase anonymous sign-in");
    if (typeof value.idToken !== "string") throw new Error("Firebase anonymous sign-in response is missing idToken");
    refreshToken = typeof value.refreshToken === "string" ? value.refreshToken : undefined;
    return { token: value.idToken, ttlMs: tokenTtlMs(value.expiresIn) };
  };

  const refresh = async () => {
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const value = await parseIdentityResponse(response, "Firebase token refresh");
    if (typeof value.id_token !== "string") throw new Error("Firebase token refresh response is missing id_token");
    refreshToken = typeof value.refresh_token === "string" ? value.refresh_token : refreshToken;
    return { token: value.id_token, ttlMs: tokenTtlMs(value.expires_in) };
  };

  const fetchToken = async () => (refreshToken ? refresh() : signUp());
  return {
    getAccessToken: cachedGetter(now, fetchToken),
    projectIdHint: typeof config.projectId === "string" ? config.projectId : undefined,
  };
}

/**
 * Builds a token source for the given `auth_mode`. Every network/process call is injectable so
 * tests never touch the real network, gcloud CLI, or a real Firebase project.
 */
export function createTokenSource(options = {}) {
  const env = options.env ?? process.env;
  const credentials = options.credentials ?? {};
  const configuration = options.configuration ?? {};
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const spawnImpl = options.spawn ?? nodeSpawn;
  const now = options.now ?? Date.now;
  const mode = options.mode;
  switch (mode) {
    case "access_token":
      return createAccessTokenSource({ env });
    case "service_account":
      return createServiceAccountSource({ credentials, fetch: fetchImpl, now });
    case "gcloud":
      return createGcloudSource({ configuration, spawn: spawnImpl, now });
    case "firebase_web":
      return createFirebaseWebSource({ credentials, fetch: fetchImpl, now });
    default:
      throw new Error(`unsupported auth_mode: ${String(mode)}`);
  }
}

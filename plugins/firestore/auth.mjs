// Firestore access token acquisition for the four supported `auth_mode` values. Every
// network/process call is injectable so tests never touch the real network, gcloud CLI, or a
// real Firebase project, and no secret value is ever placed in a URL, a log line, a thrown
// error, or a subprocess argv.
import { createSign } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const IDENTITY_SIGNUP_ENDPOINT = "https://identitytoolkit.googleapis.com/v1/accounts:signUp";
const IDENTITY_REFRESH_ENDPOINT = "https://securetoken.googleapis.com/v1/token";
const DATASTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const GCLOUD_TOKEN_TTL_MS = 50 * 60 * 1000;
const GCLOUD_TIMEOUT_MS = 30_000;
const TOKEN_SAFETY_MARGIN_S = 60;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function readJsonCredential(raw, fieldName) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${fieldName} is not configured`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${fieldName} must be a JSON object`);
  return parsed;
}

/** Wraps a token fetcher with an expiry-aware cache; `forceRefresh` always bypasses it. */
function withCache(now, fetchFreshToken) {
  let cachedToken;
  let cachedUntil = -Infinity;
  return async ({ forceRefresh = false } = {}) => {
    if (!forceRefresh && cachedToken !== undefined && now() < cachedUntil) return cachedToken;
    const { token, ttlMs } = await fetchFreshToken();
    cachedToken = token;
    cachedUntil = now() + ttlMs;
    return token;
  };
}

function accessTokenMode({ env }) {
  return {
    projectIdHint: undefined,
    getAccessToken: async () => {
      const token = env.FIREBASE_ACCESS_TOKEN;
      if (!token) throw new Error("auth_mode 'access_token' requires the FIREBASE_ACCESS_TOKEN environment variable");
      return token;
    },
  };
}

async function exchangeToken(fetchImpl, body, label) {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || typeof parsed.access_token !== "string") throw new Error(`${label} failed (HTTP ${response.status})`);
  const ttlSeconds = Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
  return { token: parsed.access_token, ttlMs: Math.max(ttlSeconds - TOKEN_SAFETY_MARGIN_S, TOKEN_SAFETY_MARGIN_S) * 1000 };
}

function serviceAccountJwt(key, now) {
  const issuedAtSeconds = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: key.client_email,
    scope: DATASTORE_SCOPE,
    aud: key.token_uri || TOKEN_ENDPOINT,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.private_key).toString("base64url");
  return `${signingInput}.${signature}`;
}

function serviceAccountMode({ credentials, fetch: fetchImpl, now }) {
  const key = readJsonCredential(credentials.service_account_key, "service_account_key");
  if (typeof key.client_email !== "string" || !key.client_email) throw new Error("service_account_key is missing client_email");
  if (typeof key.private_key !== "string" || !key.private_key) throw new Error("service_account_key is missing private_key");
  const fetchFreshToken = async () => exchangeToken(fetchImpl, new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: serviceAccountJwt(key, now),
  }), "service account token exchange");
  return { projectIdHint: typeof key.project_id === "string" ? key.project_id : undefined, getAccessToken: withCache(now, fetchFreshToken) };
}

function runGcloudPrintAccessToken(spawnImpl, account) {
  return new Promise((resolve, reject) => {
    const args = ["auth", "print-access-token", ...(account ? ["--account", account] : [])];
    let child;
    try {
      child = spawnImpl("gcloud", args, { shell: false, timeout: GCLOUD_TIMEOUT_MS });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      reject(error?.code === "ENOENT"
        ? new Error("the gcloud CLI was not found on PATH; install the Google Cloud SDK or choose a different auth_mode")
        : new Error(`gcloud CLI failed to start: ${error instanceof Error ? error.message : String(error)}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const firstStderrLine = stderr.trim().split("\n")[0];
      reject(new Error(`gcloud auth print-access-token failed (${signal ? `signal ${signal}` : `exit code ${code}`})${firstStderrLine ? `: ${firstStderrLine}` : ""}`));
    });
  });
}

function gcloudMode({ configuration, spawn: spawnImpl, now }) {
  const account = typeof configuration.gcloud_account === "string" && configuration.gcloud_account ? configuration.gcloud_account : undefined;
  const fetchFreshToken = async () => {
    const token = await runGcloudPrintAccessToken(spawnImpl, account);
    if (!token) throw new Error("gcloud auth print-access-token returned an empty token");
    return { token, ttlMs: GCLOUD_TOKEN_TTL_MS };
  };
  return { projectIdHint: undefined, getAccessToken: withCache(now, fetchFreshToken) };
}

async function parseIdentityToolkitResponse(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned a non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
  return parsed;
}

function firebaseWebMode({ credentials, fetch: fetchImpl, now }) {
  const firebaseConfig = readJsonCredential(credentials.firebase_web_config, "firebase_web_config");
  if (typeof firebaseConfig.apiKey !== "string" || !firebaseConfig.apiKey) throw new Error("firebase_web_config is missing apiKey");
  let refreshToken;

  const signUpAnonymously = async () => {
    const response = await fetchImpl(`${IDENTITY_SIGNUP_ENDPOINT}?key=${encodeURIComponent(firebaseConfig.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    const parsed = await parseIdentityToolkitResponse(response, "Firebase anonymous sign-in");
    if (typeof parsed.idToken !== "string") throw new Error("Firebase anonymous sign-in response is missing idToken");
    refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined;
    return { token: parsed.idToken, ttlMs: Math.max(Number(parsed.expiresIn) || 3600, TOKEN_SAFETY_MARGIN_S) * 1000 };
  };

  const refreshIdToken = async () => {
    const response = await fetchImpl(`${IDENTITY_REFRESH_ENDPOINT}?key=${encodeURIComponent(firebaseConfig.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const parsed = await parseIdentityToolkitResponse(response, "Firebase token refresh");
    if (typeof parsed.id_token !== "string") throw new Error("Firebase token refresh response is missing id_token");
    refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token : refreshToken;
    return { token: parsed.id_token, ttlMs: Math.max(Number(parsed.expires_in) || 3600, TOKEN_SAFETY_MARGIN_S) * 1000 };
  };

  const fetchFreshToken = () => (refreshToken ? refreshIdToken() : signUpAnonymously());
  return {
    projectIdHint: typeof firebaseConfig.projectId === "string" ? firebaseConfig.projectId : undefined,
    getAccessToken: withCache(now, fetchFreshToken),
  };
}

/**
 * Builds a `{ getAccessToken({ forceRefresh }), projectIdHint }` source for the given `auth_mode`.
 * `fetch`, `spawn`, and `now` are all injectable so the caller can run fully offline in tests.
 */
export function createTokenSource(options = {}) {
  const env = options.env ?? process.env;
  const credentials = isPlainObject(options.credentials) ? options.credentials : {};
  const configuration = isPlainObject(options.configuration) ? options.configuration : {};
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const spawnImpl = options.spawn ?? nodeSpawn;
  const now = options.now ?? Date.now;
  switch (options.mode) {
    case "access_token":
      return accessTokenMode({ env });
    case "service_account":
      return serviceAccountMode({ credentials, fetch: fetchImpl, now });
    case "gcloud":
      return gcloudMode({ configuration, spawn: spawnImpl, now });
    case "firebase_web":
      return firebaseWebMode({ credentials, fetch: fetchImpl, now });
    default:
      throw new Error(`unsupported auth_mode: ${String(options.mode)}`);
  }
}

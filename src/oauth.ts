import http from "http";
import https from "https";
import { URL } from "url";
import fs from "fs/promises";
import { CLIENT_ID, ISSUER, OAUTH_PORT, TOKEN_FILE, ensureConfigDir, type TokenData } from "./config.js";

interface PkceCodes {
  verifier: string;
  challenge: string;
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(128);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex-proxy",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "auth.openai.com",
        path: "/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Token exchange failed: ${res.statusCode} - ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "auth.openai.com",
        path: "/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Token refresh failed: ${res.statusCode} - ${data}`));
          } else {
            resolve(JSON.parse(data));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Codex Proxy - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful!</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Codex Proxy - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`;

export async function performOAuthLogin(): Promise<TokenData> {
  return new Promise((resolve, reject) => {
    const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`;
    const pkcePromise = generatePKCE();
    const state = generateState();

    let pkce: PkceCodes;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`);

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const receivedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          const errorMsg = errorDescription || error;
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(HTML_ERROR(errorMsg));
          server.close();
          reject(new Error(errorMsg));
          return;
        }

        if (!code) {
          const errorMsg = "Missing authorization code";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(HTML_ERROR(errorMsg));
          server.close();
          reject(new Error(errorMsg));
          return;
        }

        if (receivedState !== state) {
          const errorMsg = "Invalid state - potential CSRF attack";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(HTML_ERROR(errorMsg));
          server.close();
          reject(new Error(errorMsg));
          return;
        }

        try {
          const tokens = await exchangeCodeForTokens(code, redirectUri, pkce);
          const tokenData: TokenData = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          };

          await ensureConfigDir();
          await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(HTML_SUCCESS);
          server.close();
          resolve(tokenData);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(HTML_ERROR(errorMsg));
          server.close();
          reject(err);
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    pkcePromise.then((generatedPkce) => {
      pkce = generatedPkce;
      server.listen(OAUTH_PORT, async () => {
        const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);
        console.log("Opening browser for OAuth authorization...");
        console.log("If browser doesn't open, visit this URL:");
        console.log(authUrl);

        // Try to open browser
        try {
          const { default: open } = await import("open");
          await open(authUrl);
        } catch {
          // Browser open failed, user will need to open manually
        }
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout - authorization took too long"));
    }, 5 * 60 * 1000);
  });
}

export async function loadTokens(): Promise<TokenData | null> {
  try {
    const data = await fs.readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: TokenData): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}

export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;

  // Check if token needs refresh (expire 5 minutes early to be safe)
  if (Date.now() >= tokens.expires_at - 5 * 60 * 1000) {
    console.log("Access token expired, refreshing...");
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      const newTokens: TokenData = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      };
      await saveTokens(newTokens);
      return newTokens.access_token;
    } catch (err) {
      console.error("Failed to refresh token:", err);
      return null;
    }
  }

  return tokens.access_token;
}

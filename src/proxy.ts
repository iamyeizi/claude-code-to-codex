import http from "http";
import https from "https";
import net from "net";
import stream from "stream";
import { URL } from "url";
import chalk from "chalk";
import { ANTHROPIC_API_HOST, CODEX_API_ENDPOINT, DEFAULT_PROXY_PORT } from "./config.js";
import { getValidAccessToken } from "./oauth.js";
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  translateOpenAIStreamChunk,
  createAnthropicStreamEvent,
  CODEX_SYSTEM_INSTRUCTIONS,
  type AnthropicRequest,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAIStreamChunk,
} from "./translator.js";

interface ProxyServerOptions {
  port?: number;
  verbose?: boolean;
  httpsMode?: boolean;
  sslCert?: { key: string; cert: string };
}

export class CodexProxyServer {
  private server: http.Server | https.Server | null = null;
  private options: ProxyServerOptions;

  constructor(options: ProxyServerOptions = {}) {
    this.options = {
      port: DEFAULT_PROXY_PORT,
      verbose: false,
      httpsMode: false,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.options.httpsMode && this.options.sslCert) {
      // HTTPS mode: Create HTTPS server with self-signed cert
      this.server = https.createServer(
        {
          key: this.options.sslCert.key,
          cert: this.options.sslCert.cert,
        },
        (req, res) => {
          this.handleRequest(req, res);
        }
      );
    } else {
      // HTTP mode: Regular HTTP proxy
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Handle CONNECT requests for HTTPS tunneling
      this.server.on("connect", (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket, head);
      });
    }

    return new Promise((resolve, reject) => {
      this.server!.listen(this.options.port, () => {
        const protocol = this.options.httpsMode ? "https" : "http";
        console.log(`🚀 Codex Proxy Server running on ${protocol}://localhost:${this.options.port}`);
        console.log(`📡 Intercepting requests to ${ANTHROPIC_API_HOST}`);
        console.log(`🎯 Forwarding to Codex API`);
        console.log("");
        
        if (this.options.httpsMode) {
          console.log(chalk.green("🔒 HTTPS Mode: Intercepting encrypted traffic"));
          console.log(chalk.white("   Claude Code will connect directly (no proxy env vars needed)"));
        } else {
          console.log("To use with Claude Code, run:");
          console.log(`  HTTP_PROXY=http://localhost:${this.options.port} HTTPS_PROXY=http://localhost:${this.options.port} claude`);
        }
        console.log("");
        console.log(chalk.cyan(`Proxy ready! Waiting for connections on port ${this.options.port}...`));
        resolve();
      });

      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  isHttpsMode(): boolean {
    return this.options.httpsMode ?? false;
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: stream.Duplex, head: Buffer): void {
    const url = new URL(`http://${req.url}`);
    
    if (this.options.verbose) {
      console.log(`[${new Date().toISOString()}] CONNECT ${req.url}`);
    }

    // If this is an Anthropic API request, we need to intercept it
    // For now, we'll just establish a tunnel to let the client connect
    // In a full MITM setup, we'd intercept the TLS here
    
    // Log intercepted hosts
    if (url.hostname === ANTHROPIC_API_HOST || url.hostname.includes("anthropic")) {
      console.log(chalk.yellow(`⚠ CONNECT to Anthropic API (${req.url})`));
      console.log(chalk.gray(`   Note: HTTPS traffic through CONNECT cannot be intercepted without MITM`));
    }

    // Establish tunnel to target host
    const port = parseInt(url.port || "443");
    const serverSocket = net.connect(port, url.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("error", (err) => {
      console.error("CONNECT tunnel error:", err);
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
    });

    clientSocket.on("error", () => {
      serverSocket.end();
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Log request
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} (Host: ${req.headers.host})`);

    // Check if this is an Anthropic API request
    if (req.headers.host?.includes(ANTHROPIC_API_HOST) || url.pathname.startsWith("/v1/messages")) {
      console.log(chalk.green(`✓ Intercepted Anthropic API request: ${req.method} ${url.pathname}`));
      await this.handleAnthropicRequest(req, res, url);
    } else if (req.headers.host?.includes("claude.ai") || req.headers.host?.includes("platform.claude.com") || 
               url.pathname.startsWith("/oauth") || url.pathname.startsWith("/api/auth") ||
               url.pathname.startsWith("/v1/keys") || url.pathname.startsWith("/v1/account")) {
      // Mock Anthropic authentication endpoints
      console.log(chalk.cyan(`🔐 Intercepted Auth request: ${req.method} ${url.pathname}`));
      await this.handleAuthRequest(req, res, url);
    } else {
      // For non-Anthropic requests, just return 200 OK
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", proxy: "codex-proxy" }));
    }
  }

  private async handleAuthRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    // Mock Anthropic authentication to bypass subscription requirements
    
    // Check for existing session/auth status
    if (url.pathname === "/v1/oauth/hello" || url.pathname === "/api/hello" || url.pathname === "/v1/auth/session") {
      // Return authenticated status - this tells Claude Code user is already logged in
      // Format based on Anthropic's actual auth response
      const authStatus = {
        authenticated: true,
        user: {
          id: "mock_user_123",
          email: "user@example.com",
          name: "Claude User",
          subscription: {
            type: "pro",
            status: "active",
            expires_at: "2099-12-31T23:59:59Z",
            plan: "pro"
          },
          flags: {
            claude_code: true,
            claude_code_enabled: true
          }
        },
        session: {
          id: "mock_session_" + Date.now(),
          valid: true,
          expires_at: "2099-12-31T23:59:59Z"
        },
        token: {
          access_token: "mock_token_" + Date.now(),
          expires_in: 3600,
          token_type: "Bearer"
        }
      };
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(authStatus));
      console.log(chalk.green("   ✓ Returned authenticated status with token"));
      return;
    }
    
    // Handle preflight/OPTIONS requests
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      res.end();
      return;
    }
    
    if (url.pathname.startsWith("/oauth/authorize")) {
      // Mock OAuth authorization - redirect back with fake code
      const redirectUri = url.searchParams.get("redirect_uri") || "https://platform.claude.com/oauth/code/callback";
      const state = url.searchParams.get("state") || "mock_state";
      const code = "mock_auth_code_12345";
      
      res.writeHead(302, { "Location": `${redirectUri}?code=${code}&state=${state}` });
      res.end();
      console.log(chalk.green("   ✓ Mocked OAuth authorize - redirecting with code"));
      return;
    }
    
    if (url.pathname.startsWith("/oauth/token") || url.pathname.startsWith("/api/auth/token")) {
      // Mock OAuth token exchange - return fake tokens
      const mockTokens = {
        access_token: "mock_anthropic_token_" + Date.now(),
        refresh_token: "mock_refresh_token_" + Date.now(),
        expires_in: 3600,
        token_type: "Bearer",
        scope: "user:profile user:inference user:sessions:claude_code"
      };
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockTokens));
      console.log(chalk.green("   ✓ Mocked OAuth token exchange"));
      return;
    }
    
    if (url.pathname.startsWith("/api/user") || url.pathname.startsWith("/v1/account")) {
      // Mock user profile - return fake Pro user
      const mockUser = {
        id: "mock_user_123",
        email: "user@example.com",
        name: "Claude User",
        subscription: {
          type: "pro",
          status: "active",
          expires_at: "2099-12-31T23:59:59Z"
        },
        features: {
          claude_code: true,
          max_context: 200000,
          api_access: true
        }
      };
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockUser));
      console.log(chalk.green("   ✓ Mocked user profile (Pro subscription)"));
      return;
    }
    
    if (url.pathname.startsWith("/v1/keys")) {
      // Mock API key validation
      const apiKeyResponse = {
        id: "key_mock_123",
        name: "Claude Code Key",
        type: "api_key",
        created_at: "2024-01-01T00:00:00Z",
        owner: {
          id: "mock_user_123",
          type: "user"
        }
      };
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(apiKeyResponse));
      console.log(chalk.green("   ✓ Mocked API key validation"));
      return;
    }
    
    // Default: return success for any other auth endpoint
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", authenticated: true }));
    console.log(chalk.gray(`   Mocked auth endpoint: ${url.pathname}`));
  }

  private async handleAnthropicRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    // Check for API key in Authorization header (from Claude Code)
    const authHeader = req.headers.authorization || "";
    const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    
    // Validate API key format (should be sk-ant-api03-...)
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "authentication_error",
            message: "Invalid API key. Please set ANTHROPIC_API_KEY environment variable.",
          },
        })
      );
      return;
    }
    
    console.log(chalk.green(`   ✓ API Key received: ${apiKey.substring(0, 20)}...`));

    // Read request body
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    // Log the request body for debugging
    console.log(chalk.gray(`   Request body: ${body.substring(0, 500)}${body.length > 500 ? '...' : ''}`));

    try {
      // Get Codex OAuth token for forwarding
      const codexToken = await getValidAccessToken();
      if (!codexToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "authentication_error",
              message: "Not authenticated with Codex. Run 'codex-proxy login' first.",
            },
          })
        );
        return;
      }
      
      // Handle different Anthropic API endpoints
      if (url.pathname.startsWith("/v1/messages")) {
        // Standard chat endpoint
        const anthropicReq: AnthropicRequest = JSON.parse(body);
        const openAIReq = translateAnthropicToOpenAI(anthropicReq, CODEX_SYSTEM_INSTRUCTIONS);
        await this.forwardToCodex(req, res, openAIReq, codexToken, anthropicReq.stream ?? true);
      } else if (url.pathname.startsWith("/api/hello")) {
        // Health check endpoint - return success
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      } else {
        // Other endpoints - return mock success to let Claude Code continue
        console.log(chalk.yellow(`   Unknown endpoint: ${url.pathname} - returning mock response`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          status: "ok",
          message: "Endpoint not implemented in proxy"
        }));
      }
    } catch (err) {
      console.error("Error processing request:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: err instanceof Error ? err.message : "Invalid request",
          },
        })
      );
    }
  }

  private async forwardToCodex(
    originalReq: http.IncomingMessage,
    res: http.ServerResponse,
    openAIReq: OpenAIRequest,
    accessToken: string,
    stream: boolean
  ): Promise<void> {
    const requestBody = JSON.stringify(openAIReq);

    const options: https.RequestOptions = {
      hostname: "chatgpt.com",
      path: "/backend-api/codex/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "claude-codex-proxy/0.1.0",
        "Accept": "text/event-stream",
        "Content-Length": Buffer.byteLength(requestBody),
      },
    };

    if (this.options.verbose) {
      console.log("Forwarding to Codex API:", options.hostname, options.path);
    }

    return new Promise((resolve, reject) => {
      const codexReq = https.request(options, (codexRes) => {
        // Handle non-streaming response
        if (!stream) {
          let data = "";
          codexRes.on("data", (chunk) => (data += chunk));
          codexRes.on("end", () => {
            try {
              const openAIResp: OpenAIResponse = JSON.parse(data);
              const anthropicResp = translateOpenAIToAnthropic(openAIResp);

              res.writeHead(codexRes.statusCode || 200, {
                "Content-Type": "application/json",
              });
              res.end(JSON.stringify({
                id: openAIResp.id,
                type: "message",
                role: "assistant",
                content: anthropicResp.content,
                model: openAIReq.model,
                stop_reason: anthropicResp.stop_reason,
                usage: anthropicResp.usage,
              }));
              resolve();
            } catch (err) {
              console.error("Error parsing Codex response:", err);
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: {
                  type: "api_error",
                  message: "Error parsing upstream response",
                },
              }));
              resolve();
            }
          });
          return;
        }

        // Handle streaming response
        res.writeHead(codexRes.statusCode || 200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        // Send Anthropic-style stream start event
        res.write(createAnthropicStreamEvent("message_start", {
          type: "message",
          role: "assistant",
          content: [],
          model: originalReq.headers["x-model"] || "claude-sonnet-4-5-20250929",
        }));

        res.write(createAnthropicStreamEvent("content_block_start", {
          type: "content_block",
          index: 0,
          content_block: { type: "text", text: "" },
        }));

        let buffer = "";
        codexRes.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();

          // Process complete SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") continue;

              try {
                const chunk: OpenAIStreamChunk = JSON.parse(data);
                const translated = translateOpenAIStreamChunk(chunk);

                if (translated?.type === "content_block_delta" && translated.delta?.text) {
                  res.write(
                    createAnthropicStreamEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: translated.delta.text },
                    })
                  );
                }
              } catch (e) {
                // Ignore parse errors for non-JSON lines
              }
            }
          }
        });

        codexRes.on("end", () => {
          res.write(createAnthropicStreamEvent("content_block_stop", { index: 0 }));
          res.write(
            createAnthropicStreamEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 0 }, // TODO: Calculate actual tokens
            })
          );
          res.write(createAnthropicStreamEvent("message_stop", { type: "message_stop" }));
          res.end();
          resolve();
        });

        codexRes.on("error", (err) => {
          console.error("Codex API error:", err);
          res.end();
          resolve();
        });
      });

      codexReq.on("error", (err) => {
        console.error("Request to Codex failed:", err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            type: "api_error",
            message: "Failed to connect to Codex API",
          },
        }));
        resolve();
      });

      codexReq.write(requestBody);
      codexReq.end();
    });
  }
}

// Health check endpoint
export function createHealthCheckServer(port: number = 8081): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", service: "codex-proxy" }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }).listen(port);
}

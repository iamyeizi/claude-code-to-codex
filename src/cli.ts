#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { CodexProxyServer, createHealthCheckServer } from "./proxy.js";
import { performOAuthLogin, getValidAccessToken, clearTokens, loadTokens } from "./oauth.js";
import {
  generateCertificates,
  addHostsEntry,
  removeHostsEntry,
  certificatesExist,
  loadCertificates,
  printTrustInstructions,
  printHttpsModeInstructions,
} from "./ssl.js";

const program = new Command();

program
  .name("codex-proxy")
  .description("Middleware to connect Claude Code to Codex OAuth (Plus/Pro)")
  .version("0.1.0");

program
  .command("login")
  .description("Authenticate with Codex OAuth")
  .action(async () => {
    const spinner = ora("Starting OAuth flow...").start();
    try {
      spinner.text = "Opening browser for authentication...";
      const tokens = await performOAuthLogin();
      spinner.succeed(chalk.green("Successfully authenticated with Codex!"));
      console.log("");
      console.log("Token expires at:", new Date(tokens.expires_at).toLocaleString());
    } catch (err) {
      spinner.fail(chalk.red(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Clear stored authentication tokens")
  .action(async () => {
    await clearTokens();
    console.log(chalk.green("✓ Cleared authentication tokens"));
  });

program
  .command("status")
  .description("Check authentication status")
  .action(async () => {
    const tokens = await loadTokens();
    if (!tokens) {
      console.log(chalk.yellow("⚠ Not authenticated"));
      console.log("Run 'codex-proxy login' to authenticate");
      return;
    }

    const isExpired = Date.now() >= tokens.expires_at;
    const expiresIn = Math.floor((tokens.expires_at - Date.now()) / 1000 / 60);

    if (isExpired) {
      console.log(chalk.yellow("⚠ Token expired"));
      console.log("Run 'codex-proxy login' to re-authenticate");
    } else {
      console.log(chalk.green("✓ Authenticated"));
      console.log(`Token expires in ${expiresIn} minutes`);
    }
  });

program
  .command("setup-https")
  .description("Setup HTTPS mode for intercepting encrypted traffic (requires sudo)")
  .action(async () => {
    console.log(chalk.blue("🔐 Setting up HTTPS interception mode...\n"));
    
    try {
      // Generate certificates
      if (!(await certificatesExist())) {
        await generateCertificates();
      } else {
        console.log(chalk.gray("SSL certificates already exist, skipping generation"));
      }
      
      // Add hosts entry
      await addHostsEntry();
      
      // Print instructions
      printTrustInstructions();
      printHttpsModeInstructions();
    } catch (err) {
      console.error(chalk.red("Setup failed:"), err);
      process.exit(1);
    }
  });

program
  .command("start")
  .description("Start the proxy server")
  .option("-p, --port <port>", "Proxy server port (default: 443 for HTTPS mode, 8080 for HTTP)")
  .option("-v, --verbose", "Enable verbose logging", false)
  .option("--https", "Use HTTPS mode (requires setup-https first)", false)
  .action(async (options) => {
    const httpsMode = options.https;
    // Default to 443 for HTTPS mode, 8080 for HTTP mode
    const defaultPort = httpsMode ? "443" : "8080";
    const port = parseInt(options.port || defaultPort, 10);

    // Check authentication first
    const token = await getValidAccessToken();
    if (!token) {
      console.log(chalk.red("✗ Not authenticated"));
      console.log("Run 'codex-proxy login' first");
      process.exit(1);
    }

    // If HTTPS mode, check for certificates
    let sslCert = undefined;
    if (httpsMode) {
      sslCert = await loadCertificates();
      if (!sslCert) {
        console.log(chalk.red("✗ SSL certificates not found"));
        console.log("Run 'codex-proxy setup-https' first");
        process.exit(1);
      }
      console.log(chalk.blue("🔒 Starting Codex Proxy Server in HTTPS mode..."));
    } else {
      console.log(chalk.blue("🚀 Starting Codex Proxy Server in HTTP mode..."));
    }
    console.log("");

    const server = new CodexProxyServer({ port, verbose: options.verbose, httpsMode, sslCert });

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n" + chalk.yellow("Shutting down..."));
      await server.stop();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await server.stop();
      process.exit(0);
    });

    try {
      await server.start();

      if (!httpsMode) {
        // Start health check server only in HTTP mode
        const healthServer = createHealthCheckServer(port + 1);
        console.log(`🏥 Health check at http://localhost:${port + 1}/health`);
      }
    } catch (err) {
      if (httpsMode && (err as NodeJS.ErrnoException).code === "EACCES") {
        console.error(chalk.red("Permission denied: HTTPS mode requires port 443 (privileged)"));
        console.log(chalk.yellow("Try running with sudo:"));
        console.log(chalk.white(`  sudo codex-proxy start --https`));
      } else {
        console.error(chalk.red("Failed to start server:"), err);
      }
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Start proxy in HTTP mode (for testing HTTP connections only)")
  .option("-p, --port <port>", "Proxy server port", "8080")
  .option("-v, --verbose", "Enable verbose logging", false)
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    // Check authentication first
    const token = await getValidAccessToken();
    if (!token) {
      console.log(chalk.red("✗ Not authenticated"));
      console.log("Run 'codex-proxy login' first");
      process.exit(1);
    }

    console.log(chalk.blue("🚀 Starting Codex Proxy Server..."));
    console.log("");
    console.log(chalk.yellow("⚠️  Important Limitation:"));
    console.log(chalk.white("   Claude Code uses HTTPS to connect to api.anthropic.com"));
    console.log(chalk.white("   HTTP_PROXY only works with HTTP connections, not HTTPS"));
    console.log(chalk.white("   For HTTPS interception, use: codex-proxy setup-https\n"));

    const server = new CodexProxyServer({ port, verbose: options.verbose });

    try {
      await server.start();

      console.log("");
      console.log(chalk.cyan("HTTP proxy is running, but Claude Code won't use it for HTTPS"));
      console.log(chalk.cyan("Use 'codex-proxy setup-https' for full HTTPS interception."));
    } catch (err) {
      console.error(chalk.red("Failed to start server:"), err);
      process.exit(1);
    }
  });

program.parse();

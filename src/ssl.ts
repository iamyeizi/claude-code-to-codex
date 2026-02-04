import https from "https";
import http from "http";
import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import { ANTHROPIC_API_HOST, CONFIG_DIR } from "./config.js";

// Paths for SSL certificates
const CERT_DIR = path.join(CONFIG_DIR, "certs");
const CERT_KEY = path.join(CERT_DIR, "anthropic-key.pem");
const CERT_CERT = path.join(CERT_DIR, "anthropic-cert.pem");

/**
 * Check if SSL certificates exist
 */
export async function certificatesExist(): Promise<boolean> {
  try {
    await fs.access(CERT_KEY);
    await fs.access(CERT_CERT);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate self-signed SSL certificates for api.anthropic.com
 */
export async function generateCertificates(): Promise<void> {
  console.log(chalk.blue("🔐 Generating SSL certificates for HTTPS interception..."));
  
  try {
    await fs.mkdir(CERT_DIR, { recursive: true });
    
    // Generate private key
    execSync(
      `openssl genrsa -out "${CERT_KEY}" 2048`,
      { stdio: "inherit" }
    );
    
    // Generate certificate signing request and self-signed cert with SAN
    // Include all Anthropic domains that need interception
    const subj = "/C=US/ST=CA/L=Local/O=CodexProxy/CN=api.anthropic.com";
    const san = "subjectAltName=DNS:api.anthropic.com,DNS:*.anthropic.com,DNS:claude.ai,DNS:*.claude.ai,DNS:platform.claude.com,DNS:*.platform.claude.com,DNS:console.anthropic.com,DNS:*.console.anthropic.com";
    execSync(
      `openssl req -new -x509 -key "${CERT_KEY}" -out "${CERT_CERT}" -days 365 -subj "${subj}" -addext "${san}"`,
      { stdio: "inherit" }
    );
    
    console.log(chalk.green("✓ Certificates generated successfully"));
    console.log(chalk.gray(`  Key: ${CERT_KEY}`));
    console.log(chalk.gray(`  Cert: ${CERT_CERT}`));
  } catch (err) {
    console.error(chalk.red("Failed to generate certificates:"), err);
    throw err;
  }
}

/**
 * Load SSL certificates
 */
export async function loadCertificates(): Promise<{ key: string; cert: string } | null> {
  try {
    const [key, cert] = await Promise.all([
      fs.readFile(CERT_KEY, "utf-8"),
      fs.readFile(CERT_CERT, "utf-8"),
    ]);
    return { key, cert };
  } catch {
    return null;
  }
}

/**
 * Instructions for trusting the certificate
 */
export function printTrustInstructions(): void {
  console.log(chalk.yellow("\n⚠️  Certificate Trust Required"));
  console.log(chalk.white("To use HTTPS interception, you need to trust the self-signed certificate."));
  console.log(chalk.white("\nTrust instructions by OS:\n"));
  
  console.log(chalk.cyan("macOS:"));
  console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CERT_CERT}"`);
  console.log(chalk.gray("  Or double-click the .pem file and add to System keychain as Always Trust\n"));
  
  console.log(chalk.cyan("Linux (Ubuntu/Debian):"));
  console.log(`  sudo cp "${CERT_CERT}" /usr/local/share/ca-certificates/anthropic-api.crt`);
  console.log(`  sudo update-ca-certificates\n`);
  
  console.log(chalk.cyan("Linux (RHEL/CentOS/Fedora):"));
  console.log(`  sudo cp "${CERT_CERT}" /etc/pki/ca-trust/source/anchors/anthropic-api.pem`);
  console.log(`  sudo update-ca-trust extract\n`);
  
  console.log(chalk.yellow("Note: You may need to restart Claude Code after trusting the certificate."));
}

/**
 * Check if /etc/hosts has the redirect entry
 */
export async function checkHostsFile(): Promise<boolean> {
  try {
    const hostsContent = await fs.readFile("/etc/hosts", "utf-8");
    return hostsContent.includes("api.anthropic.com");
  } catch {
    return false;
  }
}

/**
 * Add entry to /etc/hosts file
 */
export async function addHostsEntry(): Promise<void> {
  const entries = [
    "127.0.0.1 api.anthropic.com",
    "127.0.0.1 claude.ai",
    "127.0.0.1 platform.claude.com",
    "127.0.0.1 www.claude.ai",
    "127.0.0.1 auth.claude.ai",
    "127.0.0.1 console.anthropic.com"
  ];
  
  try {
    const hostsContent = await fs.readFile("/etc/hosts", "utf-8");
    const missingEntries = entries.filter(e => !hostsContent.includes(e));
    
    if (missingEntries.length === 0) {
      console.log(chalk.gray("All hosts entries already exist"));
      return;
    }
    
    console.log(chalk.blue(`Adding ${missingEntries.length} domain(s) to /etc/hosts...`));
    for (const entry of missingEntries) {
      execSync(`echo "${entry}" | sudo tee -a /etc/hosts`, { stdio: "inherit" });
    }
    console.log(chalk.green(`✓ Added ${missingEntries.length} entr(y/ies) to /etc/hosts`));
  } catch (err) {
    console.error(chalk.red("Failed to modify /etc/hosts:"), err);
    console.log(chalk.yellow("\nPlease manually add these lines to /etc/hosts:"));
    for (const entry of entries) {
      console.log(chalk.white(`  ${entry}`));
    }
    throw err;
  }
}

/**
 * Remove entry from /etc/hosts file
 */
export async function removeHostsEntry(): Promise<void> {
  const domains = ["api.anthropic.com", "claude.ai", "platform.claude.com", "www.claude.ai", "auth.claude.ai"];
  
  try {
    console.log(chalk.blue("Removing Anthropic domains from /etc/hosts..."));
    for (const domain of domains) {
      execSync(`sudo sed -i '/${domain}/d' /etc/hosts`, { stdio: "inherit" });
    }
    console.log(chalk.green("✓ Removed Anthropic domains from /etc/hosts"));
  } catch (err) {
    console.error(chalk.yellow("Could not automatically remove hosts entries:"), err);
    console.log(chalk.white("Please manually remove the lines from /etc/hosts"));
  }
}

/**
 * Print instructions for using HTTPS mode
 */
export function printHttpsModeInstructions(): void {
  console.log(chalk.green("\n✓ HTTPS Mode Setup Complete!\n"));
  console.log(chalk.white("Next steps:"));
  console.log(chalk.white("  1. Trust the SSL certificate (see instructions above)"));
  console.log(chalk.white("  2. Run: codex-proxy start --https"));
  console.log(chalk.white("  3. Claude Code will automatically connect through the proxy\n"));
  console.log(chalk.gray("The proxy will intercept HTTPS traffic to api.anthropic.com and"));
  console.log(chalk.gray("translate it to Codex API requests.\n"));
}

# Claude Code → Codex Proxy (WIP)

Middleware to connect Claude Code to OpenAI Codex OAuth (ChatGPT Plus/Pro subscription).

## ✅ Working Solution: API Key Mode

**This approach uses Anthropic Console API key authentication - no subscription required!**

## Quick Start

### 1. Get Anthropic API Key (Free Tier)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up for free ($5 credit included)
3. Create an API key
4. Copy the key (starts with `sk-ant-api03-...`)

### 2. Login to Codex OAuth

```bash
# Authenticate with your ChatGPT Plus/Pro account
codex-proxy login
```

This opens browser for Codex OAuth. You'll need an active ChatGPT Plus or Pro subscription.

### 3. Start the Proxy (HTTP Mode)

```bash
# Start the proxy on port 8082
codex-proxy start --port 8082
```

### 4. Run Claude Code with API Key

```bash
# Set the API key and proxy URL
export ANTHROPIC_API_KEY="sk-ant-api03-your-key-here"
export ANTHROPIC_BASE_URL="http://localhost:8082"

# Run Claude Code
claude
```

**That's it!** Claude Code will:
- Use your Anthropic API key for authentication
- Connect through the proxy to Codex
- Work with your ChatGPT Plus/Pro subscription

## How It Works

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│ Claude Code  │ ──────► │   Proxy      │ ──────► │  Codex API   │
│              │ API Key │  (HTTP)      │ OAuth   │              │
└──────────────┘         └──────────────┘         └──────────────┘
       │                        │
       │ Uses                   │ Translates
       │ ANTHROPIC_API_KEY        │ Anthropic ↔ OpenAI
       │ for auth                 │
```

1. **Claude Code** authenticates with Anthropic using your API key
2. **API calls** go to `localhost:8082` (our proxy)
3. **Proxy** validates the API key format
4. **Proxy** uses your **Codex OAuth token** to forward requests to OpenAI
5. **Responses** translated back to Anthropic format

## Installation

```bash
# Install globally
npm install -g .

# Or run locally
npm install
npm run build
```

## Commands

```bash
codex-proxy login                 # Authenticate with Codex OAuth
codex-proxy logout                # Clear stored tokens
codex-proxy status                # Check authentication status
codex-proxy start [options]       # Start the proxy server
  --port <port>                   # Proxy port (default: 8082)
  --verbose                       # Enable verbose logging
codex-proxy --help                # Show help
```

## Configuration

### Environment Variables

**For Claude Code:**
```bash
export ANTHROPIC_API_KEY="sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # Required
export ANTHROPIC_BASE_URL="http://localhost:8082"                     # Required
```

**For Proxy:**
```bash
export CODEX_PROXY_PORT=8082    # Override default port
```

### Token Storage

Codex OAuth tokens are stored in `~/.codex-proxy/tokens.json` (plaintext).

## Architecture

### Components

- **CLI (`src/cli.ts`)**: Command-line interface
- **OAuth (`src/oauth.ts`)**: PKCE OAuth flow with OpenAI for Codex
- **Proxy (`src/proxy.ts`)**: HTTP proxy translating Anthropic ↔ OpenAI
- **Translator (`src/translator.ts`)**: Message format conversion
- **Config (`src/config.ts`)**: Constants and configuration

### Model Mapping

| Claude Model | Codex Model |
|-------------|-------------|
| claude-sonnet-4-5 | gpt-5.2-codex |
| claude-opus-4-5 | gpt-5.2-codex |
| claude-haiku-4-5 | gpt-5.1-codex-mini |
| *(default)* | gpt-5.2-codex |

## Troubleshooting

### "Invalid API key" error

Make sure your API key starts with `sk-ant-` and is properly set:
```bash
echo $ANTHROPIC_API_KEY
```

### "Not authenticated with Codex" error

Run `codex-proxy login` first to authenticate with Codex OAuth.

### Claude Code still shows subscription requirement

Make sure you're using Claude Code v2.1.30 or later. Older versions may have different authentication flows.

### Proxy not intercepting requests

Check that `ANTHROPIC_BASE_URL` is set correctly:
```bash
export ANTHROPIC_BASE_URL="http://localhost:8082"
```

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build

# Run in development mode
npm run dev
```

## Requirements

- Node.js 20+
- ChatGPT Plus or Pro subscription (for Codex OAuth)
- Anthropic Console account with API key (free tier works)
- Claude Code CLI installed

## Limitations

- Basic chat only (no MCP/tools)
- Single session support
- Requires active ChatGPT Plus/Pro for Codex access
- API key mode bypasses subscription but requires Anthropic account

## License

MIT

## Acknowledgments

Based on the OpenCode Codex implementation and the claude-code-proxy project by fuergaosi233.

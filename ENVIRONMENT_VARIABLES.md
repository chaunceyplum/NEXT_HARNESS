# Environment Variables Guide

## Required Variables

### `MCP_ENDPOINT_URL` (REQUIRED)

**What it is**: The URL to your MCP Lambda backend via API Gateway

**Where to get it**:
1. From your SAM deployment outputs:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name mcp \
     --query 'Stacks[0].Outputs[?OutputKey==`McpEndpointUrl`].OutputValue' \
     --output text
   ```

2. Or from AWS Console:
   - Go to CloudFormation → Stacks → mcp → Outputs
   - Look for `McpEndpointUrl`

**Format**:
```
https://<api-gateway-id>.execute-api.<region>.amazonaws.com/mcp
```

**Example**:
```
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
```

**Used by**: 
- `lib/mcp-client.ts` — HTTP bridge to call MCP tools
- All API routes — Build, status, artifacts

**What happens if missing**:
```
Error: MCP_ENDPOINT_URL is not set. Please configure it in .env.local
```

---

## Optional Variables

### `NEXT_PUBLIC_API_URL` (OPTIONAL)

**What it is**: Public URL for your harness API (used by frontend)

**Default value**: `http://localhost:3000` (development)

**Use cases**:
- **Local development**: `http://localhost:3000`
- **Staging**: `https://staging-harness.example.com`
- **Production**: `https://harness.example.com`

**Example**:
```
NEXT_PUBLIC_API_URL=https://harness.example.com
```

**Note**: Variables prefixed with `NEXT_PUBLIC_` are exposed to the browser

---

## Setup Instructions

### Local Development

Create `.env.local` in the project root:

```bash
cat > .env.local << 'EOF'
# Required: Get from MCP SAM deployment
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp

# Optional: API URL (defaults to http://localhost:3000)
NEXT_PUBLIC_API_URL=http://localhost:3000
EOF
```

### Vercel Deployment

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project
3. Go to **Settings** → **Environment Variables**
4. Add variable:
   - **Name**: `MCP_ENDPOINT_URL`
   - **Value**: `https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp`
   - **Environments**: Select Production (or all)
5. Click "Save"
6. Trigger new deployment (or push to git)

### EC2 Deployment

Create `.env.local` on your server:

```bash
ssh -i your-key.pem ubuntu@your-instance-ip

cd NEXT_HARNESS

cat > .env.local << 'EOF'
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
NEXT_PUBLIC_API_URL=https://your-domain.com
EOF

npm run build
npm run start
```

### Docker Deployment

Pass environment variables when running:

```bash
docker run -p 3000:3000 \
  -e MCP_ENDPOINT_URL="https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp" \
  -e NEXT_PUBLIC_API_URL="https://harness.example.com" \
  mcp-harness:latest
```

Or in docker-compose.yml:

```yaml
version: '3'
services:
  harness:
    image: mcp-harness:latest
    ports:
      - "3000:3000"
    environment:
      MCP_ENDPOINT_URL: https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
      NEXT_PUBLIC_API_URL: https://harness.example.com
```

### Self-Hosted Deployment

Create `.env.local`:

```bash
MCP_ENDPOINT_URL=https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp
NEXT_PUBLIC_API_URL=https://your-domain.com
```

Then start:

```bash
npm install
npm run build
npm run start
```

---

## Verifying Configuration

### Test MCP Connection

```bash
# Verify endpoint is accessible
curl -X POST https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test","method":"tools/list"}'

# Should return a list of MCP tools
```

### Test Harness Locally

```bash
# Start development server
npm run dev

# In another terminal, test the build endpoint
curl -X POST http://localhost:3000/api/build \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Build an AEP solution for ecommerce"
  }'

# Should return:
# {"execution_id":"exec-xxx","status":"QUEUED","message":"..."}
```

### Test Status Polling

```bash
# Replace exec-xxx with actual execution_id
curl http://localhost:3000/api/executions/exec-xxx/status

# Should return:
# {"execution_id":"exec-xxx","status":"RUNNING","progress":0.25,...}
```

---

## Troubleshooting

### "MCP_ENDPOINT_URL is not set"

**Problem**: Environment variable not configured

**Solution**:
1. Create `.env.local` in project root
2. Add: `MCP_ENDPOINT_URL=https://...`
3. Restart dev server: `npm run dev`

### "Cannot connect to MCP"

**Problem**: Endpoint URL is wrong or MCP is offline

**Solutions**:
1. Verify endpoint URL from SAM outputs
2. Check MCP Lambda is deployed: `aws lambda list-functions`
3. Test endpoint with curl (see Verifying Configuration)
4. Check API Gateway is deployed: `aws apigateway get-rest-apis`

### "NetworkError when attempting to fetch"

**Problem**: CORS or network issues

**Solutions**:
1. Verify endpoint URL is correct
2. Check security groups allow HTTPS (port 443)
3. Try from different network
4. Check CloudWatch logs for Lambda errors

### Staging vs Production Using Different Endpoints

Use environment-specific variables:

**.env.local** (local development):
```
MCP_ENDPOINT_URL=https://dev-mcp.execute-api.us-east-1.amazonaws.com/mcp
```

**.env.staging**:
```
MCP_ENDPOINT_URL=https://staging-mcp.execute-api.us-east-1.amazonaws.com/mcp
```

**.env.production**:
```
MCP_ENDPOINT_URL=https://prod-mcp.execute-api.us-east-1.amazonaws.com/mcp
```

Then load with: `next build --env-file=.env.production`

---

## Environment Variables Reference

| Variable | Required | Type | Example |
|----------|----------|------|---------|
| `MCP_ENDPOINT_URL` | ✅ Yes | URL | `https://abc123xyz.execute-api.us-east-1.amazonaws.com/mcp` |
| `NEXT_PUBLIC_API_URL` | ❌ No | URL | `https://harness.example.com` |

---

## Security Best Practices

✅ **DO**:
- Store `.env.local` in `.gitignore` (already configured)
- Use environment-specific configs (dev, staging, prod)
- Rotate endpoints if leaked
- Use HTTPS only
- Monitor API Gateway access logs

❌ **DON'T**:
- Commit `.env.local` to git
- Hardcode endpoints in code
- Share endpoints publicly
- Use HTTP (insecure)
- Expose endpoint in client-side code

---

## Getting Help

If you're stuck finding your MCP endpoint:

1. **Check AWS Console**:
   - Go to CloudFormation
   - Find stack named `mcp`
   - Click "Outputs" tab
   - Look for `McpEndpointUrl`

2. **Use AWS CLI**:
   ```bash
   aws cloudformation describe-stacks --stack-name mcp --query 'Stacks[0].Outputs'
   ```

3. **Check SAM logs**:
   ```bash
   sam logs --stack-name mcp --tail
   ```

4. **Verify Lambda is running**:
   ```bash
   aws lambda list-functions --query 'Functions[?contains(FunctionName, `mcp`)]'
   ```

5. **Test API Gateway**:
   ```bash
   aws apigateway get-rest-apis
   ```

---

## Quick Reference

### Minimal Setup (Local Development)

```bash
# 1. Create .env.local
echo "MCP_ENDPOINT_URL=https://your-endpoint/mcp" > .env.local

# 2. Install dependencies
npm install

# 3. Run development server
npm run dev

# 4. Open http://localhost:3000
```

### Production Setup (Vercel)

```bash
# 1. Push to GitHub
git push origin main

# 2. On Vercel Dashboard:
#    - Go to Settings → Environment Variables
#    - Add MCP_ENDPOINT_URL
#    - Deploy

# 3. Application live at your-project.vercel.app
```

### Docker Quick Setup

```bash
docker run -p 3000:3000 \
  -e MCP_ENDPOINT_URL="https://your-endpoint/mcp" \
  mcp-harness:latest
```

---

## Advanced Configuration

### Multiple MCP Endpoints (A/B Testing)

```bash
# .env.local
MCP_ENDPOINT_URL=https://primary-endpoint/mcp
MCP_ENDPOINT_URL_FALLBACK=https://fallback-endpoint/mcp
```

Then update `lib/mcp-client.ts` to use fallback on failure.

### Custom API Base Path

```bash
# If your API isn't at /api
NEXT_PUBLIC_API_BASE=/v1/api
```

### Development vs Production

Use `.env.development` and `.env.production`:

**.env.development**:
```
MCP_ENDPOINT_URL=https://localhost:3001/mcp
NODE_ENV=development
```

**.env.production**:
```
MCP_ENDPOINT_URL=https://api.example.com/mcp
NODE_ENV=production
```

---

That's it! Just set `MCP_ENDPOINT_URL` and you're good to go. 🚀

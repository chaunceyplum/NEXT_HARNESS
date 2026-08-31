# Deployment Guide - MCP Harness

## Quick Start

### 1. Prerequisites
- Node.js 20.9+ installed (Next.js 16 requires it — `node --version` to check)
- MCP Lambda deployed on AWS
- GitHub repository access

### 2. Get MCP Endpoint

From your MCP deployment outputs:
```bash
aws cloudformation describe-stacks --stack-name mcp --query 'Stacks[0].Outputs' --output table
```

Look for `McpEndpointUrl` output.

### 3. Configure Environment

Create `.env.local`. `MCP_ENDPOINT_URL` is required, but so is at least one
chat-model provider now — the harness runs an LLM agent loop
(`lib/llm/agent.ts`), not just an MCP passthrough. See
`ENVIRONMENT_VARIABLES.md` for the full list (Bedrock/Anthropic/OpenAI
options, tool-shortlisting embeddings, `ADOBE_TOOLS_ONLY`, the RAG judge).
Minimum to actually run something:
```bash
MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp

# Bedrock is the default chat-model provider — no Anthropic key needed,
# just AWS credentials (or AWS_BEARER_TOKEN_BEDROCK — see the note below).
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

### 4. Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Visit http://localhost:3000
```

### 5. Test the Connection

In browser at http://localhost:3000:
1. Enter a description: "Create an XDM schema for ecommerce purchase events"
2. Click "Run"
3. Read the Agent Trace — each tool call, its result, and the token usage
   for the run — then the final answer at the bottom
4. If `finished:` isn't `stop`, the agent hit its step limit mid-task
   (raise "Max steps" and re-run) rather than reaching a real answer

---

## Deployment Options

Every option below shows only `MCP_ENDPOINT_URL` for brevity — in practice
you also need at least one chat-model provider's credentials (Bedrock's
`AWS_*` vars by default, per step 3 above) or the app will fail at request
time, not at startup. See `ENVIRONMENT_VARIABLES.md` for the full list.

### Option A: Vercel (Recommended)

**Easiest for Next.js, free tier available**

#### Step 1: Push to GitHub
```bash
git push origin main
```

#### Step 2: Connect to Vercel
1. Visit https://vercel.com/new
2. Import GitHub repository
3. Configure build settings (Next.js preset)
4. Add environment variable:
   - Name: `MCP_ENDPOINT_URL`
   - Value: `https://xxx.execute-api.us-east-1.amazonaws.com/mcp`
5. Click "Deploy"

#### Step 3: Done!
Your harness is live at: `https://<project>.vercel.app`

---

### Option B: AWS EC2

**Full control, ~$10/month**

#### Step 1: Create EC2 Instance
```bash
# Launch t3.micro instance with Ubuntu 22.04
# Security group: Allow HTTP (80), HTTPS (443), SSH (22)
# Generate and save key pair
```

#### Step 2: SSH into Instance
```bash
ssh -i your-key.pem ubuntu@<instance-ip>
```

#### Step 3: Install Dependencies
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2
```

#### Step 4: Deploy Application
```bash
# Clone repository
git clone https://github.com/chaunceyplum/NEXT_HARNESS.git
cd NEXT_HARNESS

# Install dependencies
npm install

# Create .env.local
echo "MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp" > .env.local

# Build
npm run build

# Start with PM2
pm2 start "npm run start" --name "mcp-harness"
pm2 startup
pm2 save
```

#### Step 5: Setup Reverse Proxy (Optional)
```bash
# Install nginx
sudo apt install -y nginx

# Create nginx config
sudo tee /etc/nginx/sites-available/harness > /dev/null <<EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/harness /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Step 6: Access Application
- SSH: Connect to your instance
- Web: Visit `http://<instance-ip>`

---

### Option C: Docker

**Portable, easy to scale**

#### Step 1: Create Dockerfile
```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]
```

#### Step 2: Build Image
```bash
docker build -t mcp-harness:latest .
```

#### Step 3: Run Container
```bash
docker run -p 3000:3000 \
  -e MCP_ENDPOINT_URL="https://xxx.execute-api.us-east-1.amazonaws.com/mcp" \
  mcp-harness:latest
```

#### Step 4: Access
Visit `http://localhost:3000`

---

### Option D: Self-Hosted

**Maximum control, requires Linux server**

#### Step 1: SSH to Server
```bash
ssh user@your-server.com
```

#### Step 2: Setup Application
```bash
# Clone repo
git clone https://github.com/chaunceyplum/NEXT_HARNESS.git
cd NEXT_HARNESS

# Install dependencies
npm install

# Create .env.local
echo "MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp" > .env.local

# Build
npm run build

# Run (in screen or tmux)
npm run start
```

#### Step 3: Setup Firewall
```bash
# Allow ports
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

#### Step 4: Setup SSL (Optional)
```bash
# Using Certbot
sudo apt install certbot python3-certbot-nginx
sudo certbot certonly --standalone -d your-domain.com
```

---

## Post-Deployment Checklist

### Verification
- [ ] Application loads without errors
- [ ] Form accepts input
- [ ] `/api/build` responds with a full agent trace
- [ ] Token usage shows up in the trace and in `/results`
- [ ] Past runs list and replay correctly from `/results`
- [ ] Error handling displays properly

### Monitoring
- [ ] Set up error tracking (Sentry, DataDog)
- [ ] Monitor API response times
- [ ] Track run success rate (`status` on `harness_agent_runs`)
- [ ] Monitor server resources

### Security
- [ ] HTTPS enabled (for production)
- [ ] Firewall properly configured
- [ ] Rate limiting enabled (optional)
- [ ] Secrets not committed
- [ ] Environment variables secured

### Performance
- [ ] Cache enabled where appropriate
- [ ] API response times reasonable given the model tier chosen (an
      "expensive" tier + many tool calls is legitimately slower, not a bug)
- [ ] Bundle size optimized
- [ ] Images optimized

---

## Troubleshooting

### "MCP_ENDPOINT_URL is not set"
**Solution**: Add to `.env.local`
```bash
MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp
```

### "Cannot connect to MCP"
**Solutions**:
1. Verify endpoint URL is correct
2. Check MCP Lambda is running
3. Check security groups allow HTTPS
4. Verify API Gateway is deployed

### "Build finishes but the answer looks cut off"
**Solutions**:
1. Check `finishReason` in the trace — `tool-calls` means the agent hit
   `maxSteps` mid-task, not a real error; raise "Max steps" and re-run
2. Check MCP logs for errors on the individual tool calls in the trace
3. Check network connectivity to the MCP endpoint

### "High latency / Slow responses"
**Solutions**:
1. Check MCP Lambda performance
2. Monitor API Gateway metrics
3. Check network latency to AWS
4. Consider Lambda optimization

---

## Scaling

### Vertical Scaling
- Increase EC2 instance size
- Increase Lambda memory
- Increase RDS instance

### Horizontal Scaling
- Use load balancer (ALB/NLB)
- Run multiple harness instances — note the tool catalog and the
  tool-shortlisting embedding index are both in-memory, per-process
  (`lib/llm/tool-catalog.ts`, `lib/llm/tool-retrieval.ts`); each instance
  rebuilds them independently on first use rather than sharing one copy.
  Fine at small scale, worth revisiting before running many instances.
- Use Lambda reserved concurrency

### Optimization
- Enable CloudFront CDN
- Use Lambda@Edge for routing
- Implement caching

---

## Monitoring & Logging

### Application Logs
```bash
# Vercel
vercel logs

# EC2 with PM2
pm2 logs mcp-harness

# Docker
docker logs <container-id>
```

### Metrics to Monitor
- API response times
- Error rate
- Run success rate (`status` on `harness_agent_runs`, via `/results`)
- Token usage / cost per run (`usage` on each run — see `/results` and
  `/results/:id`)

### Error Tracking
```bash
# Install Sentry (example)
npm install @sentry/nextjs

# Add to app
import * as Sentry from "@sentry/nextjs";
```

---

## Maintenance

### Regular Tasks
- Monitor disk space
- Update dependencies: `npm update`
- Check for security vulnerabilities: `npm audit`
- Review error logs
- Monitor performance metrics

### Updates
```bash
# Pull latest changes
git pull origin main

# Install updates
npm install

# Rebuild
npm run build

# Restart (EC2 with PM2) — see "Known Gotchas" below if changed env vars
# don't seem to take effect after this
pm2 restart mcp-harness --update-env
```

---

## Known Gotchas (from live deployment)

These cost real debugging time on a real deployment — check them before
assuming something deeper is broken.

### PM2 caches environment variables at daemon start
`pm2 restart <name>` alone does **not** reliably pick up changes to
`.env.local` — the PM2 daemon itself can hold onto stale env vars from
when it was first started, especially if it was ever started from a shell
that had conflicting values exported. Fixes, in order of how much they
actually work:
1. `pm2 restart <name> --update-env` (as in the Updates command above)
2. If that doesn't work: `pm2 kill`, start a **clean** shell (no leftover
   `export`ed vars from earlier debugging), then `pm2 start` fresh
3. Confirm what the running process actually sees with `pm2 env <id>` or
   by checking `pm2 logs` right after a boot

### `npm run build` must succeed *before* `pm2 start`/`npm run start`
Skipping or silently failing the build doesn't fail loudly — you'll instead
see `next start` fail to bind the port, or a confusing `EADDRINUSE` on the
next attempt, rather than a clear "no build found" error. If startup
behaves strangely, `npm run build` on its own first and read its output
before touching PM2 at all.

### Bedrock auth: two different mechanisms, don't mix signals
Bedrock (the default chat-model provider) accepts either SigV4 credentials
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`) or bearer
token auth (`AWS_BEARER_TOKEN_BEDROCK`), and the bearer token takes
precedence if both are set. Either way, `AWS_REGION` is still required —
Bedrock builds its endpoint URL from the region regardless of which auth
method you're using, and throws rather than defaulting on its own if it's
unresolvable. A bare `Forbidden` with no useful body from Bedrock is worth
checking both of these before assuming an IAM permissions problem.

---

## Backup & Disaster Recovery

### Data to Backup
- `.env.local` (secrets)
- Run history — lives in the **MCP server's own Postgres**
  (`harness_agent_runs`, written via its `execute_sql` tool), not in
  anything local to the harness; back that database up, not this app
- Application logs

### Recovery Steps
1. Restore `.env.local`
2. Redeploy application
3. Verify MCP connectivity
4. Run a real request end-to-end and confirm it shows up in `/results`

---

## Support & Resources

- **Overview & architecture**: See `README.md` and `ARCHITECTURE.md`
- **Environment variables**: See `ENVIRONMENT_VARIABLES.md`
- Everything else in this repo's root (`START_HERE.md`,
  `HARNESS_REQUIREMENTS.md`, `MCP_TOOLS_REFERENCE.md`,
  `IMPLEMENTATION_SUMMARY.md`, etc.) describes an earlier, abandoned design
  and is marked superseded at the top — historical context only.

---

## Next Steps

1. ✅ Choose deployment platform
2. ✅ Configure MCP endpoint
3. ✅ Deploy application
4. ✅ Test end-to-end
5. ✅ Set up monitoring
6. ✅ Share with team

**Happy deploying!** 🚀

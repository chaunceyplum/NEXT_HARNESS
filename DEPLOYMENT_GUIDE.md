# Deployment Guide - MCP Harness

## Quick Start

### 1. Prerequisites
- Node.js 18+ installed
- MCP Lambda deployed on AWS
- GitHub repository access

### 2. Get MCP Endpoint

From your MCP deployment outputs:
```bash
aws cloudformation describe-stacks --stack-name mcp --query 'Stacks[0].Outputs' --output table
```

Look for `McpEndpointUrl` output.

### 3. Configure Environment

Create `.env.local`:
```bash
MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp
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
1. Enter a description: "Build an AEP solution for ecommerce"
2. Click "Build"
3. Monitor progress on the execution page
4. Download artifacts when complete

---

## Deployment Options

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
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
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
FROM node:18-alpine

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
- [ ] Build endpoint responds
- [ ] Status polling works
- [ ] Artifacts download successfully
- [ ] Error handling displays properly

### Monitoring
- [ ] Set up error tracking (Sentry, DataDog)
- [ ] Monitor API response times
- [ ] Track execution success rate
- [ ] Monitor server resources

### Security
- [ ] HTTPS enabled (for production)
- [ ] Firewall properly configured
- [ ] Rate limiting enabled (optional)
- [ ] Secrets not committed
- [ ] Environment variables secured

### Performance
- [ ] Cache enabled where appropriate
- [ ] API response times < 1s (excluding orchestrator)
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

### "Build starts but doesn't complete"
**Solutions**:
1. Check MCP logs for errors
2. Verify orchestrator is running
3. Check network connectivity
4. Verify timeout settings

### "Artifacts not downloading"
**Solutions**:
1. Check artifact generation in MCP
2. Verify response size is reasonable
3. Check browser console for errors
4. Try different browser

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
- Run multiple harness instances
- Use Lambda reserved concurrency

### Optimization
- Enable CloudFront CDN
- Use Lambda@Edge for routing
- Implement caching
- Optimize artifact storage (S3)

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
- Build success rate
- User sessions
- Artifact downloads

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

# Restart (EC2 with PM2)
pm2 restart mcp-harness
```

---

## Backup & Disaster Recovery

### Data to Backup
- `.env.local` (secrets)
- Execution history (if storing in DB)
- Application logs

### Recovery Steps
1. Restore `.env.local`
2. Redeploy application
3. Verify MCP connectivity
4. Run test builds

---

## Support & Resources

- **Documentation**: See `START_HERE.md`
- **Architecture**: See `HARNESS_REQUIREMENTS.md`
- **API Reference**: See `MCP_TOOLS_REFERENCE.md`
- **Implementation**: See `IMPLEMENTATION_SUMMARY.md`

---

## Next Steps

1. ✅ Choose deployment platform
2. ✅ Configure MCP endpoint
3. ✅ Deploy application
4. ✅ Test end-to-end
5. ✅ Set up monitoring
6. ✅ Share with team

**Happy deploying!** 🚀

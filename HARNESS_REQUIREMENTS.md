# MCP Harness Architecture & Requirements

## Current State Summary

You have two repositories:

1. **MCP Repository** (`chaunceyplum/mcp`) — Python Lambda function on AWS
   - 139 production tools across 3 agents (Adobe, AWS, Data Engineering)
   - Planner (1,151 LOC) — converts natural language to SolutionConfig
   - Orchestrator (28 KB) — executes multi-phase automation workflows
   - Knowledge base — pgvector + Voyage AI semantic search
   - Deployed as AWS Lambda + API Gateway

2. **Harness Repository** (`chaunceyplum/NEXT_HARNESS`) — JavaScript/Next.js
   - Minimal bootstrap (Next.js 16.2, React 19.2, TypeScript, Tailwind)
   - No backend logic yet
   - Will be the UI & orchestration layer

---

## What the "Harness" Should Be

The **Harness** is a wrapper application that:
- Provides a **web UI** for users to describe what they want to build
- Calls the **MCP Planner** (on Lambda) to convert natural language → SolutionConfig
- Calls the **MCP Orchestrator** (on Lambda) to execute the multi-phase workflow
- Polls for progress, handles retries, stores execution history
- Returns artifacts (Terraform, scripts, configuration) to the user

### Architecture Diagram

```
┌─────────────────────────────┐
│   Browser UI (React)        │
│   NEXT_HARNESS/app         │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────────────────────┐
│   Next.js API Routes (/api/build, /api/*)   │
│   - Call MCP Planner (HTTP POST)            │
│   - Call MCP Orchestrator (HTTP POST)       │
│   - Store execution in Postgres             │
│   - Poll orchestrator status                │
└────────────┬────────────────────────────────┘
             │  (HTTP/HTTPS)
             ▼
┌─────────────────────────────────────────────┐
│   AWS Lambda (MCP Server)                   │
│   chaunceyplum/mcp                          │
│   - Planner tool (language → config)        │
│   - Orchestrator tool (config → execute)    │
│   - 139 integration tools                   │
└─────────────────────────────────────────────┘
```

---

## What You Need to Add to the Harness

### 1. **API Routes** (Next.js App Router)

Create these endpoints in the harness:

#### `POST /api/build`
Accepts user description, calls planner, launches orchestration.

```typescript
// app/api/build/route.ts
export async function POST(request: Request) {
  const { description, config_overrides } = await request.json();
  
  // 1. Call MCP planner_parse_natural_language
  const plan = await callMcpTool('planner_parse_natural_language', {
    natural_language: description,
    business_vertical: config_overrides?.business_vertical || 'generic',
  });
  
  // 2. Call MCP orchestrator_execute
  const execution = await callMcpTool('orchestrator_execute', {
    solution_config: plan.solution_config,
  });
  
  // 3. Store in database
  await storeExecution(execution);
  
  return { execution_id: execution.id, status: 'QUEUED' };
}
```

#### `GET /api/executions/:id/status`
Poll orchestrator status.

```typescript
// app/api/executions/[id]/status/route.ts
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = (await params).id;
  
  // 1. Get execution from database
  const execution = await getExecution(id);
  
  // 2. Poll MCP orchestrator_get_status
  const status = await callMcpTool('orchestrator_get_status', {
    execution_id: id,
  });
  
  // 3. Update database
  await updateExecution(id, status);
  
  return { status: status.phase, progress: status.progress };
}
```

#### `GET /api/executions/:id/artifacts`
Retrieve generated artifacts (Terraform, scripts, etc.).

```typescript
// app/api/executions/[id]/artifacts/route.ts
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = (await params).id;
  
  // Get from database or S3
  const artifacts = await getArtifacts(id);
  
  return artifacts;
}
```

#### `GET /api/executions`
List user's executions.

```typescript
// app/api/executions/route.ts
export async function GET(request: Request) {
  // Query database for user's executions
  const executions = await listExecutions(user_id);
  return executions;
}
```

---

### 2. **MCP Client Utility** (HTTP Bridge to Lambda)

Create a utility to call MCP tools via HTTP:

```typescript
// lib/mcp-client.ts

const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL; // From SAM outputs
const MCP_API_KEY = process.env.MCP_API_KEY;

export async function callMcpTool(
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const payload = {
    jsonrpc: '2.0',
    id: `harness-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MCP_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`MCP call failed: ${response.status}`);
  }

  const result = await response.json();
  
  if (result.error) {
    throw new Error(`Tool error: ${result.error.message}`);
  }

  return result.result;
}
```

---

### 3. **Database Schema** (Postgres)

Add to your Postgres instance:

```sql
-- Execution history
CREATE TABLE executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    phase TEXT,
    progress FLOAT,
    solution_config JSONB,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Artifacts storage
CREATE TABLE artifacts (
    id SERIAL PRIMARY KEY,
    execution_id UUID REFERENCES executions(id) ON DELETE CASCADE,
    artifact_type TEXT,  -- 'terraform', 'script', 'config', etc.
    filename TEXT,
    content TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log
CREATE TABLE execution_logs (
    id SERIAL PRIMARY KEY,
    execution_id UUID REFERENCES executions(id) ON DELETE CASCADE,
    phase TEXT,
    message TEXT,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_executions_user_id ON executions(user_id);
CREATE INDEX idx_executions_created_at ON executions(created_at DESC);
CREATE INDEX idx_artifacts_execution_id ON artifacts(execution_id);
```

---

### 4. **UI Components** (React)

Create pages/components:

#### `app/page.tsx` — Landing / Builder Page
```typescript
// app/page.tsx
'use client';

import { useState } from 'react';

export default function Home() {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);

  async function handleBuild() {
    setLoading(true);
    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const { execution_id } = await res.json();
      setExecutionId(execution_id);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold">Autonomous MarTech Builder</h1>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe what you want to build..."
        className="w-full h-40 p-4 mt-4 border rounded"
      />
      <button
        onClick={handleBuild}
        disabled={loading}
        className="mt-4 px-4 py-2 bg-blue-600 text-white rounded"
      >
        {loading ? 'Building...' : 'Build'}
      </button>
      {executionId && (
        <div className="mt-4">
          <p>Execution ID: {executionId}</p>
          <a href={`/executions/${executionId}`}>View Progress</a>
        </div>
      )}
    </div>
  );
}
```

#### `app/executions/[id]/page.tsx` — Status Monitor
```typescript
// app/executions/[id]/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

export default function ExecutionPage() {
  const params = useParams();
  const id = params.id as string;
  
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await fetch(`/api/executions/${id}/status`);
      const data = await res.json();
      setStatus(data);
      setLoading(false);

      if (data.status === 'COMPLETED' || data.status === 'FAILED') {
        clearInterval(interval);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [id]);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Execution {id}</h1>
      <div className="mt-4">
        <p><strong>Status:</strong> {status.status}</p>
        <p><strong>Phase:</strong> {status.phase}</p>
        <p><strong>Progress:</strong> {(status.progress * 100).toFixed(0)}%</p>
        <div className="w-full bg-gray-300 h-4 mt-2 rounded">
          <div
            className="bg-green-500 h-4 rounded"
            style={{ width: `${status.progress * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
```

---

### 5. **Environment Variables** (`.env.local`)

```bash
# MCP Connection
MCP_ENDPOINT_URL=https://<api-gateway-id>.execute-api.us-east-1.amazonaws.com/mcp
MCP_API_KEY=<your-api-key-or-empty-if-internal>

# Database
DATABASE_URL=postgresql://user:pass@host/dbname

# Next.js
NEXT_PUBLIC_API_URL=http://localhost:3000
```

---

### 6. **Infrastructure (Terraform)** — Optional but Recommended

If you want to deploy the harness on EC2 or use managed services:

```hcl
# terraform/main.tf

provider "aws" {
  region = "us-east-1"
}

# EC2 for Next.js
resource "aws_instance" "harness" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.small"
  
  user_data = base64encode(templatefile("${path.module}/user_data.sh", {
    DATABASE_URL = var.database_url
    MCP_ENDPOINT = var.mcp_endpoint_url
  }))

  tags = {
    Name = "autonomous-martech-harness"
  }
}

# RDS for execution history
resource "aws_db_instance" "harness_db" {
  identifier     = "autonomous-martech-db"
  engine         = "postgres"
  engine_version = "15.4"
  instance_class = "db.t3.micro"
  
  # ... full config
}

# API Gateway (optional, if you want a custom domain)
resource "aws_apigatewayv2_api" "harness_api" {
  name          = "autonomous-martech-harness"
  protocol_type = "HTTP"
}
```

---

### 7. **Package Dependencies** (Add to `package.json`)

```bash
npm install dotenv pg node-fetch
npm install --save-dev @types/pg
```

Update `package.json`:

```json
{
  "dependencies": {
    "next": "16.2.10",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "pg": "^8.11.3",
    "dotenv": "^16.3.1"
  }
}
```

---

## Implementation Roadmap

### Phase 1: Core API (Days 1-2)
- [ ] Create MCP client utility (`lib/mcp-client.ts`)
- [ ] Create database schema
- [ ] Implement `POST /api/build`
- [ ] Implement `GET /api/executions/:id/status`
- [ ] Set up environment variables

### Phase 2: UI (Days 3-4)
- [ ] Create landing page (`app/page.tsx`)
- [ ] Create execution monitor (`app/executions/[id]/page.tsx`)
- [ ] Add execution history page
- [ ] Add artifact viewer

### Phase 3: Polish & Deployment (Days 5-6)
- [ ] Error handling & retry logic
- [ ] Execution logging & audit trail
- [ ] Authentication (optional: Auth0, Cognito)
- [ ] Terraform for deployment
- [ ] Documentation

---

## Key Design Decisions

1. **MCP on Lambda, Harness on Next.js** ✅
   - Keeps concerns separated
   - MCP tools are reusable (CLI, Claude Desktop, webhooks)
   - Harness is just one client

2. **HTTP Bridge** ✅
   - Harness calls MCP via HTTP POST to Lambda
   - No embedding Python in Next.js
   - No need to port planner/orchestrator to JavaScript (unless you want CLI support)

3. **Database for Execution History** ✅
   - User can see past builds
   - Retry failed phases
   - Audit trail

4. **Polling Pattern** ✅
   - Harness polls orchestrator status every 2-5 seconds
   - No WebSockets needed initially
   - Simple to implement

---

## What's Already Done

✅ **MCP Server** (139 tools, planner, orchestrator)
✅ **Knowledge Base** (pgvector, Voyage AI)
✅ **SAM Template** (Lambda + API Gateway deployment)
✅ **Authentication** (Adobe IMS OAuth2, AWS IAM, API auth)

---

## What You Still Need

❌ Next.js API routes to call MCP
❌ Database schema for execution history
❌ MCP HTTP client utility
❌ React UI components
❌ Environment variables & secrets management
❌ Authentication for harness users (optional)
❌ Artifact storage (S3 or Postgres)
❌ Execution logging
❌ Terraform for EC2/RDS deployment (optional)

---

## Getting Started

1. **Create the MCP client utility** first — this is the bridge
2. **Set up database schema** — store execution history
3. **Build API routes** — `/api/build`, `/api/executions/:id/status`
4. **Create UI** — landing page + status monitor
5. **Test end-to-end** — build something simple and watch it execute

Would you like me to implement any of these components?

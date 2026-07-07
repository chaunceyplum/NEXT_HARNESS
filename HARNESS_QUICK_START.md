# Quick Start: Building the Harness

## What is the Harness?

The **Harness** is a web application that lets users describe what they want to build (in plain English), and then automatically orchestrates the entire build process on the MCP backend.

### User Journey

```
┌─────────────────────────────────┐
│ User visits harness.example.com │
└────────────┬────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────┐
│ "I want to build an AEP solution that        │
│  tracks ecommerce purchases and identifies   │
│  high-value customers"                       │
└────────────┬─────────────────────────────────┘
             │  [Click "Build"]
             ▼
┌──────────────────────────────────────────────┐
│ Harness sends to MCP Planner:                │
│ {                                            │
│   "toolName": "planner_parse_natural_...",   │
│   "description": "..."                       │
│ }                                            │
└────────────┬─────────────────────────────────┘
             │  (HTTP POST)
             ▼
┌──────────────────────────────────────────────┐
│ MCP Planner returns SolutionConfig:          │
│ {                                            │
│   "website_domain": "example.com",           │
│   "events": [page_view, purchase],           │
│   "segments": [high_value_customers],        │
│   "destinations": [email, adobe_audience],   │
│   "merge_policy": "recommended"              │
│ }                                            │
└────────────┬─────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────┐
│ Harness sends to MCP Orchestrator:           │
│ {                                            │
│   "toolName": "orchestrator_execute",        │
│   "solution_config": {...}                   │
│ }                                            │
└────────────┬─────────────────────────────────┘
             │  (HTTP POST)
             ▼
┌──────────────────────────────────────────────┐
│ MCP Orchestrator returns execution_id        │
│ and starts multi-phase build                 │
└────────────┬─────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────┐
│ User sees progress page:                     │
│ ● Phase 1: Validation        [DONE]         │
│ ● Phase 2: Schema Creation   [RUNNING...]   │
│ ● Phase 3: Segment Setup     [PENDING]      │
│ ● Phase 4: Activation        [PENDING]      │
└──────────────────────────────────────────────┘
             │  (Polling every 2-5 sec)
             ▼
┌──────────────────────────────────────────────┐
│ After ~10-20 min, orchestrator completes     │
│                                              │
│ ✅ Build Complete!                           │
│                                              │
│ Artifacts:                                   │
│ • aep_schema_setup.sql                       │
│ • segments.json                              │
│ • destinations_config.json                   │
│ • verification_report.txt                    │
└──────────────────────────────────────────────┘
```

---

## MCP Tools You'll Be Calling

### From the Harness Backend

These are the two main entry points:

#### 1. **Planner Tool** (converts language → config)
```
Tool Name: planner_parse_natural_language
Input:
  - natural_language (string): "Build AEP for ecommerce..."
  - business_vertical (string, optional): "ecommerce", "finance", "healthcare"
  - url (string, optional): "example.com"

Output:
  - solution_config: SolutionConfig object
    {
      "website_domain": "example.com",
      "business_vertical": "ecommerce",
      "events": [
        {
          "name": "page_view",
          "description": "User views a page",
          "frequency": "frequent"
        },
        {
          "name": "purchase",
          "description": "User completes purchase",
          "frequency": "occasional"
        }
      ],
      "segments": [
        {
          "name": "high_value_customers",
          "description": "Revenue > $1000",
          "pql_expression": "revenue > 1000"
        }
      ],
      "destinations": ["email", "adobe_audience_manager"],
      "merge_policy": "default",
      "confidence_score": 0.95
    }
```

#### 2. **Orchestrator Tool** (executes the build)
```
Tool Name: orchestrator_execute
Input:
  - solution_config: (SolutionConfig object from planner)
  - webhook_url (optional): "https://harness.com/webhooks/notify"

Output:
  - execution_id: "exec-abc123xyz"
  - status: "QUEUED"
  - estimated_duration: "15 minutes"
```

#### 3. **Orchestrator Status Tool** (polling for progress)
```
Tool Name: orchestrator_get_status
Input:
  - execution_id: "exec-abc123xyz"

Output:
  - status: "RUNNING"
  - current_phase: "Phase 2: Schema Creation"
  - phase_number: 2
  - total_phases: 4
  - progress: 0.45
  - estimated_time_remaining: "10 minutes"
  - logs: [
      "Created XDM schema...",
      "Added field groups...",
      "Activated for insights..."
    ]
```

#### 4. **Get Artifacts Tool** (retrieve generated files)
```
Tool Name: orchestrator_get_artifacts
Input:
  - execution_id: "exec-abc123xyz"

Output:
  - artifacts: [
      {
        "type": "sql",
        "filename": "aep_schema_setup.sql",
        "content": "CREATE TABLE..."
      },
      {
        "type": "json",
        "filename": "segments.json",
        "content": {...}
      }
    ]
```

---

## 5 Core Files You Need to Create

### 1. MCP Client (`lib/mcp-client.ts`)

```typescript
// lib/mcp-client.ts
/**
 * HTTP bridge to call MCP tools from Next.js backend
 */

const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL;

export async function callMcpTool(
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const payload = {
    jsonrpc: '2.0',
    id: `harness-${Date.now()}-${Math.random()}`,
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
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`MCP call failed: ${response.status}`);
  }

  const result = await response.json();
  
  if (result.error) {
    throw new Error(`MCP tool error: ${result.error.message}`);
  }

  return result.result;
}
```

### 2. Build API Endpoint (`app/api/build/route.ts`)

```typescript
// app/api/build/route.ts
import { callMcpTool } from '@/lib/mcp-client';

export async function POST(request: Request) {
  try {
    const { description } = await request.json();

    // Step 1: Call planner
    const plan = await callMcpTool('planner_parse_natural_language', {
      natural_language: description,
    });

    // Step 2: Call orchestrator to start build
    const execution = await callMcpTool('orchestrator_execute', {
      solution_config: plan.solution_config,
    });

    // Step 3: Return execution ID to client
    return Response.json({
      execution_id: execution.execution_id,
      status: execution.status,
    });
  } catch (error) {
    return Response.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
```

### 3. Status API Endpoint (`app/api/executions/[id]/status/route.ts`)

```typescript
// app/api/executions/[id]/status/route.ts
import { callMcpTool } from '@/lib/mcp-client';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const id = (await params).id;

    const status = await callMcpTool('orchestrator_get_status', {
      execution_id: id,
    });

    return Response.json(status);
  } catch (error) {
    return Response.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
```

### 4. Home Page UI (`app/page.tsx`)

```typescript
// app/page.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleBuild() {
    setLoading(true);
    try {
      const res = await fetch('/api/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });

      const { execution_id } = await res.json();
      router.push(`/executions/${execution_id}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Autonomous MarTech Builder
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Describe your MarTech solution in plain English, and we'll build it automatically.
        </p>

        <div className="bg-white rounded-lg shadow-lg p-8">
          <label className="block text-lg font-semibold text-gray-700 mb-4">
            What do you want to build?
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Example: Build an AEP solution that tracks ecommerce purchases and identifies high-value customers for email activation..."
            className="w-full h-40 p-4 border-2 border-gray-300 rounded-lg focus:border-blue-500 focus:outline-none"
          />

          <button
            onClick={handleBuild}
            disabled={loading || !description.trim()}
            className="mt-6 w-full px-6 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Building...' : 'Build'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 5. Execution Monitor (`app/executions/[id]/page.tsx`)

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
    async function fetchStatus() {
      try {
        const res = await fetch(`/api/executions/${id}/status`);
        const data = await res.json();
        setStatus(data);
        setLoading(false);

        if (data.status === 'COMPLETED' || data.status === 'FAILED') {
          return; // Stop polling
        }
      } catch (error) {
        console.error('Failed to fetch status:', error);
      }
    }

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);

    return () => clearInterval(interval);
  }, [id]);

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  if (!status) {
    return <div className="p-8">Failed to load execution</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-4">Build Progress</h1>
        <p className="text-gray-600 mb-8">Execution ID: {id}</p>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold">
              {status.current_phase}
            </h2>
            <span className={`px-4 py-2 rounded font-bold ${
              status.status === 'COMPLETED' ? 'bg-green-100 text-green-800' :
              status.status === 'FAILED' ? 'bg-red-100 text-red-800' :
              'bg-blue-100 text-blue-800'
            }`}>
              {status.status}
            </span>
          </div>

          <div className="w-full bg-gray-300 h-4 rounded-full overflow-hidden">
            <div
              className="bg-blue-600 h-4 transition-all"
              style={{ width: `${status.progress * 100}%` }}
            />
          </div>
          <p className="text-sm text-gray-600 mt-2">
            {(status.progress * 100).toFixed(0)}% complete
          </p>
        </div>

        {status.logs && status.logs.length > 0 && (
          <div className="bg-gray-900 text-green-400 rounded-lg p-4 font-mono text-sm max-h-96 overflow-y-auto">
            {status.logs.map((log: string, i: number) => (
              <div key={i}>{log}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Environment Variables Setup

Create `.env.local`:

```bash
# Get this from your SAM deployment outputs
MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp

# Database (optional for now)
DATABASE_URL=postgresql://localhost/harness
```

---

## How to Deploy Your MCP

First, make sure the MCP is deployed to Lambda. From the MCP repo:

```bash
cd /projects/sandbox/mcp

# Build
sam build

# Deploy (first time)
sam deploy --guided

# Deploy (subsequent times)
sam deploy
```

The output will include:
```
McpEndpointUrl=https://xxx.execute-api.us-east-1.amazonaws.com/mcp
```

Copy that URL to your `.env.local` as `MCP_ENDPOINT_URL`.

---

## Step-by-Step Implementation

### Day 1: Get MCP Connected
1. ✅ Verify MCP is deployed to Lambda
2. ✅ Add `MCP_ENDPOINT_URL` to `.env.local`
3. ✅ Create `lib/mcp-client.ts`
4. ✅ Test by calling planner directly: `callMcpTool('planner_parse_natural_language', {...})`

### Day 2: Build the APIs
1. ✅ Create `app/api/build/route.ts`
2. ✅ Create `app/api/executions/[id]/status/route.ts`
3. ✅ Test with curl/Postman

### Day 3: Build the UI
1. ✅ Update `app/page.tsx` (home page)
2. ✅ Create `app/executions/[id]/page.tsx` (status monitor)
3. ✅ Test end-to-end

### Day 4+: Polish
1. ✅ Add error handling
2. ✅ Add artifact viewer
3. ✅ Add execution history
4. ✅ Add authentication (optional)
5. ✅ Deploy to production

---

## Testing the MCP Connection

Before building the UI, test that your MCP endpoint works:

```bash
# Test with curl
curl -X POST https://xxx.execute-api.us-east-1.amazonaws.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-1",
    "method": "tools/call",
    "params": {
      "name": "planner_parse_natural_language",
      "arguments": {
        "natural_language": "Build an AEP solution for ecommerce"
      }
    }
  }'
```

Expected response:
```json
{
  "jsonrpc": "2.0",
  "id": "test-1",
  "result": {
    "solution_config": {
      "website_domain": "...",
      "events": [...],
      "segments": [...],
      "confidence_score": 0.95
    }
  }
}
```

---

## Next Steps

Ready to start building? I can help you with:

1. **Getting the MCP endpoint URL** — verify deployment
2. **Creating the MCP client utility** — the bridge between Next.js and Lambda
3. **Building the API routes** — /api/build, /api/executions/:id/status
4. **Creating the UI** — landing page, execution monitor
5. **Adding database support** — store execution history
6. **Deploying everything** — Vercel + Lambda + RDS

Which would you like to start with?

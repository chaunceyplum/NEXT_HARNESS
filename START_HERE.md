# START HERE: Building the MCP Harness

## TL;DR

You have a complete MCP (139 tools, planner, orchestrator) on AWS Lambda. You need to build a Next.js web app that:

1. Accepts user description ("Build AEP for ecommerce...")
2. Calls the MCP Planner to create a configuration
3. Calls the MCP Orchestrator to execute the build
4. Shows real-time progress to the user
5. Returns generated artifacts (SQL, JSON, Terraform, etc.)

**Total new code**: ~400 lines (mostly boilerplate)  
**Timeline**: 16-20 hours for one person  
**Complexity**: Medium (Next.js + HTTP calls + React hooks)

---

## What You Have

### ✅ MCP Repository (`chaunceyplum/mcp`)
- **139 production tools** across 3 agents
- **Planner** (1,151 LOC) — converts English → SolutionConfig
- **Orchestrator** (28 KB) — executes multi-phase builds
- **Knowledge base** (pgvector + Voyage AI)
- **Deployed** on AWS Lambda + API Gateway

### ✅ Harness Repository (`chaunceyplum/NEXT_HARNESS`)
- **Bootstrap** Next.js 16.2 + React 19.2 + TypeScript
- **Ready** for implementation

---

## What You Need to Build

### 5 Main Components

```
1. MCP Client Bridge
   File: lib/mcp-client.ts
   Lines: ~50
   Purpose: HTTP wrapper to call MCP tools
   
2. Build API Endpoint
   File: app/api/build/route.ts
   Lines: ~40
   Purpose: Accept description, call planner + orchestrator
   
3. Status Polling Endpoint
   File: app/api/executions/[id]/status/route.ts
   Lines: ~20
   Purpose: Poll orchestrator status
   
4. Home Page
   File: app/page.tsx
   Lines: ~80
   Purpose: Form for user input
   
5. Execution Monitor
   File: app/executions/[id]/page.tsx
   Lines: ~100
   Purpose: Real-time progress display
```

---

## The Data Flow

```
┌──────────────────────────┐
│   User Browser           │
│  [Form] [Build Button]   │
└───────────┬──────────────┘
            │
            ▼ POST /api/build
┌──────────────────────────────────────────┐
│   Next.js Backend                        │
│                                          │
│  1. callMcpTool('planner_...')          │
│     Returns: { solution_config: {...} }  │
│                                          │
│  2. callMcpTool('orchestrator_...')     │
│     Returns: { execution_id: 'abc123' }  │
│                                          │
│  Send: { execution_id: 'abc123' }        │
└───────────┬──────────────────────────────┘
            │
            ▼ Redirect to /executions/abc123
┌──────────────────────────────────────────┐
│   Status Monitor Page                    │
│                                          │
│  Every 3 seconds:                        │
│  GET /api/executions/abc123/status       │
│  → callMcpTool('orchestrator_get_...')  │
│                                          │
│  Update UI:                              │
│  ├─ Progress bar: 45%                   │
│  ├─ Phase: "Schema Creation"            │
│  └─ Logs: [recent messages]             │
│                                          │
│  When status === "COMPLETED":            │
│  GET /api/executions/abc123/artifacts    │
│  → Show download links                   │
└──────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Phase 1: Setup (2 hours)
- [ ] Verify MCP is deployed to Lambda
- [ ] Get endpoint URL from SAM outputs
- [ ] Create `.env.local` with `MCP_ENDPOINT_URL`
- [ ] Verify connectivity with curl

### Phase 2: MCP Client Bridge (2 hours)
- [ ] Create `lib/mcp-client.ts`
- [ ] Implement `callMcpTool()` function
- [ ] Test with sample MCP calls
- [ ] Add error handling

### Phase 3: API Routes (4 hours)
- [ ] Create `app/api/build/route.ts`
- [ ] Create `app/api/executions/[id]/status/route.ts`
- [ ] Test with Postman/curl
- [ ] Add validation & error handling

### Phase 4: UI Components (6 hours)
- [ ] Update `app/page.tsx` (home page)
- [ ] Create `app/executions/[id]/page.tsx` (status monitor)
- [ ] Add styling with Tailwind
- [ ] Test form submission
- [ ] Test status polling

### Phase 5: Polish (4 hours)
- [ ] Add loading states
- [ ] Add error messages
- [ ] Test edge cases
- [ ] Deploy to staging
- [ ] Deploy to production

---

## File-by-File Implementation

### 1. `.env.local`
```bash
MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp
```

### 2. `lib/mcp-client.ts` (~50 lines)
```typescript
const MCP_ENDPOINT = process.env.MCP_ENDPOINT_URL;

export async function callMcpTool(
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const payload = {
    jsonrpc: '2.0',
    id: `req-${Date.now()}`,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  
  return result.result;
}
```

### 3. `app/api/build/route.ts` (~40 lines)
```typescript
import { callMcpTool } from '@/lib/mcp-client';

export async function POST(request: Request) {
  try {
    const { description } = await request.json();

    // Step 1: Parse with planner
    const plan = await callMcpTool('planner_parse_natural_language', {
      natural_language: description,
    });

    // Step 2: Execute with orchestrator
    const execution = await callMcpTool('orchestrator_execute', {
      solution_config: plan.solution_config,
    });

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

### 4. `app/api/executions/[id]/status/route.ts` (~20 lines)
```typescript
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

### 5. `app/page.tsx` (~80 lines)
```typescript
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
          Describe your MarTech solution in plain English.
        </p>

        <div className="bg-white rounded-lg shadow-lg p-8">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Example: Build AEP solution for ecommerce..."
            className="w-full h-40 p-4 border rounded"
          />

          <button
            onClick={handleBuild}
            disabled={loading || !description.trim()}
            className="mt-6 w-full px-6 py-3 bg-blue-600 text-white font-bold rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Building...' : 'Build'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 6. `app/executions/[id]/page.tsx` (~100 lines)
```typescript
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

  if (loading) return <div className="p-8">Loading...</div>;
  if (!status) return <div className="p-8">Failed to load</div>;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold mb-4">Build Progress</h1>

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

## Documentation Reference

All comprehensive docs are in `/projects/sandbox/`:

| File | Purpose |
|------|---------|
| `HARNESS_REQUIREMENTS.md` | Full architecture & design |
| `HARNESS_QUICK_START.md` | Step-by-step setup guide |
| `MCP_TOOLS_REFERENCE.md` | All tool signatures |
| `IMPLEMENTATION_CHECKLIST.md` | Detailed tasks & testing |
| `HARNESS_SUMMARY.md` | Executive summary |
| `README_HARNESS.txt` | Quick reference |

---

## Testing Checklist

### Basic Connectivity
- [ ] MCP endpoint responds to `/tools/list`
- [ ] Can call `planner_parse_natural_language` manually
- [ ] Can call `orchestrator_execute` manually

### API Routes
- [ ] `POST /api/build` returns `execution_id`
- [ ] `GET /api/executions/:id/status` returns status object
- [ ] Status includes `progress`, `logs`, `current_phase`

### UI
- [ ] Home page renders form
- [ ] Form submission calls API
- [ ] Redirects to execution page
- [ ] Status page shows progress bar
- [ ] Progress bar updates every 3 seconds
- [ ] Logs appear and update in real-time
- [ ] Page stops polling when complete

### Error Handling
- [ ] Invalid description shown as error
- [ ] Network error handled gracefully
- [ ] MCP timeout handled (after 30s)
- [ ] Orchestrator failure shown to user

---

## Deployment

### Local Development
```bash
cd NEXT_HARNESS
npm install
npm run dev
# Open http://localhost:3000
```

### Production (Vercel - Recommended)
```bash
# Push to GitHub
git push origin main

# Vercel auto-deploys on push
# Add environment variable: MCP_ENDPOINT_URL
# Done!
```

### Production (EC2)
```bash
npm run build
npm run start
# Runs on port 3000
```

---

## Quick Start Command

```bash
# 1. Navigate to harness repo
cd /projects/sandbox/NEXT_HARNESS

# 2. Create .env.local
echo "MCP_ENDPOINT_URL=https://YOUR_ENDPOINT/mcp" > .env.local

# 3. Start dev server
npm run dev

# 4. Visit http://localhost:3000
```

---

## Common Questions

**Q: Do I need to port planner/orchestrator to JavaScript?**  
A: No! They're MCP tools on Lambda. The harness just calls them via HTTP.

**Q: Can I use this with Claude Desktop?**  
A: Yes! The MCP works with both Claude Desktop and the harness.

**Q: What happens if orchestrator times out?**  
A: Add a timeout handler (30 seconds) and offer user a retry option.

**Q: Can I add authentication?**  
A: Yes! Use Auth0, Cognito, or NextAuth.js (optional for MVP).

**Q: How do I store execution history?**  
A: PostgreSQL table + queries in API routes (optional for MVP).

---

## Success Criteria

### MVP (Minimum Viable)
✅ User submits description  
✅ Planner creates config  
✅ Orchestrator executes  
✅ User sees progress  
✅ User gets artifacts  

### Production-Ready
✅ All MVP  
✅ Error handling  
✅ Execution history  
✅ Monitoring  
✅ Documentation  

---

## Next Actions

### Right Now
1. [ ] Read this file (you're done!)
2. [ ] Review `HARNESS_QUICK_START.md`
3. [ ] Verify MCP endpoint works

### This Afternoon
1. [ ] Create `.env.local`
2. [ ] Create `lib/mcp-client.ts`
3. [ ] Test with curl/Postman

### This Evening
1. [ ] Create API routes
2. [ ] Create React components
3. [ ] Test locally

### Tomorrow
1. [ ] Deploy to staging
2. [ ] Get feedback
3. [ ] Deploy to production

---

## Need Help?

Each component has detailed docs:
- Architecture → `HARNESS_REQUIREMENTS.md`
- Setup → `HARNESS_QUICK_START.md`
- Tools → `MCP_TOOLS_REFERENCE.md`
- Tasks → `IMPLEMENTATION_CHECKLIST.md`

---

**Ready to build? Let's go! 🚀**

Start with Phase 1: Setup, then follow the roadmap above.

Questions? Check the documentation files in `/projects/sandbox/`

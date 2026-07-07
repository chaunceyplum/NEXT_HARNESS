# Harness Architecture Summary

## What You Need to Add to the MCP Repo & Harness

---

## Part 1: MCP Repository Status ✅

**Current State**: The MCP is complete and production-ready.

### What Already Exists
- ✅ **139 tools** deployed on AWS Lambda
- ✅ **Planner tool** (converts natural language → SolutionConfig)
- ✅ **Orchestrator tool** (executes multi-phase builds)
- ✅ **Knowledge base** (pgvector + Voyage AI embeddings)
- ✅ **Authentication** (Adobe IMS, AWS IAM, etc.)
- ✅ **API Gateway** for HTTP access
- ✅ **SAM template** for deployment

### What You Don't Need to Change
- ✅ Keep all Python tools as-is
- ✅ Keep planner and orchestrator on Lambda (they're MCP tools)
- ✅ Keep knowledge base connection
- ✅ Keep API Gateway deployment

### What's Missing (Nothing!)
The MCP is complete. The orchestration logic was correctly built as MCP tools, making them reusable across multiple clients.

---

## Part 2: Harness Repository — What to Build

**Current State**: Bootstrap Next.js app, ready for implementation.

### The Harness is a Web App That:

1. **Accepts user input** — Plain English description of what to build
2. **Calls the Planner** — HTTP POST to MCP to convert language → config
3. **Launches the Orchestrator** — HTTP POST to MCP to start the build
4. **Monitors Progress** — Polls orchestrator status every 2-5 seconds
5. **Shows Results** — Returns generated artifacts (SQL, JSON, Terraform, etc.)

### Core Components to Build

#### 1. **MCP Client Bridge** (`lib/mcp-client.ts`)
```typescript
// HTTP wrapper to call MCP tools from Next.js backend
async callMcpTool(toolName: string, args: Record<string, any>) → Promise<any>
```

#### 2. **API Routes** (Backend)
```
POST /api/build
  → Call planner_parse_natural_language
  → Call orchestrator_execute
  → Return execution_id

GET /api/executions/:id/status
  → Call orchestrator_get_status
  → Return progress, logs, phase

GET /api/executions/:id/artifacts
  → Call orchestrator_get_artifacts
  → Return generated files
```

#### 3. **React Components** (Frontend)
```
app/page.tsx
  → Form for user description
  → "Build" button
  → Redirect to execution page

app/executions/[id]/page.tsx
  → Real-time progress bar
  → Phase information
  → Live logs (terminal-style)
  → Artifact links when done
```

---

## What You Need: Complete Checklist

### To Deploy
- [ ] Verify MCP endpoint URL (from SAM outputs)
- [ ] Add to `.env.local`: `MCP_ENDPOINT_URL=https://...`

### To Implement (4-5 Components)

**Component 1: MCP Client** (~50 lines)
```typescript
// lib/mcp-client.ts
function callMcpTool(toolName, args) {
  // POST to MCP_ENDPOINT_URL with JSON-RPC payload
  // Return result or throw error
}
```

**Component 2: Build API** (~40 lines)
```typescript
// app/api/build/route.ts
async function POST(request) {
  const { description } = await request.json();
  const plan = await callMcpTool('planner_parse_natural_language', {...});
  const exec = await callMcpTool('orchestrator_execute', {...});
  return { execution_id: exec.execution_id };
}
```

**Component 3: Status API** (~20 lines)
```typescript
// app/api/executions/[id]/status/route.ts
async function GET(request, { params }) {
  const status = await callMcpTool('orchestrator_get_status', {...});
  return status;
}
```

**Component 4: Home Page** (~80 lines)
```typescript
// app/page.tsx
function HomePage() {
  return (
    <form onSubmit={handleBuild}>
      <textarea placeholder="Describe your build..." />
      <button>Build</button>
    </form>
  );
}
```

**Component 5: Execution Monitor** (~100 lines)
```typescript
// app/executions/[id]/page.tsx
function ExecutionPage() {
  useEffect(() => {
    // Poll status every 3 seconds
    // Update progress bar
    // Display logs
  }, []);
  return (
    <div>
      <progress value={status.progress} />
      <pre>{status.logs.join('\n')}</pre>
    </div>
  );
}
```

---

## The Data Flow

```
User Input
  ↓
┌─────────────────────────────────────────┐
│ Browser                                 │
│ Form: "Build AEP for ecommerce..."      │
│ Button: [Build]                         │
└────────────┬──────────────────────────┘
             │
             ↓ POST /api/build
┌─────────────────────────────────────────┐
│ Next.js Backend (Node.js)               │
│                                         │
│ 1. Call planner_parse_natural_language  │
│    Input: { description: "..." }        │
│    Output: { solution_config: {...} }   │
│                                         │
│ 2. Call orchestrator_execute            │
│    Input: { solution_config: {...} }    │
│    Output: { execution_id: "exec-123" } │
│                                         │
│ Return: { execution_id: "exec-123" }    │
└────────────┬──────────────────────────┘
             │
             ↓ Redirect to /executions/exec-123
┌─────────────────────────────────────────┐
│ Browser                                 │
│ Page: Execution Monitor                 │
│ ┌─────────────────────────────────────┐ │
│ │ Progress: ████░░░░░░░░ 45%         │ │
│ │ Phase: XDM Schema Creation          │ │
│ │ Status: RUNNING                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Polling every 3 seconds:                │
│ GET /api/executions/exec-123/status     │
└────────────┬──────────────────────────┘
             │
             ↓ (repeated every 3 sec)
┌─────────────────────────────────────────┐
│ Next.js Backend                         │
│                                         │
│ Call orchestrator_get_status            │
│ Input: { execution_id: "exec-123" }     │
│ Output: {                               │
│   status: "RUNNING",                    │
│   phase: 2,                             │
│   progress: 0.45,                       │
│   logs: ["Created schema...", ...]      │
│ }                                       │
│                                         │
│ Return to browser                       │
└────────────┬──────────────────────────┘
             │
             ↓ (repeat until status === "COMPLETED")
┌─────────────────────────────────────────┐
│ Browser                                 │
│ Final State: "✅ Build Complete!"       │
│                                         │
│ Call: GET /api/executions/exec-123/... │
│ GET /api/executions/exec-123/artifacts │
│                                         │
│ Download Links:                         │
│ • aep_schema_setup.sql                  │
│ • segments.json                         │
│ • event_tracking.js                     │
└─────────────────────────────────────────┘
```

---

## Technical Stack

### Frontend (Browser)
- **React 19.2** — UI components
- **Next.js 16.2** — Framework
- **TypeScript** — Type safety
- **Tailwind CSS** — Styling

### Backend (Next.js Server)
- **Node.js** — Runtime
- **HTTP/HTTPS** — Calls to MCP Lambda
- **JSON-RPC 2.0** — Protocol

### MCP (Lambda)
- **Python 3.12** — Language
- **AWS Lambda** — Compute
- **AWS API Gateway** — HTTP endpoint
- **pgvector** — Knowledge base
- **Voyage AI** — Embeddings

### Database (Optional)
- **PostgreSQL** — Execution history, artifacts
- **pg** package — Node.js driver

---

## Key Design Decisions

### ✅ Why Harness is Separate from MCP
- **Reusability**: MCP tools can be used by Claude Desktop, CLI, webhooks, etc.
- **Scalability**: Each client independently scales
- **Maintainability**: Clear separation of concerns
- **Flexibility**: Easy to replace UI without changing backend

### ✅ Why Harness is JavaScript/Next.js
- **Single language**: No Python in frontend (user's requirement)
- **Fast development**: Full-stack JavaScript
- **Easy deployment**: Vercel, EC2, etc.
- **WebSocket support**: Real-time updates (if needed later)

### ✅ Why Polling Instead of WebSockets
- **Simple**: No connection management
- **Reliable**: Works in all network conditions
- **Stateless**: Lambda doesn't hold connections
- **Cost-effective**: No always-on servers needed

### ✅ Why Use HTTP Bridge Instead of Embedding
- **Isolation**: Harness doesn't need Python dependencies
- **Simplicity**: Standard HTTP REST calls
- **Security**: No shared process memory
- **Flexibility**: Can replace MCP endpoint later

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     End User (Browser)                       │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│          Harness (Next.js on Vercel/EC2)                    │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  UI Layer (React)                                    │  │
│  │  - Home page with form                               │  │
│  │  - Execution monitor with progress                   │  │
│  └──────────────────────────────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │  API Layer (Next.js Routes)                          │  │
│  │  - POST /api/build                                   │  │
│  │  - GET /api/executions/:id/status                    │  │
│  │  - GET /api/executions/:id/artifacts                 │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │  MCP Client Bridge (lib/mcp-client.ts)               │  │
│  │  - HTTP POST to Lambda                               │  │
│  │  - JSON-RPC 2.0 protocol                             │  │
│  └──────────────────────┬──────────────────────────────┘  │
└─────────────────────────┼────────────────────────────────┘
                         │ HTTPS (API Gateway)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP (AWS Lambda + API Gateway)                 │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  JSON-RPC Dispatcher (lambda_handler.py)             │  │
│  │  - tools/call method                                 │  │
│  │  - tools/list method                                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │  Planner & Orchestrator Tools                        │  │
│  │  - planner_parse_natural_language                    │  │
│  │  - orchestrator_execute                              │  │
│  │  - orchestrator_get_status                           │  │
│  │  - orchestrator_get_artifacts                        │  │
│  │  + 135 other tools                                   │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │  External Services                                   │  │
│  │  - Adobe IMS (OAuth2)                                │  │
│  │  - Adobe AEP API                                     │  │
│  │  - AWS APIs (boto3)                                  │  │
│  │  - Databricks REST API                               │  │
│  │  - Snowflake connector                               │  │
│  │  - pgvector (PostgreSQL)                             │  │
│  │  - Voyage AI embeddings                              │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Files to Create

### Minimum Viable Harness (5 files)

1. **`lib/mcp-client.ts`** (~50 lines)
   - HTTP bridge to MCP
   - `callMcpTool()` function

2. **`app/api/build/route.ts`** (~40 lines)
   - POST endpoint
   - Call planner → orchestrator

3. **`app/api/executions/[id]/status/route.ts`** (~20 lines)
   - GET endpoint
   - Poll orchestrator status

4. **`app/page.tsx`** (~80 lines)
   - Home page with form

5. **`app/executions/[id]/page.tsx`** (~100 lines)
   - Execution monitor

6. **`.env.local`** (~3 lines)
   - MCP_ENDPOINT_URL

### Enhanced Harness (Add These)

7. **`app/api/executions/[id]/artifacts/route.ts`** (~20 lines)
   - GET artifacts endpoint

8. **`lib/db.ts`** (~100 lines)
   - Database helpers (optional)

9. **`lib/types.ts`** (~50 lines)
   - TypeScript types

10. **`public/examples.json`** (~30 lines)
    - Example descriptions

---

## Success Criteria

### MVP (Minimum Viable Product)
✅ User fills form with description  
✅ Clicks "Build" button  
✅ Planner creates config  
✅ Orchestrator starts execution  
✅ User sees progress page  
✅ User sees real-time logs  
✅ User gets artifacts when done  
✅ No manual intervention needed  

### Production-Ready
✅ All MVP criteria  
✅ Error handling (timeouts, failures)  
✅ User authentication (optional)  
✅ Execution history (database)  
✅ Monitoring & alerting  
✅ Deployment automation  
✅ Documentation  

---

## Implementation Timeline

| Task | Duration | Notes |
|------|----------|-------|
| Setup & MCP connection | 2 hours | Verify endpoint works |
| MCP client bridge | 2 hours | HTTP wrapper function |
| API routes (build + status) | 4 hours | Backend logic |
| UI components (home + monitor) | 4 hours | React pages |
| Error handling & polish | 4 hours | Edge cases, cleanup |
| Testing & deployment | 4 hours | Staging → production |
| **Total** | **20 hours** | ~2.5 days for one person |

---

## Next Steps

### Immediate Actions
1. [ ] Verify MCP endpoint is accessible
2. [ ] Get endpoint URL from SAM deployment
3. [ ] Create `.env.local` with `MCP_ENDPOINT_URL`

### This Week
1. [ ] Create `lib/mcp-client.ts`
2. [ ] Create API routes
3. [ ] Create React components
4. [ ] Test end-to-end

### Next Week
1. [ ] Add database support (optional)
2. [ ] Deploy to staging
3. [ ] Get feedback
4. [ ] Deploy to production

---

## Questions?

If you need clarification on:
- **Architecture** → See `/projects/sandbox/HARNESS_REQUIREMENTS.md`
- **Quick start** → See `/projects/sandbox/HARNESS_QUICK_START.md`
- **Tool signatures** → See `/projects/sandbox/MCP_TOOLS_REFERENCE.md`
- **Implementation** → See `/projects/sandbox/IMPLEMENTATION_CHECKLIST.md`

All documentation is in the `/projects/sandbox/` directory.

---

## Bottom Line

You need to build:
1. **MCP Client Bridge** — HTTP wrapper (1 file, 50 lines)
2. **API Routes** — Calls to MCP tools (2-3 files, 80 lines)
3. **React UI** — Forms & progress monitor (2 files, 180 lines)
4. **Environment Setup** — Add MCP endpoint URL (.env.local)

**Total new code**: ~400 lines (mostly boilerplate)

Everything else already exists in the MCP!

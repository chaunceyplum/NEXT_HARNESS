╔════════════════════════════════════════════════════════════════════════════════╗
║                    MCP HARNESS - QUICK REFERENCE GUIDE                        ║
╚════════════════════════════════════════════════════════════════════════════════╝

WHAT IS THE HARNESS?
━━━━━━━━━━━━━━━━━━━━
A web application that lets users describe what they want to build (in English),
and automatically orchestrates the entire build process via the MCP backend.

USER JOURNEY:
User: "Build AEP for ecommerce"
  ↓
Harness: Call planner_parse_natural_language()
  ↓
MCP: Return validated SolutionConfig
  ↓
Harness: Call orchestrator_execute(config)
  ↓
MCP: Start multi-phase build, return execution_id
  ↓
Harness: Poll status every 3 seconds
  ↓
Browser: Show real-time progress
  ↓
MCP: Execute phases 1-4
  ↓
Harness: Get artifacts, show download links
  ↓
User: Download generated files

WHAT YOU NEED TO BUILD
━━━━━━━━━━━━━━━━━━━━━
The MCP is complete. You only need to build a Next.js wrapper:

1. MCP CLIENT BRIDGE (lib/mcp-client.ts)
   - HTTP wrapper to call MCP tools
   - ~50 lines

2. API ROUTES (app/api/)
   - POST /api/build → planner + orchestrator
   - GET /api/executions/:id/status → poll
   - GET /api/executions/:id/artifacts → results
   - ~80 lines

3. REACT UI (app/)
   - Home page with form
   - Execution monitor
   - ~180 lines

TOTAL: ~400 lines of code

CORE FILES TO CREATE
━━━━━━━━━━━━━━━━━━━
1. lib/mcp-client.ts
   - HTTP POST wrapper
   - JSON-RPC 2.0 protocol
   - Error handling

2. app/api/build/route.ts
   - POST endpoint
   - Call planner
   - Call orchestrator
   - Return execution_id

3. app/api/executions/[id]/status/route.ts
   - GET endpoint
   - Poll orchestrator status
   - Return progress/logs

4. app/page.tsx
   - Update home page
   - Textarea for input
   - Build button
   - Redirect to /executions/:id

5. app/executions/[id]/page.tsx
   - New status monitor page
   - Progress bar
   - Phase info
   - Live logs
   - Poll every 3 seconds

ENVIRONMENT SETUP
━━━━━━━━━━━━━━━━
1. Get MCP endpoint from SAM deployment
2. Create .env.local:
   MCP_ENDPOINT_URL=https://xxx.execute-api.us-east-1.amazonaws.com/mcp

3. Test:
   curl -X POST $MCP_ENDPOINT_URL \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":"test","method":"tools/list"}'

MCP TOOLS YOU'LL CALL
━━━━━━━━━━━━━━━━━━━━
1. planner_parse_natural_language
   Input: { natural_language: string }
   Output: { solution_config: {...} }

2. orchestrator_execute
   Input: { solution_config: {...} }
   Output: { execution_id, status }

3. orchestrator_get_status
   Input: { execution_id }
   Output: { status, phase, progress, logs }

4. orchestrator_get_artifacts
   Input: { execution_id }
   Output: { artifacts: [...] }

DATA FLOW
━━━━━━━━
User Form
  ↓ POST /api/build
Backend
  ├─ MCP: planner_parse_natural_language()
  ├─ MCP: orchestrator_execute()
  └─ Return { execution_id }
  ↓ Redirect to /executions/:id
UI: Status Monitor
  ├─ GET /api/executions/:id/status (every 3 sec)
  ├─ Update progress bar
  ├─ Show current phase
  └─ Display logs
  ↓ When status === "COMPLETED"
UI: Artifacts Page
  ├─ GET /api/executions/:id/artifacts
  └─ Show download links

TESTING CHECKLIST
━━━━━━━━━━━━━━━
□ MCP endpoint accessible
□ Can call planner
□ Can call orchestrator
□ Form submits
□ Status page polls
□ Progress updates
□ Artifacts appear
□ Errors handled

FILE STRUCTURE
━━━━━━━━━━━━━
NEXT_HARNESS/
├── app/
│   ├── api/
│   │   ├── build/route.ts ← Create
│   │   └── executions/[id]/status/route.ts ← Create
│   ├── executions/[id]/page.tsx ← Create
│   ├── page.tsx ← Update
│   ├── layout.tsx (exists)
│   └── globals.css (exists)
├── lib/
│   └── mcp-client.ts ← Create
├── .env.local ← Create
└── package.json (exists)

DOCUMENTATION
━━━━━━━━━━━━━
See /projects/sandbox/:

- HARNESS_REQUIREMENTS.md      Full architecture
- HARNESS_QUICK_START.md       Step-by-step setup
- MCP_TOOLS_REFERENCE.md       Tool signatures
- IMPLEMENTATION_CHECKLIST.md  Task list
- HARNESS_SUMMARY.md           Complete overview

TIMELINE
━━━━━━━
Day 1: Setup + MCP Client     (4 hours)
Day 2: API Routes + UI        (8 hours)
Day 3: Testing + Deploy       (4 hours)
Total: ~16 hours

NEXT STEPS
━━━━━━━━
1. Verify MCP deployment works
2. Get endpoint URL from SAM
3. Create .env.local
4. Create lib/mcp-client.ts
5. Create API routes
6. Create React components
7. Test end-to-end
8. Deploy to Vercel/EC2

Ready to build? Let's code! 🚀

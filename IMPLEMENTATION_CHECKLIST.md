# Harness Implementation Checklist

## Pre-Implementation

### Prerequisites
- [ ] MCP is deployed to Lambda
- [ ] You have the MCP endpoint URL (from SAM outputs)
- [ ] PostgreSQL database is running (if adding persistence)
- [ ] Voyage API key is set up (for MCP knowledge base)

### Verify MCP Works
- [ ] Test MCP endpoint with curl
  ```bash
  curl -X POST https://<endpoint>/mcp \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":"test","method":"tools/list"}'
  ```
- [ ] Verify planner tool responds
- [ ] Verify orchestrator tool responds

---

## Phase 1: MCP Client Bridge (Day 1)

### Setup
- [ ] Create `lib/mcp-client.ts`
- [ ] Add `MCP_ENDPOINT_URL` to `.env.local`
- [ ] Create `lib/db.ts` for database (optional)
- [ ] Add environment variables:
  - [ ] `MCP_ENDPOINT_URL` — from SAM
  - [ ] `DATABASE_URL` — PostgreSQL connection (optional)

### Testing
- [ ] Test `callMcpTool('planner_parse_natural_language', {...})`
- [ ] Test `callMcpTool('orchestrator_execute', {...})`
- [ ] Test `callMcpTool('orchestrator_get_status', {...})`
- [ ] Handle errors gracefully

---

## Phase 2: API Routes (Day 1-2)

### Create Endpoints

#### `/api/build` — POST
- [ ] Accept `{ description: string }`
- [ ] Call `planner_parse_natural_language`
- [ ] Call `orchestrator_execute` with result
- [ ] Return `{ execution_id, status }`
- [ ] Handle errors (validation, API failures)

#### `/api/executions/:id/status` — GET
- [ ] Accept `execution_id` from URL
- [ ] Call `orchestrator_get_status`
- [ ] Return status, progress, logs
- [ ] Handle "not found" case

#### `/api/executions/:id/artifacts` — GET (Optional)
- [ ] Accept `execution_id` from URL
- [ ] Call `orchestrator_get_artifacts`
- [ ] Return list of artifacts
- [ ] Optionally store in S3 for long-term archival

#### `/api/executions` — GET (Optional)
- [ ] List user's past executions
- [ ] Query from database
- [ ] Support filtering by status, date range

### Testing
- [ ] Test `/api/build` with valid description
- [ ] Test `/api/executions/:id/status` during execution
- [ ] Test status polling every 2-5 seconds
- [ ] Test artifact retrieval after completion
- [ ] Test error cases (invalid config, API timeout)

---

## Phase 3: UI Components (Day 2-3)

### Home Page (`app/page.tsx`)
- [ ] Show landing page with title
- [ ] Show textarea for description input
- [ ] Show "Build" button
- [ ] Show loading state while submitting
- [ ] Redirect to execution page on success
- [ ] Show error message if submission fails
- [ ] Add example descriptions in placeholder

#### Optional Enhancements
- [ ] Business vertical selector (ecommerce, finance, healthcare, media)
- [ ] URL input field
- [ ] Advanced options (merge policy, sandbox)

### Execution Monitor (`app/executions/[id]/page.tsx`)
- [ ] Show execution ID
- [ ] Show current phase name
- [ ] Show progress bar (0-100%)
- [ ] Show status badge (QUEUED, RUNNING, COMPLETED, FAILED)
- [ ] Poll status every 2-5 seconds
- [ ] Stop polling when complete
- [ ] Show log messages in terminal-style box
- [ ] Auto-scroll logs to bottom

#### Optional Enhancements
- [ ] Cancel button (call `orchestrator_cancel`)
- [ ] Retry failed phase button
- [ ] Download artifacts button
- [ ] Share execution link

### Execution History (`app/executions/page.tsx`) — Optional
- [ ] List all user's executions
- [ ] Show creation date, status, duration
- [ ] Click to view execution details
- [ ] Filter by status (running, completed, failed)

### Testing
- [ ] Fill form and click Build
- [ ] Watch progress page update
- [ ] See logs appear in real-time
- [ ] See artifacts after completion
- [ ] Test all UI states (loading, running, complete, error)

---

## Phase 4: Database (Optional)

### Schema Setup
- [ ] Create `executions` table
- [ ] Create `artifacts` table
- [ ] Create `execution_logs` table
- [ ] Add indexes for performance

### Code
- [ ] Create `lib/db.ts` with helper functions
  - [ ] `storeExecution()`
  - [ ] `getExecution()`
  - [ ] `listExecutions()`
  - [ ] `updateExecution()`
  - [ ] `storeArtifacts()`
  - [ ] `getArtifacts()`

### Integration
- [ ] Store execution info after calling planner
- [ ] Update execution status after polling
- [ ] Store artifacts after completion

### Testing
- [ ] Verify data persists in database
- [ ] Query execution history
- [ ] Retrieve old artifacts

---

## Phase 5: Polish & Production (Day 4+)

### Error Handling
- [ ] Validate user input (description length, etc.)
- [ ] Handle MCP timeouts (30s limit)
- [ ] Handle MCP errors gracefully
- [ ] Show user-friendly error messages
- [ ] Log errors for debugging

### Performance
- [ ] Cache planner results (optional)
- [ ] Optimize database queries
- [ ] Add request deduplication (prevent double-clicks)
- [ ] Lazy-load artifacts

### Security
- [ ] Validate MCP endpoint URL
- [ ] Sanitize user descriptions before logging
- [ ] Add rate limiting (optional)
- [ ] Add authentication (optional)
- [ ] Use HTTPS only
- [ ] Store database password in `.env` (not in code)

### Observability
- [ ] Add structured logging
- [ ] Track metrics (planner time, orchestrator time, success rate)
- [ ] Monitor error rates
- [ ] Add debug mode for troubleshooting

### Documentation
- [ ] Write README.md for harness setup
- [ ] Add inline code comments
- [ ] Document API endpoints
- [ ] Add troubleshooting guide

### Deployment
- [ ] Set up CI/CD pipeline (GitHub Actions, Vercel)
- [ ] Deploy to staging environment first
- [ ] Test in staging
- [ ] Deploy to production (Vercel, EC2, or managed platform)

---

## Testing Checklist

### Happy Path
- [ ] User describes a valid build
- [ ] Planner creates valid config
- [ ] Orchestrator executes successfully
- [ ] User sees progress
- [ ] User gets artifacts
- [ ] User can download/use artifacts

### Edge Cases
- [ ] Ambiguous description (e.g., "Build something")
- [ ] Missing domain/business vertical
- [ ] Invalid PQL expression
- [ ] Conflicting requirements
- [ ] Orchestrator timeout (>20 minutes)
- [ ] Network disconnect during polling
- [ ] User closes tab while building

### Errors
- [ ] MCP endpoint is down
- [ ] Invalid MCP endpoint URL
- [ ] Planner tool fails
- [ ] Orchestrator tool fails
- [ ] Database connection fails
- [ ] Artifacts are too large
- [ ] Concurrent builds from same user

---

## File Structure (Expected Result)

```
NEXT_HARNESS/
├── app/
│   ├── api/
│   │   ├── build/
│   │   │   └── route.ts          ✅ POST /api/build
│   │   └── executions/
│   │       └── [id]/
│   │           ├── status/
│   │           │   └── route.ts   ✅ GET /api/executions/:id/status
│   │           └── artifacts/
│   │               └── route.ts   ✅ GET /api/executions/:id/artifacts
│   ├── executions/
│   │   ├── page.tsx               ✅ GET /executions (list)
│   │   └── [id]/
│   │       └── page.tsx           ✅ GET /executions/:id (monitor)
│   ├── page.tsx                   ✅ Home page with form
│   ├── layout.tsx                 (existing)
│   ├── globals.css                (existing)
│   └── favicon.ico                (existing)
├── lib/
│   ├── mcp-client.ts              ✅ HTTP bridge to MCP
│   ├── db.ts                      ✅ Database helpers (optional)
│   └── types.ts                   ✅ TypeScript types
├── .env.local                     ✅ Environment variables
├── package.json                   (updated)
├── tsconfig.json                  (existing)
├── next.config.ts                 (existing)
└── README.md                      ✅ Setup instructions
```

---

## Quick Reference: Tool Call Order

### User Flow
```
1. User fills form with description
   ↓
2. User clicks "Build"
   ↓
3. Harness calls POST /api/build
   ↓
4. Backend calls MCP: planner_parse_natural_language()
   ↓ Returns: solution_config
   ↓
5. Backend calls MCP: orchestrator_execute(solution_config)
   ↓ Returns: execution_id
   ↓
6. Harness redirects to /executions/:id
   ↓
7. Frontend polls GET /api/executions/:id/status every 3 sec
   ↓ Returns: status, progress, logs
   ↓
8. Frontend updates UI with progress
   ↓
9. When status === "COMPLETED", frontend calls GET /api/executions/:id/artifacts
   ↓ Returns: list of artifact files
   ↓
10. Frontend shows download links
```

---

## Common Issues & Solutions

### Issue: "Cannot connect to MCP"
- **Check**: Is the endpoint URL correct? (from SAM outputs)
- **Check**: Is the Lambda still running? (not throttled, not out of memory)
- **Fix**: Verify with `curl` directly
- **Fix**: Check Lambda CloudWatch logs

### Issue: "Planner returns invalid config"
- **Check**: Is the description clear and complete?
- **Fix**: Ask user for more details
- **Fix**: Check planner logs on Lambda

### Issue: "Orchestrator hangs"
- **Check**: Is it stuck on a particular phase?
- **Fix**: Add timeout (20-30 min max)
- **Fix**: Check MCP logs for errors
- **Option**: Add cancel button

### Issue: "UI doesn't update"
- **Check**: Is polling working? (check network tab in browser devtools)
- **Fix**: Verify polling interval (should be 2-5 sec, not too frequent)
- **Fix**: Check browser console for errors

### Issue: "Artifacts are huge"
- **Option**: Store in S3 instead of database
- **Option**: Compress before storage
- **Option**: Return only small metadata, fetch full content on demand

---

## Success Criteria

### Minimum Viable Harness ✅
- [ ] User can describe a build in plain English
- [ ] Build completes without manual intervention
- [ ] User sees real-time progress
- [ ] User gets artifacts on completion
- [ ] System handles errors gracefully

### Production Harness ✅
- [ ] All success criteria above
- [ ] Database stores execution history
- [ ] Authentication for users
- [ ] Structured logging
- [ ] Monitoring & alerting
- [ ] Load testing (can handle 10+ concurrent users)
- [ ] Deployment automation
- [ ] Disaster recovery plan

---

## Estimated Timeline

| Phase | Tasks | Timeline |
|-------|-------|----------|
| 1 | MCP client, env setup | 2-4 hours |
| 2 | API routes | 4-6 hours |
| 3 | UI components | 6-8 hours |
| 4 | Database (optional) | 4-6 hours |
| 5 | Polish & deployment | 4-8 hours |
| **Total** | **All phases** | **20-32 hours** |

**Fast track** (core functionality only): 12-16 hours

---

## Next Steps

### Immediate (Next 2 hours)
1. [ ] Verify MCP is deployed and accessible
2. [ ] Create `lib/mcp-client.ts`
3. [ ] Add environment variables to `.env.local`
4. [ ] Test MCP connection with simple tool call

### Short term (Next 8 hours)
1. [ ] Create API routes for `/api/build` and `/api/executions/:id/status`
2. [ ] Create home page and execution monitor UI
3. [ ] Test end-to-end flow locally

### Medium term (Next 24 hours)
1. [ ] Add database support (optional)
2. [ ] Add error handling and logging
3. [ ] Deploy to staging

### Long term (Ongoing)
1. [ ] Monitor production performance
2. [ ] Gather user feedback
3. [ ] Iterate on UI/UX
4. [ ] Add advanced features (execution history, analytics, etc.)

---

## Resources

### Documentation
- `/projects/sandbox/HARNESS_REQUIREMENTS.md` — Full requirements
- `/projects/sandbox/HARNESS_QUICK_START.md` — Setup guide
- `/projects/sandbox/MCP_TOOLS_REFERENCE.md` — Tool signatures
- `/projects/sandbox/mcp/README.md` — MCP documentation

### MCP Repository
- **Tools**: `/projects/sandbox/mcp/mcp_server/tools/planner.py`
- **Tools**: `/projects/sandbox/mcp/mcp_server/tools/orchestrator.py`
- **Deployment**: `/projects/sandbox/mcp/template.yaml`

### Harness Repository
- **Start**: `/projects/sandbox/NEXT_HARNESS/app/page.tsx`

---

## Ready to Start?

✅ Phase 1: Start with `lib/mcp-client.ts`
✅ Phase 2: Build the API routes
✅ Phase 3: Create the UI components
✅ Phase 4: Add database (optional)
✅ Phase 5: Deploy

Which phase would you like me to help you implement first?

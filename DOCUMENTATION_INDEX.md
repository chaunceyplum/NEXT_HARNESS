# Documentation Index: Complete Harness Setup Guide

> **⚠️ Superseded.** Everything below describes the original fixed
> planner→orchestrator pipeline, which called tools that don't exist on the
> real MCP (`orchestrator_*`) and, once fixed to the real `msb_execute_solution`,
> would still route every request through one monolithic full-build tool
> regardless of scope. The harness now runs a dynamic, provider-agnostic
> agent instead — start with `lib/llm/agent.ts` (the tool-call loop),
> `lib/llm/tool-retrieval.ts` (semantic tool shortlisting), and
> `lib/llm/model-registry.ts` (swappable Anthropic/Bedrock/OpenAI models,
> configured via `ENVIRONMENT_VARIABLES.md`'s "LLM Provider Variables"
> section). The docs below are kept for historical context only.

## Overview

This directory contains comprehensive documentation for building an MCP Harness—a web application that automates MarTech solution deployment.

---

## 📚 Documentation Files

### **START HERE**
- **`START_HERE.md`** — Read this first! Complete overview with implementation roadmap.
- **`README_HARNESS.txt`** — Quick reference guide (2-minute read)

### **Requirements & Architecture**
- **`HARNESS_REQUIREMENTS.md`** — Full requirements, design decisions, what to build
- **`HARNESS_SUMMARY.md`** — Executive summary with tech stack and file structure
- **`HARNESS_QUICK_START.md`** — Step-by-step implementation guide with code examples

### **API & Tools Reference**
- **`MCP_TOOLS_REFERENCE.md`** — All 4 core MCP tools you'll use with signatures and examples

### **Implementation**
- **`IMPLEMENTATION_CHECKLIST.md`** — Detailed checklist with all tasks, testing criteria, and timelines

---

## 🎯 Quick Navigation by Use Case

### "I just want to understand what needs to be built"
→ Read: `START_HERE.md` (10 minutes)

### "I want the complete picture"
→ Read: `HARNESS_REQUIREMENTS.md` + `HARNESS_SUMMARY.md` (30 minutes)

### "I want to start coding"
→ Read: `HARNESS_QUICK_START.md` (20 minutes, includes code examples)

### "I need a detailed checklist"
→ Use: `IMPLEMENTATION_CHECKLIST.md` (task-by-task guide)

### "I need tool signatures"
→ Reference: `MCP_TOOLS_REFERENCE.md` (quick lookup)

### "I need a quick reference"
→ Use: `README_HARNESS.txt` (2-minute overview)

---

## 🏗️ Architecture at a Glance

```
Browser (React)
    ↓ HTTP
Next.js Backend
    ├─ lib/mcp-client.ts (HTTP bridge)
    └─ app/api/ (API routes)
    ↓ JSON-RPC 2.0
Lambda (MCP)
    ├─ planner_parse_natural_language
    ├─ orchestrator_execute
    ├─ orchestrator_get_status
    └─ + 135 other tools
    ↓
External APIs
    ├─ Adobe Experience Platform
    ├─ AWS Services
    ├─ Databricks
    └─ Snowflake
```

---

## 📋 Files to Create

```
NEXT_HARNESS/
├── lib/
│   └── mcp-client.ts           ← HTTP bridge (50 lines)
├── app/
│   ├── page.tsx                ← Update home page (80 lines)
│   ├── api/
│   │   ├── build/route.ts      ← POST endpoint (40 lines)
│   │   └── executions/[id]/
│   │       └── status/route.ts ← GET endpoint (20 lines)
│   └── executions/[id]/
│       └── page.tsx            ← Status monitor (100 lines)
├── .env.local                  ← Environment vars (3 lines)
└── package.json                (already exists)
```

**Total new code: ~400 lines**

---

## 🔄 Data Flow

```
1. User enters description in form
        ↓
2. POST /api/build
        ↓
3. Backend calls MCP planner
        ↓ Returns SolutionConfig
4. Backend calls MCP orchestrator
        ↓ Returns execution_id
5. Redirect to /executions/:id
        ↓
6. GET /api/executions/:id/status (every 3 sec)
        ↓ Poll orchestrator
7. Update UI with progress
        ↓
8. When complete, GET artifacts
        ↓
9. Show download links
```

---

## 🛠️ Core Components

### 1. MCP Client Bridge (`lib/mcp-client.ts`)
```typescript
// Wrapper to call MCP tools via HTTP
async callMcpTool(toolName, args) → result
```

### 2. Build Endpoint (`app/api/build/route.ts`)
```typescript
POST /api/build
  Input: { description: string }
  → Call planner
  → Call orchestrator
  → Return { execution_id }
```

### 3. Status Endpoint (`app/api/executions/[id]/status/route.ts`)
```typescript
GET /api/executions/:id/status
  → Call orchestrator_get_status
  → Return { status, progress, logs, phase }
```

### 4. Home Page (`app/page.tsx`)
```typescript
- Textarea for user input
- "Build" button
- Redirect on success
```

### 5. Status Monitor (`app/executions/[id]/page.tsx`)
```typescript
- Progress bar
- Current phase
- Live logs
- Poll every 3 seconds
- Show artifacts when done
```

---

## 📖 Reading Order

### For Developers (Ready to Code)
1. `START_HERE.md` — Overview (10 min)
2. `HARNESS_QUICK_START.md` — Code examples (20 min)
3. `MCP_TOOLS_REFERENCE.md` — Tool signatures (5 min)
4. `IMPLEMENTATION_CHECKLIST.md` — Start coding!

### For Architects (Understanding Design)
1. `HARNESS_REQUIREMENTS.md` — Architecture decisions (15 min)
2. `HARNESS_SUMMARY.md` — Tech stack overview (10 min)
3. `MCP_TOOLS_REFERENCE.md` — Tool capabilities (10 min)

### For Project Managers (Timeline & Scope)
1. `START_HERE.md` — TL;DR section (5 min)
2. `IMPLEMENTATION_CHECKLIST.md` — Timeline & phases (10 min)
3. `HARNESS_SUMMARY.md` — Success criteria (5 min)

---

## ⚡ Quick Facts

| Metric | Value |
|--------|-------|
| **MCP Tools** | 139 tools (complete) |
| **Planner** | 1,151 LOC (complete) |
| **Orchestrator** | 28 KB (complete) |
| **Harness Code** | ~400 lines (new) |
| **Implementation Time** | 16-20 hours |
| **API Endpoints** | 3 new routes |
| **React Components** | 2 new pages |
| **Deployment** | Vercel, EC2, or self-hosted |

---

## 🎯 Success Criteria

### MVP (Minimum Viable Product)
✅ User submits description  
✅ Planner creates config  
✅ Orchestrator starts build  
✅ User sees progress  
✅ User gets artifacts  

### Production-Ready
✅ All MVP criteria  
✅ Error handling  
✅ Execution history (DB)  
✅ Authentication  
✅ Monitoring  
✅ Documentation  

---

## 🚀 Next Steps

### Immediate (Today)
1. [ ] Read `START_HERE.md`
2. [ ] Verify MCP endpoint is working
3. [ ] Create `.env.local` with endpoint URL

### This Week
1. [ ] Create `lib/mcp-client.ts`
2. [ ] Create API routes
3. [ ] Create React components
4. [ ] Test end-to-end

### Next Week
1. [ ] Deploy to staging
2. [ ] Get feedback
3. [ ] Deploy to production

---

## 📞 Key MCP Tools

### 1. Planner
```
Tool: planner_parse_natural_language
Input: { natural_language: string }
Output: { solution_config: {...} }
Purpose: Convert English → config
```

### 2. Orchestrator Execute
```
Tool: orchestrator_execute
Input: { solution_config: {...} }
Output: { execution_id: string }
Purpose: Start the build
```

### 3. Orchestrator Status
```
Tool: orchestrator_get_status
Input: { execution_id: string }
Output: { status, progress, logs, phase }
Purpose: Poll progress
```

### 4. Get Artifacts
```
Tool: orchestrator_get_artifacts
Input: { execution_id: string }
Output: { artifacts: [{type, filename, content}] }
Purpose: Retrieve results
```

---

## 🔧 Environment Setup

```bash
# 1. Get MCP endpoint from SAM deployment
# Example: https://xxx.execute-api.us-east-1.amazonaws.com/mcp

# 2. Create .env.local
echo "MCP_ENDPOINT_URL=https://your-endpoint/mcp" > .env.local

# 3. Test
npm run dev
# Visit http://localhost:3000
```

---

## 📊 File Sizes

| File | Lines | Size |
|------|-------|------|
| `lib/mcp-client.ts` | 50 | 1.5 KB |
| `app/api/build/route.ts` | 40 | 1.2 KB |
| `app/api/.../status/route.ts` | 20 | 0.7 KB |
| `app/page.tsx` | 80 | 2.4 KB |
| `app/executions/[id]/page.tsx` | 100 | 3.1 KB |
| **Total New Code** | **~400** | **~9 KB** |

---

## 🎓 Learning Resources

### Within This Documentation
- **Architecture**: `HARNESS_REQUIREMENTS.md`
- **Implementation**: `HARNESS_QUICK_START.md`
- **Reference**: `MCP_TOOLS_REFERENCE.md`
- **Checklist**: `IMPLEMENTATION_CHECKLIST.md`

### External Resources
- Next.js Docs: https://nextjs.org/docs
- React Hooks: https://react.dev/reference/react
- TypeScript: https://www.typescriptlang.org/docs
- Tailwind CSS: https://tailwindcss.com/docs

---

## ✅ Checklist Before Starting

- [ ] MCP is deployed to Lambda
- [ ] You have the endpoint URL
- [ ] `.env.local` is created
- [ ] You've read `START_HERE.md`
- [ ] You understand the data flow
- [ ] Node.js 18+ is installed
- [ ] Git is configured

---

## 🆘 Troubleshooting

### "MCP endpoint not responding"
→ Check SAM deployment, verify Lambda is running

### "Planner returns invalid config"
→ Check description is detailed enough, review planner logs

### "Frontend not updating progress"
→ Check polling interval (should be 3 sec), verify API route works

### "Artifacts are huge"
→ Store in S3, return only metadata to browser

### "Build times out"
→ Add timeout handler, offer retry, or run longer on EC2

---

## 📞 Support

For questions about:
- **Architecture** → See `HARNESS_REQUIREMENTS.md`
- **Implementation** → See `HARNESS_QUICK_START.md`
- **Tools** → See `MCP_TOOLS_REFERENCE.md`
- **Tasks** → See `IMPLEMENTATION_CHECKLIST.md`
- **Overview** → See `START_HERE.md`

---

## 🏁 Summary

You have everything you need to build the harness:

✅ Complete MCP with 139 tools  
✅ Working planner (converts English → config)  
✅ Working orchestrator (executes multi-phase builds)  
✅ Next.js bootstrap  
✅ Comprehensive documentation  

**What's left**: Build ~400 lines of Next.js code to bridge them together.

**Timeline**: 16-20 hours  
**Difficulty**: Medium  
**Complexity**: HTTP calls + React hooks + database (optional)  

---

## 🎬 Get Started

1. Open `START_HERE.md`
2. Follow the roadmap
3. Implement each phase
4. Deploy to production

**Let's build! 🚀**

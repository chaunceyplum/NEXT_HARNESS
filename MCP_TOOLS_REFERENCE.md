# MCP Tools Reference for Harness

## Overview

The harness will primarily use these **core orchestration tools** from the MCP:

1. **Planner Tools** — Convert natural language → validated configuration
2. **Orchestrator Tools** — Execute multi-phase builds
3. **Status/Monitoring Tools** — Poll progress and retrieve artifacts

---

## Planner Tools

These tools convert user descriptions into actionable configurations.

### `planner_parse_natural_language`

Converts a plain-English description into a complete `SolutionConfig`.

**Endpoint**: MCP Tool `planner_parse_natural_language`

**Input**:
```typescript
{
  natural_language: string;        // Required: "Build AEP for ecommerce..."
  business_vertical?: string;      // Optional: "ecommerce" | "finance" | "healthcare" | "media"
  url?: string;                    // Optional: domain to analyze
}
```

**Output**:
```typescript
{
  solution_config: {
    website_domain: string;
    business_vertical: string;
    page_types: string[];
    events: Array<{
      name: string;
      description: string;
      page_types: string[];
      frequency: "frequent" | "occasional" | "rare";
      required_attributes: string[];
      optional_attributes: string[];
    }>;
    segments: Array<{
      name: string;
      description: string;
      segment_type: string;
      pql_expression: string;
      destinations: string[];
    }>;
    destinations: string[];
    personalization_placements: string[];
    merge_policy: string;
    sandbox_name: string;
    goals: string[];
    success_metrics: string[];
    confidence_score: number;
  };
  report?: {
    extracted_entities: Record<string, any>;
    validation_result: {
      warnings: string[];
      suggestions: string[];
    };
    enrichment_applied: Record<string, any>;
  };
}
```

**Example Request**:
```json
{
  "jsonrpc": "2.0",
  "id": "build-123",
  "method": "tools/call",
  "params": {
    "name": "planner_parse_natural_language",
    "arguments": {
      "natural_language": "I want to build an AEP solution for our ecommerce store. We need to track product views, add-to-cart, and purchases. We want to create segments for high-value customers and repeat buyers, and then activate them to email.",
      "business_vertical": "ecommerce",
      "url": "www.example.com"
    }
  }
}
```

**Example Response**:
```json
{
  "jsonrpc": "2.0",
  "id": "build-123",
  "result": {
    "solution_config": {
      "website_domain": "www.example.com",
      "business_vertical": "ecommerce",
      "page_types": ["product", "cart", "checkout"],
      "events": [
        {
          "name": "product_view",
          "description": "User views a product",
          "page_types": ["product"],
          "frequency": "frequent",
          "required_attributes": ["product_id", "product_name"],
          "optional_attributes": ["category", "price"]
        },
        {
          "name": "add_to_cart",
          "description": "User adds product to cart",
          "page_types": ["product", "cart"],
          "frequency": "occasional",
          "required_attributes": ["product_id", "quantity"],
          "optional_attributes": ["price"]
        },
        {
          "name": "purchase",
          "description": "User completes purchase",
          "page_types": ["checkout"],
          "frequency": "occasional",
          "required_attributes": ["order_id", "total"],
          "optional_attributes": ["items", "currency"]
        }
      ],
      "segments": [
        {
          "name": "high_value_customers",
          "description": "Customers with total purchase value > $500",
          "segment_type": "value_based",
          "pql_expression": "(xEvent.commerce.purchases.value > 500)",
          "destinations": ["email", "adobe_audience_manager"]
        },
        {
          "name": "repeat_buyers",
          "description": "Customers with 3+ purchases",
          "segment_type": "behavioral",
          "pql_expression": "(xEvent.commerce.purchases.totalPurchaseNumber >= 3)",
          "destinations": ["email"]
        }
      ],
      "destinations": ["email", "adobe_audience_manager"],
      "personalization_placements": ["homepage_banner", "product_recommendations"],
      "merge_policy": "recommended",
      "sandbox_name": "prod",
      "goals": ["Increase repeat purchase rate", "Maximize customer lifetime value"],
      "success_metrics": ["Repeat purchase rate", "Average order value"],
      "confidence_score": 0.92
    }
  }
}
```

---

### `planner_parse_with_report`

Same as above, but returns detailed analysis report.

**Input**: Same as `planner_parse_natural_language`

**Output**: Same + detailed report with extracted entities, validation warnings, enrichment info

---

### `planner_validate_config`

Validates a configuration without executing it.

**Input**:
```typescript
{
  solution_config: SolutionConfig;  // The config to validate
}
```

**Output**:
```typescript
{
  is_valid: boolean;
  warnings: string[];
  errors: string[];
  suggestions: string[];
  aep_capability_gaps: string[];
}
```

---

### `planner_find_similar`

Find similar past configurations for pattern matching.

**Input**:
```typescript
{
  business_vertical: string;
  keywords: string[];
}
```

**Output**:
```typescript
{
  similar_configs: Array<{
    config_id: string;
    similarity_score: number;
    business_vertical: string;
    summary: string;
  }>;
}
```

---

## Orchestrator Tools

These tools execute the build process and manage execution state.

### `orchestrator_execute`

Starts a multi-phase build process.

**Input**:
```typescript
{
  solution_config: SolutionConfig;        // From planner
  webhook_url?: string;                   // Optional: URL to notify on completion
  skip_validation?: boolean;              // Optional: default false
  dry_run?: boolean;                      // Optional: test without changes
}
```

**Output**:
```typescript
{
  execution_id: string;                   // Unique identifier for this run
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;                          // Current phase name
  estimated_duration_seconds: number;     // ~600-1200 seconds (10-20 min)
  message: string;
}
```

**Example Request**:
```json
{
  "jsonrpc": "2.0",
  "id": "exec-456",
  "method": "tools/call",
  "params": {
    "name": "orchestrator_execute",
    "arguments": {
      "solution_config": { /* from planner */ }
    }
  }
}
```

**Example Response**:
```json
{
  "jsonrpc": "2.0",
  "id": "exec-456",
  "result": {
    "execution_id": "exec-abc123xyz789",
    "status": "QUEUED",
    "phase": "validation",
    "estimated_duration_seconds": 900,
    "message": "Build queued. Estimated time: 15 minutes."
  }
}
```

---

### `orchestrator_get_status`

Poll the status of a running or completed execution.

**Input**:
```typescript
{
  execution_id: string;                   // From orchestrator_execute
}
```

**Output**:
```typescript
{
  execution_id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  current_phase: string;                  // e.g., "Phase 2: Schema Creation"
  phase_number: number;                   // 1, 2, 3, 4
  total_phases: number;                   // Usually 4
  progress: number;                       // 0.0 to 1.0
  estimated_time_remaining_seconds: number;
  logs: string[];                         // Recent log lines
  error?: string;                         // If status === "FAILED"
}
```

**Example Request**:
```json
{
  "jsonrpc": "2.0",
  "id": "status-1",
  "method": "tools/call",
  "params": {
    "name": "orchestrator_get_status",
    "arguments": {
      "execution_id": "exec-abc123xyz789"
    }
  }
}
```

**Example Response**:
```json
{
  "jsonrpc": "2.0",
  "id": "status-1",
  "result": {
    "execution_id": "exec-abc123xyz789",
    "status": "RUNNING",
    "current_phase": "Phase 2: XDM Schema Creation",
    "phase_number": 2,
    "total_phases": 4,
    "progress": 0.35,
    "estimated_time_remaining_seconds": 585,
    "logs": [
      "2025-06-28 14:32:12 - Validating solution config...",
      "2025-06-28 14:32:15 - ✓ Config valid",
      "2025-06-28 14:32:20 - Creating XDM schema...",
      "2025-06-28 14:33:45 - Adding field groups...",
      "2025-06-28 14:33:50 - ✓ Schema created successfully"
    ]
  }
}
```

---

### `orchestrator_get_artifacts`

Retrieve generated files/artifacts from a completed execution.

**Input**:
```typescript
{
  execution_id: string;
}
```

**Output**:
```typescript
{
  artifacts: Array<{
    type: "sql" | "json" | "javascript" | "terraform" | "text";
    filename: string;
    content: string;
    size_bytes: number;
    generated_at: string;  // ISO 8601 timestamp
  }>;
  summary: {
    total_artifacts: number;
    total_size_bytes: number;
  };
}
```

**Example Response**:
```json
{
  "jsonrpc": "2.0",
  "id": "artifacts-1",
  "result": {
    "artifacts": [
      {
        "type": "sql",
        "filename": "01_create_schema.sql",
        "content": "CREATE SCHEMA aep_ecommerce;...",
        "size_bytes": 2341,
        "generated_at": "2025-06-28T14:45:00Z"
      },
      {
        "type": "json",
        "filename": "02_segments.json",
        "content": "{\"segments\": [{...}]}",
        "size_bytes": 1523,
        "generated_at": "2025-06-28T14:45:15Z"
      },
      {
        "type": "javascript",
        "filename": "03_event_tracking.js",
        "content": "window.trackEvent = function(event) {...}",
        "size_bytes": 3214,
        "generated_at": "2025-06-28T14:45:30Z"
      }
    ],
    "summary": {
      "total_artifacts": 3,
      "total_size_bytes": 7078
    }
  }
}
```

---

### `orchestrator_cancel`

Cancel a running execution.

**Input**:
```typescript
{
  execution_id: string;
}
```

**Output**:
```typescript
{
  execution_id: string;
  status: "CANCELLED";
  message: string;
}
```

---

### `orchestrator_retry_phase`

Retry a failed phase.

**Input**:
```typescript
{
  execution_id: string;
  phase_number: number;  // 1, 2, 3, or 4
}
```

**Output**:
```typescript
{
  execution_id: string;
  status: "RUNNING";
  current_phase: string;
  message: string;
}
```

---

## All Available 139 Tools

Beyond the orchestrator, the MCP exposes 139 tools you can call from the harness if needed. These are grouped by domain:

### Adobe Experience Platform (73 tools)

- **Segments** (5): list, get, create, update, delete
- **Datasets** (4): list, create, update, delete
- **Schemas/XDM** (5): list, get, create, update, delete
- **Query Service** (12): run, get, results, cancel, list, schedule, etc.
- **Sources** (16): connection specs, base connections, source connections, dataflows
- **Destinations** (16): connection specs, base connections, target connections, dataflows
- **Reactor/Launch** (27): properties, extensions, rules, data elements, libraries, environments, builds
- **Customer Journey Analytics** (12): projects, data views, segments, calculated metrics, connections

### AWS Services (18 tools)

- **S3** (5): list buckets, list objects, get metadata, create bucket, delete object
- **Glue** (5): list databases, list tables, get table, create database, delete table
- **Redshift** (3): run query, get result, list tables
- **Lambda** (3): list functions, get function, invoke
- **CloudWatch Logs** (3): list groups, get recent, query

### Data Platforms (25 tools)

- **Databricks** (15): SQL, catalogs, schemas, tables, jobs, runs, clusters
- **Snowflake** (10): SQL, schema browser, query history, warehouse usage, table stats, copy history

### Knowledge Base (2 tools)

- `search_knowledge_base` — Find relevant docs
- `knowledge_base_stats` — Get corpus statistics

### Knowledge Tools (21 tools)

- AWS patterns, data eng patterns, etc.

---

## How the Harness Uses These Tools

### Typical User Flow

```python
# 1. User submits description
user_input = "Build AEP for ecommerce with email activation"

# 2. Harness calls planner
solution_config = await callMcpTool('planner_parse_natural_language', {
  'natural_language': user_input
})

# 3. Harness calls orchestrator
execution = await callMcpTool('orchestrator_execute', {
  'solution_config': solution_config['solution_config']
})

# 4. Harness polls status every 2-5 seconds
while True:
  status = await callMcpTool('orchestrator_get_status', {
    'execution_id': execution['execution_id']
  })
  
  if status['status'] == 'COMPLETED':
    break
  
  time.sleep(3)

# 5. When done, fetch artifacts
artifacts = await callMcpTool('orchestrator_get_artifacts', {
  'execution_id': execution['execution_id']
})

# 6. Return artifacts to user
return {
  'status': 'COMPLETED',
  'artifacts': artifacts['artifacts']
}
```

---

## Error Handling

All MCP tools follow the JSON-RPC 2.0 error format:

```json
{
  "jsonrpc": "2.0",
  "id": "...",
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": {
      "details": "solution_config is required"
    }
  }
}
```

Common error codes:

- `-32602` — Invalid parameters
- `-32603` — Internal error (tool execution failed)
- `-32001` — Tool not found
- `-32000` — Server error

**Harness should**:
1. Check for `error` field in response
2. Log the error
3. Display user-friendly message
4. Offer retry option

---

## Tool Availability

All tools are available at the MCP endpoint after deployment. To list all tools:

```json
{
  "jsonrpc": "2.0",
  "id": "list-1",
  "method": "tools/list",
  "params": {}
}
```

Response includes all 139 tool schemas.

---

## Rate Limiting & Timeouts

- **Planner** — ~100ms, should complete in <1 second
- **Orchestrator execute** — Returns immediately with execution_id
- **Orchestrator status** — ~500ms per call
- **Artifacts** — ~1-2 seconds depending on artifact size
- **Other tools** — Varies (usually 100ms-30s for async queries)

The harness should:
- Retry transient failures (5xx errors)
- Timeout after 30 seconds
- Aggregate logs in database for long-running orchestrations

---

## Next Steps

Ready to integrate? You'll need:

1. ✅ MCP deployed to Lambda (with endpoint URL)
2. ✅ MCP client utility in harness (`lib/mcp-client.ts`)
3. ✅ API routes that call these tools
4. ✅ UI that shows progress
5. ✅ Database to store execution history (optional)

The core loop is:
```
User Description → Planner → SolutionConfig → Orchestrator → Poll Status → Get Artifacts
```

Each step calls one MCP tool via HTTP.

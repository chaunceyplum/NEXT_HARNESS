# Test MCP Connection

If you're getting "Unknown tool: planner_parse_natural_language", it means the MCP backend doesn't have the planner tools registered.

## Diagnose the Problem

### 1. Test MCP Endpoint is Accessible

```bash
# Get your endpoint from SAM deployment
export MCP_ENDPOINT=https://your-endpoint/mcp

# Test with curl
curl -X POST $MCP_ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-1",
    "method": "tools/list",
    "params": {}
  }' | jq '.'
```

This should return a list of available tools.

### 2. Check if Planner Tools Are Registered

Look in the response for tools named:
- `planner_parse_natural_language`
- `planner_parse_with_report`
- `orchestrator_execute`
- `orchestrator_get_status`

If these tools are **missing**, the MCP Lambda doesn't have them deployed.

## Solutions

### Solution 1: Check MCP Deployment

```bash
# Verify MCP is deployed
aws cloudformation list-stacks --query 'StackSummaries[?StackName==`mcp`]'

# Check MCP Lambda function
aws lambda get-function --function-name mcp

# Check Lambda has recent code
aws lambda get-function-code-location --function-name mcp
```

### Solution 2: Redeploy MCP

The planner and orchestrator tools need to be in the MCP. You must:

1. **Check that planner.py and orchestrator.py exist** in MCP repo
2. **Make sure they're imported in lambda_handler.py**
3. **Make sure tools are registered in TOOLS dict**
4. **Redeploy MCP**

```bash
cd /projects/sandbox/mcp

# Build
sam build

# Deploy
sam deploy --guided

# Or update existing deployment
sam deploy
```

### Solution 3: Update Harness to Use Alternative Tools

If you can't deploy the planner tools yet, you can temporarily modify the harness to work with basic tools:

Edit `app/api/build/route.ts` to use a simpler approach without the planner:

```typescript
// Temporary: Skip planner, create basic config directly
const basicConfig = {
  website_domain: "example.com",
  business_vertical: "ecommerce",
  page_types: ["product", "cart", "checkout"],
  events: [
    { name: "product_view", description: "User views product" },
    { name: "purchase", description: "User completes purchase" }
  ],
  segments: [
    { name: "high_value", description: "Customers with >$500 total", pql_expression: "(xEvent.commerce.purchases.value > 500)" }
  ],
  destinations: ["email"],
  personalization_placements: ["homepage"],
  merge_policy: "default",
  sandbox_name: "prod",
  goals: [],
  success_metrics: [],
  confidence_score: 0.8
};

// Then call orchestrator directly
const execution = await callMcpTool('orchestrator_execute', {
  solution_config: basicConfig
});
```

---

## Verify Planner Exists in Lambda

### Check 1: Lambda Environment

```bash
# Check if planner.py file exists in Lambda code
aws lambda get-function --function-name mcp --query 'Code.RepositoryType'

# Get function code
aws lambda get-function --function-name mcp --query 'Code.Location' | xargs curl
```

### Check 2: CloudWatch Logs

```bash
# View Lambda execution logs
aws logs tail /aws/lambda/mcp --follow

# Look for import errors or registration issues
```

### Check 3: Lambda Layer

If you're using layers, make sure planner dependencies are included:

```bash
# List Lambda layers
aws lambda list-layers --query 'Layers[].LayerArn'

# Check layer version code
aws lambda get-layer-version --layer-name mcp-deps --version-number 1
```

---

## Next Steps

1. **Test MCP endpoint** - Run the curl command above
2. **Check what tools exist** - Look for planner_* tools
3. **If missing, redeploy MCP** - `sam deploy`
4. **If still missing, check imports** - Verify lambda_handler.py imports planner
5. **Check Lambda logs** - Look for import or registration errors

---

## Expected Tools Response

If MCP is working correctly, `tools/list` should return something like:

```json
{
  "jsonrpc": "2.0",
  "id": "test-1",
  "result": {
    "tools": [
      {
        "name": "planner_parse_natural_language",
        "description": "🎯 Convert natural language description...",
        "inputSchema": {
          "type": "object",
          "properties": {
            "user_input": {
              "type": "string",
              "description": "Natural language description..."
            }
          },
          "required": ["user_input"]
        }
      },
      {
        "name": "orchestrator_execute",
        "description": "🚀 Execute multi-phase build...",
        ...
      },
      ... (many more tools)
    ]
  }
}
```

If you DON'T see `planner_parse_natural_language` or `orchestrator_execute`, the planner/orchestrator code isn't deployed.

---

## Quick Fix Checklist

- [ ] MCP endpoint URL is correct
- [ ] MCP endpoint is publicly accessible (test with curl)
- [ ] `tools/list` returns list of tools
- [ ] `planner_parse_natural_language` exists in list
- [ ] `orchestrator_execute` exists in list
- [ ] `orchestrator_get_status` exists in list
- [ ] If missing, run `sam deploy` in /projects/sandbox/mcp

**Once planner/orchestrator tools exist in the list, the harness will work!** 🚀

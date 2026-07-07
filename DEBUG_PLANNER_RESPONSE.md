# Debugging "Planner returned invalid response"

This error means the harness received a response from the planner that doesn't match the expected structure.

## How to Debug

### Step 1: Check Browser Console
Open your browser's developer tools (F12) and check the Network tab:

1. **Open Network tab**
2. **Enter a description and click Build**
3. **Look for the `/api/build` request**
4. **Click it and view the Response tab**
5. **You should see the error details**

The error response will look like:
```json
{
  "error": "Planner returned invalid response structure",
  "code": "INVALID_RESPONSE",
  "details": {
    "received": { ... actual response ... },
    "expectedStructure": "Object with solution_config field"
  }
}
```

### Step 2: Log the Actual Response

Add temporary logging to see what the planner actually returns. Edit `app/api/build/route.ts`:

```typescript
// After calling planner
console.log('[BUILD] Raw planner response:', JSON.stringify(planResponse, null, 2));

// Then try to understand structure
console.log('[BUILD] Response keys:', Object.keys(planResponse));
console.log('[BUILD] Response type:', typeof planResponse);
```

### Step 3: Test Planner Directly

Test the planner tool directly with curl:

```bash
# Set your MCP endpoint
export MCP_ENDPOINT=https://your-endpoint/mcp

# Call planner directly
curl -X POST $MCP_ENDPOINT \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "test-planner",
    "method": "tools/call",
    "params": {
      "name": "planner_parse_natural_language",
      "arguments": {
        "user_input": "Build an ecommerce AEP solution"
      }
    }
  }' | jq '.result'
```

Look at the response structure. It should be something like:

```json
{
  "solution_config": {
    "website_domain": "...",
    "business_vertical": "...",
    "events": [...],
    "segments": [...],
    ...
  }
}
```

Or it might be:

```json
{
  "website_domain": "...",
  "business_vertical": "...",
  "events": [...],
  "segments": [...],
  ...
}
```

### Step 4: Check Server Logs

If running locally:

```bash
# In the terminal where you ran 'npm run dev'
# Look for [BUILD] log lines that show the planner response
```

If on production, check your hosting platform's logs:

- **Vercel**: Vercel Dashboard → Functions
- **EC2**: `pm2 logs mcp-harness`
- **Docker**: `docker logs <container-id>`

---

## Common Response Structures

### ✅ Correct Response (What We Expect)

```json
{
  "solution_config": {
    "website_domain": "example.com",
    "business_vertical": "ecommerce",
    "page_types": ["product", "cart", "checkout"],
    "events": [
      {
        "name": "product_view",
        "description": "User views product",
        "page_types": ["product"],
        "frequency": "frequent",
        "required_attributes": ["product_id"],
        "optional_attributes": ["price"]
      }
    ],
    "segments": [...],
    "destinations": ["email"],
    "personalization_placements": ["homepage"],
    "merge_policy": "default",
    "sandbox_name": "prod",
    "goals": [],
    "success_metrics": [],
    "confidence_score": 0.85
  }
}
```

### ❌ Wrong Response 1 (Flat Structure)

If the planner returns the config directly without nesting:

```json
{
  "website_domain": "example.com",
  "business_vertical": "ecommerce",
  ...
}
```

**Fix**: The harness now handles this! It checks for both `planResponse.solution_config` and treats `planResponse` as the config if needed.

### ❌ Wrong Response 2 (Extra Wrapping)

If the planner returns extra wrapping:

```json
{
  "data": {
    "solution_config": { ... }
  }
}
```

**Fix**: Report this as an issue. The planner should return `{ solution_config: {...} }` directly.

### ❌ Wrong Response 3 (Error Returned)

If the planner returns an error:

```json
{
  "error": "Failed to parse input",
  "message": "Could not understand the request"
}
```

**Cause**: The planner NLP layer is rejecting the input.

**Fix**: Try a more detailed description. Example:
```
"Build an AEP solution for ecommerce. We need to track product views, 
add-to-cart, and purchase events. Create segments for high-value customers 
and activate to email marketing."
```

---

## Solutions

### Solution 1: Use Better Description

If planner rejects input, provide more detail:

❌ Too vague:
```
"Build an AEP solution"
```

✅ Better:
```
"Build an Adobe Experience Platform solution for our ecommerce website.
We need to track product views, add-to-cart actions, and purchases.
Create segments for high-value customers ($500+) and repeat buyers (3+ purchases).
Activate these segments to email for promotional campaigns."
```

### Solution 2: Check Planner Deployment

Make sure the planner was deployed correctly:

```bash
# Verify planner.py exists in Lambda
aws lambda get-function --function-name mcp --query 'Configuration.CodeSize'

# Check when Lambda was last updated
aws lambda get-function --function-name mcp --query 'Configuration.LastModified'

# If it's old, redeploy:
cd /projects/sandbox/mcp
sam build
sam deploy
```

### Solution 3: Check Response Size

If the response is too large, Lambda might truncate it:

```bash
# Check Lambda response size limit
# Default: 6MB for synchronous invocation

# If response is huge, it might be getting truncated
# Check CloudWatch logs for truncation warnings
aws logs tail /aws/lambda/mcp --follow
```

### Solution 4: Manual Config

If planner is completely broken, use the workaround:

Edit `app/api/build/route.ts` to skip planner:

```typescript
// Skip planner, create basic config
const solutionConfig = {
  website_domain: "example.com",
  business_vertical: "ecommerce",
  page_types: ["product", "cart", "checkout"],
  events: [
    {
      name: "product_view",
      description: "User views product",
      page_types: ["product"],
      frequency: "frequent",
      required_attributes: ["product_id"],
      optional_attributes: ["price"]
    },
    {
      name: "purchase",
      description: "User completes purchase",
      page_types: ["checkout"],
      frequency: "occasional",
      required_attributes: ["order_id", "total"],
      optional_attributes: ["items"]
    }
  ],
  segments: [
    {
      name: "high_value",
      description: "Revenue > $500",
      segment_type: "value_based",
      pql_expression: "(xEvent.commerce.purchases.value > 500)",
      destinations: ["email"]
    }
  ],
  destinations: ["email"],
  personalization_placements: ["homepage"],
  merge_policy: "default",
  sandbox_name: "prod",
  goals: ["Increase sales"],
  success_metrics: ["AOV"],
  confidence_score: 0.8
};

// Then call orchestrator directly
const orchestratorResponse = await callMcpTool('orchestrator_execute', {
  solution_config: solutionConfig,
});
```

---

## Checklist

- [ ] MCP endpoint URL is correct and accessible
- [ ] Planner tool is registered in MCP (test with `tools/list`)
- [ ] You've tried with a detailed description
- [ ] Browser console shows full error details
- [ ] Server logs show what response was received
- [ ] Direct curl test works against MCP
- [ ] Lambda was redeployed recently

---

## Still Stuck?

1. **Get the actual error details** from browser console Network tab
2. **Test planner directly** with curl command above
3. **Check the response structure** to understand what's being returned
4. **Use the workaround** (manual config) to continue testing
5. **Report the response structure** that's being returned

The improved error messages should now tell you exactly what response structure you're getting, which will help identify the issue!

---

## Quick Fix

**Most likely**: Redeploy the MCP

```bash
cd /projects/sandbox/mcp
sam build
sam deploy
```

Then try again. If it still fails, the new error messages will tell you exactly what's wrong!

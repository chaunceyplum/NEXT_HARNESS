# Planner Keyword Reference

## Important: NO LLM Required

The planner does **NOT use Claude or any LLM**. It uses simple **regex-based keyword matching** to parse your description.

This means:
- ✅ No API calls to external LLM services
- ✅ No latency from LLM inference
- ✅ No costs for LLM usage
- ❌ It only understands keywords it knows about

## How the Planner Works

1. **User provides description** (plain text)
2. **Planner looks for keywords** (using regex patterns)
3. **Extracts entities** (domain, events, segments, destinations)
4. **Creates SolutionConfig** from what it finds
5. **Returns config for orchestrator**

No language model involved!

## Supported Keywords

### Events

The planner looks for these keywords to identify events:

| Event | Keywords |
|-------|----------|
| page_view | "page view", "page load", "visit", "navigate" |
| click | "click", "tap", "interact", "engagement" |
| form_fill | "form", "fill", "submit", "signup", "register" |
| add_to_cart | "add to cart", "add cart", "shopping cart" |
| remove_from_cart | "remove", "delete", "cart" |
| purchase | "purchase", "buy", "checkout", "order", "transaction" |
| checkout_start | "checkout", "payment", "start checkout" |
| wishlist | "wishlist", "save for later", "favorite" |
| product_view | "product", "view", "details" |
| search | "search", "query", "find" |
| download | "download" |
| email_signup | "email", "signup", "subscribe" |

### Segments

The planner looks for these keywords to identify segments:

| Segment | Keywords |
|---------|----------|
| high_value | "high value", "premium", "loyal", "vip", "valuable", "big spender" |
| at_risk | "at risk", "churn", "inactive", "dormant", "abandoned" |
| new | "new", "recent", "acquisition", "first time" |
| returning | "return", "repeat", "loyal", "frequent" |
| engaged | "engaged", "active", "frequent visitor" |
| cart_abandoners | "abandon", "cart abandon", "incomplete" |

### Destinations

The planner looks for these keywords to identify activation destinations:

| Destination | Keywords |
|-------------|----------|
| email | "email", "mail" |
| facebook | "facebook", "fb" |
| google | "google" |
| web | "web", "website", "personalization", "homepage" |
| mobile | "mobile", "app" |

### Business Verticals

If your description mentions these, it will set the vertical:

| Vertical | Keywords |
|----------|----------|
| ecommerce | "ecommerce", "shop", "store", "retail", "product" |
| finance | "bank", "financial", "insurance", "investment" |
| healthcare | "health", "hospital", "doctor", "patient" |
| media | "media", "news", "content", "article", "video" |
| travel | "travel", "hotel", "flight", "booking" |
| saas | "software", "app", "platform" |

## Example Descriptions That Work

### ✅ Good - Has Clear Keywords

```
"Build an ecommerce AEP solution. Track product views, add to cart, 
and purchases. Create segments for high-value customers and at-risk users. 
Activate to email marketing."
```

**Why it works:**
- ✓ "ecommerce" → sets vertical
- ✓ "product views" → product_view event
- ✓ "add to cart" → add_to_cart event
- ✓ "purchases" → purchase event
- ✓ "high-value" → high_value segment
- ✓ "at-risk" → at_risk segment
- ✓ "email" → email destination

**Result**: Complete configuration extracted

---

### ✅ Good - Minimum Keywords

```
"Build AEP for an online store. We need to track purchases 
and email marketing activation."
```

**Why it works:**
- ✓ "online store" → ecommerce vertical
- ✓ "track purchases" → purchase event
- ✓ "email" → email destination

**Result**: Basic config with sensible defaults

---

### ❌ Bad - No Clear Keywords

```
"Build something with Adobe."
```

**Why it fails:**
- ✗ No vertical keywords (ecommerce, finance, etc.)
- ✗ No event keywords (purchase, click, etc.)
- ✗ No destination keywords (email, facebook, etc.)
- ✗ No segment keywords (high-value, at-risk, etc.)

**Result**: Falls back to generic defaults

---

## How to Write a Good Description

### Do:

1. **Mention your industry**
   ```
   "For an ecommerce company..."
   "Financial services platform..."
   "Healthcare provider..."
   ```

2. **List specific events you track**
   ```
   "Track product views, add to cart, and purchases"
   "Monitor form fills and email signups"
   "Record clicks and page views"
   ```

3. **Describe audience segments**
   ```
   "Identify high-value customers and at-risk users"
   "Find returning customers and new visitors"
   "Segment engaged users from cart abandoners"
   ```

4. **Specify where to activate**
   ```
   "Activate to email marketing"
   "Send to Facebook audiences"
   "Personalize on website"
   ```

### Don't:

1. **Use vague descriptions**
   ```
   ❌ "Build an AEP solution"
   ✅ "Build an AEP solution for ecommerce"
   ```

2. **Expect the planner to infer context**
   ```
   ❌ "We want to track customer behavior"
   ✅ "Track customer purchases, page views, and cart abandonment"
   ```

3. **Use industry jargon the planner doesn't know**
   ```
   ❌ "Implement CDP for funnel optimization"
   ✅ "Build CDP to track and segment customers for email marketing"
   ```

4. **Assume it understands complex logic**
   ```
   ❌ "Prioritize high LTV customers with low engagement"
   ✅ "Create segments for high-value customers and engaged users"
   ```

## Test Descriptions

### For Ecommerce

**Minimal:**
```
Build an AEP solution for an online store. Track purchases and email activation.
```

**Complete:**
```
Build an AEP solution for our ecommerce website. We need to track product views, 
add to cart, purchases, and cart abandonment. Create segments for high-value 
customers ($500+), repeat buyers, and cart abandoners. Activate to email and 
web personalization.
```

---

### For Finance

**Minimal:**
```
Build an AEP solution for a bank. Track account interactions and email marketing.
```

**Complete:**
```
Build an AEP solution for our financial services company. Track account views, 
loan applications, form fills, and purchases. Create segments for high-value 
customers and at-risk users. Activate to email campaigns.
```

---

### For Media

**Minimal:**
```
Build an AEP solution for our news site. Track article views and email signups.
```

**Complete:**
```
Build an AEP solution for our media company. Track article page views, video 
plays, clicks, and email signups. Create segments for engaged readers, repeat 
visitors, and new users. Activate to email and web personalization.
```

---

### For Healthcare

**Minimal:**
```
Build an AEP solution for a healthcare provider. Track patient forms and email.
```

**Complete:**
```
Build an AEP solution for our healthcare provider. Track patient forms, 
appointments, downloads, and clicks. Create segments for engaged patients and 
at-risk users. Activate to email marketing.
```

---

## Debugging Descriptions

### If You Get "Invalid Response"

1. **Check what was extracted**
   - Look at server logs for extraction details
   - See what keywords matched

2. **Add more keywords**
   - Make event types explicit: use "purchase" instead of "buying"
   - Make segments clear: use "high-value" instead of "important"
   - Use standard destination names: "email", "facebook", "web"

3. **Test with our examples**
   - Start with one of the test descriptions above
   - Gradually customize it
   - Add keywords one at a time

### If Keywords Aren't Recognized

The planner only recognizes the keywords listed above. If you use synonyms:

| What You Said | What Planner Sees | What to Use |
|---------------|-------------------|------------|
| "revenue tier" | Not recognized | "high-value" |
| "cart drop" | Not recognized | "cart abandonment" |
| "display ads" | Not recognized | "web" or "personalization" |
| "SMS" | Not recognized | "mobile" |

---

## Adding More Keywords

If you need to extend the planner with more keywords, edit `planner.py`:

```python
self.destination_keywords = {
    "email": ["email", "mail"],
    # Add more:
    "sms": ["sms", "text", "messaging"],  # Add this
    "web": ["web", "website", "personalization"],  # Add this
}
```

Then redeploy:
```bash
cd /projects/sandbox/mcp
sam build
sam deploy
```

---

## FAQ

**Q: Why no LLM?**
A: The planner uses simple regex patterns for speed and cost. If you need natural language understanding, you could extend it to use Claude, but it's not required for basic use cases.

**Q: Can I make it smarter?**
A: Yes! You can:
1. Add more keywords to the pattern dictionaries
2. Extend the extraction logic with more sophisticated rules
3. Integrate an LLM like Claude for complex descriptions
4. Use semantic search to find similar past configs

**Q: What if my industry isn't supported?**
A: The planner will use "general" vertical. You can:
1. Add your industry keywords to `VERTICAL_DEFAULTS`
2. Use a more generic description that matches existing keywords
3. Manually create the config and skip the planner

**Q: Does it work offline?**
A: Yes! No external API calls. Pure regex matching on the description you provide.

---

## Reference

For the complete planner implementation, see:
- `/projects/sandbox/mcp/mcp_server/tools/planner.py`

To extend it:
- Add keywords to pattern dictionaries
- Modify extraction methods
- Redeploy with `sam deploy`

The planner is intentionally simple for speed and reliability. For more complex NLP, consider adding Claude integration! 🚀

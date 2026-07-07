/**
 * Intent Extractor
 *
 * The MCP's `planner_parse_natural_language` is regex-based and collapses a
 * wide range of asks into a narrow, near-constant SolutionConfig — which is
 * the root reason "every ask produced the same tasks". We can't change the
 * MCP, so the harness re-reads the RAW natural-language description itself
 * and ENRICHES the config with signals the MCP planner misses.
 *
 * This is deterministic (same input -> same output) but genuinely
 * ask-sensitive: two different descriptions now yield different configs, so
 * the heuristic planner downstream produces different plans. (When an LLM
 * key is present, lib/llm-planner.ts goes further and synthesizes the plan
 * directly from the raw description — this enricher is the no-LLM floor.)
 *
 * It only ADDS signal; it never removes what the MCP planner found. All
 * additions are de-duplicated against existing config values.
 */

import { SolutionConfig, EventDefinition, SegmentDefinition } from './types';

export interface ExtractedIntent {
  /** High-level intent flags detected in the description. */
  flags: {
    loyalty: boolean;
    onboarding: boolean;
    reengagement: boolean;
    abandonment: boolean;
    acquisition: boolean;
    retention: boolean;
    b2b: boolean;
    realtime: boolean;
    subscription: boolean;
    personalization: boolean;
    reporting: boolean;
  };
  addedEvents: string[];
  addedSegments: string[];
  addedPlacements: string[];
  addedGoals: string[];
  addedDestinations: string[];
  notes: string[];
}

// keyword -> event name
const EVENT_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(purchase|checkout|order|transaction|buy|bought)\b/i, 'purchase'],
  [/\b(add to cart|added to cart|cart add|added an item)\b/i, 'add_to_cart'],
  [/\b(cart abandon|abandoned cart|abandonment)\b/i, 'cart_abandonment'],
  [/\b(sign ?up|register|registration|create an? account|onboard)\b/i, 'signup'],
  [/\b(log ?in|sign ?in|authenticat)/i, 'login'],
  [/\b(form|lead|contact us|request a demo|quote)\b/i, 'form_fill'],
  [/\b(product view|viewed a product|product page|browse|catalog)\b/i, 'product_view'],
  [/\b(search|searched|query)\b/i, 'search'],
  [/\b(subscribe|subscription|newsletter|opt.?in)\b/i, 'subscribe'],
  [/\b(video|watch|play|stream)\b/i, 'video_play'],
  [/\b(download|downloaded)\b/i, 'download'],
  [/\b(article|read|content view|blog)\b/i, 'content_view'],
  [/\b(wishlist|favorite|saved item)\b/i, 'add_to_wishlist'],
  [/\b(review|rating|rated)\b/i, 'review_submitted'],
  [/\b(page ?view|visit|landing)\b/i, 'page_view'],
];

// keyword -> { segment name, pql }
const SEGMENT_KEYWORDS: Array<[RegExp, { name: string; pql: string; description: string }]> = [
  [/\b(high[- ]?value|vip|premium|big spender|top customer)\b/i, { name: 'high_value_customers', pql: 'profile.purchaseHistory.totalValue > 1000', description: 'Customers with high lifetime value' }],
  [/\b(cart abandon|abandoned cart|abandonment)\b/i, { name: 'cart_abandoners', pql: "profile.cartHistory.lastAbandoned.timestamp > now() - 7 days", description: 'Users who abandoned a cart recently' }],
  [/\b(new|first[- ]?time|recently acquired|acquisition)\b/i, { name: 'new_customers', pql: 'profile.firstPurchaseDate > now() - 30 days', description: 'Recently acquired customers' }],
  [/\b(loyal|repeat|returning|frequent)\b/i, { name: 'loyal_customers', pql: 'profile.purchaseHistory.totalPurchases > 3', description: 'Repeat / loyal customers' }],
  [/\b(at[- ]?risk|churn|laps|inactive|dormant|win.?back|re.?engage)\b/i, { name: 'at_risk_users', pql: 'lastEvent.timestamp < now() - 90 days', description: 'Users at risk of churning' }],
  [/\b(subscriber|subscription|member)\b/i, { name: 'subscribers', pql: "profile.subscriptionStatus = 'active'", description: 'Active subscribers' }],
  [/\b(cart|browse|window shop|considering)\b/i, { name: 'engaged_browsers', pql: 'profile.productViews > 3', description: 'Actively browsing users' }],
];

// keyword -> placement
const PLACEMENT_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(hero|banner|homepage)\b/i, 'hero_banner'],
  [/\b(recommend|suggested|you may also)/i, 'product_recommendation'],
  [/\b(checkout|cart)\b/i, 'checkout_offer'],
  [/\b(email|newsletter)\b/i, 'email_content'],
  [/\b(sidebar|widget)\b/i, 'sidebar_offer'],
  [/\b(popup|modal|overlay)\b/i, 'modal_offer'],
];

// keyword -> goal
const GOAL_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(conversion|convert|increase sales|drive revenue|more purchases)\b/i, 'increase_conversion'],
  [/\b(churn|retain|retention|keep customers)\b/i, 'reduce_churn'],
  [/\b(engagement|engage|interact)\b/i, 'increase_engagement'],
  [/\b(personaliz|tailor|customize|relevant)/i, 'personalize_experience'],
  [/\b(report|dashboard|analytics|measure|insight|kpi|metric)/i, 'improve_reporting'],
  [/\b(acqui|grow|new customers|top of funnel)/i, 'grow_acquisition'],
  [/\b(loyalty|reward|retain)\b/i, 'build_loyalty'],
];

// keyword -> destination
const DESTINATION_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(email|newsletter)\b/i, 'email'],
  [/\b(push|mobile app|app notification)\b/i, 'push'],
  [/\b(sms|text message)\b/i, 'sms'],
  [/\b(on[- ]?site|website|web personaliz|in[- ]?page)\b/i, 'web'],
  [/\b(crm|salesforce|sales team)\b/i, 'crm'],
  [/\b(facebook|meta|instagram|google ads|paid media|advertis)\b/i, 'paid_media'],
];

function matchAll<T>(text: string, table: Array<[RegExp, T]>): T[] {
  const out: T[] = [];
  for (const [re, val] of table) {
    if (re.test(text)) out.push(val);
  }
  return out;
}

function detectFlags(text: string): ExtractedIntent['flags'] {
  return {
    loyalty: /\b(loyal|loyalty|reward|repeat|retention|retain)\b/i.test(text),
    onboarding: /\b(onboard|welcome|new user|getting started|first[- ]?time)\b/i.test(text),
    reengagement: /\b(re.?engage|win.?back|laps|dormant|inactive|churn)/i.test(text),
    abandonment: /\b(abandon|left items)/i.test(text),
    acquisition: /\b(acqui|grow|new customers|top of funnel|lead gen)/i.test(text),
    retention: /\b(retention|retain|keep customers|reduce churn)/i.test(text),
    b2b: /\b(b2b|business customer|enterprise|account[- ]?based|abm)\b/i.test(text),
    realtime: /\b(real[- ]?time|instant|immediate|live)\b/i.test(text),
    subscription: /\b(subscri|membership|recurring|renewal)/i.test(text),
    personalization: /\b(personaliz|tailor|customize|relevant|recommend)/i.test(text),
    reporting: /\b(report|dashboard|analytics|measure|insight|kpi|metric)/i.test(text),
  };
}

/**
 * Read the raw description and return the structured intent it implies,
 * de-duplicated against what the config already contains.
 */
export function extractIntent(config: SolutionConfig, description: string): ExtractedIntent {
  const text = description || '';

  const existingEvents = new Set((config.events || []).map((e) => (typeof e === 'string' ? e : e?.name)));
  const existingSegments = new Set((config.segments || []).map((s) => s?.name));
  const existingPlacements = new Set(config.personalization_placements || []);
  const existingGoals = new Set(config.goals || []);
  const existingDestinations = new Set(config.destinations || []);

  const addedEvents = [...new Set(matchAll(text, EVENT_KEYWORDS))].filter((e) => !existingEvents.has(e));
  const segMatches = matchAll(text, SEGMENT_KEYWORDS);
  const addedSegments = [...new Map(segMatches.map((s) => [s.name, s])).values()]
    .filter((s) => !existingSegments.has(s.name))
    .map((s) => s.name);
  const addedPlacements = [...new Set(matchAll(text, PLACEMENT_KEYWORDS))].filter((p) => !existingPlacements.has(p));
  const addedGoals = [...new Set(matchAll(text, GOAL_KEYWORDS))].filter((g) => !existingGoals.has(g));
  const addedDestinations = [...new Set(matchAll(text, DESTINATION_KEYWORDS))].filter((d) => !existingDestinations.has(d));

  const flags = detectFlags(text);
  const notes: string[] = [];
  for (const [k, v] of Object.entries(flags)) {
    if (v) notes.push(k);
  }

  return { flags, addedEvents, addedSegments, addedPlacements, addedGoals, addedDestinations, notes };
}

/**
 * Produce a NEW SolutionConfig enriched with intent extracted from the raw
 * description. Non-mutating; only adds (never drops) config values.
 */
export function enrichConfigFromDescription(
  config: SolutionConfig,
  description: string
): { config: SolutionConfig; intent: ExtractedIntent } {
  const intent = extractIntent(config, description);

  const newEvents: EventDefinition[] = intent.addedEvents.map((name) => ({
    name,
    description: `${name} (inferred from the request)`,
    page_types: ['all'],
    frequency: 'occasional',
    required_attributes: [],
    optional_attributes: [],
  }));

  const segLookup = new Map(SEGMENT_KEYWORDS.map(([, s]) => [s.name, s]));
  const newSegments: SegmentDefinition[] = intent.addedSegments.map((name) => {
    const tmpl = segLookup.get(name);
    return {
      name,
      description: tmpl?.description || `${name} (inferred from the request)`,
      segment_type: 'behavioral',
      pql_expression: tmpl?.pql || `profile.custom.${name} = true`,
      destinations: [],
    };
  });

  const enriched: SolutionConfig = {
    ...config,
    events: [...(config.events || []), ...newEvents],
    segments: [...(config.segments || []), ...newSegments],
    personalization_placements: [...(config.personalization_placements || []), ...intent.addedPlacements],
    goals: [...(config.goals || []), ...intent.addedGoals],
    destinations: [...(config.destinations || []), ...intent.addedDestinations],
  };

  return { config: enriched, intent };
}

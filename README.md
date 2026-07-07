This is the web harness for an Adobe Experience Cloud MCP server (schemas,
segments, CJA, AJO, Reactor/Launch, AWS, Databricks, Snowflake, and a
solutions-architecture knowledge base — ~300 tools total).

`POST /api/build` runs a dynamic agent (`lib/llm/agent.ts`) rather than a
fixed pipeline: it semantically shortlists the handful of MCP tools relevant
to your request (`lib/llm/tool-retrieval.ts`), then lets an LLM call them in
a loop until the task is done. The model is swappable per request across
Anthropic, Bedrock, or OpenAI (`lib/llm/model-registry.ts`) — pick cheap vs.
expensive, or switch providers, without code changes. The full end-to-end,
9-phase martech build tool (`msb_execute_solution`) is only offered to the
agent when a request explicitly opts into it (`allowFullBuild`), since it
has real side effects across GitHub/Netlify/Adobe/AWS.

See `ENVIRONMENT_VARIABLES.md` for the required `MCP_ENDPOINT_URL` and the
LLM provider variables that control which models are available.

This project was bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

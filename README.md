This is the web harness for an Adobe Experience Cloud MCP server (schemas,
segments, CJA, Reactor/Launch, and a solutions-architecture knowledge base
that also covers AJO — though there are no dedicated AJO journey/offer
tools yet). The catalog is filtered to Adobe-scoped tools by default
(`ADOBE_TOOLS_ONLY`, see below) — AWS/Databricks/Snowflake support is
defined in the harness's tool-catalog filtering code but isn't currently
present in the connected MCP server's tool list.

`POST /api/build` runs a dynamic agent (`lib/llm/agent.ts`) rather than a
fixed pipeline: it semantically shortlists the handful of MCP tools relevant
to your request (`lib/llm/tool-retrieval.ts`), then lets an LLM call them in
a loop until the task is done. The model is swappable per request across
Anthropic, Bedrock, or OpenAI (`lib/llm/model-registry.ts`) — pick cheap vs.
expensive, or switch providers, without code changes. There is no full,
end-to-end build tool wired up — every request resolves through specific,
narrow tool calls chosen by the agent.

See `ENVIRONMENT_VARIABLES.md` for the required `MCP_ENDPOINT_URL` and the
LLM provider variables that control which models are available. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for a diagram of how the harness,
the MCP server, and the platforms behind it fit together.

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

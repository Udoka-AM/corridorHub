/**
 * The Ramp API as an MCP server, so an agent can hold a Corridor payout as a
 * tool rather than an HTTP call.
 *
 * The tools are the SDK's own `agentTools`: one source of schemas for MCP and
 * for any other agent runtime, so a tool cannot drift between them. The
 * low-level MCP server is used on purpose — `agentTools` already carries JSON
 * Schema, which goes straight onto the wire with nothing to convert.
 *
 * Spending limits are not enforced here. They belong to the key the server
 * checks, so an agent holding these tools can only ever do what its key
 * allows, whatever it asks for.
 *
 *   RAMP_API_KEY=rk_live_agent_… RAMP_API_URL=https://… pnpm ramp:mcp
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ramp, agentTools } from "@corridor/ramp-sdk";

const apiKey = process.env.RAMP_API_KEY;
if (!apiKey) throw new Error("set RAMP_API_KEY to an agent key (rk_live_agent_… or rk_test_agent_…)");

const ramp = new Ramp({ apiKey, baseUrl: process.env.RAMP_API_URL });
const tools = agentTools(ramp);
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: "corridor-ramp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: "text" as const, text: `no tool ${request.params.name}` }] };
  }
  const result = await tool.handler((request.params.arguments ?? {}) as never);
  // A refusal is a result, not a crash: the agent is told which limit it hit
  // and what is still allowed, so it can retry within it.
  return {
    isError: !result.ok,
    content: [{ type: "text" as const, text: JSON.stringify(result.ok ? result.result : result.error, null, 2) }],
  };
});

await server.connect(new StdioServerTransport());

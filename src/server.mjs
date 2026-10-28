#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GoToClient } from './client.mjs';
import { GoToError, isMain } from './store.mjs';
import { getCallDay } from './calls.mjs';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function buildServer(client = new GoToClient()) {
  const server = new McpServer({ name: 'goto-call-review-mcp', version: '0.1.0' });
  const handle = operation => async args => {
    try { return result(await operation(args)); }
    catch (error) { return { ...result({ status: 'unavailable', error: error instanceof GoToError ? error.publicResult() : { code: 'LOCAL_ERROR', message: 'The GoTo read could not complete; data remains unknown.' } }), isError: true }; }
  };
  server.registerTool('goto_auth_status', {
    description: 'Read local GoTo authorization status and principal without exposing tokens or client credentials. Does not open a browser or change permissions.', inputSchema: {}, annotations,
  }, handle(() => client.authStatus()));
  server.registerTool('goto_get_identity', {
    description: 'Read the authenticated GoTo principal, accessible account keys and own assigned lines. User/account/line attribution is not proof of who performed every action.', inputSchema: {}, annotations,
  }, handle(() => client.identity()));
  server.registerTool('goto_get_call_day', {
    description: 'Read one local workday of GoTo call history, following every page up to a declared limit. Errors/partial results stay unknown, never zero. Defaults to the authenticated user. An explicit user_key requests another user only if GoTo permits it; no administrator authorization is performed. No recordings, transcription, calls, messages, external record writes or email sending.',
    inputSchema: {
      work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Local work date YYYY-MM-DD; both UTC boundaries are calculated with daylight saving time.'),
      timezone: z.string().default('America/Los_Angeles'),
      account_key: z.string().min(1).optional().describe('Verified GoTo account key; optional only when identity discovery returns exactly one account.'),
      user_key: z.string().min(1).optional().describe('Explicit target employee GoTo user key, not a Clio ID. Omit for own records. Cross-user live testing is deferred.'),
      extension: z.string().min(1).optional().describe('Optional verified extension filter, not a substitute for employee identity.'),
      page_size: z.number().int().min(1).max(200).default(100),
      max_pages: z.number().int().min(1).max(100).default(20),
    }, annotations,
  }, handle(args => getCallDay(client, args)));
  return server;
}
if (isMain(import.meta.url)) {
  await buildServer().connect(new StdioServerTransport());
}

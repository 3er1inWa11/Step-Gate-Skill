/**
 * Interactive MCP client — single-shot command sender
 * Usage: node scripts/mcp-call.mjs <method> [json-args]
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const DIST = resolve(import.meta.dirname, '..', 'dist', 'index.js');
const method = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const proc = spawn('node', [DIST], { stdio: ['pipe', 'pipe', 'pipe'] });
const buf = [];
let id = 0;

proc.stdout.on('data', (d) => buf.push(d.toString()));

// Step 1: initialize
id++;
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'cli', version: '1.0.0' }, capabilities: {} } }) + '\n');

// Step 2: initialized notification
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// Step 3: tools/list to confirm
id++;
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }) + '\n');

// Step 4: the actual tool call
id++;
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: method, arguments: args } }) + '\n');

proc.stdin.end();

// Wait for all output
setTimeout(() => {
  const all = buf.join('');
  const lines = all.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === id) {
        if (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) {
          const parsed = JSON.parse(msg.result.content[0].text);
          console.log(JSON.stringify(parsed, null, 2));
        } else if (msg.error) {
          console.log(JSON.stringify({ error: msg.error }, null, 2));
        } else {
          console.log(JSON.stringify(msg.result, null, 2));
        }
      }
    } catch {}
  }
  proc.kill();
  process.exit(0);
}, 2000);

// Step Gate — SubagentStop Hook
// Reminds Main Agent to call finalize after Sub Agent returns.
// The Sub Agent should have provided taskId + taskKey per Weaver protocol.

console.log('');
console.log('═══════════════════════════════════════════');
console.log('🔒 Step Gate: Sub Agent finished');
console.log('═══════════════════════════════════════════');
console.log('');
console.log('  If the Sub Agent returned a taskKey:');
console.log('  step-gate finalize \'{"taskId":"<taskId>","taskKey":"<taskKey>"}\'');
console.log('');
console.log('  The finalize response level tells you what happened:');
console.log('    "task"    → more tasks in this node');
console.log('    "node"    → node complete, next node unlocked');
console.log('    "program" → all done');
console.log('');
console.log('═══════════════════════════════════════════');
console.log('');
process.exit(0);

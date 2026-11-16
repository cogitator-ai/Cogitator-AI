process.stderr.write(String(process.pid));
process.stdin.resume();
setTimeout(() => process.exit(), 120_000);

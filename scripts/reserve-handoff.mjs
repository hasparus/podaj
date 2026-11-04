#!/usr/bin/env node
/** Reserve a compose URL for an agent/human fill-then-share flow. */
const base = process.argv[2] ?? process.env.PODAJ_URL ?? "http://127.0.0.1:8787";
const url = new URL("/api/handoffs/reserve", base);
const response = await fetch(url, { method: "POST" });
if (!response.ok) {
  console.error(`reserve failed (${response.status})`);
  process.exit(1);
}
const body = await response.json();
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);

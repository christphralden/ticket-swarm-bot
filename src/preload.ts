import fs from "fs";
import path from "path";
import readline from "readline";
import { chromium } from "playwright";
import { SESSION_DIR, STEALTH_SCRIPT } from "../constants";
import type { Config } from "./types";

async function main() {
  const config: Config = JSON.parse(fs.readFileSync("config.json", "utf-8"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  console.log("=== Preload: manual login session saver ===");
  console.log(`Found ${config.credentials.length} credential(s) in config.json`);
  console.log("A browser will open for each credential. Log in, then press Enter here to save the session.\n");

  for (let i = 0; i < config.credentials.length; i++) {
    const cred = config.credentials[i];
    const sessionPath = path.resolve(SESSION_DIR, `worker-${i}`);
    fs.mkdirSync(sessionPath, { recursive: true });

    console.log(`\n[${i}] Opening browser for: ${cred.email}`);

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: config.userAgents?.[0],
      locale: config.locale,
      timezoneId: config.timezoneId,
      ...(cred.proxy ? { proxy: { server: cred.proxy } } : {}),
    });

    await context.addInitScript(STEALTH_SCRIPT);
    const page = await context.newPage();
    await page.goto(config.targetUrl, { waitUntil: "domcontentloaded" });

    await ask(`[${i}] Log in as ${cred.email}, then press Enter to save session...`);

    await context.storageState({ path: path.join(sessionPath, "state.json") });
    console.log(`[${i}] Session saved to ${sessionPath}/state.json`);

    await browser.close();
  }

  rl.close();
  console.log("\nAll sessions saved. Run npm start when ready.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

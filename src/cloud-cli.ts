import { scaffoldCloudAgent } from "./cloud-scaffold.js";

export function handleCloud(flags, positionals, io) {
  const action = String(positionals[0] || "help");
  switch (action) {
    case "scaffold": {
      const result = scaffoldCloudAgent({
        outDir: flags.out,
        force: Boolean(flags.force),
        flue: Boolean(flags.flue),
      });
      io.stdout.write(`Created Flue cloud-agent scaffold at ${result.root}\n`);
      for (const file of result.files) {
        io.stdout.write(`  ${file}\n`);
      }
      io.stdout.write("Next: wire the generated env placeholders in Flue and point the sandbox hands service at a private authenticated endpoint.\n");
      return 0;
    }
    case "help":
      io.stdout.write(cloudHelpText());
      return 0;
    default:
      throw new Error(`Unknown cloud command "${action}". Use relaymux cloud help.`);
  }
}

export function cloudHelpText() {
  return `relaymux cloud - advanced cloud-agent scaffolding

relaymux cloud is optional. Local relaymux remains the default path: Telegram or
iMessage can still talk directly to the local background daemon and tmux tabs.

Usage:
  relaymux cloud scaffold --flue --out <dir> [--force]
  relaymux cloud help

Options:
  --flue        Generate the Flue cloud-agent scaffold
  --out <dir>   Output directory for the generated bundle
  --force       Overwrite generated files in an existing directory

The scaffold uses env var placeholders for all secrets:
  TELEGRAM_BOT_TOKEN
  RELAYMUX_TELEGRAM_WEBHOOK_SECRET
  RELAYMUX_SANDBOX_BASE_URL
  RELAYMUX_SANDBOX_TOKEN
  RELAYMUX_CLOUD_CALLBACK_TOKEN
`;
}

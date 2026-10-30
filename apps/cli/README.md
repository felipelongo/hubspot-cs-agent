# CLI

Commands to set up, seed, run a sweep, and run on a schedule or a HubSpot webhook.

**Why it exists.** Anyone can run the demo from one command, and a cron job can run the same command.

**One sentence.** "Commands to set up, seed, run a sweep, and run on a schedule or a HubSpot webhook."

**Public interface.** `pnpm cs setup|seed|seed:reset|sweep|approve|eval|backtest|serve|doctor`. `pnpm demo:mock` runs the renewal sweep twice against `MockHubSpot` with no API keys.

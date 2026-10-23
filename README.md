# io-tech-deals

Monitor and search the Finnish deal forum [io-tech.fi Hyvät tarjoukset](https://bbs.io-tech.fi/forums/hyvat-tarjoukset.100/) from the command line or as an agent skill.

## Install

Requires Node.js 18+ (CI covers 18, 20 and 22).

```bash
git clone https://github.com/junousia/io-tech-deals.git
cd io-tech-deals
npm ci
node scripts/check-deals.js check
```

The compiled JavaScript is committed under `scripts/`; `npm run build` regenerates it from `src/`.
Runtime state (SQLite database, `state.json`) is created in the project directory and is git-ignored.
See `SKILL.md` for all commands and `references/config.json` for configuration.

## Use as an agent skill

`SKILL.md` makes this repo usable as a skill in [Hermes Agent](https://hermes-agent.nousresearch.com) and OpenClaw.
Clone it into the agent's skills directory (Hermes: `~/.hermes/skills/<category>/io-tech-deals`,
OpenClaw: `<workspace>/skills/io-tech-deals`) and run `npm ci` there. Run commands from the skill directory.

## License

MIT, see [LICENSE](LICENSE).

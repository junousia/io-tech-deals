---
name: io-tech-deals
description: Monitor and search Finnish deal community (io-tech.fi Hyvät tarjoukset). Use when user wants deal alerts, price tracking, product discounts, or searching deal history from io-tech forum.
---

# io-tech-deals

Monitor and search deals from io-tech.fi forum.

## Quick Start

```bash
# run from this skill's directory
npm ci            # first time only (needs Node.js; builds sqlite3)
node scripts/check-deals.js check
```

## Commands

| Command | Description |
|---------|-------------|
| `check` | Fetch RSS, notify on new deals |
| `history [n]` | Show recent deals (default: 10) |
| `search <query>` | Search deals by title |
| `stats` | Show statistics |
| `scrape <n>` | Populate history from forum pages |
| `clear` | Clear all history |

## Examples

```bash
# Check for new deals
node scripts/check-deals.js check

# View 20 most recent deals
node scripts/check-deals.js history 20

# Search for Samsung deals
node scripts/check-deals.js search Samsung

# Show stats
node scripts/check-deals.js stats

# Scrape 50 pages of history
node scripts/check-deals.js scrape 50
```

## Database

SQLite database stores:
- Deal ID, title, link
- `pubDate` - when deal was posted
- `foundAt` - when deal was discovered

Query directly:
```bash
sqlite3 .io-tech-deals-state.db "SELECT * FROM deals WHERE title LIKE '%Samsung%'"
```

## Configuration

Edit `references/config.json` to add feeds:

```json
{
  "feeds": [
    "https://bbs.io-tech.fi/forums/hyvat-tarjoukset.100/index.rss"
  ],
  "stateFile": ".io-tech-deals-state.db",
  "notifyOnNew": true
}
```

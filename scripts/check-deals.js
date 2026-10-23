#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const sqlite3_1 = __importDefault(require("sqlite3"));
const rss_parser_1 = __importDefault(require("rss-parser"));
const parser = new rss_parser_1.default({
    customFields: {
        item: ['content:encoded', 'author', 'category']
    }
});
// CLI args
const args = process.argv.slice(2);
const command = args.filter(arg => !arg.startsWith('--'))[0] || 'check';
const isJson = args.includes('--json');
// Advanced Filters (AI-ready)
const storeFilter = args.find(a => a.startsWith('--store='))?.split('=')[1];
const maxPrice = parseFloat(args.find(a => a.startsWith('--max-price='))?.split('=')[1] || 'Infinity');
const minDiscount = parseFloat(args.find(a => a.startsWith('--min-discount='))?.split('=')[1] || '0');
// Paths
const configPath = (0, path_1.join)(__dirname, '..', 'references', 'config.json');
// Helper to clean HTML & RSS fluff
function cleanText(text) {
    if (!text)
        return '';
    // Strip HTML tags
    let cleaned = text.replace(/<[^>]*>?/gm, '');
    // Strip "Read more" links and similar RSS fluff
    cleaned = cleaned.replace(/Read more\s*$/i, '');
    // Unescape common HTML entities
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&nbsp;': ' ',
        '&euro;': '€',
        '&copy;': '©',
        '&reg;': '®'
    };
    return cleaned.replace(/&[a-z0-9#]+;/gi, (match) => entities[match] || match).trim();
}
// Filter logic helper for AI queries
function applyFilters(deals) {
    return deals.filter(d => {
        if (storeFilter && (!d.store || !d.store.toLowerCase().includes(storeFilter.toLowerCase())))
            return false;
        if (maxPrice !== Infinity && (d.price === undefined || d.price > maxPrice))
            return false;
        if (minDiscount > 0 && (d.discountPercent === undefined || d.discountPercent < minDiscount))
            return false;
        return true;
    });
}
// Load config
function loadConfig() {
    const defaults = {
        feeds: ["https://bbs.io-tech.fi/forums/hyvat-tarjoukset.100/index.rss"],
        stateFile: ".io-tech-deals-state.db",
        notifyOnNew: true,
        watchlist: [],
        webhooks: [],
        retentionDays: 730
    };
    try {
        const config = JSON.parse((0, fs_1.readFileSync)(configPath, 'utf-8'));
        return { ...defaults, ...config };
    }
    catch (e) {
        return defaults;
    }
}
// Save config
function saveConfig(config) {
    (0, fs_1.writeFileSync)(configPath, JSON.stringify(config, null, 2));
}
// Database setup
function getDb(dbPath) {
    const db = new sqlite3_1.default.Database(dbPath);
    db.serialize(() => {
        db.exec(`
      CREATE TABLE IF NOT EXISTS deals (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT UNIQUE,
        title TEXT,
        description TEXT,
        link TEXT,
        pubDate TEXT,
        author TEXT,
        categories TEXT,
        feedUrl TEXT,
        foundAt TEXT NOT NULL,
        product TEXT,
        store TEXT,
        price REAL,
        originalPrice REAL,
        discountPercent REAL,
        expiry TEXT,
        directLink TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_deals_external_id ON deals(external_id);
      CREATE INDEX IF NOT EXISTS idx_deals_feedUrl ON deals(feedUrl);
      CREATE INDEX IF NOT EXISTS idx_deals_foundAt ON deals(foundAt);
      CREATE INDEX IF NOT EXISTS idx_deals_title ON deals(title);
      
      CREATE VIRTUAL TABLE IF NOT EXISTS deals_fts USING fts5(title, product, store, description, content='deals', content_rowid='rowid');
    `);
    });
    return db;
}
// Fetch RSS via fetch API
async function fetchRss(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response.text();
}
// Extract price and store from title and description
function extractMetadata(title, description) {
    const meta = {};
    // Helper to parse price from string
    const parsePrice = (s) => {
        const match = s.match(/(\d+[.,]\d+|\d+)/);
        return match ? parseFloat(match[1].replace(',', '.')) : undefined;
    };
    // 1. Parse from Description (Template)
    const lines = description.split('\n');
    for (const line of lines) {
        if (line.match(/^Tuote:/i))
            meta.product = line.split(':')[1]?.trim();
        if (line.match(/^Kauppa:/i))
            meta.store = line.split(':')[1]?.trim();
        if (line.match(/^Tarjoushinta:/i))
            meta.price = parsePrice(line.split(':')[1]);
        if (line.match(/^Normaalihinta:/i))
            meta.originalPrice = parsePrice(line.split(':')[1]);
        if (line.match(/^Voimassa:/i))
            meta.expiry = line.split(':')[1]?.trim();
        if (line.match(/^Linkki:/i)) {
            const parts = line.split('Linkki:');
            if (parts[1])
                meta.directLink = parts[1].trim();
        }
    }
    // 2. Fallback/Complement from Title
    if (!meta.store) {
        const storeMatch = title.match(/^\[(.*?)\]/);
        if (storeMatch)
            meta.store = storeMatch[1].trim();
        const atStoreMatch = title.match(/@\s*([^@]*?)$/);
        if (atStoreMatch)
            meta.store = atStoreMatch[1].trim();
    }
    if (!meta.price) {
        const priceRegex = /(\d+[.,]\d+|\d+)\s*(?:€|e|eur|EUR)/gi;
        const prices = Array.from(title.matchAll(priceRegex));
        if (prices.length > 0) {
            meta.price = parseFloat(prices[0][1].replace(',', '.'));
            if (!meta.originalPrice && prices.length > 1) {
                const p2 = parseFloat(prices[1][1].replace(',', '.'));
                if (p2 > (meta.price || 0))
                    meta.originalPrice = p2;
            }
        }
    }
    // Calculate discount
    if (meta.price && meta.originalPrice) {
        meta.discountPercent = Math.round((1 - (meta.price / meta.originalPrice)) * 100);
    }
    return meta;
}
// Parse XML to extract deals
async function parseDeals(xml, feedUrl) {
    const foundAt = new Date().toISOString();
    const feed = await parser.parseString(xml);
    return feed.items.map(item => {
        const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : '';
        const categories = Array.isArray(item.category) ? item.category.join(', ') : (item.category || '');
        const rawContent = item['content:encoded'] || item.content || item.contentSnippet || '';
        const description = cleanText(rawContent);
        const title = cleanText(item.title || 'Untitled');
        const metadata = extractMetadata(title, description);
        return {
            id: item.guid || item.link || '',
            title,
            description,
            link: item.link || '',
            pubDate,
            author: item.creator || item.author || '',
            categories,
            feedUrl,
            foundAt,
            ...metadata
        };
    }).filter(d => d.id);
}
// Send to webhooks
async function sendWebhooks(deal, webhooks) {
    for (const url of webhooks) {
        try {
            const isDiscord = url.includes('discord.com/api/webhooks');
            const payload = isDiscord ? {
                embeds: [{
                        title: deal.title,
                        url: deal.link,
                        description: deal.price ? `💰 Price: ${deal.price}€ ${deal.originalPrice ? `(Norm. ${deal.originalPrice}€, -${deal.discountPercent}%)` : ''}` : 'New deal found!',
                        color: 0x00ff00,
                        footer: { text: `Source: ${deal.store || 'io-tech'}` },
                        timestamp: deal.pubDate
                    }]
            } : {
                text: `📦 *${deal.title}*\n🔗 ${deal.link}\n💰 Price: ${deal.price || 'N/A'}€`
            };
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
        catch (e) {
            console.error(`Failed to send webhook to ${url}:`, e);
        }
    }
}
// Command: check (fetch new deals)
async function cmdCheck() {
    const config = loadConfig();
    const dbPath = (0, path_1.join)(__dirname, '..', config.stateFile);
    const db = getDb(dbPath);
    if (!isJson)
        console.log(`🔍 Checking ${config.feeds.length} feed(s)...\n`);
    const allNewDeals = [];
    for (const feedUrl of config.feeds) {
        const feedName = feedUrl.split('/').pop() || feedUrl;
        try {
            const xml = await fetchRss(feedUrl);
            const deals = await parseDeals(xml, feedUrl);
            const newDeals = [];
            for (const deal of deals) {
                const exists = await new Promise((resolve) => {
                    db.get('SELECT 1 FROM deals WHERE external_id = ?', [deal.id], (err, row) => resolve(!!row));
                });
                if (!exists) {
                    await new Promise((resolve, reject) => {
                        db.run('INSERT INTO deals (external_id, title, description, link, pubDate, author, categories, feedUrl, foundAt, product, store, price, originalPrice, discountPercent, expiry, directLink) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [deal.id, deal.title, deal.description, deal.link, deal.pubDate, deal.author, deal.categories, deal.feedUrl, deal.foundAt, deal.product, deal.store, deal.price, deal.originalPrice, deal.discountPercent, deal.expiry, deal.directLink], function (err) {
                            if (err)
                                return reject(err);
                            const lastId = this.lastID;
                            db.run('INSERT INTO deals_fts(rowid, title, product, store, description) VALUES (?, ?, ?, ?, ?)', [lastId, deal.title, deal.product, deal.store, deal.description], (err2) => {
                                if (err2)
                                    return reject(err2);
                                resolve();
                            });
                        });
                    });
                    newDeals.push(deal);
                }
            }
            if (newDeals.length > 0) {
                if (!isJson) {
                    console.log(`📦 ${feedName}: ${newDeals.length} new deal(s)`);
                    for (const deal of newDeals) {
                        const watchMatch = config.watchlist.some(w => deal.title.toLowerCase().includes(w.toLowerCase()));
                        const prefix = watchMatch ? '⭐ [WATCHLIST] ' : '  • ';
                        console.log(`${prefix}${deal.title}`);
                        console.log(`    ${deal.link}\n`);
                        if (config.webhooks.length > 0) {
                            await sendWebhooks(deal, config.webhooks);
                        }
                    }
                }
                allNewDeals.push(...newDeals);
            }
            else if (!isJson) {
                console.log(`✓ ${feedName}: No new deals`);
            }
        }
        catch (error) {
            if (!isJson)
                console.error(`❌ Error fetching ${feedUrl}:`, error);
            else
                throw error;
        }
    }
    if (config.retentionDays > 0) {
        db.run('DELETE FROM deals WHERE foundAt < date("now", ?)', [`-${config.retentionDays} days`]);
        db.run('DELETE FROM deals_fts WHERE rowid NOT IN (SELECT rowid FROM deals)');
    }
    db.close();
    const filteredDeals = applyFilters(allNewDeals);
    if (isJson) {
        console.log(JSON.stringify(filteredDeals, null, 2));
    }
    else if (filteredDeals.length > 0) {
        console.log(`\n✨ Total: ${filteredDeals.length} filtered new deal(s) found`);
    }
    else {
        console.log(`\n💤 No new deals matching filters`);
    }
}
// Command: history [limit]
async function cmdHistory(limit = 10) {
    const config = loadConfig();
    const dbPath = (0, path_1.join)(__dirname, '..', config.stateFile);
    const db = getDb(dbPath);
    if (!isJson)
        console.log(`📜 Recent ${limit} deals:\n`);
    db.all('SELECT *, external_id as id FROM deals ORDER BY pubDate DESC, foundAt DESC LIMIT ?', [limit], (err, rows) => {
        if (err) {
            if (!isJson)
                console.error('Error:', err);
            else
                console.log(JSON.stringify({ error: err.message }, null, 2));
            db.close();
            return;
        }
        const allDeals = rows;
        const deals = applyFilters(allDeals);
        if (isJson) {
            console.log(JSON.stringify(deals, null, 2));
        }
        else {
            for (const deal of deals) {
                const date = deal.pubDate ? new Date(deal.pubDate).toLocaleDateString('fi-FI') : '?';
                const priceStr = deal.price ? ` [${deal.price}€]` : '';
                const storeStr = deal.store ? ` @ ${deal.store}` : '';
                console.log(`[${date}]${priceStr}${storeStr} ${deal.title}`);
                console.log(`  ${deal.link}\n`);
            }
            console.log(`Total: ${deals.length} deals`);
        }
        db.close();
    });
}
// Command: search <query>
async function cmdSearch(query) {
    const config = loadConfig();
    const dbPath = (0, path_1.join)(__dirname, '..', config.stateFile);
    const db = getDb(dbPath);
    if (!isJson)
        console.log(`🔍 Searching for "${query}":\n`);
    const ftsQuery = `SELECT deals.*, external_id as id FROM deals JOIN deals_fts ON deals.rowid = deals_fts.rowid WHERE deals_fts MATCH ? ORDER BY rank LIMIT 20`;
    const likeQuery = `SELECT *, external_id as id FROM deals WHERE title LIKE ? OR product LIKE ? OR store LIKE ? OR description LIKE ? ORDER BY pubDate DESC LIMIT 20`;
    const searchTerm = query && (query.includes('*') || query.includes(' ')) ? query : (query ? `${query}*` : '');
    if (searchTerm) {
        db.all(ftsQuery, [searchTerm], (err, rows) => {
            if (err || (rows && rows.length === 0)) {
                const lk = `%${query}%`;
                db.all(likeQuery, [lk, lk, lk, lk], (err2, rows2) => {
                    handleRows(err2, rows2 || []);
                });
            }
            else {
                handleRows(err, rows || []);
            }
        });
    }
    else {
        db.all('SELECT *, external_id as id FROM deals ORDER BY pubDate DESC LIMIT 20', (err, rows) => {
            handleRows(err, rows || []);
        });
    }
    function handleRows(err, rows) {
        if (err) {
            if (!isJson)
                console.error('Error:', err);
            else
                console.log(JSON.stringify({ error: err.message }, null, 2));
            db.close();
            return;
        }
        const allDeals = rows;
        const deals = applyFilters(allDeals);
        if (isJson) {
            console.log(JSON.stringify(deals, null, 2));
        }
        else if (deals.length === 0) {
            console.log('No matches found.');
        }
        else {
            for (const deal of deals) {
                const date = deal.pubDate ? new Date(deal.pubDate).toLocaleDateString('fi-FI') : '?';
                const priceStr = deal.price ? ` [${deal.price}€]` : '';
                const storeStr = deal.store ? ` @ ${deal.store}` : '';
                console.log(`[${date}]${priceStr}${storeStr} ${deal.title}`);
                console.log(`  ${deal.link}\n`);
            }
            console.log(`Found: ${deals.length} match(es)`);
        }
        db.close();
    }
}
// Command: watchlist <add|remove|list> <query>
async function cmdWatchlist() {
    const config = loadConfig();
    const sub = process.argv[3];
    const query = process.argv[4];
    if (sub === 'add' && query) {
        if (!config.watchlist.includes(query)) {
            config.watchlist.push(query);
            saveConfig(config);
            console.log(`✅ Added "${query}" to watchlist.`);
        }
        else {
            console.log(`ℹ️ "${query}" is already in watchlist.`);
        }
    }
    else if (sub === 'remove' && query) {
        config.watchlist = config.watchlist.filter(w => w !== query);
        saveConfig(config);
        console.log(`✅ Removed "${query}" from watchlist.`);
    }
    else {
        console.log('⭐ Current Watchlist:');
        config.watchlist.forEach(w => console.log(`  • ${w}`));
        if (config.watchlist.length === 0)
            console.log('  (Empty)');
    }
}
// Command: stats
async function cmdStats() {
    const config = loadConfig();
    const dbPath = (0, path_1.join)(__dirname, '..', config.stateFile);
    const db = getDb(dbPath);
    db.get('SELECT COUNT(*) as total FROM deals', [], (err, row) => {
        if (err) {
            if (!isJson)
                console.error(err);
            else
                console.log(JSON.stringify({ error: err.message }));
            db.close();
            return;
        }
        const stats = { total: row.total, byFeed: [], dateRange: {}, topStores: [] };
        db.all('SELECT feedUrl, COUNT(*) as count FROM deals GROUP BY feedUrl', [], (err, rows) => {
            if (err) {
                db.close();
                return;
            }
            for (const r of rows) {
                const name = r.feedUrl.split('/').pop() || r.feedUrl;
                stats.byFeed.push({ name, url: r.feedUrl, count: r.count });
            }
            db.all('SELECT store, COUNT(*) as count FROM deals WHERE store IS NOT NULL GROUP BY store ORDER BY count DESC LIMIT 5', [], (err, rows) => {
                if (err) {
                    db.close();
                    return;
                }
                stats.topStores = rows;
                db.get("SELECT MIN(pubDate) as oldest, MAX(pubDate) as newest FROM deals", [], (err, row) => {
                    if (err) {
                        db.close();
                        return;
                    }
                    stats.dateRange = { oldest: row.oldest, newest: row.newest };
                    if (isJson) {
                        console.log(JSON.stringify(stats, null, 2));
                    }
                    else {
                        console.log('📊 Statistics:\n');
                        console.log(`Total deals: ${stats.total}`);
                        console.log('\nTop Stores:');
                        for (const s of stats.topStores) {
                            console.log(`  ${s.store}: ${s.count}`);
                        }
                        console.log('\nBy feed:');
                        for (const feed of stats.byFeed) {
                            console.log(`  ${feed.name}: ${feed.count}`);
                        }
                        console.log('\nDate range (when posted):');
                        console.log(`  Oldest: ${stats.dateRange.oldest || 'N/A'}`);
                        console.log(`  Newest: ${stats.dateRange.newest || 'N/A'}`);
                    }
                    db.close();
                });
            });
        });
    });
}
// Command: clear
async function cmdClear() {
    const config = loadConfig();
    const dbPath = (0, path_1.join)(__dirname, '..', config.stateFile);
    const db = getDb(dbPath);
    db.run('DELETE FROM deals', (err) => {
        if (err) {
            console.error('Error clearing:', err);
        }
        else {
            db.run('DELETE FROM deals_fts', () => {
                console.log('✅ History cleared.');
            });
        }
        db.close();
    });
}
// Main router
async function main() {
    switch (command) {
        case 'check':
            await cmdCheck();
            break;
        case 'history':
            await cmdHistory(parseInt(process.argv[3]) || 10);
            break;
        case 'search':
            await cmdSearch(process.argv[3] || '');
            break;
        case 'watchlist':
            await cmdWatchlist();
            break;
        case 'stats':
            await cmdStats();
            break;
        case 'clear':
            await cmdClear();
            break;
        default:
            console.log(`
io-tech-deals - Advanced Deal Monitor for io-tech.fi

Usage: check-deals.sh <command> [options]

Options:
  --json             Output results as JSON
  --store=Name       Filter by store
  --max-price=Number Filter by max price
  --min-discount=P   Filter by min discount %

Commands:
  check              Fetch and check for new deals (default)
  history [limit]    Show recent deals (default: 10)
  search <query>     Search deals by title, product, store, desc
  watchlist <cmd>    Manage keyword watchlist (add|remove|list)
  stats              Show statistics including top stores
  clear              Clear all history

Examples:
  check-deals.sh check --json
  check-deals.sh watchlist add "RTX 50"
  check-deals.sh search "Samsung" --max-price=500
  check-deals.sh stats
`);
    }
}
main().catch(console.error);

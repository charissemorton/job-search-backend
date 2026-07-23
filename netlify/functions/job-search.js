// job-search.js — Netlify Function
// Backend for the MatchMentum × Lorikeet "Find a Role" feature.
//
// LIVE, per-request data via Lorikeet's public CX-Jobs MCP server
// (https://cx-jobs.lorikeet.tools/api/mcp — free, no sign-up, publicly
// promoted by Lorikeet's co-founder for exactly this kind of use). This
// function is not itself an MCP client — it calls the Claude API's MCP
// connector (Messages API, mcp_servers + mcp_toolset), which does the
// remote MCP round-trip on our behalf and returns the raw tool result.
//
// Every request now costs one live Claude API call plus a remote MCP
// round-trip to Lorikeet: real added latency (~1-3s) and per-request $,
// unlike a static file read. Deliberately NO static-snapshot fallback —
// this board turns over often, and showing stale/possibly-filled roles
// when the live call fails would be worse than an honest error. If the
// live call fails, this returns a 502 and the frontend's existing error
// states ("Couldn't load the job board right now" / "Search failed. Try
// again in a moment.") handle it.
//
// Requires env var: ANTHROPIC_API_KEY (same key claude-proxy.js uses).
//
// Contract (matches frontend lkCallBackend in index.html) — unchanged from
// the snapshot-only version, so no frontend changes are needed:
//   POST body: { action: 'stats' | 'featured' | 'search' | 'job', ...params }
//   'stats'    -> { stats: { totalJobs, totalCompanies } }
//   'featured' -> { jobs: [...] }
//   'search'   -> { jobs: [...] }   params: query, pillar, seniority, country, arrangement
//   'job'      -> { job: {...} | null }   params: slug (best-effort — Lorikeet's
//                 MCP server has no confirmed single-job-by-slug tool, so this
//                 searches by slug-derived keywords and matches the exact slug
//                 client-side; not guaranteed to find every job)

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MCP_BETA_HEADER = 'mcp-client-2025-11-20';
const MCP_SERVER_URL = 'https://cx-jobs.lorikeet.tools/api/mcp';
const MODEL = 'claude-haiku-4-5-20251001'; // cheap/fast — this is a deterministic single-tool lookup, not reasoning
const LIVE_CALL_TIMEOUT_MS = 9500; // fail fast rather than hang until Netlify's own function timeout

const ALLOWED_ORIGINS = new Set([
    'https://matchmentum.com',
    'https://www.matchmentum.com'
]);

function corsHeaders(originHeader) {
    const origin = ALLOWED_ORIGINS.has(originHeader) ? originHeader : 'https://matchmentum.com';
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };
}

// ---------------------------------------------------------------------
// Cleaning helpers — Lorikeet's raw job objects carry descriptionHtml and
// a free-text location, not the frontend's expected shape. Mirrors the
// logic used to build the offline snapshot (clean_batch.py) so live and
// fallback results look identical to the frontend.
// ---------------------------------------------------------------------

const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY'
]);

const COUNTRY_PATTERNS = [
    ['United Kingdom', /\b(United Kingdom|UK|England|Scotland|Wales|Northern Ireland)\b/i],
    ['Canada', /\bCanada\b/i],
    ['Spain', /\bSpain\b/i],
    ['Mexico', /\bMexico\b/i],
    ['Australia', /\bAustralia\b/i],
    ['France', /\bFrance\b/i],
    ['Germany', /\bGermany\b/i],
    ['India', /\bIndia\b/i],
    ['United States', /\b(United States|USA|U\.S\.)\b/i]
];

function deriveCountry(location) {
    const loc = location || '';
    for (const [country, pattern] of COUNTRY_PATTERNS) {
        if (pattern.test(loc)) return country;
    }
    const m = loc.match(/,\s*([A-Z]{2})\b/);
    if (m && US_STATES.has(m[1])) return 'United States';
    return 'Other';
}

function deriveArrangement(location) {
    const loc = location || '';
    if (/\bremote\b/i.test(loc)) return 'Remote';
    if (/\bhybrid\b/i.test(loc)) return 'Hybrid';
    return 'On-site';
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', 39: "'", nbsp: ' ' };

function decodeEntities(text) {
    return text.replace(/&(#(\d+)|[a-z]+);/gi, (match, entity, numeric) => {
        if (numeric) return String.fromCharCode(parseInt(numeric, 10));
        const key = entity.toLowerCase();
        return HTML_ENTITIES[key] !== undefined ? HTML_ENTITIES[key] : match;
    });
}

function htmlToText(rawHtml) {
    if (!rawHtml) return '';
    let text = rawHtml;
    text = text.replace(/<\/(p|h1|h2|h3|h4|li|div)>/gi, '\n\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = decodeEntities(text);
    const lines = text.split('\n').map(l => l.trim());
    const cleaned = [];
    let blankRun = 0;
    for (const ln of lines) {
        if (ln === '') {
            blankRun++;
            if (blankRun <= 1) cleaned.push('');
        } else {
            blankRun = 0;
            cleaned.push(ln);
        }
    }
    return cleaned.join('\n').trim();
}

function cleanJob(j) {
    const location = j.location || '';
    return {
        id: j.id,
        slug: j.slug,
        title: j.title,
        company: j.company,
        location,
        country: deriveCountry(location),
        arrangement: deriveArrangement(location),
        pillar: j.pillar,
        seniority: j.seniority,
        summary: j.summary || '',
        description: htmlToText(j.descriptionHtml || j.description || ''),
        applyUrl: j.applyUrl || '',
        boardUrl: j.boardUrl || '',
        logoUrl: j.logoUrl || ''
    };
}

// ---------------------------------------------------------------------
// Live MCP call via the Claude API's MCP connector
// ---------------------------------------------------------------------

async function callLorikeetTool(toolName, toolInput) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_CALL_TIMEOUT_MS);

    try {
        const res = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': ANTHROPIC_VERSION,
                'anthropic-beta': MCP_BETA_HEADER
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 4096,
                system: 'You are a backend relay with exactly one job: call the single tool you are given, with the exact parameters provided, immediately. Do not ask questions, do not add commentary, do not explain — just call it.',
                messages: [{
                    role: 'user',
                    content: `Call the tool "${toolName}" now with these exact parameters: ${JSON.stringify(toolInput)}`
                }],
                mcp_servers: [{
                    type: 'url',
                    url: MCP_SERVER_URL,
                    name: 'cx-jobs'
                }],
                tools: [{
                    type: 'mcp_toolset',
                    mcp_server_name: 'cx-jobs',
                    default_config: { enabled: false },
                    configs: { [toolName]: { enabled: true } }
                }]
            })
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
        }

        const data = await res.json();
        const resultBlock = (data.content || []).find(b => b.type === 'mcp_tool_result');
        if (!resultBlock) {
            throw new Error('No mcp_tool_result in response — model may not have called the tool');
        }
        if (resultBlock.is_error) {
            throw new Error('MCP tool call errored: ' + JSON.stringify(resultBlock.content));
        }
        const textBlock = (resultBlock.content || []).find(c => c.type === 'text');
        if (!textBlock) throw new Error('mcp_tool_result had no text content');
        return JSON.parse(textBlock.text);
    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------
// Live action handlers
// ---------------------------------------------------------------------

async function liveStats() {
    const raw = await callLorikeetTool('get_stats', {});
    return { stats: { totalJobs: raw.totalJobs, totalCompanies: raw.totalCompanies }, source: 'live' };
}

async function liveFeatured() {
    const raw = await callLorikeetTool('get_featured_jobs', {});
    return { jobs: (raw.jobs || []).map(cleanJob), source: 'live' };
}

async function liveSearch(params) {
    // Lorikeet's search_jobs only supports pillar/seniority/region/query/limit —
    // country and arrangement aren't native filters, so we over-fetch and filter
    // those two locally after cleaning, same as the snapshot does.
    const toolInput = { limit: 40 };
    if (params.pillar) toolInput.pillar = params.pillar;
    if (params.seniority) toolInput.seniority = params.seniority;
    if (params.query) toolInput.query = params.query;
    const raw = await callLorikeetTool('search_jobs', toolInput);
    const cleaned = (raw.jobs || []).map(cleanJob);
    const filtered = cleaned.filter(j => {
        if (params.country && j.country !== params.country) return false;
        if (params.arrangement && j.arrangement !== params.arrangement) return false;
        return true;
    });
    return { jobs: filtered, source: 'live' };
}

async function liveJob(params) {
    // Best-effort: no confirmed single-job-by-slug tool on Lorikeet's server,
    // so search using the slug's words as a keyword query and match exactly.
    const keywords = (params.slug || '').replace(/-/g, ' ');
    const raw = await callLorikeetTool('search_jobs', { query: keywords, limit: 20 });
    const cleaned = (raw.jobs || []).map(cleanJob);
    const match = cleaned.find(j => j.slug === params.slug) || null;
    return { job: match, source: 'live' };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

exports.handler = async (event) => {
    const originHeader = event.headers && (event.headers.origin || event.headers.Origin);
    const headers = corsHeaders(originHeader);

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { action, ...params } = payload;

    if (!['stats', 'featured', 'search', 'job'].includes(action)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }

    try {
        let result;
        switch (action) {
            case 'stats': result = await liveStats(); break;
            case 'featured': result = await liveFeatured(); break;
            case 'search': result = await liveSearch(params); break;
            case 'job': result = await liveJob(params); break;
        }
        return { statusCode: 200, headers, body: JSON.stringify(result) };
    } catch (liveError) {
        // Live path failed (network, timeout, MCP server down, bad response
        // shape). No stale-data fallback by design — the frontend's existing
        // error states handle this (see lkCallBackend's catch in index.html).
        return {
            statusCode: 502,
            headers,
            body: JSON.stringify({ error: 'Live job board request failed: ' + liveError.message })
        };
    }
};

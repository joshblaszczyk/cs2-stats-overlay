// Browser-side DOM parsers for csstats.gg. These functions are serialized
// and sent over the DevTools protocol to run inside the page via
// `page.evaluate(...)` — so they must be fully self-contained (no
// references to any outer scope, no require() calls, no closures).
//
// There are two distinct scrape stages:
//   parsePlayerPage  — the main /player/<steamid> view. Server-rendered,
//                      contains ranks, lifetime stats, clutches, entries,
//                      and map breakdowns.
//   parseMatchesTab  — the /#/matches client-rendered view. Used only to
//                      compute recent-30 stats that the legacy main-page
//                      "recent" column no longer populates reliably.
//
// The parsers return plain data (no DOM nodes) so serialization back to
// the Node side is cheap and crash-free.

// ── Stage 1: main player page ────────────────────────────────
// Parses ranks, lifetime stats, clutches, entries, and map breakdowns.
// Lines near the bottom use the raw innerText of the stats block; csstats
// renders each stat as a two-column (overall | recent-30) layout, and we
// grab the overall column with a simple label-then-value walker.
function parsePlayerPage() {
  const result = {
    premier: null,
    peakPremier: null,
    premierWins: null,
    faceitLevel: null,
    faceitNickname: null,
    mapWins: {},
    kd: null,
    hltvRating: null,
    winRate: null,
    hsPercent: null,
    adr: null,
    kills: null,
    deaths: null,
    assists: null,
    headshots: null,
    matches: null,
    won: null,
    lost: null,
    rounds: null,
    clutch1v1: null, clutch1v1Wins: null, clutch1v1Losses: null,
    clutch1v2: null, clutch1v2Wins: null, clutch1v2Losses: null,
    clutch1v3: null, clutch1v3Wins: null, clutch1v3Losses: null,
    clutch1v4: null, clutch1v4Wins: null, clutch1v4Losses: null,
    clutch1v5: null, clutch1v5Wins: null, clutch1v5Losses: null,
    clutchOverall: null,
    entrySuccess: null,
    entrySuccessT: null,
    entrySuccessCT: null,
    entryAttempts: null,
    entryAttemptsT: null,
    entryAttemptsCT: null,
    entryPerRound: null,
    tied: null,
    damage: null,
    mapStats: {},
  };

  const bodyText = document.body.innerText;

  // Ranks block — premier is one card, FACEIT another, plus one card per
  // map with a win counter. Icons discriminate between card types.
  const rankSections = document.querySelectorAll('.ranks');
  for (const section of rankSections) {
    const icon = section.querySelector('.icon img');
    const src = icon?.src || '';
    const ratingEls = section.querySelectorAll('.cs2rating');
    const winsMatch = section.textContent.match(/Wins:\s*(\d+)/);
    const wins = winsMatch ? parseInt(winsMatch[1]) : null;

    if (src.includes('premier') && ratingEls.length >= 1) {
      const ratings = [...ratingEls].map(el => {
        const text = el.textContent.trim().replace(/,/g, '');
        return text && text !== '---' ? parseInt(text) : null;
      }).filter(v => v != null);

      if (ratings.length > 0 && !result.premier) {
        result.premier = ratings[0];
        result.peakPremier = ratings[1] || ratings[0];
        result.premierWins = wins;
      } else if (ratings.length > 0) {
        for (const r of ratings) {
          if (r > (result.peakPremier || 0)) result.peakPremier = r;
        }
      }
    }

    if (src.includes('faceit')) {
      const levelImg = section.querySelector('img.rank');
      if (levelImg?.src) {
        const lvlMatch = levelImg.src.match(/level(\d+)/);
        if (lvlMatch) result.faceitLevel = parseInt(lvlMatch[1]);
      }
      // Nickname → used by the faceit-api public endpoint fallback. Lets
      // us fetch elo even when the user hasn't set a FACEIT API key.
      const faceitLink = section.querySelector('a[href*="faceit.com"]');
      if (faceitLink?.href) {
        const m = faceitLink.href.match(/faceit\.com\/[a-z]{2}\/players\/([^/?#]+)/i);
        if (m) result.faceitNickname = decodeURIComponent(m[1]);
      }
    }
  }
  // Broad FACEIT-link fallback for themes that don't put the link inside
  // a .ranks section.
  if (!result.faceitNickname) {
    const anyLink = document.querySelector('a[href*="faceit.com/en/players/"]');
    if (anyLink?.href) {
      const m = anyLink.href.match(/faceit\.com\/[a-z]{2}\/players\/([^/?#]+)/i);
      if (m) result.faceitNickname = decodeURIComponent(m[1]);
    }
  }

  // Map-wins cards
  for (const section of rankSections) {
    const text = section.textContent;
    const mapMatch = text.match(/(?:de|cs)_(\w+)/);
    const winsMatch = text.match(/Wins:\s*(\d+)/);
    if (mapMatch && winsMatch) {
      result.mapWins[mapMatch[1]] = parseInt(winsMatch[1]);
    }
  }

  // ── Lifetime stats block (label → value walker) ──
  // csstats renders lifetime stats in one of two layouts, depending on
  // how the page chooses to lay out the card grid for the viewer:
  //   Multi-line: LABEL\n<overall>\n<recent>\n<next LABEL>\n...
  //     (block-level elements, typical when 30+ matches exist)
  //   Inline:     LABEL <overall> <recent>    on ONE innerText line
  //     (inline spans, seen on some friend-private / partial profiles)
  // Either can populate `bodyText`; the extractor needs to handle both
  // or we leave lifetime stats null on profiles that use inline rendering
  // (user-visible bug: kd=null even though premier + recent-matches populated).
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const clean = (s) => s.replace(/,/g, '').replace('%', '').trim();
  const isNumish = (s) => /^-?\d+\.?\d*$/.test(clean(s));
  // Escape a label for use inside a RegExp — csstats labels include '/'
  // ('K/D') and '%' ('HS%') which are regex-meaningful characters.
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const getPair = (label) => {
    // Primary: line-based walker (multi-line layout).
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].toUpperCase() === label.toUpperCase()) {
        const a = isNumish(lines[i + 1]) ? parseFloat(clean(lines[i + 1])) : null;
        const b = (i + 2 < lines.length && isNumish(lines[i + 2])) ? parseFloat(clean(lines[i + 2])) : null;
        return [a, b];
      }
    }
    // Fallback: inline layout. Match "LABEL <number> <number?>" anywhere
    // in a line — we don't require the line to START with the label so
    // we don't miss cases where csstats wraps it in a prefix element.
    // Numbers are permissive: comma thousands separators, optional '%'.
    const inlineRe = new RegExp(
      `(?:^|\\s)${reEscape(label)}\\s+(-?[\\d.,]+)%?(?:\\s+(-?[\\d.,]+)%?)?`,
      'i',
    );
    for (const line of lines) {
      const m = line.match(inlineRe);
      if (m) {
        const a = isNumish(m[1]) ? parseFloat(clean(m[1])) : null;
        const b = (m[2] && isNumish(m[2])) ? parseFloat(clean(m[2])) : null;
        return [a, b];
      }
    }
    return [null, null];
  };
  const getAfter = (label) => getPair(label)[0];
  const parseInt2 = (v) => v != null ? parseInt(v) : null;

  const [kdA, kdR]   = getPair('K/D');
  const [hltvA, hltvR] = getPair('HLTV RATING');
  const [wrA, wrR]   = getPair('WIN RATE');
  const [hsA, hsR]   = getPair('HS%');
  const [adrA, adrR] = getPair('ADR');
  result.kd = kdA;
  result.hltvRating = hltvA;
  result.winRate = wrA;
  result.hsPercent = hsA;
  result.adr = adrA;
  result.recentKd = kdR;
  result.recentRating = hltvR;
  result.recentWinRate = wrR;
  result.recentHs = hsR;
  result.recentAdr = adrR;
  result.kills    = parseInt2(getAfter('KILLS'));
  result.deaths   = parseInt2(getAfter('DEATHS'));
  result.assists  = parseInt2(getAfter('ASSISTS'));
  result.headshots= parseInt2(getAfter('HEADSHOTS'));
  result.rounds   = parseInt2(getAfter('ROUNDS'));
  result.matches  = parseInt2(getAfter('PLAYED'));
  result.won      = parseInt2(getAfter('WON'));
  result.lost     = parseInt2(getAfter('LOST'));
  result.tied     = parseInt2(getAfter('TIED'));
  result.damage   = parseInt2(getAfter('DAMAGE'));

  // Clutch block. "1vX 17%" is the combined figure; then each 1v1..1v5
  // row is "{pct}%\nW:{wins} / L:{losses}" but wins/losses may be absent
  // on players who've never clutched that scenario.
  const clutchMatch = bodyText.match(/1vX\s+(\d+)%/);
  if (clutchMatch) result.clutchOverall = parseInt(clutchMatch[1]);
  const clutchParse = (label) => {
    const re = new RegExp(`${label}\\s*\\n\\s*(\\d+)%(?:\\s*\\n?\\s*W:\\s*(\\d+)\\s*/\\s*L:\\s*(\\d+))?`, 'i');
    const m = bodyText.match(re);
    if (!m) return null;
    return {
      pct: parseInt(m[1]),
      wins: m[2] != null ? parseInt(m[2]) : null,
      losses: m[3] != null ? parseInt(m[3]) : null,
    };
  };
  const c1 = clutchParse('1v1'); if (c1) { result.clutch1v1 = c1.pct; result.clutch1v1Wins = c1.wins; result.clutch1v1Losses = c1.losses; }
  const c2 = clutchParse('1v2'); if (c2) { result.clutch1v2 = c2.pct; result.clutch1v2Wins = c2.wins; result.clutch1v2Losses = c2.losses; }
  const c3 = clutchParse('1v3'); if (c3) { result.clutch1v3 = c3.pct; result.clutch1v3Wins = c3.wins; result.clutch1v3Losses = c3.losses; }
  const c4 = clutchParse('1v4'); if (c4) { result.clutch1v4 = c4.pct; result.clutch1v4Wins = c4.wins; result.clutch1v4Losses = c4.losses; }
  const c5 = clutchParse('1v5'); if (c5) { result.clutch1v5 = c5.pct; result.clutch1v5Wins = c5.wins; result.clutch1v5Losses = c5.losses; }

  // Entry block — three columns: combined, T side, CT side.
  const entryRound = bodyText.match(/per Round\s+(\d+)%/);
  if (entryRound) result.entryPerRound = parseInt(entryRound[1]);
  const entrySuccessRow = bodyText.match(/Entry Success\s*\n\s*(\d+)%(?:\s*\n\s*(\d+)%)?(?:\s*\n\s*(\d+)%)?/);
  if (entrySuccessRow) {
    result.entrySuccess = parseInt(entrySuccessRow[1]);
    if (entrySuccessRow[2]) result.entrySuccessT  = parseInt(entrySuccessRow[2]);
    if (entrySuccessRow[3]) result.entrySuccessCT = parseInt(entrySuccessRow[3]);
  }
  const entryAttemptsRow = bodyText.match(/Entry Attempts\s*\n\s*(\d+)%(?:\s*\n\s*(\d+)%)?(?:\s*\n\s*(\d+)%)?/);
  if (entryAttemptsRow) {
    result.entryAttempts = parseInt(entryAttemptsRow[1]);
    if (entryAttemptsRow[2]) result.entryAttemptsT  = parseInt(entryAttemptsRow[2]);
    if (entryAttemptsRow[3]) result.entryAttemptsCT = parseInt(entryAttemptsRow[3]);
  }

  // Map breakdowns: "Most Played" (plays per map) and "Most Success" (win
  // rate per map). Both live in the same innerText block and are scraped
  // by splitting the inter-section text on whitespace pairs.
  const mostPlayed = bodyText.match(/Most Played\n([\s\S]*?)(?:Most Success|$)/);
  if (mostPlayed) {
    const mapLines = mostPlayed[1].trim().split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < mapLines.length - 1; i += 2) {
      const mapName = mapLines[i].replace(/^(de|cs)_/, '');
      const count = parseInt(mapLines[i + 1]);
      if (mapName && !isNaN(count)) {
        result.mapStats[mapName] = { played: count };
      }
    }
  }
  const mostSuccess = bodyText.match(/Most Success\n([\s\S]*?)(?:Most Kills|$)/);
  if (mostSuccess) {
    const mapLines = mostSuccess[1].trim().split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < mapLines.length - 1; i += 2) {
      const mapName = mapLines[i].replace(/^(de|cs)_/, '');
      const wr = parseInt(mapLines[i + 1]);
      if (mapName && !isNaN(wr)) {
        if (!result.mapStats[mapName]) result.mapStats[mapName] = {};
        result.mapStats[mapName].winRate = wr;
      }
    }
  }

  return result;
}

// ── Stage 2: matches tab ─────────────────────────────────────
// Returns an array of per-match rows: { k, d, hs, adr, rating, mine, theirs }.
// Caller aggregates these into recent-30 averages.
function parseMatchesTab() {
  // Find the matches table: the one whose header contains K, D, ADR, RATING.
  const tables = Array.from(document.querySelectorAll('table'));
  let matchTable = null;
  for (const t of tables) {
    const headers = Array.from(t.querySelectorAll('th')).map(h => h.innerText.trim().toUpperCase());
    if (headers.includes('K') && headers.includes('D') && headers.includes('RATING') && headers.includes('ADR')) {
      matchTable = t;
      break;
    }
  }
  if (!matchTable) return null;

  const headers = Array.from(matchTable.querySelectorAll('th')).map(h => h.innerText.trim().toUpperCase());
  const idx = {
    score: headers.indexOf('SCORE'),
    k: headers.indexOf('K'),
    d: headers.indexOf('D'),
    hs: headers.indexOf('HS%'),
    adr: headers.indexOf('ADR'),
    rating: headers.indexOf('RATING'),
  };
  const rows = Array.from(matchTable.querySelectorAll('tbody tr')).slice(0, 30);
  const out = [];
  for (const r of rows) {
    const cells = Array.from(r.querySelectorAll('td')).map(td => td.innerText.trim());
    const score = idx.score >= 0 ? cells[idx.score] : '';
    const kVal      = idx.k      >= 0 ? parseFloat(cells[idx.k])      : NaN;
    const dVal      = idx.d      >= 0 ? parseFloat(cells[idx.d])      : NaN;
    const hsVal     = idx.hs     >= 0 ? parseFloat(cells[idx.hs])     : NaN;
    const adrVal    = idx.adr    >= 0 ? parseFloat(cells[idx.adr])    : NaN;
    const ratingVal = idx.rating >= 0 ? parseFloat(cells[idx.rating]) : NaN;
    const sm = /^(\d+)\s*:\s*(\d+)/.exec(score || '');
    const mine   = sm ? parseInt(sm[1]) : null;
    const theirs = sm ? parseInt(sm[2]) : null;
    out.push({ k: kVal, d: dVal, hs: hsVal, adr: adrVal, rating: ratingVal, mine, theirs });
  }
  return out;
}

// Aggregate the matches-tab rows into recent-30 averages. Kept on the
// Node side so it doesn't have to be re-serialized for every page.
function aggregateRecentMatches(recent) {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  let sumK = 0, sumD = 0;
  let sumHs = 0, hsCount = 0;
  let sumAdr = 0, adrCount = 0;
  let sumRating = 0, ratingCount = 0;
  let wins = 0, losses = 0, decided = 0;
  for (const m of recent) {
    if (Number.isFinite(m.k)) sumK += m.k;
    if (Number.isFinite(m.d)) sumD += m.d;
    if (Number.isFinite(m.hs))     { sumHs += m.hs; hsCount++; }
    if (Number.isFinite(m.adr))    { sumAdr += m.adr; adrCount++; }
    if (Number.isFinite(m.rating)) { sumRating += m.rating; ratingCount++; }
    if (Number.isFinite(m.mine) && Number.isFinite(m.theirs) && m.mine !== m.theirs) {
      decided++;
      if (m.mine > m.theirs) wins++; else losses++;
    }
  }
  return {
    recentKd:      sumD > 0 ? +(sumK / sumD).toFixed(2) : null,
    recentHs:      hsCount > 0 ? Math.round(sumHs / hsCount) : null,
    recentAdr:     adrCount > 0 ? Math.round(sumAdr / adrCount) : null,
    recentRating:  ratingCount > 0 ? +(sumRating / ratingCount).toFixed(2) : null,
    recentWinRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
    recentMatchCount: recent.length,
  };
}

module.exports = { parsePlayerPage, parseMatchesTab, aggregateRecentMatches };

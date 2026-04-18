// Buy-round advisor for the local player. Classifies teammate spending
// ("buying" / "forcing" / "saving") when we have visibility into their
// money, then maps the local player's money + score delta to a single
// buy recommendation: PISTOL | FULL BUY | FORCE | ECO | SAVE.
//
// Why live in its own file: the http handler in gsi-server.js should not
// grow ~80 lines of economy branching. Keeping the classifier pure also
// makes it easy to unit test later without standing up a real CS2 feed.

// Median is used instead of mean so one outlier (e.g. a rich AWPer sitting
// on $10k) doesn't drag the classification toward "buying" when the rest
// of the team is clearly saving.
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}

// Returns 'buying' | 'forcing' | 'saving' | null.
// null = no teammate visibility (GSI hides teammate money while the local
// player is alive in a live comp match — a Valve limitation we can't work
// around).
function classifyTeamState(teamMoneys) {
  if (!teamMoneys || teamMoneys.length === 0) return null;
  const med = median(teamMoneys);
  const buyers = teamMoneys.filter(v => v >= 4500).length;
  const savers = teamMoneys.filter(v => v < 2000).length;
  if (med >= 4500) return 'buying';
  if (med < 2000) return 'saving';
  // Unanimous read (all but one teammate matches) beats the mixed middle.
  if (buyers >= teamMoneys.length - 1) return 'buying';
  if (savers >= teamMoneys.length - 1) return 'saving';
  return 'forcing';
}

// Pull teammate money values from the allplayers block. Returns null when
// we have no usable data so the caller can fall through to the money-only
// heuristic instead of misclassifying an empty set as "saving".
function collectTeamMoneys(allplayers, localId, myTeam) {
  if (!allplayers || !myTeam || !localId) return null;
  const mates = [];
  for (const [id, info] of Object.entries(allplayers)) {
    if (id === localId) continue;
    if (info?.team !== myTeam) continue;
    const m = info?.state?.money;
    if (typeof m === 'number') mates.push(m);
  }
  return mates.length > 0 ? mates : null;
}

// Map the current economic + match situation onto a buy recommendation.
// Pistol rounds (round 0 and 12 — start of each half) override everything
// else; the player has a fixed $800 and the only real question is which
// pistol to pick.
function computeBuyAdvice({ money, roundNum, myScore, enemyScore, teamState }) {
  if (roundNum === 0 || roundNum === 12) {
    return { advice: 'PISTOL', reason: null };
  }

  if (teamState === 'buying') {
    if (money >= 4500) return { advice: 'FULL BUY', reason: null };
    if (money >= 2000) return { advice: 'FORCE', reason: 'match team buy' };
    return { advice: 'ECO', reason: 'stay alive, drop' };
  }

  if (teamState === 'saving') {
    if (money >= 5000 && enemyScore - myScore >= 3) {
      return { advice: 'SAVE', reason: "don't solo vs stacked enemy" };
    }
    if (money >= 5000) return { advice: 'SAVE', reason: 'save with team' };
    return { advice: 'SAVE', reason: null };
  }

  if (teamState === 'forcing') {
    if (money >= 4500) return { advice: 'FULL BUY', reason: null };
    if (money >= 2000) return { advice: 'FORCE', reason: 'team is forcing' };
    return { advice: 'ECO', reason: null };
  }

  // No teammate visibility — money + score-delta heuristic.
  if (money >= 4500) return { advice: 'FULL BUY', reason: null };
  if (money >= 2000) {
    return enemyScore - myScore >= 3
      ? { advice: 'SAVE', reason: null }
      : { advice: 'FORCE', reason: null };
  }
  if (money >= 1000) return { advice: 'ECO', reason: null };
  return { advice: 'SAVE', reason: null };
}

// One-call convenience: collect, classify, advise. Returns all three pieces
// so the server can surface the team state to the renderer.
function buyAdviceFor({ allplayers, localId, myTeam, money, roundNum, myScore, enemyScore }) {
  const teamMoneys = collectTeamMoneys(allplayers, localId, myTeam);
  const teamState = classifyTeamState(teamMoneys);
  const { advice, reason } = computeBuyAdvice({ money, roundNum, myScore, enemyScore, teamState });
  return { advice, reason, teamState };
}

module.exports = {
  buyAdviceFor,
  classifyTeamState,
  collectTeamMoneys,
  computeBuyAdvice,
  median,
};

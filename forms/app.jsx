// ============================================================
// Most Likely To — Oracle Edition
// Main React app: Home / Host / Player + PeerJS multiplayer
// ============================================================

const { useState, useEffect, useRef, useCallback, useMemo } = React;

const PLAYERS = window.PLAYERS;
const QUESTIONS = window.QUESTIONS;
const ROOM_PREFIX = window.ROOM_PREFIX;
const playerById = (id) => PLAYERS.find((p) => p.id === id);

// ---------- routing via location.hash ----------
function parseHash() {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return { route: 'home' };
  const parts = h.split('/');
  if (parts[0] === 'host') return { route: 'host' };
  if (parts[0] === 'join') return { route: 'join', code: (parts[1] || '').toUpperCase() };
  return { route: 'home' };
}
function setHash(h) {
  if (location.hash !== '#' + h) location.hash = h;
}

// ---------- 4-char room code: avoid ambiguous chars ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

// ---------- shared chrome ----------
function TopBar({ right }) {
  return (
    <header className="topbar">
      <div className="logo">MOST LIKELY <span className="dot">●</span> Oracle Ed.</div>
      <div className="meta">{right || 'v1 · live voting'}</div>
    </header>
  );
}

function Roster() {
  return (
    <div className="roster">
      {PLAYERS.map((p) => (
        <span key={p.id} className="pill">
          <span className="swatch-dot" style={{ background: p.color }}></span>
          {p.name}
        </span>
      ))}
    </div>
  );
}

// ============================================================
// HOME (host or join chooser)
// ============================================================
function Home() {
  return (
    <div className="app-wrap">
      <TopBar right="press start" />
      <main className="home">
        <div className="home-inner">
          <div className="eyebrow"><span className="pulse"></span>A coworker party game · roasty, kind, HR-safe</div>
          <h1 className="megaword">
            <span className="row">MOST</span>
            <span className="row"><span className="swatch swatch-pink">LIKELY</span></span>
            <span className="row">TO<span style={{ color: 'var(--pink)' }}>.</span></span>
          </h1>

          <div className="home-grid">
            <div className="card">
              <h3>Run the room</h3>
              <p>Project this on the big screen. Your team joins from their phones with a code &amp; QR. You drive the questions and reveal the results.</p>
              <button className="big-btn pink" onClick={() => setHash('host')}>
                ▶ Host game
              </button>
            </div>
            <div className="card">
              <h3>Join on your phone</h3>
              <p>Got a room code from the host? Tap in, pick which Oracle legend you are, and start voting. Anonymous — no one sees your picks.</p>
              <button className="big-btn cobalt" onClick={() => setHash('join')}>
                ◢ Join with code
              </button>
            </div>
          </div>

          <Roster />

          <div className="home-foot">
            <span><b>25</b> questions</span>
            <span><b>11</b> players</span>
            <span><b>Anonymous</b> voting</span>
            <span><b>Live</b> reveal + recap</span>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// HOST: peer lifecycle + state machine
// ============================================================
function useHostPeer() {
  const [code] = useState(genCode);
  const [status, setStatus] = useState('booting'); // booting | open | error
  const [error, setError] = useState(null);
  const peerRef = useRef(null);
  const connsRef = useRef(new Map()); // playerId -> connection
  // joinedIds / state changes broadcast via a callback registered by HostView
  const onMessageRef = useRef(null);
  const onJoinedChangeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const peer = new window.Peer(ROOM_PREFIX + code, { debug: 0 });
    peerRef.current = peer;

    peer.on('open', () => {
      if (cancelled) return;
      setStatus('open');
    });
    peer.on('error', (err) => {
      console.error('host peer error', err);
      if (cancelled) return;
      // 'unavailable-id' means another host has same code — retry with a new code (rare with random 4-char)
      if (err.type === 'unavailable-id') {
        setError('Room code collision. Please refresh to try again.');
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        setError('Network hiccup talking to the relay. Refresh to retry.');
      } else if (err.type === 'browser-incompatible') {
        setError("This browser doesn't support live rooms. Try Chrome/Safari/Firefox.");
      } else {
        setError(String(err && err.message ? err.message : err));
      }
      setStatus('error');
    });
    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        // wait for join message
      });
      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'join') {
          const pid = data.playerId;
          // if already taken (by a different conn), reject
          const prev = connsRef.current.get(pid);
          if (prev && prev !== conn && prev.open) {
            conn.send({ type: 'identityTaken', playerId: pid });
            try { conn.close(); } catch (e) {}
            return;
          }
          connsRef.current.set(pid, conn);
          conn.__playerId = pid;
          conn.send({ type: 'identityOk', playerId: pid });
          if (onJoinedChangeRef.current) onJoinedChangeRef.current();
          return;
        }
        if (onMessageRef.current) onMessageRef.current(data, conn);
      });
      conn.on('close', () => {
        if (conn.__playerId && connsRef.current.get(conn.__playerId) === conn) {
          connsRef.current.delete(conn.__playerId);
          if (onJoinedChangeRef.current) onJoinedChangeRef.current();
        }
      });
      conn.on('error', () => {
        if (conn.__playerId && connsRef.current.get(conn.__playerId) === conn) {
          connsRef.current.delete(conn.__playerId);
          if (onJoinedChangeRef.current) onJoinedChangeRef.current();
        }
      });
    });

    return () => {
      cancelled = true;
      try { peer.destroy(); } catch (e) {}
    };
  }, [code]);

  const broadcast = useCallback((msg) => {
    for (const conn of connsRef.current.values()) {
      if (conn.open) {
        try { conn.send(msg); } catch (e) {}
      }
    }
  }, []);

  const joinedIds = useCallback(() => {
    return Array.from(connsRef.current.keys());
  }, []);

  return {
    code, status, error,
    broadcast, joinedIds,
    onMessage: (fn) => { onMessageRef.current = fn; },
    onJoinedChange: (fn) => { onJoinedChangeRef.current = fn; },
  };
}

function HostView() {
  const host = useHostPeer();
  const [phase, setPhase] = useState('lobby'); // lobby | question | reveal | final
  const [questionIdx, setQuestionIdx] = useState(0);
  const [votes, setVotes] = useState({}); // {qIdx: {voterPlayerId: votedForPlayerId}}
  const [joined, setJoined] = useState([]); // playerIds
  const [revealKey, setRevealKey] = useState(0);

  // join URL for QR
  const joinUrl = useMemo(() => {
    const u = new URL(location.href);
    u.hash = 'join/' + host.code;
    return u.toString();
  }, [host.code]);

  // wire host callbacks
  useEffect(() => {
    host.onJoinedChange(() => {
      setJoined(host.joinedIds());
    });
    host.onMessage((data, conn) => {
      if (data.type === 'vote') {
        setVotes((prev) => {
          const next = { ...prev };
          const q = { ...(next[data.questionIdx] || {}) };
          q[conn.__playerId] = data.votedFor;
          next[data.questionIdx] = q;
          return next;
        });
      }
    });
  }, [host]);

  // broadcast state to everyone whenever it changes
  useEffect(() => {
    if (host.status !== 'open') return;
    const payload = buildBroadcast({ phase, questionIdx, votes, joinedIds: host.joinedIds() });
    host.broadcast({ type: 'state', state: payload });
  }, [host, host.status, phase, questionIdx, votes, joined]);

  function buildBroadcast({ phase, questionIdx, votes, joinedIds }) {
    const out = {
      phase,
      questionIdx,
      totalQuestions: QUESTIONS.length,
      question: QUESTIONS[questionIdx] || null,
      joinedIds,
    };
    const voted = Object.keys(votes[questionIdx] || {});
    out.votedCount = voted.length;
    out.totalJoined = joinedIds.length;
    if (phase === 'reveal' || phase === 'final') {
      out.tally = tallyFor(votes[questionIdx] || {});
    }
    if (phase === 'final') {
      out.allTallies = QUESTIONS.map((_, i) => tallyFor(votes[i] || {}));
    }
    return out;
  }
  function tallyFor(qVotes) {
    const counts = {};
    for (const v of Object.values(qVotes)) counts[v] = (counts[v] || 0) + 1;
    return counts;
  }

  // ----- lobby -> question -----
  function startGame() {
    if (joined.length < 1) return;
    setQuestionIdx(0);
    setPhase('question');
  }
  function revealNow() {
    setPhase('reveal');
    setRevealKey((k) => k + 1);
    setTimeout(() => fireConfetti(), 200);
  }
  function nextQuestion() {
    if (questionIdx + 1 >= QUESTIONS.length) {
      setPhase('final');
      setTimeout(() => fireConfetti(true), 200);
      return;
    }
    setQuestionIdx((i) => i + 1);
    setPhase('question');
  }
  function backToLobby() {
    setPhase('lobby');
    setQuestionIdx(0);
    setVotes({});
  }

  const currentVotes = votes[questionIdx] || {};
  const votedCount = Object.keys(currentVotes).length;
  const tally = tallyFor(currentVotes);
  const winner = pickWinner(tally);

  return (
    <div className="app-wrap">
      <TopBar right={phase === 'lobby' ? 'lobby' : phase === 'final' ? 'recap' : `Q ${questionIdx + 1}/${QUESTIONS.length}`} />
      <main className="host">
        {phase === 'lobby' && (
          <LobbyScreen
            code={host.code} joinUrl={joinUrl}
            status={host.status} error={host.error}
            joined={joined}
            onStart={startGame}
          />
        )}
        {phase === 'question' && (
          <QuestionScreen
            qIdx={questionIdx}
            joined={joined}
            currentVotes={currentVotes}
            onReveal={revealNow}
          />
        )}
        {phase === 'reveal' && (
          <RevealScreen
            key={revealKey}
            qIdx={questionIdx}
            tally={tally}
            winner={winner}
            isLast={questionIdx + 1 >= QUESTIONS.length}
            onNext={nextQuestion}
          />
        )}
        {phase === 'final' && (
          <RecapScreen
            votes={votes}
            onRestart={backToLobby}
          />
        )}
      </main>
    </div>
  );
}

function pickWinner(tally) {
  let max = 0;
  for (const c of Object.values(tally)) if (c > max) max = c;
  if (max === 0) return { ids: [], count: 0 };
  const ids = Object.entries(tally).filter(([, c]) => c === max).map(([id]) => id);
  return { ids, count: max };
}

// ---------- LOBBY ----------
function LobbyScreen({ code, joinUrl, status, error, joined, onStart }) {
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=8&data=${encodeURIComponent(joinUrl)}`;
  return (
    <>
      {error && <div className="conn-banner err"><span className="dot"></span>{error}</div>}
      {!error && status !== 'open' && (
        <div className="conn-banner warn"><span className="dot"></span>Connecting to relay…</div>
      )}
      {!error && status === 'open' && (
        <div className="conn-banner ok"><span className="dot"></span>Room live — share the code</div>
      )}

      <div className="lobby">
        <div className="code-block">
          <div className="label">Room code</div>
          <div className="code-display">{code}</div>
          <div className="code-url">{joinUrl}</div>
          <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="big-btn yellow" onClick={() => navigator.clipboard?.writeText(joinUrl)}>
              ⎘ Copy link
            </button>
            <button className="big-btn ghost" onClick={() => navigator.clipboard?.writeText(code)}>
              ⎘ Copy code
            </button>
          </div>
        </div>

        <div className="lobby-side">
          <div className="qr-card">
            <img src={qrSrc} alt="Scan to join" />
            <div className="qr-cap">Scan with phone camera</div>
          </div>

          <div className="joined-card">
            <h4>
              Players in <span className="count">{joined.length}/{PLAYERS.length}</span>
            </h4>
            <div className="joined-grid">
              {PLAYERS.map((p, idx) => {
                const isIn = joined.includes(p.id);
                return (
                  <div key={p.id} className={`joined-chip ${isIn ? 'in' : 'out'} ${idx % 2 ? 'alt' : ''}`}
                       style={isIn ? { background: p.color, color: p.text, borderColor: 'var(--ink)' } : {}}>
                    <span className="dot"></span>
                    {p.name}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="host-foot">
        <button className="link-btn" onClick={() => setHash('')}>← Back home</button>
        <div className="spacer"></div>
        <button
          className="big-btn ink"
          style={{ minWidth: 240 }}
          disabled={joined.length < 1 || status !== 'open'}
          onClick={onStart}
        >
          {joined.length < 1 ? 'Waiting for players…' : `Start game · ${joined.length} in`}
        </button>
      </div>
    </>
  );
}

// ---------- QUESTION ----------
function QuestionScreen({ qIdx, joined, currentVotes, onReveal }) {
  const q = QUESTIONS[qIdx];
  const total = QUESTIONS.length;
  const pct = ((qIdx + 1) / total) * 100;
  const votedCount = Object.keys(currentVotes).length;
  const allIn = joined.length > 0 && votedCount >= joined.length;
  return (
    <div className="qstage">
      <div className="q-head">
        <div className="q-counter">Question <b>{qIdx + 1}</b> of {total}</div>
        <div className="q-progress"><div style={{ width: pct + '%' }}></div></div>
        <button className="big-btn ink" style={{ padding: '14px 22px', fontSize: 18 }} onClick={onReveal}>
          {allIn ? '✨ Reveal results' : `Reveal anyway · ${votedCount}/${joined.length}`}
        </button>
      </div>

      <div className="q-body">
        <div className="q-prompt">
          <div className="q-eyebrow">The vote</div>
          <div className="body">{q}</div>
          <div className="corner-num">Q{String(qIdx + 1).padStart(2, '0')}</div>
        </div>

        <div className="live-card">
          <h5>
            <span>Votes coming in</span>
            <span className="live-dot">LIVE</span>
          </h5>
          <div className="vote-progress">{votedCount}<span>/{joined.length || 0}</span></div>
          <div className="live-grid">
            {PLAYERS.map((p) => {
              const isIn = joined.includes(p.id);
              const hasVoted = !!currentVotes[p.id];
              return (
                <div key={p.id} className={`live-chip ${!isIn ? 'not-joined' : ''} ${hasVoted ? 'voted' : ''}`}>
                  {p.name}
                </div>
              );
            })}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(255,244,230,0.5)' }}>
            Picks are anonymous · only count is shown
          </div>
        </div>
      </div>
    </div>
  );
}

function stripPrefix(q) {
  // legacy helper, no longer used — questions render verbatim now
  return (q || '').replace(/^Most likely to\s+/i, '');
}

// ---------- REVEAL ----------
function RevealScreen({ qIdx, tally, winner, isLast, onNext }) {
  const sorted = [...PLAYERS]
    .map((p) => ({ ...p, count: tally[p.id] || 0 }))
    .sort((a, b) => b.count - a.count);
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const maxCount = sorted[0]?.count || 0;
  const winnerPlayers = winner.ids.map(playerById).filter(Boolean);
  const isTie = winnerPlayers.length > 1;
  const noVotes = total === 0;

  // pick a color for the winner card from first winner
  const wColor = winnerPlayers[0]?.color || 'var(--yellow)';
  const wText = winnerPlayers[0]?.text || 'var(--ink)';

  return (
    <div className="reveal-stage">
      <div className="reveal-banner">
        <h2 className="reveal-title">
          {noVotes ? 'Crickets…' : isTie ? 'It\u2019s a TIE!' : 'And the winner is…'}
        </h2>
        <div className="row">
          <div className="q-counter">Q <b>{qIdx + 1}</b> / {QUESTIONS.length}</div>
          <button className="big-btn pink" style={{ padding: '14px 22px', fontSize: 18 }} onClick={onNext}>
            {isLast ? '🏆 See recap' : 'Next question →'}
          </button>
        </div>
      </div>

      <div className="reveal-question">“{QUESTIONS[qIdx]}”</div>

      <div className="winner-row">
        <div className="winner-card" style={{ background: noVotes ? 'var(--paper)' : wColor, color: noVotes ? 'var(--ink)' : wText }}>
          {isTie && <div className="tie-badge">{winnerPlayers.length}-way tie</div>}
          <div className="crown">{noVotes ? 'No votes recorded' : '★ Crowned'}</div>
          <div className="name">
            {noVotes ? '—' : winnerPlayers.map((p) => p.name).join(' & ')}
          </div>
          {!noVotes && <div className="votes">{winner.count} vote{winner.count === 1 ? '' : 's'}</div>}
        </div>

        <div className="tally">
          <h5>Full tally</h5>
          {sorted.map((p) => (
            <div key={p.id} className={`bar-row ${p.count === 0 ? 'zero' : ''}`}>
              <div className="nm">{p.name}</div>
              <div className="bar-track">
                <div className="bar-fill" style={{
                  width: maxCount > 0 ? (p.count / maxCount * 100) + '%' : '0%',
                  background: p.color,
                }}></div>
              </div>
              <div className="vc">{p.count}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- RECAP ----------
function RecapScreen({ votes, onRestart }) {
  const summary = QUESTIONS.map((q, i) => {
    const tally = {};
    for (const v of Object.values(votes[i] || {})) tally[v] = (tally[v] || 0) + 1;
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    const w = pickWinner(tally);
    const winners = w.ids.map(playerById).filter(Boolean);
    return { q, i, tally, total, winners, count: w.count };
  });

  return (
    <div className="recap">
      <div className="recap-head">
        <div className="eyebrow"><span className="pulse"></span>Game over · final results</div>
        <h1>The Superlatives.</h1>
        <p>Twenty-five questions later, the people have spoken. Quietly. Anonymously. With mild chaos.</p>
        <div style={{ marginTop: 18, display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="big-btn ink" onClick={() => window.print()}>🖨 Print / save PDF</button>
          <button className="big-btn ghost" onClick={onRestart}>↺ New game</button>
        </div>
      </div>

      <div className="recap-grid">
        {summary.map(({ q, i, winners, count, total }) => {
          const isTie = winners.length > 1;
          const noVotes = winners.length === 0;
          const bg = noVotes ? 'var(--paper)' : winners[0].color;
          const tx = noVotes ? 'var(--ink)' : winners[0].text;
          return (
            <div key={i} className="recap-card">
              <div className="qnum">Q{String(i + 1).padStart(2, '0')}</div>
              <div className="qtext">{q}</div>
              <div className="winner-pill" style={noVotes ? {} : { background: bg, color: tx, borderColor: 'var(--ink)' }}>
                {noVotes ? '— no votes —' : winners.map((p) => p.name).join(' & ')}
              </div>
              <div className="sub">
                {noVotes ? '0 votes' : `${count} of ${total} vote${total === 1 ? '' : 's'}${isTie ? ' · tie' : ''}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// PLAYER VIEW
// ============================================================
function PlayerView({ initialCode }) {
  const [stage, setStage] = useState('code'); // code | identity | playing
  const [code, setCode] = useState(initialCode || '');
  const [error, setError] = useState(null);
  const [connStatus, setConnStatus] = useState('idle'); // idle | connecting | open | error
  const [identity, setIdentity] = useState(null); // player object
  const [hostState, setHostState] = useState(null);
  const [myVotes, setMyVotes] = useState({}); // {qIdx: playerId}
  const [draftVote, setDraftVote] = useState(null);
  const [identityWaiting, setIdentityWaiting] = useState(null); // pid mid-claim

  const peerRef = useRef(null);
  const connRef = useRef(null);

  // ---- step 1: enter code, open peer connection ----
  function tryJoin() {
    const c = (code || '').trim().toUpperCase();
    if (c.length !== 4) {
      setError('Code must be 4 characters.');
      return;
    }
    setError(null);
    setConnStatus('connecting');
    const peer = new window.Peer(undefined, { debug: 0 });
    peerRef.current = peer;
    peer.on('open', () => {
      const conn = peer.connect(ROOM_PREFIX + c, { reliable: true });
      connRef.current = conn;
      let opened = false;
      const fail = (msg) => {
        if (opened) return;
        setError(msg);
        setConnStatus('error');
        try { conn.close(); } catch (e) {}
      };
      const tmo = setTimeout(() => fail('No room with that code. Double-check it.'), 8000);

      conn.on('open', () => {
        opened = true;
        clearTimeout(tmo);
        setConnStatus('open');
        setStage('identity');
      });
      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'state') {
          setHostState(data.state);
        } else if (data.type === 'identityTaken') {
          setIdentityWaiting(null);
          setError(`That player is already taken. Pick another.`);
        } else if (data.type === 'identityOk') {
          const p = playerById(data.playerId);
          setIdentity(p);
          setIdentityWaiting(null);
          setError(null);
          setStage('playing');
        }
      });
      conn.on('close', () => {
        setConnStatus('error');
        setError('Disconnected from the room.');
      });
      conn.on('error', (e) => {
        clearTimeout(tmo);
        fail('Connection error: ' + (e.message || e.type || 'unknown'));
      });
    });
    peer.on('error', (e) => {
      console.error('player peer error', e);
      if (e.type === 'peer-unavailable') {
        setError('No room with that code (host may have closed).');
      } else if (e.type === 'network' || e.type === 'server-error') {
        setError('Network problem reaching the relay. Try again.');
      } else if (e.type === 'browser-incompatible') {
        setError("Your browser doesn't support live rooms.");
      } else {
        setError(e.message || String(e));
      }
      setConnStatus('error');
    });
  }

  useEffect(() => () => {
    try { connRef.current?.close(); } catch (e) {}
    try { peerRef.current?.destroy(); } catch (e) {}
  }, []);

  function claimIdentity(playerId) {
    setIdentityWaiting(playerId);
    setError(null);
    try {
      connRef.current.send({ type: 'join', playerId });
    } catch (e) {
      setError('Could not send to host.');
      setIdentityWaiting(null);
    }
  }

  function submitVote() {
    if (!draftVote || !hostState) return;
    const qIdx = hostState.questionIdx;
    setMyVotes((prev) => ({ ...prev, [qIdx]: draftVote }));
    try {
      connRef.current.send({ type: 'vote', questionIdx: qIdx, votedFor: draftVote });
    } catch (e) {}
    setDraftVote(null);
  }

  // ---- screens ----
  if (stage === 'code') {
    return (
      <div className="app-wrap">
        <TopBar right="Join a room" />
        <main className="player">
          <button className="link-btn" onClick={() => setHash('')} style={{ alignSelf: 'flex-start', marginBottom: 18 }}>← Home</button>
          <h2 className="q-prompt-mobile">Got a code?</h2>
          <p style={{ marginTop: 0, color: 'var(--ink-2)', fontSize: 16 }}>Type the 4-character code on the host's screen.</p>

          <input
            className="code-input"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={4}
            placeholder="A B C D"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') tryJoin(); }}
          />

          {error && <div className="toast error" style={{ marginTop: 16 }}>⚠ {error}</div>}

          <div style={{ marginTop: 24 }}>
            <button
              className="big-btn pink"
              onClick={tryJoin}
              disabled={connStatus === 'connecting' || code.length !== 4}
            >
              {connStatus === 'connecting' ? 'Connecting…' : 'Join room →'}
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (stage === 'identity') {
    const joinedIds = (hostState && hostState.joinedIds) || [];
    return (
      <div className="app-wrap">
        <TopBar right={`Room · ${code}`} />
        <main className="player">
          <h2 className="q-prompt-mobile">Who are you?</h2>
          <p style={{ marginTop: 0, color: 'var(--ink-2)', fontSize: 16 }}>Pick yourself. Greyed-out names are already in.</p>

          {error && <div className="toast error" style={{ marginTop: 8 }}>⚠ {error}</div>}

          <div className="identity-grid" style={{ marginTop: 18 }}>
            {PLAYERS.map((p) => {
              const taken = joinedIds.includes(p.id);
              const claiming = identityWaiting === p.id;
              return (
                <button
                  key={p.id}
                  className="id-btn"
                  disabled={taken || claiming}
                  onClick={() => claimIdentity(p.id)}
                  style={taken ? {} : { background: p.color, color: p.text, borderColor: 'var(--ink)' }}
                >
                  <span className="swatch-dot" style={{ background: taken ? 'var(--muted)' : '#fff' }}></span>
                  {p.name}{taken ? '  ·  in' : claiming ? '  …' : ''}
                </button>
              );
            })}
          </div>
        </main>
      </div>
    );
  }

  // stage === 'playing'
  return <PlayerPlaying
    identity={identity}
    code={code}
    hostState={hostState}
    myVotes={myVotes}
    draftVote={draftVote}
    setDraftVote={setDraftVote}
    submitVote={submitVote}
  />;
}

function PlayerPlaying({ identity, code, hostState, myVotes, draftVote, setDraftVote, submitVote }) {
  const phase = hostState?.phase || 'lobby';
  const qIdx = hostState?.questionIdx ?? 0;
  const q = hostState?.question;
  const hasVoted = !!myVotes[qIdx];
  const tally = hostState?.tally || {};

  return (
    <div className="app-wrap">
      <TopBar right={`Room · ${code}`} />
      <main className="player">
        <div className="ptopbar">
          <span>You're playing as</span>
          <span className="me">
            <span className="dot" style={{ background: identity.color }}></span>
            {identity.name}
          </span>
        </div>

        {phase === 'lobby' && (
          <>
            <h2 className="q-prompt-mobile">Hang tight.</h2>
            <p style={{ marginTop: 0, color: 'var(--ink-2)' }}>Waiting for the host to start the game…</p>
            <div style={{ marginTop: 24 }} className="voted-badge">
              <h3>You're in ✓</h3>
              <p>{(hostState?.joinedIds || []).length} player{(hostState?.joinedIds||[]).length===1?'':'s'} joined</p>
            </div>
          </>
        )}

        {phase === 'question' && (
          <>
            <div className="qmeta">Question {qIdx + 1} / {hostState.totalQuestions}</div>
            <h2 className="q-prompt-mobile">{q}</h2>

            {hasVoted ? (
              <div className="voted-badge" style={{ marginTop: 24 }}>
                <h3>Locked in ✓</h3>
                <p>Waiting for the reveal…</p>
              </div>
            ) : (
              <>
                <div className="vote-grid">
                  {PLAYERS.map((p) => (
                    <button
                      key={p.id}
                      className={`vote-btn ${draftVote === p.id ? 'picked' : ''}`}
                      onClick={() => setDraftVote(p.id)}
                      style={draftVote === p.id ? { background: p.color, color: p.text, borderColor: 'var(--ink)' } : {}}
                    >
                      <span className="swatch-dot" style={{ background: p.color }}></span>
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="submit-cta">
                  <button className="big-btn ink" disabled={!draftVote} onClick={submitVote}>
                    {draftVote ? `Lock in vote for ${playerById(draftVote).name}` : 'Pick someone'}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {phase === 'reveal' && (
          <RevealPlayerView qIdx={qIdx} q={q} tally={tally} myVote={myVotes[qIdx]} total={hostState.totalQuestions} />
        )}

        {phase === 'final' && (
          <>
            <h2 className="q-prompt-mobile">That's a wrap!</h2>
            <p style={{ color: 'var(--ink-2)' }}>Look at the host's screen for the full recap. Thanks for playing 🎉</p>
            <div className="voted-badge" style={{ marginTop: 16 }}>
              <h3>{Object.keys(myVotes).length} votes cast</h3>
              <p>out of {hostState.totalQuestions} questions</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function RevealPlayerView({ qIdx, q, tally, myVote, total }) {
  const sorted = [...PLAYERS]
    .map((p) => ({ ...p, count: tally[p.id] || 0 }))
    .sort((a, b) => b.count - a.count);
  const maxCount = sorted[0]?.count || 0;
  const winnerCount = maxCount;
  const winners = sorted.filter((p) => p.count === maxCount && winnerCount > 0);
  const noVotes = winnerCount === 0;
  const myPick = myVote ? playerById(myVote) : null;
  const iWasRight = myVote && winners.some((w) => w.id === myVote);

  return (
    <>
      <div className="qmeta">Reveal · Q {qIdx + 1} / {total}</div>
      <h2 className="q-prompt-mobile">{q}</h2>

      <div style={{
        marginTop: 16,
        padding: 20,
        border: '2.5px solid var(--ink)',
        borderRadius: 18,
        background: noVotes ? 'var(--paper)' : winners[0].color,
        color: noVotes ? 'var(--ink)' : winners[0].text,
        boxShadow: '4px 4px 0 var(--ink)',
      }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', opacity: 0.7 }}>
          {noVotes ? 'No votes' : winners.length > 1 ? `${winners.length}-WAY TIE` : '★ Winner'}
        </div>
        <div style={{
          fontFamily: 'var(--display)',
          fontWeight: 800,
          fontSize: 'clamp(38px, 11vw, 56px)',
          lineHeight: 0.9,
          letterSpacing: '-0.03em',
          margin: '6px 0',
        }}>
          {noVotes ? '—' : winners.map((w) => w.name).join(' & ')}
        </div>
        {!noVotes && (
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, opacity: 0.85 }}>
            {winnerCount} vote{winnerCount === 1 ? '' : 's'}
          </div>
        )}
      </div>

      {myPick && (
        <div className="toast" style={{
          marginTop: 14,
          background: iWasRight ? 'var(--mint)' : 'var(--paper)',
          color: 'var(--ink)',
          border: '2px solid var(--ink)',
        }}>
          You voted for <b style={{ marginLeft: 4 }}>{myPick.name}</b>
          {iWasRight ? ' · matched!' : ''}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <div className="qmeta">Full tally</div>
        <div className="stack" style={{ gap: 8 }}>
          {sorted.map((p) => (
            <div key={p.id} className={`bar-row ${p.count === 0 ? 'zero' : ''}`} style={{
              gridTemplateColumns: '90px 1fr 32px',
            }}>
              <div className="nm" style={{ fontSize: 14 }}>{p.name}</div>
              <div className="bar-track" style={{ height: 18 }}>
                <div className="bar-fill" style={{
                  width: maxCount > 0 ? (p.count / maxCount * 100) + '%' : '0%',
                  background: p.color,
                }}></div>
              </div>
              <div className="vc" style={{ fontSize: 13 }}>{p.count}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ============================================================
// confetti helper
// ============================================================
function fireConfetti(big) {
  if (!window.confetti) return;
  const canvas = document.getElementById('confetti-canvas');
  const myConfetti = window.confetti.create(canvas, { resize: true, useWorker: true });
  const colors = ['#FF3D6E','#FFD60A','#2348FF','#00D68F','#FF6B35','#B47DFF'];
  if (big) {
    myConfetti({ particleCount: 200, spread: 100, origin: { y: 0.5 }, colors });
    setTimeout(() => myConfetti({ particleCount: 120, angle: 60, spread: 70, origin: { x: 0 }, colors }), 250);
    setTimeout(() => myConfetti({ particleCount: 120, angle: 120, spread: 70, origin: { x: 1 }, colors }), 400);
  } else {
    myConfetti({ particleCount: 110, spread: 75, origin: { y: 0.55 }, colors });
  }
}

// ============================================================
// ROOT
// ============================================================
function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route.route === 'host') return <HostView />;
  if (route.route === 'join') return <PlayerView initialCode={route.code} />;
  return <Home />;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

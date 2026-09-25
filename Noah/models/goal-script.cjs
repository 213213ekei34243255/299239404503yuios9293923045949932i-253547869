// Noah/models/goal-script.cjs
//
// "Do it like a person": a deterministic plan for the common browsing goal shapes, executed one visible action at a time.
//
//   "open youtube.com and search for lo-fi music, scroll down, pick the best one and play it"
//        -> click the search box, type the query key by key, press Enter, scroll the results twice with the wheel,
//           move to the most-viewed result and click it, press play if the video is paused.
//
// It exists for models that cannot plan a multi-step task themselves (the hosted text-only model guesses URLs and jumps
// straight to a video page, so nothing is ever typed or scrolled). Instead of trusting such a model to choose the next
// step, the goal is parsed here and each step is derived from the goal + what has already happened + what is on screen.
// A goal the parser does not recognise yields no script and the model is asked as before.

"use strict";

// "search" must stop BEFORE a trailing "play"/"and play" too - without it, "search for X play it" swallowed "play it"
// straight into the search query ("X play it"), instead of leaving "play it" for PLAY_RE to claim as its own step.
const SEARCH_END = "(?=[,;]|\\.(?=\\s|$)|\\s+(?:and|then|over here|here|on (?:this|the) (?:site|page|website)|play)\\b|\\s*$)";
const PICK_RE = /\b(?:search\s+for|look\s+for|find|pick|choose|select|open|click(?:\s+on)?|go\s+(?:with|for)|watch|play)\s+(?:the\s+)?(best|top|first|number one|#1|most\s+(?:popular|viewed|relevant)|highest[- ]rated)\s*(?:one|result|video|song|track|link|item|product|option)?/gi;
const SEARCH_RE = new RegExp(`\\b(?:search(?:\\s+for)?|look\\s+for|shop\\s+for|browse\\s+for)\\s+["“']?(.+?)["”']?${SEARCH_END}`, "gi");
const SCROLL_RE = /\bscroll(?:\s+(up|down))?(?:\s+(?:a\s+(?:bit|little)|through(?:\s+the\s+(?:results|page|list))?|the\s+(?:page|results)|to\s+see\s+more|for\s+a\s+while))?/gi;
const PLAY_RE = new RegExp(`\\bplay\\b(?:\\s+(?:the|that|this|it|a|some))?(?:\\s+(song|video|music|track|one)\\b)?(?:\\s+(.+?))?${SEARCH_END}`, "gi");
// "please"/"now"/"for me" etc trail a bare "play it" the way a person actually talks; none of them names a new title.
const PRONOUN_OBJECT = /^(it|that|this|them|the song|the video|the track|the music|the one|one|song|video|track|music|please|now|for me|here|too)$/i;

// A person asked to "search for the song named Cold by NCS" does not type that whole sentence into the search box - they
// type "Cold by NCS". Strip the naming filler a person would never type.
const NAMED_FILLER = /^(?:the|a|an)?\s*(?:song|track|tune|video|movie|show|episode|film)\s+(?:named|called|titled)\s+/i;
const GENERIC_LEAD = /^(?:the|a|an)\s+(?:song|track|tune|video|movie|show|episode|film)\s+/i;
/** "the song named Cold by NCS" -> "Cold by NCS"; "Cold" stays "Cold". */
function cleanSearchQuery(raw) {
  let q = String(raw || "").trim();
  q = q.replace(NAMED_FILLER, "");
  q = q.replace(GENERIC_LEAD, "");
  return q.trim() || String(raw || "").trim();
}

// "...by NCS", "...by Alan Walker": a single-word artist/channel qualifier is the common, safe case (a multi-word class
// would over-capture into whatever follows, e.g. "by NCS and play it").
const BY_ARTIST = /\bby\s+([A-Za-z][\w&'.-]{1,30})\b/i;
// The title of what is wanted, in either word order: "like <X> song/track/tune/music" or "song/track/tune named/called <X>".
const AFTER_LIKE = /\blike\s+([A-Za-z][\w' -]*?)(?=\s+(?:song|track|tune|music)\b|\s+by\b|[.,;!?]|\s+and\b|\s+if\b|$)/i;
const NAMED_TITLE = /\b(?:song|track|tune)\s+(?:named|called|titled)\s+["""]?([A-Za-z0-9][\w' -]*?)["""]?(?=\s+by\b|[.,;!?]|$)/i;
// "Find Cold by NCS on YouTube and play it": no "like"/"named", just the verb straight onto the title.
const FIND_TITLE = /\b(?:find(?:\s+me)?|get\s+me|discover|play|watch)\s+(?:the\s+)?([A-Za-z][\w' -]*?)(?=\s+by\b|\s+on\b|\s+and\b|[.,;!?]|$)/i;
// Only a "find X"/"play X" this bare implies media at all when the goal is clearly about media in the first place -
// otherwise "find the login button and click it" would wrongly be treated as something to search YouTube for.
const MEDIA_CONTEXT = /\b(?:song|track|tune|music|video|audio|mp3|playlist|album|youtube|spotify|soundcloud)\b/i;

/**
 * A goal phrased loosely ("find a song ... which can give us chill like Cold song ... by NCS") names what is wanted
 * without ever saying "search for": SEARCH_RE finds nothing. Pull the title/artist out with the shapes people actually
 * use ("like X song", "song named X", plain "find X by Y") plus an optional "by ARTIST", so there is a real query to
 * search for instead of falling through to the raw model with no scaffolding at all.
 * @returns {{ query: string, artist: string|null } | null}
 */
// After stripping generic filler, is there an actual title left, or was FIND_TITLE's greedy capture just "song please" /
// "the video" (nothing was really named)? "Play the song please" must NOT be treated as "search for a new thing called
// 'song please'" - it has no title at all, only a request to play whatever is already in front of the user.
const TITLE_FILLER = /\b(?:song|track|tune|video|music|audio|please|now|for me|here|too|the|a|an|it|that|this|them|one)\b/gi;
function hasRealTitle(title) {
  return !!String(title || "").replace(TITLE_FILLER, " ").trim();
}

function mediaQueryFrom(goal) {
  const g = String(goal || "");
  if (!MEDIA_CONTEXT.test(g)) return null;
  const artist = (BY_ARTIST.exec(g) || [])[1] || null;
  const title = ((AFTER_LIKE.exec(g) || [])[1] || (NAMED_TITLE.exec(g) || [])[1] || (FIND_TITLE.exec(g) || [])[1] || "").trim();
  if (!hasRealTitle(title)) return null;
  return { query: artist ? `${title} ${artist}` : title, artist };
}

const PLAY_VERB = /\b(?:play|watch|listen(?:\s+to)?|put\s+on|start\s+playing)\b/i;
const FIND_VERB = /\b(?:find(?:\s+me)?|get\s+me|discover|track\s+down|locate)\b/i;
const SEARCH_VERB = /\b(?:search(?:\s+for)?|look\s+for|shop\s+for|browse\s+for)\b/i;

// A goal that asks to answer/fill in/submit a FORM has real work this engine has no concept of: reading each question,
// choosing an appropriate answer, ticking the right box, typing into the right field. A reported bug: such a goal also
// happened to say "scroll", GoalScripts recognised only that one word, scrolled twice, and declared the WHOLE task
// "done" - "you are on Customer Feedback" - having answered nothing and submitted nothing. GoalScripts must stay out of
// these goals entirely (return no script at all) so the step-by-step model, which can actually read the page, handles
// them instead of a two-word fragment of the goal silently standing in for the rest of it.
const FORM_TASK = /\b(answer(?:s|ing)?(?:\s+(?:all|every|the))?\s+(?:the\s+)?questions?|fill(?:\s+(?:in|out))?\s+(?:this|the)\s+form|submit\s+(?:this|the)?\s*form|check\s?box(?:es)?|radio\s+button|drop\s?down|feedback\s+form|survey|questionnaire|multiple[\s-]choice)\b/i;
/** A goal that is clearly asking for MULTIPLE things across a form/questionnaire (as opposed to one field to type into). */
function looksLikeFormTask(goal) {
  return FORM_TASK.test(String(goal || ""));
}

/** @returns {Array<{kind:'search',query:string,artist?:string}|{kind:'scroll',dir:string,times:number}|{kind:'pick',which:'best'|'first',artist?:string}|{kind:'play'}>} */
function parseGoalScript(goal) {
  const g = String(goal || "").replace(/^\s*noah\s*[,:]\s*/i, "");
  if (FORM_TASK.test(g)) return [];
  const claims = [];
  const free = (m) => !claims.some((c) => m.index < c.end && c.at < m.index + m[0].length);
  const add = (m, step) => claims.push({ at: m.index, end: m.index + m[0].length, step });
  const artistInGoal = (BY_ARTIST.exec(g) || [])[1] || null;
  const withArtist = (step) => (artistInGoal ? { ...step, artist: artistInGoal } : step);

  for (const m of g.matchAll(PICK_RE)) add(m, withArtist({ kind: "pick", which: /first/i.test(m[1]) ? "first" : "best" }));
  for (const m of g.matchAll(SEARCH_RE)) {
    const query = cleanSearchQuery(m[1].replace(/\s+/g, " ").trim().replace(/[.,;]+$/, ""));
    if (free(m) && query.length >= 2 && query.length <= 120) add(m, { kind: "search", query });
  }
  for (const m of g.matchAll(SCROLL_RE)) {
    if (free(m)) add(m, { kind: "scroll", dir: (m[1] || "down").toLowerCase(), times: /through|for a while/i.test(m[0]) ? 3 : 2 });
  }
  const hasSearch = claims.some((c) => c.step.kind === "search");
  for (const m of g.matchAll(PLAY_RE)) {
    if (!free(m)) continue;
    const object = (m[2] || "").trim();
    if (object && !PRONOUN_OBJECT.test(object) && !hasSearch) {
      // "play lo-fi music": search for it, take the first result, play it
      add(m, { kind: "compound", steps: [{ kind: "search", query: object }, withArtist({ kind: "pick", which: "first" }), { kind: "play" }] });
    } else {
      add(m, { kind: "play" });
    }
  }
  let ordered = claims.sort((a, b) => a.at - b.at).flatMap((c) => (c.step.kind === "compound" ? c.step.steps : [c.step]));
  ordered = ordered.filter((s, i) => !(i > 0 && s.kind === "pick" && ordered[i - 1].kind === "pick"));

  // "search for X ... play it" (no "best"/"first" wording, so PICK_RE never fired) still needs something opened before
  // it can be played - playing is never valid straight from a results page. Insert the missing pick.
  const searchIdx = ordered.findIndex((s) => s.kind === "search");
  const playIdx = ordered.findIndex((s) => s.kind === "play");
  if (searchIdx !== -1 && playIdx !== -1 && searchIdx < playIdx && !ordered.some((s) => s.kind === "pick")) {
    ordered.splice(playIdx, 0, withArtist({ kind: "pick", which: "best" }));
  }

  // Nothing recognisable was said explicitly ("find a song ... like Cold ... by NCS"), or the goal named what to play
  // without ever using a "search"/"pick" verb ("find Cold by NCS and play it" -> PLAY_RE alone produces a lone,
  // unreachable {kind:'play'} with no preceding search/pick). Recover a script from the title+artist instead of handing
  // an empty or broken plan to the raw step model, which has no way to verify it actually found the right thing.
  const media = mediaQueryFrom(g);
  const brokenPlayOnly = ordered.length === 1 && ordered[0].kind === "play" && !hasSearch;
  if (media && (!ordered.length || brokenPlayOnly)) {
    const wantsPlay = PLAY_VERB.test(g) || brokenPlayOnly;
    // "find"/"get me" without an explicit search verb means "show me one", not merely "search": open the match.
    const wantsPick = wantsPlay || (FIND_VERB.test(g) && !SEARCH_VERB.test(g));
    const steps = [{ kind: "search", query: media.query }];
    if (wantsPick) steps.push({ kind: "pick", which: "best", ...(media.artist ? { artist: media.artist } : {}) });
    if (wantsPlay) steps.push({ kind: "play" });
    return steps;
  }
  return ordered;
}

// ------------------------------------------------------------------------------------------------ choosing a result

const MULT = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
/** "…by Lofi Girl 1.2M views 3 years ago" / "63,463,182 views" -> a number, or -1 when there is no count. */
function parseCount(name) {
  const m = /(\d[\d.,]*)\s*(thousand|million|billion|[KMB])?\s*(?:views|view|watching|vistas|visualizaciones|reproducciones|ratings|reviews|stars)\b/i.exec(String(name || ""));
  if (!m) return -1;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n * (m[2] ? MULT[m[2].toLowerCase()] : 1) : -1;
}

const CONTENT_HREF = /\/watch\?v=|\/video\/|\/dp\/|\/itm\/|\/track\/|\/album\/|\/wiki\//i;
// When a page gives no link URLs, a video result still announces itself: "... 3 hours, 25 minutes", "1.2M views", "watching".
const CONTENT_NAME = /\b\d+\s*(?:hours?|minutes?|seconds?)\b|\b\d[\d.,]*\s*(?:[KMB]|thousand|million|billion)?\s*(?:views|watching|vistas)\b/i;
const NOT_CONTENT_NAME = /^(go to channel|channel\b|subscribe|sign in|skip|home\b|shorts\b|history\b|library\b|explore\b)/i;
/**
 * The result a person would pick: among links that look like content (long names, below the page header, on screen),
 * the most-viewed for "best" (falls back to the first), or simply the first one.
 */
const AD_HREF = /googleadservices|doubleclick|googlesyndication|\/pagead\/|\/aclk|[?&]adurl=|[?&]gclid=/i;
const keyOf = (e) => e.href || e.name;
/** Does this result look like it is BY the named artist/channel ("by NCS")? Checked against everything we know about it. */
function matchesArtist(e, artist) {
  if (!artist) return true;
  const a = artist.toLowerCase();
  return [e.name, e.ctx, e.channel, e.nearby].some((s) => s && String(s).toLowerCase().includes(a));
}
/**
 * @param {{artist?: string}} [opts] when given, a result BY that artist/channel is preferred over a merely popular one;
 *   never invented from nothing - if nothing matches, the caller is told via `artistMatched: false` on the return value.
 */
function chooseResult(els, which, viewportHeight, { exclude = new Set(), requireContent = false, artist } = {}) {
  const H = viewportHeight || 1e9;
  let links = (els || []).filter((e) => e.role === "link" && e.name && e.name.length >= 12 && e.rect && e.rect.y > 60 && e.rect.y < H - 8 && !/^(ad|sponsored)\b|\bsponsored\b/i.test(e.name) && !AD_HREF.test(e.href || "") && !exclude.has(keyOf(e)));
  const contentLike = links.filter((e) => !/\/shorts\//i.test(e.href || "") && !NOT_CONTENT_NAME.test(e.name) && (CONTENT_HREF.test(e.href || "") || CONTENT_NAME.test(e.name)));
  if (requireContent && !contentLike.length) return null;
  if (contentLike.length) links = contentLike;
  const byHref = new Map();
  for (const e of links) {
    const key = e.href || `${e.name}|${Math.round(e.rect.y)}`;
    if (!byHref.has(key) || e.name.length > byHref.get(key).name.length) byHref.set(key, e);
  }
  let list = [...byHref.values()].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (!list.length) return null;
  const artistMatched = list.filter((e) => matchesArtist(e, artist));
  // Prefer a result really from the named artist/channel over the merely most-popular one (the reported bug: the top
  // view-count result for "Cold" was "Maroon 5 - Cold", not the requested NCS release). Only narrow the list when
  // something actually matches; never invent a match.
  if (artist && artistMatched.length) list = artistMatched;
  const pick = (l) => {
    if (which === "best") {
      const scored = l.map((e) => ({ e, n: parseCount(e.name) })).filter((s) => s.n >= 0);
      if (scored.length) return scored.sort((a, b) => b.n - a.n)[0].e;
    }
    return l[0];
  };
  const chosen = pick(list);
  if (!chosen) return null;
  return artist ? { ...chosen, artistMatched: artistMatched.length > 0 && list === artistMatched } : chosen;
}

// ------------------------------------------------------------------------------------------------------- the engine

const isSearchBox = (e) => e.role === "searchbox" || (/^(textbox|combobox)$/.test(e.role) && /search|query|buscar|find|look/i.test(e.name || ""));
const PLAY_BUTTON = /^(play|reproducir)\b(?!\s*(all|todo|next|siguiente))/i;
const siteOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
};
const MEDIA_URL =/[?&]v=|\/watch|\/video\/|\/track\/|\/song\/|\/play|\/listen/i;

class GoalScripts {
  constructor() {
    this._s = new Map(); // taskId -> state
  }

  /**
   * @param {object} c { taskId, goal, obs, els, recent:[{text,ok}], needsAnswer }
   * @returns {null | { status:'continue'|'done', summary:string, method?:string, actions?:object[], result?:string }}
   *   null = no script applies here; ask the model as usual.
   */
  next(c) {
    const { taskId, goal, obs, els, recent, needsAnswer = false } = c;
    if (!/^https?:/i.test(obs.url || "")) return null; // still on Jonah's own page: opening the site comes first
    let st = this._s.get(taskId);
    if (!st) {
      st = { steps: parseGoalScript(goal), i: 0, sub: 0, pending: null, retries: 0, waits: 0, pickTries: 0, pickWaits: 0, playWaits: 0, repicks: 0, bad: new Set(), chosen: null, chosenKey: null, pickedFrom: null, pressedPlay: false, log: [] };
      this._s.set(taskId, st);
      if (this._s.size > 20) this._s.delete(this._s.keys().next().value);
    }
    if (!st.steps.length || st.dead) return null;

    // 1) settle what our previous action turned out to be
    if (st.pending) {
      const last = recent[recent.length - 1];
      const ok = !!last && last.ok !== false && new RegExp(`^${st.pending.verb}\\b`).test(String(last.text || ""));
      const p = st.pending;
      st.pending = null;
      if (ok) p.commit();
      else {
        if (++st.retries > 4) {
          st.dead = true; // it keeps failing: hand the task back to the model rather than loop
          return null;
        }
        st.lastFailure = String((last && last.text) || "");
        st.recover = true; // fix the situation (reveal a hidden box, let the page settle) before trying again
      }
    }
    // When the goal also asks for information ("...and tell me the price"), the visible steps are only the way there: hand
    // back to the model, whose answer step reads the page.
    const finish = () => {
      if (needsAnswer) { st.dead = true; return null; }
      return { status: "done", summary: "Finished the steps", result: this._summary(st, obs) };
    };
    if (st.i >= st.steps.length) return finish();

    const step = st.steps[st.i];
    const act = (summary, action, verb, commit, method = "ax") => {
      st.pending = { verb, commit };
      return { status: "continue", summary, method, actions: [action] };
    };
    const wait = (why, counter = "waits") => act(why, { action: "wait", ms: 1200 }, "wait", () => { st[counter]++; });

    // The last attempt failed. A person would not just repeat it: if the field was off-screen (a narrow window collapses
    // YouTube's search box into a magnifier icon) open it first; otherwise give the page a moment to finish loading.
    if (st.recover) {
      st.recover = false;
      if (/offscreen|not[_ ]visible|hidden|obscured/i.test(st.lastFailure || "") && !st.revealedOnce) {
        const icon = els.find((e) => e.role === "button" && /^(search|buscar)\b/i.test(e.name || "") && !/voice|voz/i.test(e.name || ""));
        if (icon) {
          st.revealedOnce = true;
          return act("Opening the search box", { action: "click", target: { ref: icon.ref } }, "click", () => {});
        }
        return act("Scrolling back to the top of the page", { action: "scroll", direction: "up", amount: 900 }, "scroll", () => {});
      }
      return wait("Letting the page settle", "waits");
    }

    switch (step.kind) {
      case "search": {
        const box = els.find(isSearchBox);
        if (!box) return st.waits < 3 ? wait("Waiting for the search box") : ((st.dead = true), null);
        return act(`Searching for "${step.query}"`, { action: "type", target: { ref: box.ref }, text: step.query, clear: true, submit: true }, "type", () => { st.log.push(`searched for "${step.query}"`); st.i++; });
      }
      case "scroll":
        return act(`Scrolling ${step.dir} to look through the results`, { action: "scroll", direction: step.dir, amount: 450 }, "scroll", () => {
          if (++st.sub >= step.times) { st.log.push(`scrolled ${step.dir}`); st.sub = 0; st.i++; }
        });
      case "pick": {
        const H = obs.viewport && obs.viewport.height;
        // results may still be loading: look for real content links first (scroll, then wait), only then settle for any link
        const target = chooseResult(els, step.which, H, { exclude: st.bad, requireContent: st.pickTries < 4, artist: step.artist });
        if (!target && st.pickTries < 4) {
          const n = st.pickTries++;
          return n < 2 ? act("Scrolling to find a result", { action: "scroll", direction: "down", amount: 450 }, "scroll", () => {}) : wait("Waiting for the results to load", "pickWaits");
        }
        if (!target) {
          st.dead = true;
          return null;
        }
        // Honest, not silent: if an artist/channel was named and NOTHING matched it, say so instead of quietly opening the
        // most popular unrelated result and calling it done.
        if (step.artist && !target.artistMatched) st.artistUnmatched = step.artist;
        return act(`Opening ${step.which === "best" ? "the most-watched" : "the first"} result`, { action: "click", target: { ref: target.ref } }, "click", () => {
          st.chosen = target.name.replace(/\s+/g, " ").slice(0, 90);
          st.chosenKey = keyOf(target);
          st.pickedFrom = obs.url;
          st.log.push(`opened "${st.chosen}"`);
          st.i++;
        });
      }
      case "play": {
        // it only counts as a video page if it IS one (or the same site moved on): an ad or a dead link is not
        const onMedia = MEDIA_URL.test(obs.url || "") || (!!st.pickedFrom && siteOf(obs.url) === siteOf(st.pickedFrom) && obs.url !== st.pickedFrom);
        if (!onMedia) {
          // A bare "play"/"play it"/"play the song please" with nothing picked yet - typically a short follow-up sent
          // as its own message, already sitting on the results page an earlier search left open. Open the best real
          // result here, the way a person would, instead of only ever waiting for a video that nothing opened.
          if (!st.pickedFrom && !st.chosenKey && st.pickTries < 4) {
            const H = obs.viewport && obs.viewport.height;
            const target = chooseResult(els, "best", H, { exclude: st.bad, requireContent: st.pickTries < 3, artist: step.artist });
            if (target) {
              if (step.artist && !target.artistMatched) st.artistUnmatched = step.artist;
              return act(`Opening ${step.which === "first" ? "the first" : "the most-watched"} result`, { action: "click", target: { ref: target.ref } }, "click", () => {
                st.chosen = target.name.replace(/\s+/g, " ").slice(0, 90);
                st.chosenKey = keyOf(target);
                st.pickedFrom = obs.url;
                st.log.push(`opened "${st.chosen}"`);
              });
            }
            const n = st.pickTries++;
            return n < 2 ? act("Scrolling to find a result", { action: "scroll", direction: "down", amount: 450 }, "scroll", () => {}) : wait("Waiting for the results to load", "pickWaits");
          }
          if (st.playWaits < 3) return wait("Waiting for the page to open", "playWaits");
          if (st.repicks < 2 && st.chosenKey) {
            // the click did not open anything playable: go back to choosing, without that result
            st.bad.add(st.chosenKey);
            st.repicks++;
            st.playWaits = 0;
            st.pickTries = 0;
            st.log.pop();
            st.i = Math.max(0, st.steps.slice(0, st.i).map((x) => x.kind).lastIndexOf("pick"));
            return this.next(c);
          }
          st.dead = true;
          return null;
        }
        const btn = els.find((e) => e.role === "button" && PLAY_BUTTON.test(e.name || "") && !/pause|pausa/i.test(e.name || ""));
        if (btn && !st.pressedPlay) return act("Pressing play", { action: "click", target: { ref: btn.ref } }, "click", () => { st.pressedPlay = true; st.log.push("pressed play"); st.i++; });
        st.log.push("it is playing");
        st.i++;
        return finish();
      }
      default:
        st.dead = true;
        return null;
    }
  }

  _summary(st, obs) {
    const what = st.log.length ? st.log.join(", ") : "did the steps";
    // "Done" must mean what actually happened, not what was hoped for: if an artist/channel was named and nothing
    // on screen matched it, say so rather than silently presenting an unrelated result as the answer.
    const caveat = st.artistUnmatched ? ` I could not find one by ${st.artistUnmatched}, so this is the closest match I found - please check it is the right one.` : "";
    return `Done: ${what}. You are on ${obs.title || obs.url}.${caveat}`;
  }
}

module.exports = { parseGoalScript, chooseResult, parseCount, siteOf, GoalScripts, looksLikeFormTask };

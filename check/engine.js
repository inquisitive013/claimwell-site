/* Claimwell engines: the rules behind the guided check, search, the scam checker, the data contract and saved
   answers. Pure functions with no page access, so the same file runs in the web app, under Node for tests, and
   later inside the phone apps. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ClaimwellEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

/* ---------- dates (ISO "YYYY-MM-DD" strings; compared as text) ---------- */
const DAY = 864e5;
const pad = n => String(n).padStart(2, "0");
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = s => new Date(s + "T00:00:00");
const daysBetween = (from, to) => Math.round((parseDay(to) - parseDay(from)) / DAY);
const isDay = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && isoDay(parseDay(v)) === v;

function effStatus(s, today) {
  if (s.status === "closed") return "ended";
  if (s.status === "auto") return "auto";
  if (s.deadline && s.deadline < today) return "ended";
  if (s.status === "soon" && s.opens && s.opens > today) return "soon";
  return "open";
}

/* ---------- text ---------- */
// Lowercase, strip accents, and turn the curly quotes and dashes phones insert into plain ones.
function fold(s) {
  return String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-").replace(/[   ]/g, " ").toLowerCase();
}
function words(s) {
  // "non-prescription" is one word, so it never matches a search for "prescription".
  return fold(s).replace(/&/g, " and ").replace(/\bnon-(?=[a-z])/g, "non").replace(/'s\b/g, "s").replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !/\d/.test(w)) return w.slice(0, -1);
  return w;
}
const stems = s => words(s).map(stem);

/* ---------- data contract (same rules as claimwell_pipeline/contract.py) ---------- */
const TYPES = {
  string: v => typeof v === "string", number: v => typeof v === "number" && isFinite(v),
  integer: v => Number.isInteger(v), boolean: v => typeof v === "boolean",
  array: v => Array.isArray(v), object: v => v !== null && typeof v === "object" && !Array.isArray(v), null: v => v === null
};
function validate(value, sch, path, root) {
  if (sch.$ref) {
    const target = root.$defs[sch.$ref.split("/").pop()];
    const extra = Object.assign({}, sch); delete extra.$ref; delete extra.description;
    return validate(value, target, path, root).concat(Object.keys(extra).length ? validate(value, extra, path, root) : []);
  }
  if (sch.anyOf) {
    const branches = sch.anyOf.map(b => validate(value, b, path, root));
    if (branches.every(b => b.length)) return [branches.reduce((a, b) => (b.length < a.length ? b : a))[0]];
  }
  const errs = [];
  if (sch.type !== undefined) {
    const ts = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!ts.some(t => TYPES[t](value))) return [`${path}: expected ${ts.join(" or ")}`];
  }
  if ("const" in sch && value !== sch.const) errs.push(`${path}: must be ${JSON.stringify(sch.const)}`);
  if (sch.enum && !sch.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} is not allowed`);
  if (typeof value === "string") {
    if (sch.minLength != null && value.length < sch.minLength) errs.push(`${path}: too short`);
    if (sch.maxLength != null && value.length > sch.maxLength) errs.push(`${path}: longer than ${sch.maxLength} characters`);
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) errs.push(`${path}: wrong format`);
    else if (sch.format === "date" && !isDay(value)) errs.push(`${path}: not a real date`);
  }
  if (TYPES.number(value)) {
    if (sch.minimum != null && value < sch.minimum) errs.push(`${path}: below ${sch.minimum}`);
    if (sch.maximum != null && value > sch.maximum) errs.push(`${path}: above ${sch.maximum}`);
  }
  if (Array.isArray(value)) {
    if (sch.minItems != null && value.length < sch.minItems) errs.push(`${path}: needs at least ${sch.minItems}`);
    if (sch.maxItems != null && value.length > sch.maxItems) errs.push(`${path}: more than ${sch.maxItems}`);
    if (sch.items) value.forEach((v, i) => { errs.push(...validate(v, sch.items, `${path}[${i}]`, root)); });
  }
  if (TYPES.object(value)) {
    const props = sch.properties || {};
    (sch.required || []).forEach(k => { if (!(k in value)) errs.push(`${path}: missing ${k}`); });
    Object.keys(value).forEach(k => {
      if (props[k]) errs.push(...validate(value[k], props[k], `${path}.${k}`, root));
      else if (sch.additionalProperties === false) errs.push(`${path}: unexpected field ${k}`);
      else if (sch.additionalProperties && typeof sch.additionalProperties === "object") errs.push(...validate(value[k], sch.additionalProperties, `${path}.${k}`, root));
    });
  }
  return errs;
}
const PAYISH_KEY = /^pay(ment|out)?[_-]?(method|type|option|choice)?s?$/i;
function semantic(r, path, schema) {
  const errs = [];
  if (r.status !== "auto" && !r.deadline) errs.push(`${path}: needs a deadline unless payment is automatic`);
  if (r.status === "soon" && !r.opens) errs.push(`${path}: status soon needs an opens date`);
  if (r.opens && r.deadline && r.opens > r.deadline) errs.push(`${path}: opens after the deadline`);
  if (Array.isArray(r.classPeriod) && r.classPeriod.length === 2 && r.classPeriod[0] > r.classPeriod[1]) errs.push(`${path}.classPeriod: starts after it ends`);
  const est = r.est || {};
  if (typeof est.lo === "number" && typeof est.hi === "number" && est.lo > est.hi) errs.push(`${path}.est: lo is above hi`);
  const keys = [];
  (Array.isArray(r.ready) ? r.ready : []).forEach((f, i) => {
    if (!f || typeof f !== "object") return;
    const k = f.key || ""; keys.push(k);
    if (f.src === "choice" && !(f.options && f.options.length)) errs.push(`${path}.ready[${i}]: a choice needs options`);
    if (f.src !== "choice" && f.options) errs.push(`${path}.ready[${i}]: only a choice has options`);
    if (PAYISH_KEY.test(k) && k !== "pay") errs.push(`${path}.ready[${i}]: payment method must use the key pay`);
    if (k === "pay" && f.src !== "choice") errs.push(`${path}.ready[${i}]: pay must be a choice`);
  });
  if (new Set(keys).size !== keys.length) errs.push(`${path}.ready: duplicate keys`);
  const allowed = new Set((schema["x-profileKeys"] || []).concat(keys));
  (String(r.template || "").match(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g) || []).forEach(m => { if (!allowed.has(m.slice(1, -1))) errs.push(`${path}.template: unknown ${m}`); });
  const people = [r.name, r.short, r.payout, r.proofDetail, r.effort && r.effort.docs, r.est && r.est.text].concat(r.whosIn || [], r.needs || []).join(" ").toLowerCase();
  (schema["x-reviewerOnlyPhrases"] || []).forEach(p => { if (new RegExp("\\b" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(people)) errs.push(`${path}: reviewer-only wording "${p}"`); });
  return errs;
}
function checkRecord(r, schema) {
  const path = `settlement ${r && r.id || "?"}`;
  const errs = validate(r, { $ref: "#/$defs/settlement" }, path, schema);
  return TYPES.object(r) ? errs.concat(semantic(r, path, schema)) : errs;
}
// Split a loaded file into records the app can use and ones it must skip. Accepts the older bare list too.
function loadDocument(data, schema) {
  const doc = Array.isArray(data) ? { schemaVersion: 1, settlements: data } : (data || {});
  const supported = schema.properties.schemaVersion.const;
  const out = { version: doc.schemaVersion, supported, generated: isDay(doc.generated) ? doc.generated : null, synonyms: TYPES.object(doc.synonyms) ? doc.synonyms : {}, records: [], rejected: [] };
  const seen = new Set();
  (Array.isArray(doc.settlements) ? doc.settlements : []).forEach(r => {
    const errs = checkRecord(r, schema);
    if (!errs.length && seen.has(r.id)) errs.push(`duplicate id ${r.id}`);
    if (errs.length) out.rejected.push({ id: r && r.id, errors: errs }); else { seen.add(r.id); out.records.push(r); }
  });
  return out;
}

/* ---------- eligibility: one state per settlement, fed by both the check and the screener ---------- */
// Screener answers are keyed by a hash of the question text, so reordering or adding questions in a refresh
// can't move an answer onto a different question. A reworded question simply asks again.
function qkey(q) {
  const t = fold(q.q).replace(/\s+/g, " ").trim(); let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function screenAnswers(s, P) {
  const given = (P.answers && P.answers[s.id]) || {}, door = P.door && P.door[s.id];
  return (s.questions || []).map(q => {
    const k = qkey(q);
    if (given[k]) return { q, k, v: given[k], implied: false };
    if (door === "yes" && q.sameAsDoor) return { q, k, v: q.ok, implied: true };
    return { q, k, v: null, implied: false };
  });
}
function verdict(s, P) {
  const a = screenAnswers(s, P);
  const bad = a.find(x => x.v && x.v !== "unsure" && x.v !== x.q.ok);
  if (bad) return { kind: "no", reason: bad.q.no };
  const left = a.filter(x => !x.v).length;
  if (left) return { kind: "pending", left, total: a.length };
  const unsure = a.filter(x => x.v === "unsure").map(x => x.q);
  return unsure.length ? { kind: "maybe", unsure } : { kind: "yes" };
}
// likely: every screening question answered the qualifying way · possible: said yes in the check
// unsure: said "not sure" · ruled_out: a screening answer excludes them · none: no signal at all
function eligibility(s, P) {
  const v = verdict(s, P), door = P.door && P.door[s.id];
  const explicit = screenAnswers(s, P).some(x => x.v && !x.implied);
  if (v.kind === "no") return { kind: "ruled_out", reason: v.reason };
  if (v.kind === "yes" && (s.questions || []).length) return { kind: "likely" };
  if (door === "yes") return { kind: "possible" };
  if (door === "unsure") return { kind: "unsure" };
  if (explicit) return { kind: v.kind === "maybe" ? "unsure" : "possible" };
  return { kind: "none" };
}
const stateFits = (s, P) => !s.states || !P.statesAnswered || s.states.some(c => P.states.includes(c));
function classify(S, P, today) {
  const out = { matches: [], unsure: [], ruledOut: [] };
  S.forEach(s => {
    if (effStatus(s, today) === "ended") return;
    const e = eligibility(s, P);
    if (e.kind === "none") return;
    // Answers from the quick check only count where the person's states fit; a fully answered screener stands on its own.
    if ((e.kind === "possible" || e.kind === "unsure") && !stateFits(s, P)) return;
    const row = { s, e };
    if (e.kind === "likely" || e.kind === "possible") out.matches.push(row);
    else if (e.kind === "unsure") out.unsure.push(row);
    else out.ruledOut.push(row);
  });
  return out;
}

/* ---------- the guided check, built from the data ---------- */
const live = (S, today) => S.filter(s => s.door && effStatus(s, today) !== "ended");
function stateOptions(S, today) {
  const m = new Map();
  live(S, today).filter(s => s.states).forEach(s => s.states.forEach(c => {
    const o = m.get(c) || { code: c, from: null, to: null, count: 0 };
    o.count++;
    if (s.classPeriod) {
      if (!o.from || s.classPeriod[0] < o.from) o.from = s.classPeriod[0];
      if (!o.to || s.classPeriod[1] > o.to) o.to = s.classPeriod[1];
    }
    m.set(c, o);
  }));
  const yearAgo = isoDay(new Date(parseDay(today).getTime() - 365 * DAY));
  return [...m.values()].map(o => Object.assign(o, {
    when: !o.from ? "" : o.to && o.to < yearAgo ? `${o.from.slice(0, 4)} to ${o.to.slice(0, 4)}` : `since ${o.from.slice(0, 4)}`
  }));
}
function doorsFor(topic, S, P, today) {
  const all = live(S, today).filter(s => s.door.group === topic);
  const shown = all.filter(s => stateFits(s, P)).sort((a, b) => a.door.label.localeCompare(b.door.label));
  return { shown, hidden: all.length - shown.length };
}
function topicOptions(S, P, today, order) {
  return order.filter(t => t !== "broad").map(t => {
    const d = doorsFor(t, S, P, today).shown;
    return { topic: t, count: d.length, examples: d.slice(0, 3).map(s => s.short) };
  }).filter(o => o.count);
}
function steps(S, P, today, order) {
  const out = [];
  if (stateOptions(S, today).length) out.push({ id: "where" });
  if (doorsFor("broad", S, P, today).shown.length) out.push({ id: "broad", topic: "broad" });
  out.push({ id: "topics" });
  order.forEach(t => { if (t !== "broad" && P.topics.includes(t) && doorsFor(t, S, P, today).shown.length) out.push({ id: "t:" + t, topic: t }); });
  return out;
}

/* ---------- saved answers: validate, never trust ---------- */
const STATE_VERSION = 3;
const PROFILE_KEYS = ["name", "address", "email", "phone", "first", "last", "street", "street2", "city", "state", "zip"];
function blankState() {
  return { v: STATE_VERSION, step: null, done: false, states: [], statesAnswered: false, topics: [], door: {}, answers: {},
    profile: { name: "", address: "", email: "", phone: "", first: "", last: "", street: "", street2: "", city: "", state: "", zip: "" }, sheet: {}, filed: [], contact: { email: "", phone: "" }, seen: null, lastVisit: null, remindersOn: false };
}
// The old guided check (saved-state v2) stored answers by question position. This is the order it shipped with.
const V2_STEPS = { yn: { 1: "atm-surcharge", 2: "realpage-renters", 3: "apple-intelligence", 4: "goodrx" },
  multi: { 5: ["kroger-rx", "davita-breach", "tenet-pixel", "prime-pixel", "columbia-breach"],
    6: ["hyundai-kia-acu", "hyundai-kia-acu", "sonata-phev-battery", "progressive-co-total-loss"],
    7: ["bofa-efta", "equifax-score", "merrill-edge-sweep", "vanilla-gift-card"],
    8: ["elanco-flea-tick", "bigelow-tea", "knotts-great-america", "costa-florida", "thinkware-dashcam", "high5-games"] } };
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (typeof v === "string" ? v.slice(0, max || 500) : "");
const ANS = new Set(["yes", "no", "unsure"]);
function sanitizeState(raw, today) {
  const P = blankState();
  if (!isObj(raw)) return P;
  try {
    P.done = raw.done === true;
    P.step = typeof raw.step === "string" ? raw.step.slice(0, 40) : null;
    P.states = Array.isArray(raw.states) ? [...new Set(raw.states.filter(c => typeof c === "string" && /^[A-Z]{2}$/.test(c)))] : [];
    P.statesAnswered = raw.statesAnswered === true || P.states.length > 0;
    P.topics = Array.isArray(raw.topics) ? [...new Set(raw.topics.filter(t => typeof t === "string" && /^[a-z]{2,20}$/.test(t)))] : [];
    if (isObj(raw.door)) Object.entries(raw.door).forEach(([k, v]) => { if ((v === "yes" || v === "unsure") && k.length < 80) P.door[k] = v; });
    if (isObj(raw.answers)) Object.entries(raw.answers).forEach(([sid, a]) => {
      if (isObj(a)) { const o = {}; Object.entries(a).forEach(([k, v]) => { if (ANS.has(v)) o[k] = v; }); P.answers[sid] = o; }
      else if (Array.isArray(a)) P.answers[sid] = { _byIndex: a.map(v => (ANS.has(v) ? v : null)) };
    });
    // name and address are single lines (the web app's form); the rest are the separate fields claim forms ask for.
    if (isObj(raw.profile)) PROFILE_KEYS.forEach(k => { P.profile[k] = str(raw.profile[k], 300); });
    if (isObj(raw.sheet)) Object.entries(raw.sheet).forEach(([sid, o]) => {
      if (!isObj(o)) return; const c = {};
      Object.entries(o).forEach(([k, v]) => { if (typeof v === "string") c[PAYISH_KEY.test(k) ? "pay" : k] = v.slice(0, 1000); });
      P.sheet[sid] = c;
    });
    if (Array.isArray(raw.filed)) {
      const seen = new Set();
      raw.filed.forEach(f => {
        if (!isObj(f) || typeof f.sid !== "string" || seen.has(f.sid)) return; seen.add(f.sid);
        const amt = typeof f.paidAmt === "number" && isFinite(f.paidAmt) && f.paidAmt >= 0 ? f.paidAmt : null;
        P.filed.push({ sid: f.sid, filedOn: isDay(f.filedOn) ? f.filedOn : today, conf: str(f.conf, 120), pay: str(f.pay || f.payment_method, 40),
          expiry: isDay(f.expiry) ? f.expiry : "", paid: f.paid === true, paidAmt: f.paid === true ? amt : null,
          // A snapshot taken when filing, so the claim stays trackable after the settlement leaves the list.
          name: str(f.name, 160), administrator: str(f.administrator, 80),
          officialUrl: typeof f.officialUrl === "string" && /^https:\/\/[^\s<>"]+$/.test(f.officialUrl) ? f.officialUrl.slice(0, 300) : "" });
      });
    }
    if (isObj(raw.contact)) { P.contact.email = str(raw.contact.email, 200); P.contact.phone = str(raw.contact.phone, 40); }
    P.seen = Array.isArray(raw.seen) ? raw.seen.filter(x => typeof x === "string") : null;
    P.lastVisit = isDay(raw.lastVisit) ? raw.lastVisit : null;
    P.remindersOn = raw.remindersOn === true;
    if (raw.v !== STATE_VERSION) {  // v2 guided-check answers
      if (isObj(raw.yn)) Object.entries(raw.yn).forEach(([i, v]) => { const sid = V2_STEPS.yn[i]; if (sid && (v === "yes" || v === "unsure")) P.door[sid] = v; });
      if (isObj(raw.multi)) Object.entries(raw.multi).forEach(([i, ks]) => { const opts = V2_STEPS.multi[i]; if (opts && Array.isArray(ks)) ks.forEach(k => { if (opts[k]) P.door[opts[k]] = "yes"; }); });
      P.step = null;
    }
  } catch (e) {
    const keep = P.filed; const fresh = blankState(); fresh.filed = keep; return fresh;
  }
  return P;
}
// Second half of loading saved answers: needs the settlements, to map old position-keyed answers and derive topics.
function finishState(P, S) {
  const byId = new Map(S.map(s => [s.id, s]));
  Object.entries(P.answers).forEach(([sid, a]) => {
    if (!a._byIndex) return;
    const s = byId.get(sid), o = {};
    if (s) a._byIndex.forEach((v, i) => { if (v && s.questions[i]) o[qkey(s.questions[i])] = v; });
    P.answers[sid] = o;
  });
  Object.keys(P.door).forEach(sid => { const s = byId.get(sid); if (s && s.door && s.door.group !== "broad" && !P.topics.includes(s.door.group)) P.topics.push(s.door.group); });
  return P;
}

/* ---------- the payout line on each card ---------- */
// When the notice says amounts go up or down with the number of claims, "$25 per iPhone" is an estimate, so it
// reads "About $25 per iPhone". Fixed amounts ("$20") and lines that already qualify themselves stay as they are.
function estLabel(s) {
  const t = (s && s.est && s.est.text) || "";
  if (!t || /^(about|est|up to|around|roughly|approx)|not set|share|based on|depends/i.test(t)) return t;
  return /pro ?rata|increase|decrease|adjust|depend|estimat|number of (claims|valid)/i.test((s && s.payout) || "") ? "About " + t : t;
}

/* ---------- money typed by people ---------- */
// "$24.50", "1,200.00", "24,50" (decimal comma) and "USD 30" all read as amounts; anything else is rejected
// rather than guessed ("1,200.00" used to become $1, and "Infinity" was accepted).
function parseMoney(input) {
  let t = String(input == null ? "" : input).trim().replace(/^(usd|us\$)/i, "").replace(/usd$/i, "").replace(/[$\s]/g, "");
  if (!t) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const v = Number(t);
  return isFinite(v) && v >= 0 && v < 1e7 ? Math.round(v * 100) / 100 : null;
}

/* ---------- search ---------- */
const STOP = new Set("a an the of and or for in on at to my i me we our your you with by from is are was were be do did have has had it its this that any some about get got settlement settlements class action lawsuit lawsuits case claim claims".split(" "));
function buildIndex(S, synonyms) {
  const recs = S.map(s => {
    const fields = [[5, [s.short].concat(s.aliases)], [4, [s.name]], [3, [s.door && s.door.label, s.caption]],
      [2, [s.category, s.door && s.door.note, s.administrator]], [1, (s.whosIn || []).concat(s.needs || [])]];
    const tok = new Map(), phrases = [];
    const put = (k, w) => { if (k && !STOP.has(k) && !/^[a-z]$/.test(k)) tok.set(k, Math.max(tok.get(k) || 0, w)); };
    fields.forEach(([w, list]) => list.filter(Boolean).forEach(t => {
      const ws = stems(t); ws.forEach(x => put(x, w));
      if (w >= 3 && ws.length) { phrases.push(ws.join(" ")); if (ws.length > 1) put(ws.join(""), w); }
    }));
    return { s, tok, phrases };
  });
  const vocab = new Set(); recs.forEach(r => r.tok.forEach((_, k) => vocab.add(k)));
  const syn = new Map();
  Object.entries(synonyms || {}).forEach(([k, v]) => { if (Array.isArray(v)) syn.set(stems(k).join(" "), v.map(x => stems(x).join(" ")).filter(Boolean)); });
  return { recs, vocab, syn };
}
function altScore(alt, r) {
  const parts = alt.split(" ");
  if (parts.length === 1) return r.tok.get(alt) || 0;
  let w = Infinity;
  for (const p of parts) { if (STOP.has(p) || /^[a-z]$/.test(p)) continue; const t = r.tok.get(p); if (!t) return 0; w = Math.min(w, t); }
  if (w === Infinity) return 0;
  return w * (r.phrases.some(ph => (" " + ph + " ").includes(" " + alt + " ")) ? 1.2 : 0.9);
}
// Bounded Damerau-Levenshtein: returns the distance, or -1 if it's over the limit.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return -1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v); rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return -1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length] <= max ? prev[b.length] : -1;
}
function parseQuery(q, ix) {
  const ws = stems(q), slots = [];
  const compact = ws.filter(w => !STOP.has(w)).join("");
  if (ws.length > 1 && compact.length > 3 && ix.vocab.has(compact)) return { slots: [{ text: compact, alts: [compact] }], full: ws.join(" ") };
  for (let i = 0; i < ws.length;) {
    let took = 0;
    for (let len = Math.min(4, ws.length - i); len >= 2 && !took; len--) {
      const ph = ws.slice(i, i + len).join(" ");
      if (ix.syn.has(ph)) { slots.push({ text: ph, alts: [ph].concat(ix.syn.get(ph)) }); took = len; }
    }
    if (took) { i += took; continue; }
    const w = ws[i++];
    if (!STOP.has(w) && !/^[a-z]$/.test(w)) slots.push({ text: w, alts: [w].concat(ix.syn.get(w) || []) });
  }
  return { slots, full: ws.join(" ") };
}
// Whole words, synonyms, typo tolerance and as-you-type prefixes. Typos and prefixes are only tried for a word
// nothing matches exactly, so "car" never turns into "card", and "gas" never matches inside "Vegas".
function search(q, ix, typing) {
  const { slots, full } = parseQuery(q, ix);
  if (!slots.length) return { empty: true, best: [], partial: [], fixes: [] };
  const fixes = [];
  const exp = slots.map((sl, i) => {
    const hit = ix.recs.some(r => sl.alts.some(a => altScore(a, r) > 0));
    const extra = [];
    if (!hit && !sl.text.includes(" ")) {
      const w = sl.text;
      if (w.length >= 4) ix.vocab.forEach(v => { if (v[0] === w[0] && v.length >= 3 && !/^\d+$/.test(v)) { const d = editDistance(w, v, w.length >= 8 ? 2 : 1); if (d > 0) extra.push({ alt: v, f: d === 1 ? 0.75 : 0.6 }); } });
      if (typing && i === slots.length - 1 && w.length >= 2) ix.vocab.forEach(v => { if (v.length > w.length && v.startsWith(w)) extra.push({ alt: v, f: 0.8, prefix: true }); });
      if (extra.length && !typing) fixes.push({ from: w, to: extra.slice().sort((a, b) => b.f - a.f)[0].alt });
    }
    return Object.assign({}, sl, { extra });
  });
  const res = [];
  ix.recs.forEach(r => {
    let matched = 0, score = 0;
    exp.forEach(sl => {
      let best = 0;
      sl.alts.forEach((a, k) => { best = Math.max(best, altScore(a, r) * (k ? 0.85 : 1)); });
      sl.extra.forEach(e => { best = Math.max(best, altScore(e.alt, r) * e.f); });
      if (best > 0) { matched++; score += best; }
    });
    if (!matched) return;
    r.phrases.forEach(ph => { if (ph === full) score += 6; else if ((" " + ph + " ").includes(" " + full + " ")) score += 2; });
    res.push({ s: r.s, coverage: matched / slots.length, score });
  });
  res.sort((a, b) => b.coverage - a.coverage || b.score - a.score);
  const best = res.filter(x => x.coverage === 1);
  // Partial matches only when nothing matches the whole search; otherwise they're noise.
  const partial = best.length ? [] : res.filter(x => x.coverage >= 0.5);
  return { empty: false, best, partial, fixes };
}

/* ---------- letter and email checker ---------- */
const SHORTENERS = new Set("bit.ly tinyurl.com t.co goo.gl ow.ly is.gd buff.ly rebrand.ly cutt.ly shorturl.at tiny.cc rb.gy lnkd.in s.id t.ly bl.ink short.io tr.im v.gd qrco.de x.co shorturl.com tiny.one surl.li".split(" "));
const NEWS_HOSTS = ["topclassactions.com", "openclassactions.com", "classaction.org", "claimdepot.com"];
const TLDS = new Set(("com org net gov edu mil int info biz io co us me ly xyz top site online club shop store live app dev page link click pro vip win " +
  "work today news email support help claims legal law money finance loan cash credit bank best tech space website icu buzz fun rest bar " +
  "life world global group services solutions center network digital zone one gold mobi name tv cc ws la ai cloud").split(" "));
const FILE_EXT = new Set("pdf doc docx xls xlsx csv txt jpg jpeg png gif zip htm html".split(" "));
function hostish(h) {
  const parts = h.split(".");
  if (parts.length < 2 || parts.some(p => !/^[a-z0-9-]+$/.test(p) || !p)) return false;
  const tld = parts[parts.length - 1];
  return !FILE_EXT.has(tld) && /^[a-z]{2,24}$/.test(tld) && (tld.length === 2 || TLDS.has(tld)) && parts[parts.length - 2].length >= 2;
}
const offHost = s => { try { return s.officialUrl ? new URL(s.officialUrl).hostname.replace(/^www\./, "").toLowerCase() : null; } catch (e) { return null; } };
function findLinks(text) {
  const out = [], seen = new Set();
  fold(text).split(/[\s<>()[\]{}"]+/).forEach(chunk => {
    let raw = chunk.replace(/^[^a-z0-9]+/, "").replace(/'s$/, "").replace(/[.,;:!?'*]+$/, "");
    if (!raw || !raw.includes(".")) return;
    let host = null, disguise = null;
    if (/^https?:\/\//.test(raw)) {
      try { const u = new URL(raw); host = u.hostname; if (u.username && hostish(decodeURIComponent(u.username))) disguise = decodeURIComponent(u.username); } catch (e) { return; }
    } else if (/^[^@/]+@[^@/]+$/.test(raw)) {
      const [local, dom] = raw.split("@");
      if (hostish(local.replace(/^www\./, ""))) { disguise = local; host = dom; }
      else if (hostish(dom)) host = dom; else return;
    } else if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/.test(raw)) {
      try { host = new URL("https://" + raw).hostname; } catch (e) { return; }
      const h = host.replace(/^www\./, "");
      if (!SHORTENERS.has(h) && !hostish(h)) return;
    } else return;
    host = host.replace(/^www\./, "").replace(/\.$/, "");
    if (!host || seen.has(host)) return; seen.add(host);
    out.push({ raw, host, disguise });
  });
  return out;
}
// Requests only count as requests: "we will never ask for your password" is a good sign, not a red flag.
const ASKS = [
  { code: "fee", tone: "bad", re: /\b(processing|release|handling|admin(istrative|istration)?|service|transfer|verification|activation|unlock(ing)?|delivery|clearance|tax|claim) (fee|charge)s?\b|\bpay (a |an |any |the )?(small |one-time |nominal |\$\s?[\d.,]+ )?(fee|charge)\b|\b(fee|charge) of \$\s?\d|\$\s?\d[\d,]*(\.\d\d)? (fee|charge)\b|\bfee to (receive|release|claim|process|get|unlock)\b/,
    text: "Asks you to pay a fee. Real settlements never charge you to get paid.", good: "Says there's no fee to file, as real notices do." },
  { code: "password", tone: "bad", re: /\b(password|passcode|pass code)s?\b|\b(online banking|bank|bank account) (login|log-in|username|user name|credentials)\b|\b(bank|debit card|atm|card) pin\b/,
    text: "Asks for a password or bank login. No settlement ever needs that.", good: "Warns you not to share passwords, as real notices do." },
  { code: "paymethod", tone: "bad", re: /\b(buy|purchase|send|pay (with|using|by|in)|in the form of|load)\b[^.]{0,40}\bgift ?cards?\b|\bwire (transfer|the|money|funds|payment)\b|\bwestern union\b|\bmoneygram\b|\b(pay|send|deposit|transfer)\b[^.]{0,30}\b(bitcoin|btc|crypto(currency)?|usdt|tether|ethereum)\b/,
    text: "Asks you to pay by gift card, wire transfer or crypto. That's a scam pattern." },
  { code: "ssn", tone: "meh", re: /\bsocial security( number)?s?\b|\bssn\b|\bitin\b|\btax id(entification)?( number)?\b/,
    text: "Asks for your Social Security number. Most consumer settlements don't need it; only give it on the official site, if at all.", good: "Warns you not to share your Social Security number." },
  { code: "bankdetails", tone: "meh", re: /\b(bank account|routing|checking account|account and routing) numbers?\b/,
    text: "Asks for bank account details. Only enter those on the official site, never by reply." }
];
const NEGATION = /\b(never|not|no|nobody|no one|don't|do not|doesn't|does not|won't|will not|cannot|can't|without|nor)\b/;
function scanRequests(text) {
  const found = new Map();
  fold(text).split(/(?<=[.!?])\s+|\n+|[:;,](?=\s)|\b(?:but|unless|until|otherwise|or else)\b/).filter(Boolean).forEach(clause => {
    ASKS.forEach(a => {
      const m = clause.match(a.re); if (!m) return;
      const before = clause.slice(0, m.index);
      const negated = NEGATION.test(before) && !/\bif (you )?(do not|don't|fail to|never)\b/.test(before);
      const prev = found.get(a.code);
      if (!negated) found.set(a.code, { a, negated: false });
      else if (!prev) found.set(a.code, { a, negated: true });
    });
  });
  return [...found.values()];
}
// Federal case numbers compared without the office prefix: a case reassigned within a district changes
// "4:23-cv-00501" to "3:23-cv-00501", and notices often show both.
const docket = s => { const m = fold(s).match(/\b(\d{1,2}):(\d{2})-?([a-z]{2,4})-?0*(\d{1,6})\b/); return m ? `${m[2]}-${m[3]}-${+m[4]}` : null; };
function mentions(text, S, hosts) {
  const t = fold(text), toks = " " + stems(text).join(" ") + " ", flat = t.replace(/[^a-z0-9]/g, "");
  const dk = new Set(); (t.match(/\b\d{1,2}:\d{2}-?[a-z]{2,4}-?\d{1,6}\b/g) || []).forEach(x => dk.add(docket(x)));
  const out = [];
  S.forEach(s => {
    const why = []; let score = 0, strong = false;
    if (s.caseNo) {
      const d = docket(s.caseNo), c = fold(s.caseNo).replace(/[^a-z0-9]/g, "");
      if ((d && dk.has(d)) || (!d && c.length >= 6 && flat.includes(c))) { score += 10; strong = true; why.push("case number"); }
    }
    const off = offHost(s);
    if (off && (hosts || []).some(h => h === off || h.endsWith("." + off))) { score += 8; strong = true; why.push("official website"); }
    const hits = [], hitStems = new Set();
    (s.aliases || []).forEach(a => {
      const p = stems(a).join(" ");
      if (!p || hitStems.has(p) || !toks.includes(" " + p + " ")) return;
      hitStems.add(p); hits.push(a); score += (a.length > 6 || p.includes(" ")) ? 2 : 1;
    });
    if (hits.length) why.push(`the words ${hits.slice(0, 3).map(h => `“${h}”`).join(", ")}`);
    if (score >= 2) out.push({ s, strong, score, why });
  });
  return out.sort((a, b) => b.score - a.score);
}
function analyzeMessage(text, S) {
  const found = findLinks(text);
  const ment = mentions(text, S, found.map(l => l.host)), strongM = ment.filter(m => m.strong);
  const subject = (strongM[0] || ment[0] || {}).s || null;
  const offs = new Map(); S.forEach(s => { const h = offHost(s); if (h) offs.set(h, s); });
  const mentionedBrands = ment.flatMap(m => (m.s.aliases || []).map(a => a.replace(/[^a-z0-9]/g, "")).concat([(offHost(m.s) || "").split(".")[0]])).filter(b => b.length >= 5);
  const reasons = [], links = [];
  found.forEach(l => {
    const official = [...offs.entries()].find(([h]) => l.host === h || l.host.endsWith("." + h));
    const embedsOfficial = [...offs.keys()].find(h => l.host !== h && !l.host.endsWith("." + h) && h.split(".")[0].length >= 6 && l.host.includes(h.split(".")[0]));
    let kind, tone, say;
    if (l.disguise) { kind = "disguised"; tone = "bad"; say = `The link is disguised: browsers ignore everything before “@”, so “${l.disguise}@…” really goes to ${l.host}.`; }
    else if (official) { kind = "official"; tone = "good"; say = `${l.host} is the official site for the ${official[1].short} settlement.`; }
    else if (embedsOfficial) { kind = "lookalike"; tone = "bad"; say = `${l.host} is made to look like the official site (${embedsOfficial}) but goes somewhere else.`; }
    else if (SHORTENERS.has(l.host)) { kind = "short"; tone = "meh"; say = `${l.host} is a short link, so you can't see where it goes. Don't tap it; type the official address yourself.`; }
    else if (/\.gov$/.test(l.host)) { kind = "gov"; tone = "good"; say = `${l.host} is a U.S. government site.`; }
    else if (NEWS_HOSTS.some(h => l.host === h || l.host.endsWith("." + h))) { kind = "news"; tone = "meh"; say = `${l.host} is a news site about settlements, not where you file.`; }
    else if (mentionedBrands.some(b => l.host.replace(/[^a-z0-9]/g, "").includes(b)) && /settle|claim|payout|refund|class|lawsuit|payment|verify|award|compensat/.test(l.host)) {
      kind = "lookalike"; tone = "bad"; say = `${l.host} uses the company's name but isn't the official settlement site.`;
    } else if (strongM.length) {
      const s = strongM[0].s, h = offHost(s);
      kind = "other"; tone = "bad"; say = `${l.host} is not the official ${s.short} settlement site${h ? ` (${h})` : ""}. A message that names the real case but sends you elsewhere is a common scam.`;
    } else { kind = "unknown"; tone = "meh"; say = `${l.host}: we can't confirm this link. Don't enter information there.`; }
    links.push(Object.assign({ kind }, l)); reasons.push({ tone, text: say });
  });
  scanRequests(text).forEach(({ a, negated }) => {
    if (negated) { if (a.good) reasons.push({ tone: "good", text: a.good }); }
    else reasons.push({ tone: a.tone, text: a.text });
  });
  const names = ms => ms.slice(0, 4).map(m => m.s.short).join(", ");
  if (strongM.length) {
    const also = ment.filter(m => m.s !== strongM[0].s);
    reasons.unshift({ tone: "good", text: `It names a real settlement we track, ${strongM[0].s.short}, by its ${strongM[0].why.filter(w => !w.startsWith("the words")).join(" and ")}.${also.length ? ` It also mentions ${names(also)}.` : ""}` });
  } else if (ment.length === 1) reasons.unshift({ tone: "meh", text: `It may be about ${ment[0].s.short} (it uses ${ment[0].why.join(", ")}), but it doesn't give the case number or the official website, so we can't confirm it.` });
  else if (ment.length > 1) reasons.unshift({ tone: "meh", text: `It mentions ${ment.length} settlements we track (${names(ment)}), but gives no case number or official website, so we can't tell which one, if any, it's really about.` });
  else reasons.unshift({ tone: "meh", text: "We couldn't match this to a settlement we track. A real notice names the court and the case number; look those up yourself before clicking anything." });
  if (subject && !links.length && (strongM.length || ment.length === 1)) { const h = offHost(subject); reasons.push({ tone: "meh", text: `No links found. To file, type the official address yourself: ${h || "the official site isn't up yet"}.` }); }
  const bad = reasons.some(r => r.tone === "bad"), meh = reasons.some(r => r.tone === "meh" && !/mentions \d+ settlements|No links found/.test(r.text));
  const kind = bad ? "scam" : strongM.length && !meh && links.every(l => l.kind === "official" || l.kind === "gov") ? "real" : "unclear";
  const h = subject && (strongM.length || ment.length === 1) ? offHost(subject) : null;
  // Lead with what decided the verdict.
  const order = kind === "scam" ? { bad: 0, meh: 1, good: 2 } : kind === "real" ? { good: 0, meh: 1, bad: 2 } : { meh: 0, bad: 1, good: 2 };
  reasons.sort((a, b) => order[a.tone] - order[b.tone]);
  const headline = kind === "scam" ? "Likely a scam" : kind === "real" ? "Looks real" : "Can't tell from this message";
  const advice = kind === "scam" ? `Don't tap its links, reply or pay anything.${h ? ` The real ${subject.short} settlement site is ${h}. Type it into your browser yourself.` : ""}`
    : kind === "real" ? `Still, type ${h || "the official address"} into your browser yourself rather than tapping the link.`
    : `Don't enter information through its links.${h ? ` If it's about ${subject.short}, the official site is ${h}; type it yourself.` : " Search for the company below, or look up the case on the court's website."}`;
  return { kind, headline, advice, reasons, links, mentions: ment };
}

/* ---------- calendar ---------- */
// Settlement dates as an .ics file people add to their own calendar, so reminders need no account and no server.
// Each event is { uid, date, title, description, url, alarms }, where alarms are days before the date (0 = that day),
// each going off at 9 a.m. local time.
function settlementEvents(s, today) {
  const st = effStatus(s, today), out = [];
  const description = [s.officialUrl ? `File on the official site: ${s.officialUrl}` : "",
    "Confirm the date on the official settlement site; it can change. Added from Claimwell, an independent guide."].filter(Boolean).join("\n\n");
  const add = (date, kind, title, alarms) => {
    if (isDay(date) && date >= today) out.push({ uid: `${s.id}-${kind}@claimwell`, date, title, description, url: s.officialUrl || null, alarms });
  };
  if (st === "soon") add(s.opens, "opens", `Claim form opens: ${s.name} settlement`, [0]);
  if (st === "open" || st === "soon") add(s.deadline, "deadline", `Claim deadline: ${s.name} settlement`, [7, 1]);
  if (st === "auto") add(s.deadline, "update", `Last day to update your details: ${s.name} settlement`, [7]);
  return out;
}
const icsEscape = v => String(v).replace(/[\\;,]/g, m => "\\" + m).replace(/\r?\n/g, "\\n");
// Lines longer than 75 bytes are folded onto continuation lines that start with a space (RFC 5545).
function icsFold(line) {
  const parts = []; let cur = "", n = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0), b = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (n + b > (parts.length ? 74 : 75)) { parts.push(cur); cur = ""; n = 0; }
    cur += ch; n += b;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}
const nextDay = d => { const t = parseDay(d); t.setDate(t.getDate() + 1); return isoDay(t); };
const alarmTrigger = days => days <= 0 ? "PT9H" : days === 1 ? "-PT15H" : `-P${days - 1}DT15H`;
function calendarFile(events, stamp) {
  const ymd = d => d.replace(/-/g, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Claimwell//Settlement dates//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  (events || []).forEach(e => {
    if (!e || !isDay(e.date)) return;
    L.push("BEGIN:VEVENT", `UID:${String(e.uid).replace(/[^\w.@-]/g, "")}`, `DTSTAMP:${ymd(isDay(stamp) ? stamp : e.date)}T000000Z`,
      `DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(e.date))}`, `SUMMARY:${icsEscape(e.title)}`, "TRANSP:TRANSPARENT");
    if (e.description) L.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (typeof e.url === "string" && /^https:\/\/\S+$/.test(e.url)) L.push(`URL:${e.url}`);
    (e.alarms || []).forEach(d => L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(e.title)}`, `TRIGGER:${alarmTrigger(d)}`, "END:VALARM"));
    L.push("END:VEVENT");
  });
  L.push("END:VCALENDAR");
  return L.map(icsFold).join("\r\n") + "\r\n";
}

return { isoDay, daysBetween, isDay, effStatus, fold, words, stems, validate, checkRecord, loadDocument, qkey, screenAnswers, verdict,
  eligibility, stateFits, classify, stateOptions, doorsFor, topicOptions, steps, STATE_VERSION, blankState, sanitizeState, finishState,
  parseMoney, estLabel, buildIndex, search, editDistance, findLinks, scanRequests, mentions, analyzeMessage,
  settlementEvents, calendarFile };
});

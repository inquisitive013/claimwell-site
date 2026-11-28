(function () {
"use strict";
const E = window.ClaimwellEngine;
const TODAY_ISO = E.isoDay(new Date());
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt = s => { const d = new Date(s + "T00:00:00"); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const short = s => { const d = new Date(s + "T00:00:00"); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const daysUntil = s => E.daysBetween(TODAY_ISO, s);
const money = n => { n = Number(n); return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATES = { AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",PR:"Puerto Rico",GU:"Guam",VI:"U.S. Virgin Islands" };
const PROOF = { none: "No proof needed", notice_id: "Needs the ID from your notice", optional: "Optional; raises the payout", required: "Proof required", unconfirmed: "Not confirmed" };
const VER = {
  official: { label: "Official site", text: d => `Checked against the official settlement site on ${fmt(d)}.` },
  partial: { label: "Partly checked", text: d => `Partly checked against the official site on ${fmt(d)}; some details from a secondary source.` },
  secondary: { label: "Secondary source", text: d => `Our checker couldn't read the official site, so details come from a secondary tracker, checked ${fmt(d)}. Confirm before filing.` }
};
const LEVEL = { none: "Nothing to do", easy: "Easy", medium: "A few minutes", hard: "Takes some digging" };
const STALE_DAYS = 7;       // a record not re-checked in a week gets a visible warning on its card
const STALE_FILE_DAYS = 2;  // the daily refresh should never leave the whole list older than this

/* ---------- data and saved state ---------- */
let S = [], DOC = null, IX = null, TOPICS = [], TOPIC_LABEL = {}, PAYS = [];
const KEY = "claimwell-live-v3", OLD_KEY = "claimwell-live-v2";
let P = E.blankState();
function readSaved() {
  for (const k of [KEY, OLD_KEY]) {
    try { const raw = JSON.parse(localStorage.getItem(k) || "null"); if (raw) return raw; } catch (e) { /* corrupt: try the next, then start fresh */ }
  }
  return null;
}
let saveT;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) {} }, 150); };
const ui = { firstVisit: true, open: new Set(), sheetOpen: new Set(), q: "", letter: "", letterResult: null, newIds: new Set(), returning: false, prevVisit: null };
let BYID = new Map();
const byId = id => BYID.get(id);
const filedRec = id => P.filed.find(f => f.sid === id);
const effStatus = s => E.effStatus(s, TODAY_ISO);
const classify = () => E.classify(S, P, TODAY_ISO);
const easyFirst = (a, b) => ((effStatus(a) === "auto") - (effStatus(b) === "auto")) || (a.effort.minutes - b.effort.minutes) || (a.deadline || "9999").localeCompare(b.deadline || "9999");
// Counts rather than a dollar sum: the amounts are different kinds (per claim, per phone, up-to caps), and one
// large "up to" amount used to dominate a total that most settlements couldn't contribute to.
function totals(list) {
  let set = 0, unset = 0, quick = 0;
  list.forEach(s => { if (s.est && s.est.hi != null) set++; else unset++; if (s.effort.minutes <= 5 && effStatus(s) !== "auto") quick++; });
  return { set, unset, quick };
}
function whyText(row) {
  const { s, e } = row;
  if (e.kind === "likely") return "Your answers fit this settlement";
  if (e.kind === "ruled_out") return "Ruled out by your answers: " + e.reason;
  if (e.kind === "unsure") return P.door[s.id] === "unsure" ? `You weren't sure: ${s.door.label}` : "Some answers were \"not sure\"";
  return P.door[s.id] === "yes" ? `You said: ${s.door.label}` : "From your answers";
}

/* ---------- card pieces ---------- */
function statusChip(s) {
  const es = effStatus(s), f = filedRec(s.id);
  if (f) return `<span class="chip filed">Filed ${short(f.filedOn)}</span><span class="when">Tracking in My claims</span>`;
  if (es === "auto") return `<span class="chip auto">Paid automatically</span><span class="when">${s.deadline && daysUntil(s.deadline) >= 0 ? `No claim needed · update details by ${fmt(s.deadline)}` : "No claim needed"}</span>`;
  if (es === "ended") return `<span class="chip ended">Closed</span><span class="when">${s.deadline ? `Deadline was ${fmt(s.deadline)}` : "No longer taking claims"}</span>`;
  if (es === "soon") return `<span class="chip notyet">Claim form not open yet</span><span class="when">Opens by ${fmt(s.opens)}</span>`;
  if (!s.deadline) return `<span class="chip open"><span class="dot"></span>Open</span><span class="when">No deadline listed; check the official site</span>`;
  const d = daysUntil(s.deadline);
  return `<span class="chip ${d <= 21 ? "soonish" : "open"}"><span class="dot"></span>${d === 0 ? "Last day" : `${d} day${d === 1 ? "" : "s"} left`}</span><span class="when">File by ${fmt(s.deadline)}</span>`;
}
const officialLink = (s, primary, text) => s.officialUrl && /^https:\/\//.test(s.officialUrl) ? `<a class="btn sm ${primary ? "primary" : ""}" href="${esc(s.officialUrl)}" target="_blank" rel="noopener noreferrer">${esc(text || "Official site")} ↗</a>` : `<span class="help">Official site not launched yet</span>`;
function effortRow(s) {
  const e = s.effort;
  return `<div class="effort"><span class="lvl ${e.level}">${LEVEL[e.level]}</span><span>${e.minutes ? `About ${e.minutes} min · ` : ""}${esc(e.docs)}</span><span class="money">${esc(E.estLabel(s))}</span></div>`;
}
// Long court language is cut to the whole sentences that fit in about 200 characters; the full text is one tap away.
function brief(text, max = 200) {
  const t = String(text || "");
  if (t.length <= max) return { head: t, rest: "" };
  let head = "";
  for (const part of t.split(/(?<=[.!?])\s+(?=[A-Z0-9$(])/)) { const next = (head + " " + part).trim(); if (next.length > max) break; head = next; }
  if (!head) head = t.slice(0, max - 40).replace(/[\s,;(]+\S*$/, "") + "…";
  return { head, rest: t };
}
function freshness(s) {
  const age = -daysUntil(s.checked);
  if (age <= STALE_DAYS || effStatus(s) === "ended") return "";
  return `<div class="stale"><b>Last checked ${age} days ago.</b> Deadlines and amounts can change. Confirm on the official site before filing.</div>`;
}
function card(s, why) {
  const es = effStatus(s), f = filedRec(s.id), open = ui.open.has(s.id), sheet = ui.sheetOpen.has(s.id), v = VER[s.verification];
  const isNew = ui.newIds.has(s.id), v8 = E.verdict(s, P);
  const legal = [s.caption, s.caseNo && `No. ${s.caseNo}`, s.court].filter(Boolean).map(esc).join(" · ");
  const pay = brief(s.payout);
  return `
  <article class="card" id="card-${s.id}">
    <div class="cardmain">
      <div style="min-width:0"><div class="title">${esc(s.name)} ${isNew ? `<span class="chip new">New</span>` : ""}</div></div>
      <div class="status">${statusChip(s)}<span class="checked">Checked ${short(s.checked)}</span></div>
      ${effortRow(s)}
      ${freshness(s)}
      ${why ? `<div class="why"><span>${esc(why)}</span></div>` : ""}
      <details class="more"><summary>Who's in, proof and where this information came from</summary>
        <div class="whosin"><ul>${s.whosIn.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>
        <div class="facts">
          <div><div class="label">Proof</div><div><b>${esc(PROOF[s.proof] || s.proof)}</b>. ${esc(s.proofDetail)}</div></div>
          <div><div class="label">Payout, per the notice</div><div>${esc(pay.head)}${pay.rest ? `<details class="fullterms"><summary>Read the full payout terms</summary>${esc(pay.rest)}</details>` : ""}</div></div>
          <div><div class="label">Fund · administrator</div><div>${esc(s.fund || "Not stated")} · ${esc(s.administrator || "Not stated")}</div></div>
          <div><div class="label">Court case</div><div class="legal">${legal || "Not stated"}</div></div>
        </div>
        <p class="help">A settlement isn't a court finding that the company did anything wrong.</p>
        <div class="prov"><span class="vbadge ${s.verification}">${v.label}</span><span>${esc(v.text(s.checked))}${s.caveat ? " " + esc(s.caveat) : ""}</span></div>
      </details>
      <div class="actions">
        ${s.questions.length && es !== "ended" && !f ? `<button class="btn sm ${open || sheet ? "" : "primary"}" data-toggle="${s.id}" aria-expanded="${open}">${open ? "Hide questions" : v8.kind === "yes" ? "1. Review my answers" : "1. Confirm I qualify"}</button>` : ""}
        ${es !== "ended" && !f && es !== "auto" ? `<button class="btn sm ${sheet ? "" : open && v8.kind === "yes" ? "primary" : ""}" data-sheet="${s.id}" aria-expanded="${sheet}">${sheet ? "Hide form details" : "2. Get ready to file"}</button>` : ""}
        ${es === "auto" && !f ? officialLink(s, false, "Update my address") : ""}
        ${f ? `<a class="btn sm" href="#mine">See in My claims</a>` : ""}
      </div>
    </div>
    ${open ? screener(s) : ""}
    ${sheet ? readySheet(s) : ""}
  </article>`;
}
function screener(s) {
  const a = E.screenAnswers(s, P);
  const qs = a.map(({ q, k, v, implied }, i) => `
    <div class="q"><div>${esc(q.q)}</div>
      <div class="seg" role="group" aria-label="${esc(q.q)}">${[["yes", "Yes"], ["no", "No"], ["unsure", "Not sure"]].map(([val, l]) => `<button type="button" id="ans-${s.id}-${i}-${val}" data-ans="${s.id}" data-k="${k}" data-v="${val}" aria-pressed="${v === val}">${l}</button>`).join("")}</div>
      ${implied ? `<div class="help">Filled in from your answer in the 2-minute check. Change it if that's not right.</div>` : ""}
      ${v === "unsure" ? `<div class="help">How to check: ${esc(q.unsure || "Open \"Who's in\" above, and read the class definition on the official site.")}</div>` : ""}
    </div>`).join("");
  const v = E.verdict(s, P); let out;
  if (v.kind === "pending") out = `<div class="verdict pending">Answer ${v.left === v.total ? (v.total > 1 ? "the questions" : "the question") : `${v.left} more`} to see where you stand.</div>`;
  else if (v.kind === "no") out = `<div class="verdict no"><h3>You're probably not in this class</h3><div>${esc(v.reason)}</div><div class="help">We've taken it off your matches. Change an answer above if it's wrong.</div></div>`;
  else if (v.kind === "maybe") out = `<div class="verdict maybe"><h3>Possibly. Check first</h3><ul>${v.unsure.map(q => `<li>${esc(q.unsure || q.q)}</li>`).join("")}</ul></div>`;
  else out = `<div class="verdict yes"><h3>You appear to be in this class</h3><div>The administrator makes the final decision. Next, get the form details ready${effStatus(s) === "soon" ? ` (the claim form opens by ${fmt(s.opens)})` : s.deadline ? ` and file by ${fmt(s.deadline)}` : ""}.</div><div><button class="btn sm primary" data-sheet-open="${s.id}">2. Get ready to file</button></div></div>`;
  return `<div class="section"><h3>Confirm you qualify</h3>${qs}${out}</div>`;
}
// Placeholders are profile fields or this record's form fields (the contract checks both); a function replacer
// keeps "$" in names from being read as a replacement pattern.
function fillTemplate(s) {
  const vals = P.sheet[s.id] || {};
  return s.template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => {
    if (k in P.profile) return P.profile[k] || `[your ${k === "name" ? "name" : k}]`;
    const f = s.ready.find(x => x.key === k);
    return vals[k] || (f ? `[${f.label.toLowerCase()}]` : m);
  });
}
function readySheet(s) {
  const p = P.profile, vals = P.sheet[s.id] || {};
  const prow = (k, label, help) => `<div class="frow"><label for="pf-${k}-${s.id}">${label}</label><input class="inp" id="pf-${k}-${s.id}" data-profile="${k}" value="${esc(p[k])}" ${FIELD_ATTRS[k]}><button type="button" class="btn sm" data-copy="pf-${k}-${s.id}">Copy</button>${help ? `<div class="help">${esc(help)}</div>` : ""}</div>`;
  const rows = [prow("name", "Full legal name"), prow("address", "Mailing address", "Use where you want a check to arrive."), prow("email", "Email", "Payment links are usually emailed here."), prow("phone", "Phone")];
  s.ready.forEach(f => {
    const id = `sh-${s.id}-${f.key}`, v = vals[f.key] || "";
    if (f.src === "choice") rows.push(`<div class="frow"><label for="${id}">${esc(f.label)}</label><select class="sel" id="${id}" data-sheetval="${s.id}" data-k="${f.key}"><option value="">Choose…</option>${f.options.map(o => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select><span></span><div class="help">${esc(f.help)}</div></div>`);
    else rows.push(`<div class="frow"><label for="${id}">${esc(f.label)}</label><input class="inp" id="${id}" data-sheetval="${s.id}" data-k="${f.key}" value="${esc(v)}" autocomplete="off"><button type="button" class="btn sm" data-copy="${id}">Copy</button><div class="help">Where to find it: ${esc(f.help)}</div></div>`);
  });
  const tmpl = s.template ? `<div class="tmpl"><span class="label">Message to send your landlord</span><p id="tmpl-${s.id}">${esc(fillTemplate(s))}</p><div><button type="button" class="btn sm" data-copytext="tmpl-${s.id}">Copy message</button></div></div>` : "";
  return `<div class="section"><h3>Everything the official form will ask for</h3>
    <p class="help" style="margin:-6px 0 0">Fill these in once, then copy each one into the official form. Saved only in this browser. Never type a Social Security number or bank password here.</p>
    <p class="help" style="margin:0">Only file if you qualify. Claim forms are signed under penalty of perjury, and administrators check claims.</p>
    <div class="frows">${rows.join("")}</div>${tmpl}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${effStatus(s) === "soon" ? `<span class="help">The claim form opens by ${fmt(s.opens)}. We'll remind you.</span>` : officialLink(s, true, "Open the official site to file")}<button type="button" class="btn sm" data-filed="${s.id}">I filed this</button></div>
    <p class="help" style="margin:0">You submit and sign on the official site yourself. Afterwards tap "I filed this" so we can track the payment.</p></div>`;
}

/* ---------- view: guided check, built from each settlement's door question ---------- */
const curSteps = () => E.steps(S, P, TODAY_ISO, TOPICS);
function stepIndex(st) { const i = st.findIndex(x => x.id === P.step); return i < 0 ? 0 : i; }
// Personal fields get the phone's matching keyboard and the browser's saved details; claim-specific fields don't.
const FIELD_ATTRS = { name: 'autocomplete="name" autocapitalize="words"', address: 'autocomplete="street-address"',
  email: 'type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false"', phone: 'type="tel" inputmode="tel" autocomplete="tel"' };
const optBtn = (attrs, on, label, note) => `<button type="button" class="opt" ${attrs} aria-pressed="${on}"><span class="box">${on ? "✓" : ""}</span><span><b>${esc(label)}</b>${note ? `<small>${esc(note)}</small>` : ""}</span></button>`;
function doorRow(s) {
  const v = P.door[s.id];
  return `<div class="door">${optBtn(`data-door="${s.id}"`, v === "yes", s.door.label, s.door.note)}<button type="button" class="unsure" data-doorunsure="${s.id}" aria-pressed="${v === "unsure"}" aria-label="Not sure about ${esc(s.door.label)}">Not sure</button></div>`;
}
function vCheck() {
  if (P.done) return vResults();
  const st = curSteps(), i = stepIndex(st), step = st[i];
  P.step = step.id;
  const n = classify().matches.length;
  let eyebrow = "", title, sub, body, next;
  if (step.id === "where") {
    const opts = E.stateOptions(S, TODAY_ISO).sort((a, b) => STATES[a.code].localeCompare(STATES[b.code]));
    title = "Have you lived or shopped in any of these states?";
    sub = "A few settlements only cover one state, for the years shown. Pick any that fit; we'll skip the rest.";
    body = `<div class="opts">${opts.map(o => optBtn(`data-state="${o.code}"`, P.states.includes(o.code), STATES[o.code], `${o.when ? o.when[0].toUpperCase() + o.when.slice(1) : ""} · ${o.count} settlement${o.count > 1 ? "s" : ""}`)).join("")}</div>`;
    next = P.states.length ? "Next" : "None of these";
  } else if (step.id === "topics") {
    const opts = E.topicOptions(S, P, TODAY_ISO, TOPICS);
    title = "Which of these are part of your life?";
    sub = "Pick all that apply. We'll only ask about settlements in the ones you pick.";
    body = `<div class="opts">${opts.map(o => optBtn(`data-topic="${o.topic}"`, P.topics.includes(o.topic), TOPIC_LABEL[o.topic], o.examples.join(", ") + (o.count > o.examples.length ? ` and ${o.count - o.examples.length} more` : ""))).join("")}</div>
      <div><button type="button" class="linkbtn" data-act="alltopics">Not sure? Ask me about all of them</button></div>`;
    next = P.topics.length ? "Next" : "None of these";
  } else {
    const { shown, hidden } = E.doorsFor(step.topic, S, P, TODAY_ISO);
    eyebrow = step.topic === "broad" ? "Applies to lots of people" : TOPIC_LABEL[step.topic];
    title = step.topic === "broad" ? "Do any of these sound familiar?" : "Do any of these fit you?";
    sub = "Tap each one that fits. Use \"Not sure\" if you might have, and we'll show it separately.";
    body = `<div class="doors">${shown.map(doorRow).join("")}</div>${hidden ? `<div class="hiddennote">Hiding ${hidden} that only appl${hidden > 1 ? "y" : "ies"} in states you didn't pick.</div>` : ""}`;
    next = shown.some(s => P.door[s.id]) ? "Next" : "None of these";
  }
  if (i === st.length - 1 && next === "Next") next = "See my results";
  return `
  <section class="stage" aria-labelledby="qh">
    <div class="progress"><div style="width:${Math.round((i / st.length) * 100)}%"></div></div>
    <div class="stagehead"><span class="label">Step ${i + 1} of ${st.length}${eyebrow ? ` · ${esc(eyebrow)}` : ""}</span><span class="tally" aria-live="polite">${n ? `${n} possible match${n > 1 ? "es" : ""} so far` : ""}</span></div>
    <div class="qbody"><h2 id="qh">${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${body}</div>
    <div class="stepnav"><button class="btn" data-act="back" ${i === 0 ? "disabled" : ""}>Back</button>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="linkbtn" data-act="finish">See results now</button><button class="btn primary" data-act="next">${next}</button></div></div>
  </section>
  <p class="help" style="margin-top:12px">We check every open settlement in our list, ${S.filter(s => effStatus(s) !== "ended").length} right now. Your answers are saved in this browser so you never answer them twice.</p>`;
}
function vResults() {
  const C = classify();
  const list = C.matches.slice().sort((a, b) => easyFirst(a.s, b.s));
  const t = totals(list.map(r => r.s));
  const banner = ui.returning ? `<div class="banner"><span>Welcome back. We kept your answers from ${fmt(ui.prevVisit)}.${ui.newIds.size ? ` <b>${ui.newIds.size} new settlement${ui.newIds.size > 1 ? "s" : ""} match${ui.newIds.size > 1 ? "" : "es"} them.</b>` : " No new matches since then."}</span><button class="btn sm" data-act="restart">Change my answers</button></div>` : "";
  return `${banner}
  <div class="vhead"><h2>${list.length ? `You may qualify for ${list.length} settlement${list.length > 1 ? "s" : ""}` : "No matches from your answers"}</h2>${ui.returning ? "" : `<button class="btn sm" data-act="restart">Change my answers</button>`}</div>
  ${list.length ? `<div class="strip">
      <div><div class="label">Matches</div><div class="big">${list.length}</div></div>
      <div><div class="label">Quick ones</div><div class="big">${t.quick}</div><div class="small">5 minutes or less</div></div>
      <div><div class="label">Amount stated</div><div class="big">${t.set}</div><div class="small">shown on each card</div></div>
      <div><div class="label">Amount not set yet</div><div class="big">${t.unset}</div><div class="small">depends on how many file</div></div>
    </div>
    <p class="muted" style="margin:-4px 0 14px">Easiest first. For each: confirm you qualify, get the form details ready, then file on the official site.</p>
    <div class="cards">${list.map(r => card(r.s, whyText(r))).join("")}</div>`
    : `<div class="empty"><h3>Nothing open fits your answers right now</h3><p>New settlements open every week, and we'll check your saved answers against each one. If you got a letter or email about a settlement, check it in the "Got a letter or email?" tab.</p><a class="btn" href="#letter">Check a letter</a></div>`}
  ${C.unsure.length ? `<div class="group"><span class="label">Worth checking · you weren't sure</span><div class="cards">${C.unsure.map(r => card(r.s, whyText(r))).join("")}</div></div>` : ""}
  ${C.ruledOut.length ? `<details class="group ruled"><summary class="label">Ruled out by your answers (${C.ruledOut.length})</summary><div class="cards">${C.ruledOut.map(r => card(r.s, whyText(r))).join("")}</div></details>` : ""}`;
}

/* ---------- view: my claims ---------- */
// Dates for the person's own calendar: each settlement's deadline (or opening day), plus any payment's redeem-by date.
function calEvents(list) {
  const out = [];
  list.forEach(s => out.push(...E.settlementEvents(s, TODAY_ISO)));
  P.filed.forEach(f => {
    if (f.paid || !f.expiry || daysUntil(f.expiry) < 0) return;
    const s = byId(f.sid);
    out.push({ uid: `${f.sid}-redeem@claimwell`, date: f.expiry, title: `Redeem your ${s ? s.short : "settlement"} settlement payment`,
      description: "Settlement payments expire. Redeem or deposit yours before this date. Added from Claimwell, an independent guide.", url: s && s.officialUrl || null, alarms: [14, 3] });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function calendarList() {
  const ms = classify().matches.map(r => r.s);
  return calEvents(ms.filter(s => !filedRec(s.id)));
}
function downloadCalendar() {
  const ev = calendarList();
  if (!ev.length) return;
  const url = URL.createObjectURL(new Blob([E.calendarFile(ev, TODAY_ISO)], { type: "text/calendar" }));
  const a = document.createElement("a"); a.href = url; a.download = "claimwell-dates.ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast("Calendar file saved. Open it to add the dates.");
}
function payOptions(s) { const f = s.ready.find(x => x.key === "pay"); return f ? f.options : PAYS; }
function trackerRow(f) {
  const gone = !byId(f.sid);
  const s = byId(f.sid) || { id: f.sid, name: f.name || "A settlement no longer in our list", short: f.name || f.sid, administrator: f.administrator || null, officialUrl: f.officialUrl || null, hearing: null, ready: [] };
  const hearing = s.hearing;
  const hearingPassed = hearing && daysUntil(hearing) < 0;
  const stages = [
    { t: "Filed", d: short(f.filedOn), done: true },
    { t: "Court final approval", d: hearing ? `hearing ${short(hearing)}` : "date not set", done: hearingPassed || !!f.paid },
    { t: "Payments sent", d: "usually weeks to months later", done: !!f.paid },
    { t: "Paid to you", d: f.paid ? money(f.paidAmt || 0) : "", done: !!f.paid }
  ];
  const al = [];
  if (gone) al.push({ c: "", i: "i", t: "This settlement has left our list, usually because its deadline passed. Your claim still counts: keep tracking the payment here." });
  if (!f.paid) {
    const digital = f.pay && f.pay !== "Paper check" && f.pay !== "Account credit";
    if (!f.conf) al.push({ c: "", i: "•", t: "Add your confirmation number from the administrator's email or the final page of the form. You'll need it if anything goes wrong." });
    if (digital) al.push({ c: "", i: "•", t: `Payment will come by email from ${s.administrator || "the administrator"}. These emails often land in spam, and the payment link expires. When it arrives, enter the "redeem by" date below and we'll remind you.` });
    if (f.pay === "Paper check") al.push({ c: "", i: "•", t: "Checks expire. Cash or deposit it as soon as it arrives; the void date is printed on it." });
    if (f.pay === "Account credit") al.push({ c: "", i: "•", t: "The credit goes to the account you named on the form. Check your statements after payments go out." });
    if (!f.pay) al.push({ c: "", i: "•", t: "Pick the payment method you chose on the form, so we know what to watch for." });
    if (f.expiry) { const d = daysUntil(f.expiry); al.push({ c: d <= 14 ? "hot" : "", i: "!", t: d >= 0 ? `Redeem your payment by ${fmt(f.expiry)}: ${d} day${d === 1 ? "" : "s"} left.` : `The redeem-by date (${fmt(f.expiry)}) has passed. Contact ${s.administrator || "the administrator"} through the official site; they can sometimes reissue it.` }); }
    al.push({ c: "", i: "•", t: `Moving? Update your address with ${s.administrator || "the administrator"} on the official site so a check or notice can reach you.` });
  } else al.push({ c: "ok", i: "✓", t: `Paid ${money(f.paidAmt || 0)}. Nice.` });
  const opts = payOptions(s).includes(f.pay) || !f.pay ? payOptions(s) : payOptions(s).concat([f.pay]);
  return `
  <article class="trow">
    <div class="trow-head"><div style="min-width:0"><div class="title">${esc(s.name)}</div><div class="caption">${esc(s.administrator || "")}${s.administrator ? " · " : ""}filed ${fmt(f.filedOn)}</div></div>${officialLink(s, false)}</div>
    <div class="stages">${stages.map(x => `<div class="${x.done ? "done" : ""}">${x.t}<small>${esc(x.d)}</small></div>`).join("")}</div>
    <div class="tfields">
      <div><label for="tc-${s.id}">Confirmation number</label><input class="inp" id="tc-${s.id}" data-track="${s.id}" data-k="conf" value="${esc(f.conf || "")}" autocomplete="off"></div>
      <div><label for="tp-${s.id}">Payment method you chose</label><select class="sel" id="tp-${s.id}" data-track="${s.id}" data-k="pay"><option value="">Choose…</option>${opts.map(o => `<option ${o === f.pay ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>
      <div><label for="te-${s.id}">Redeem-by date (from the payment email or check)</label><input class="inp" type="date" id="te-${s.id}" data-track="${s.id}" data-k="expiry" value="${esc(f.expiry || "")}"></div>
    </div>
    <div class="alerts">${al.map(a => `<div class="alert ${a.c}"><span>${a.i}</span><span>${esc(a.t)}</span></div>`).join("")}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${f.paid ? `<button class="btn sm" data-unpaid="${s.id}">Undo paid</button>` : `<label class="sr" for="pa-${s.id}">Amount received</label><input class="inp" id="pa-${s.id}" placeholder="Amount received, e.g. 24.50" inputmode="decimal" style="max-width:220px"><button class="btn sm" data-paid="${s.id}">Mark paid</button>`}<button class="linkbtn" data-unfile="${s.id}">Not filed after all</button></div>
  </article>`;
}
function vMine() {
  const C = classify(), ms = C.matches.map(r => r.s);
  const toFile = ms.filter(s => !filedRec(s.id) && effStatus(s) !== "auto").sort(easyFirst);
  const autos = ms.filter(s => effStatus(s) === "auto");
  const filed = P.filed.slice().sort((a, b) => b.filedOn.localeCompare(a.filedOn));
  const paid = filed.filter(f => f.paid).reduce((a, f) => a + (+f.paidAmt || 0), 0);
  const t = totals(toFile);
  const rem = calendarList();
  const p = P.profile, nothing = !ms.length && !filed.length;
  return `
  <div class="vhead"><h2>My claims</h2>${nothing ? "" : `<a class="btn sm" href="#check">Change my answers</a>`}</div>
  <div class="strip">
    <div><div class="label">To file</div><div class="big">${toFile.length}</div><div class="small">${t.quick} take 5 minutes or less</div></div>
    <div><div class="label">Amount stated</div><div class="big">${t.set}</div><div class="small">${t.unset} more depend on how many file</div></div>
    <div><div class="label">Filed</div><div class="big">${filed.length}</div><div class="small">${filed.filter(f => !f.paid).length} waiting for payment</div></div>
    <div><div class="label">Paid to you</div><div class="big">${money(paid)}</div></div>
  </div>
  ${nothing ? `<div class="empty"><h3>Nothing here yet</h3><p>Take the 2-minute check. Your matches, the details each form needs, and your filed claims will collect here.</p><a class="btn primary" href="#check">Start the 2-minute check</a></div>` : ""}
  ${toFile.length ? `<div class="group"><span class="label">Ready to file · easiest first</span><div class="cards">${toFile.map(s => card(s)).join("")}</div></div>` : ""}
  ${autos.length ? `<div class="group"><span class="label">Paid automatically · just keep your address current</span><div class="cards">${autos.map(s => card(s)).join("")}</div></div>` : ""}
  ${filed.length ? `<div class="group"><span class="label">Filed · tracking your payment</span><div class="cards">${filed.map(trackerRow).join("")}</div></div>` : ""}
  <div class="group"><span class="label">Your details</span>
    <div class="panel"><p>Filled in once, used on every claim's form details. Saved only in this browser.</p>
      <div class="profile">
        <div><label for="me-name">Full legal name</label><input class="inp" id="me-name" data-profile="name" value="${esc(p.name)}" ${FIELD_ATTRS.name}></div>
        <div><label for="me-phone">Phone</label><input class="inp" id="me-phone" data-profile="phone" value="${esc(p.phone)}" ${FIELD_ATTRS.phone}></div>
        <div class="full"><label for="me-email">Email</label><input class="inp" id="me-email" data-profile="email" value="${esc(p.email)}" ${FIELD_ATTRS.email}></div>
        <div class="full"><label for="me-address">Mailing address</label><input class="inp" id="me-address" data-profile="address" value="${esc(p.address)}" ${FIELD_ATTRS.address}></div>
      </div></div></div>
  <div class="group"><span class="label">Deadline reminders</span>
    <div class="panel">
      <p>Add these dates to your own calendar, with alerts a week and a day before each deadline. Nothing is sent to us.</p>
      ${rem.length ? `<ul class="remlist">${rem.map(r => `<li><span class="d">${short(r.date)}</span><span>${esc(r.title)}</span></li>`).join("")}</ul>
      <div class="row"><button class="btn sm" type="button" data-act="calendar">Add ${rem.length === 1 ? "this date" : `these ${rem.length} dates`} to my calendar</button></div>` : `<p>No dates yet. They appear once you have matches to file.</p>`}
    </div></div>
  <div class="group"><span class="label">Your data</span>
    <div class="panel"><p>Everything Claimwell keeps is in this browser: your answers, your details and your claims. None of it is sent to us.</p>
      <div class="row"><button class="btn sm" type="button" data-act="erase">Erase everything in this browser</button></div></div></div>`;
}

/* ---------- view: letter ---------- */
const SAMPLE = `Subject: You're owed money — GoodRx Settlement

Our records show you used GoodRx before April 20, 2024 and may be eligible for a payment from the GoodRx privacy settlement (Doe v. GoodRx Holdings, Inc., Case No. 4:23-cv-00501).

To receive your payment, verify your identity and pay the $4.99 processing fee at:
https://goodrx-payout-claims.com/verify

Official settlement website: https://www.goodrxprivacysettlement.com/`;
function vLetter() {
  const r = ui.letterResult; let res = "";
  if (r) {
    const IC = { good: "✓", bad: "!", meh: "?" };
    res = `<div class="lverdict ${r.kind}" role="status"><div class="lv-ic" aria-hidden="true">${r.kind === "scam" ? "!" : r.kind === "real" ? "✓" : "?"}</div><div><h3>${esc(r.headline)}</h3><p>${esc(r.advice)}</p></div></div>
      <div class="group"><span class="label">Why we think so</span><div class="checks">${r.reasons.map(x => `<div class="check ${x.tone}"><span class="ic">${IC[x.tone]}</span><span>${esc(x.text)}</span></div>`).join("")}</div>
        <p class="help">This checks the wording and links of what you pasted, and it can be wrong. The official settlement site is the final word.</p></div>
      ${r.mentions.length ? `<div class="group"><span class="label">${r.mentions.length > 1 ? `Settlements it mentions (${r.mentions.length})` : "The settlement it mentions"}</span><div class="cards">${r.mentions.slice(0, 3).map(m => card(m.s, m.strong ? "Named in your message" : "Possibly what your message is about")).join("")}</div></div>` : ""}`;
  }
  return `
  <div class="vhead"><h2>Got a letter or email about a settlement?</h2></div>
  <p class="muted" style="margin:-4px 0 14px;max-width:62ch">Paste the text. We'll tell you whether it looks real, which settlement it's about, and where its links really go.</p>
  <form class="letter" id="letterform"><label class="sr" for="letter-text">Letter or email text</label>
    <textarea id="letter-text" placeholder="Paste the email or type what the letter says, including any website address">${esc(ui.letter)}</textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn primary" type="submit">Check it</button><button class="btn" type="button" data-act="sample">Try a sample scam email</button></div>
  </form>${res}`;
}

/* ---------- view: search ---------- */
function searchResults(q, typing) {
  const live = S.filter(s => effStatus(s) !== "ended");
  if (!q.trim()) return `<div class="group"><span class="label">Every settlement we track, A to Z</span><div class="atoz">${live.map(s => s.short).sort((a, b) => a.localeCompare(b)).map(n => `<button type="button" data-q="${esc(n)}">${esc(n)}</button>`).join("")}</div></div>`;
  const r = E.search(q, IX, typing);
  if (r.empty) return `<div class="empty"><h3>Type a company, product or store</h3><p>For example Hyundai, GoodRx, ATM, Kroger, or an everyday word like "dog" or "apartment".</p></div>`;
  const keep = x => effStatus(x.s) !== "ended";
  const best = r.best.filter(keep), partial = r.partial.filter(keep);
  const fix = r.fixes.length ? `<p class="fixnote">Showing results for ${r.fixes.map(f => `“${esc(f.to)}”`).join(", ")} instead of ${r.fixes.map(f => `“${esc(f.from)}”`).join(", ")}.</p>` : "";
  if (best.length) return `${fix}<div class="group"><span class="label">${best.length} result${best.length === 1 ? "" : "s"} for “${esc(q)}”</span><div class="cards">${best.map(x => card(x.s)).join("")}</div></div>`;
  if (partial.length) return `${fix}<div class="group"><span class="label">Nothing matches all of “${esc(q)}”. These match part of it</span><div class="cards">${partial.map(x => card(x.s)).join("")}</div></div>`;
  return `<div class="empty"><h3>No open settlement for “${esc(q)}” in our list</h3><p>We track ${live.length} open settlements. Try the company's name, a product or a store, or take the 2-minute check.</p><a class="btn primary" href="#check">Start the 2-minute check</a></div>`;
}
function vSearch() {
  return `
  <div class="vhead"><h2>Search a company or product</h2></div>
  <form class="searchbox" id="searchform" role="search"><label class="sr" for="q">Company or product</label><input id="q" type="search" value="${esc(ui.q)}" placeholder="e.g. Hyundai, GoodRx, ATM, Kroger" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><button class="btn primary" type="submit">Search</button></form>
  <div id="results" aria-live="polite">${searchResults(ui.q, false)}</div>`;
}

/* ---------- rail and data panel ---------- */
function renderRail() {
  const el = document.getElementById("mine");
  const list = classify().matches.map(r => r.s).sort(easyFirst);
  const n = list.filter(s => !filedRec(s.id)).length + P.filed.length;
  ["minecount", "minecount2"].forEach(id => { const c = document.getElementById(id); c.hidden = !n; c.textContent = n; });
  if (!list.length) { el.innerHTML = `<p>Matches from the 2-minute check show up here, easiest first.</p>`; return; }
  el.innerHTML = `<ul class="mylist">${list.map(s => `<li><span>${esc(s.short)}</span><span>${filedRec(s.id) ? "filed" : effStatus(s) === "auto" ? "auto" : s.effort.minutes + " min"}</span></li>`).join("")}</ul><a class="btn sm" href="#mine">Open My claims</a>`;
}
function renderData() {
  const c = { official: 0, partial: 0, secondary: 0 }; S.forEach(s => c[s.verification]++);
  const checks = S.map(s => s.checked).sort();
  const gen = DOC.generated;
  document.getElementById("datatag").textContent = `Real settlements · ${gen ? `updated ${fmt(gen)}` : "update date unknown"}`;
  document.getElementById("datasum").textContent = `${S.length} real settlements. Each card shows the day we last checked it${checks.length ? `; the oldest check is ${fmt(checks[0])}` : ""}.${DOC.rejected.length ? ` ${DOC.rejected.length} more ${DOC.rejected.length > 1 ? "are" : "is"} hidden because ${DOC.rejected.length > 1 ? "their" : "its"} data was incomplete.` : ""}`;
  const col = { official: "var(--accent)", partial: "var(--info)", secondary: "var(--warn)" };
  document.getElementById("bars").innerHTML = ["official", "partial", "secondary"].map(k => `<div class="bar"><span>${VER[k].label}</span><b>${c[k]}</b><div class="track"><div class="fill" style="width:${S.length ? (c[k] / S.length) * 100 : 0}%;background:${col[k]}"></div></div></div>`).join("");
}
function fileBanner() {
  const gen = DOC && DOC.generated, age = gen ? -daysUntil(gen) : null;
  if (gen && age <= STALE_FILE_DAYS) return "";
  return `<div class="banner warn"><span>${gen ? `This list was last updated ${fmt(gen)}, ${age} days ago.` : "We can't tell when this list was last updated."} Deadlines can change, so confirm each one on the official site before filing.</span></div>`;
}

/* ---------- routing ---------- */
const ROUTES = ["check", "mine", "letter", "search"];
const route = () => { const h = location.hash.slice(1); return ROUTES.includes(h) ? h : "check"; };
function render(focusId) {
  const view = document.getElementById("view");
  try {
    const r = route();
    document.querySelectorAll("#ways a, #tabbar a").forEach(a => a.setAttribute("aria-current", a.getAttribute("href") === "#" + r ? "page" : "false"));
    document.body.classList.toggle("compact", !ui.firstVisit || r !== "check");
    const y = window.scrollY;
    view.innerHTML = fileBanner() + ({ check: vCheck, mine: vMine, letter: vLetter, search: vSearch })[r]();
    renderRail();
    window.scrollTo(0, y);
    if (focusId) { const f = document.getElementById(focusId); if (f) f.focus({ preventScroll: true }); }
  } catch (err) {
    // Never leave someone locked out: offer a fresh start that keeps their filed claims and details.
    console.error(err);
    view.innerHTML = `<div class="empty"><h3>Something went wrong showing this page</h3><p>Your saved answers may come from an older version of Claimwell. Starting over clears your answers but keeps your filed claims and your details.</p><button class="btn primary" type="button" data-act="reset">Start over</button></div>`;
  }
}
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
let toastT;
function toast(t) { const el = document.getElementById("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 1800); }
function copyText(text) {
  if (!text) { toast("Nothing to copy yet"); return; }
  try { navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Select the text and copy it")); } catch (e) { toast("Select the text and copy it"); }
}

function goNext() {
  const st = curSteps(), i = stepIndex(st);
  if (st[i].id === "where") P.statesAnswered = true;
  const after = curSteps(), j = after.findIndex(x => x.id === st[i].id);
  if (j < after.length - 1) P.step = after[j + 1].id; else P.done = true;
  save(); render(); window.scrollTo(0, 0);
}
function setTopic(t, on) {
  if (on) { if (!P.topics.includes(t)) P.topics.push(t); return; }
  P.topics = P.topics.filter(x => x !== t);
  S.forEach(s => { if (s.door && s.door.group === t) delete P.door[s.id]; });  // unpicking a topic withdraws its answers
}
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t || !S.length) return;
  const act = t.dataset.act;
  if (act === "erase") {
    if (!confirm("Erase your answers, details and claims from this browser? This can't be undone.")) return;
    clearTimeout(saveT);
    try { localStorage.removeItem(KEY); localStorage.removeItem(OLD_KEY); } catch (e) {}
    P = E.finishState(E.sanitizeState(null, TODAY_ISO), S); location.hash = "check"; render(); return;
  }
  if (act === "calendar") { downloadCalendar(); return; }
  if (act === "reset") { const keep = { filed: P.filed, profile: P.profile, sheet: P.sheet, contact: P.contact }; P = Object.assign(E.blankState(), keep); save(); location.hash = "check"; render(); return; }
  if (t.dataset.state) { const c = t.dataset.state; P.states = P.states.includes(c) ? P.states.filter(x => x !== c) : P.states.concat([c]); P.statesAnswered = true; save(); render(); const b = document.querySelector(`[data-state="${c}"]`); if (b) b.focus(); return; }
  if (t.dataset.topic) { const k = t.dataset.topic; setTopic(k, !P.topics.includes(k)); save(); render(); const b = document.querySelector(`[data-topic="${k}"]`); if (b) b.focus(); return; }
  if (t.dataset.door) { const id = t.dataset.door; P.door[id] === "yes" ? delete P.door[id] : (P.door[id] = "yes"); save(); render(); const b = document.querySelector(`[data-door="${id}"]`); if (b) b.focus(); return; }
  if (t.dataset.doorunsure) { const id = t.dataset.doorunsure; P.door[id] === "unsure" ? delete P.door[id] : (P.door[id] = "unsure"); save(); render(); const b = document.querySelector(`[data-doorunsure="${id}"]`); if (b) b.focus(); return; }
  if (act === "alltopics") { E.topicOptions(S, P, TODAY_ISO, TOPICS).forEach(o => setTopic(o.topic, true)); save(); render(); return; }
  if (act === "next") { goNext(); return; }
  if (act === "back") { const st = curSteps(), i = stepIndex(st); if (i > 0) { P.step = st[i - 1].id; save(); render(); } return; }
  if (act === "finish") { P.done = true; save(); render(); return; }
  if (act === "restart") { P.done = false; P.step = null; ui.returning = false; save(); location.hash = "check"; render(); return; }
  if (act === "sample") { ui.letter = SAMPLE; ui.letterResult = E.analyzeMessage(SAMPLE, S); render(); return; }
  if (t.dataset.q) { ui.q = t.dataset.q; render(); return; }
  if (t.dataset.toggle) { const id = t.dataset.toggle; ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); render(); return; }
  if (t.dataset.sheet) { const id = t.dataset.sheet; ui.sheetOpen.has(id) ? ui.sheetOpen.delete(id) : ui.sheetOpen.add(id); render(); return; }
  if (t.dataset.sheetOpen) { ui.open.delete(t.dataset.sheetOpen); ui.sheetOpen.add(t.dataset.sheetOpen); render(); const c = document.getElementById("card-" + t.dataset.sheetOpen); if (c) c.scrollIntoView({ block: "start" }); return; }
  if (t.dataset.ans) { (P.answers[t.dataset.ans] ||= {})[t.dataset.k] = t.dataset.v; save(); render(t.id); return; }
  if (t.dataset.copy) { const el = document.getElementById(t.dataset.copy); copyText(el ? el.value : ""); return; }
  if (t.dataset.copytext) { const el = document.getElementById(t.dataset.copytext); copyText(el ? el.textContent : ""); return; }
  if (t.dataset.filed) {
    const id = t.dataset.filed, s = byId(id);
    if (!filedRec(id)) { const pay = (P.sheet[id] || {}).pay || ""; P.filed.push({ sid: id, filedOn: TODAY_ISO, conf: "", pay, expiry: "", paid: false, paidAmt: null, name: s ? s.name : "", administrator: s && s.administrator || "", officialUrl: s && s.officialUrl || "" }); }
    ui.sheetOpen.delete(id); ui.open.delete(id); save(); toast("Moved to My claims"); render(); return;
  }
  if (t.dataset.unfile) { P.filed = P.filed.filter(f => f.sid !== t.dataset.unfile); save(); render(); return; }
  if (t.dataset.paid) { const f = filedRec(t.dataset.paid); const v = E.parseMoney((document.getElementById("pa-" + t.dataset.paid) || {}).value); if (v === null) { toast("Enter the amount, like 24.50"); return; } f.paid = true; f.paidAmt = v; save(); render(); return; }
  if (t.dataset.unpaid) { const f = filedRec(t.dataset.unpaid); f.paid = false; f.paidAmt = null; save(); render(); return; }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.track) { const f = filedRec(t.dataset.track); if (f) { f[t.dataset.k] = t.value; save(); render(t.id); } return; }
  if (t.dataset.sheetval && t.tagName === "SELECT") { (P.sheet[t.dataset.sheetval] ||= {})[t.dataset.k] = t.value; save(); }
});
let searchT;
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "letter-text") ui.letter = t.value;
  if (t.id === "q") {  // results as you type, without re-rendering the box (keeps focus and the keyboard up)
    ui.q = t.value; clearTimeout(searchT);
    searchT = setTimeout(() => { const box = document.getElementById("results"); if (box) box.innerHTML = searchResults(ui.q, true); }, 120);
  }
  if (t.dataset.profile) { P.profile[t.dataset.profile] = t.value; save(); }
  if (t.dataset.contact) { P.contact[t.dataset.contact] = t.value; save(); }
  if (t.dataset.sheetval && t.tagName === "INPUT") { (P.sheet[t.dataset.sheetval] ||= {})[t.dataset.k] = t.value; save(); }
  if (t.dataset.track && t.dataset.k === "conf") { const f = filedRec(t.dataset.track); if (f) { f.conf = t.value; save(); } }
  // Keep landlord-message templates in step with what's typed, without re-rendering (which would steal focus).
  document.querySelectorAll("[id^='tmpl-']").forEach(el => { const s = byId(el.id.slice(5)); if (s && s.template) el.textContent = fillTemplate(s); });
});
document.addEventListener("submit", e => {
  e.preventDefault();
  if (e.target.id === "letterform") { ui.letter = document.getElementById("letter-text").value; ui.letterResult = ui.letter.trim() ? E.analyzeMessage(ui.letter, S) : null; render(); }
  if (e.target.id === "searchform") { ui.q = document.getElementById("q").value; render("q"); }
});

const getJSON = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); });
Promise.all([getJSON("real-settlements.json"), getJSON("settlement.schema.json")]).then(([data, schema]) => {
  DOC = E.loadDocument(data, schema);
  if (DOC.rejected.length) console.warn("Skipped settlements that don't fit the data contract:", DOC.rejected);
  S = DOC.records; BYID = new Map(S.map(s => [s.id, s]));
  TOPICS = schema.$defs.topic.enum; TOPIC_LABEL = schema.$defs.topic["x-labels"]; PAYS = schema.$defs.paymentMethod.enum;
  IX = E.buildIndex(S, DOC.synonyms);
  P = E.finishState(E.sanitizeState(readSaved(), TODAY_ISO), S);
  // Returning visitor: name the open settlements that are new since last time and match their saved answers.
  ui.firstVisit = !P.lastVisit;
  const hadAnswers = Object.keys(P.door).length || Object.keys(P.answers).length;
  if (P.lastVisit && P.lastVisit < TODAY_ISO && hadAnswers) {
    ui.returning = P.done; ui.prevVisit = P.lastVisit;
    if (Array.isArray(P.seen)) { const seen = new Set(P.seen); classify().matches.forEach(r => { if (!seen.has(r.s.id)) ui.newIds.add(r.s.id); }); }
  }
  P.seen = S.filter(s => effStatus(s) !== "ended").map(s => s.id); P.lastVisit = TODAY_ISO; save();
  renderData(); render();
}, err => {
  console.error(err);
  document.getElementById("view").innerHTML = `<div class="empty"><h3>The settlement list didn't load</h3><p>Check your connection and reload the page.</p></div>`;
  document.getElementById("datasum").textContent = "Data unavailable.";
});
})();

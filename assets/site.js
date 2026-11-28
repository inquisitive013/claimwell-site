/* Claimwell public site: small extras on top of pages that work without JavaScript.
   Nothing here stores or sends anything. */
(function () {
  "use strict";
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var now = new Date();
  var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  var days = function (iso) { return Math.round((new Date(iso + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5); };

  // Keep "N days left" right even when the page was built a few days ago.
  document.querySelectorAll("[data-left]").forEach(function (el) {
    var n = days(el.getAttribute("data-left"));
    el.textContent = n < 0 ? "deadline passed" : n === 0 ? "last day today" : n === 1 ? "1 day left" : n + " days left";
    el.classList.toggle("hot", n <= 14);
  });

  // Quick check on a settlement page.
  document.querySelectorAll("[data-quiz]").forEach(function (quiz) {
    quiz.hidden = false;
    var items = Array.prototype.slice.call(quiz.querySelectorAll("[data-ok]"));
    var verdicts = quiz.querySelectorAll("[data-v]");
    quiz.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-a]");
      if (!b) return;
      var li = b.closest("[data-ok]"), a = b.getAttribute("data-a");
      li.setAttribute("data-answer", a);
      li.querySelectorAll("button[data-a]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
      li.querySelector(".why").hidden = a === "unsure" || a === li.getAttribute("data-ok");
      var answers = items.map(function (x) { return [x.getAttribute("data-answer"), x.getAttribute("data-ok")]; });
      var out = answers.some(function (p) { return p[0] && p[0] !== "unsure" && p[0] !== p[1]; }) ? "no"
        : answers.some(function (p) { return p[0] === "unsure"; }) ? "unsure"
        : answers.every(function (p) { return p[0] === p[1]; }) ? "yes" : "";
      verdicts.forEach(function (v) { v.hidden = v.getAttribute("data-v") !== out; });
    });
  });

  // Share a settlement with someone it might apply to.
  document.querySelectorAll("[data-share]").forEach(function (b) {
    if (!navigator.share && !(navigator.clipboard && navigator.clipboard.writeText)) return;
    b.hidden = false;
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-share"), url = location.href.split("#")[0];
      if (navigator.share) { navigator.share({ title: document.title, text: text, url: url }).catch(function () {}); return; }
      navigator.clipboard.writeText(text + " " + url).then(function () {
        b.textContent = "Link copied";
        setTimeout(function () { b.textContent = "Share"; }, 2000);
      }, function () {});
    });
  });

  // Filter the settlement list as you type.
  var box = document.querySelector("[data-filter]");
  if (box) {
    box.hidden = false;
    var input = box.querySelector("input"), none = box.querySelector(".none");
    var fold = function (s) {
      return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").toLowerCase().trim();
    };
    input.addEventListener("input", function () {
      var words = fold(input.value).split(/\s+/).filter(Boolean), shown = 0;
      document.querySelectorAll("[data-group]").forEach(function (g) {
        var inGroup = 0;
        g.querySelectorAll(".card").forEach(function (c) {
          var t = " " + c.getAttribute("data-text");
          var hit = words.every(function (w) { return t.indexOf(" " + w) >= 0; });
          c.hidden = !hit;
          if (hit) inGroup++;
        });
        g.hidden = !inGroup;
        shown += inGroup;
      });
      none.hidden = shown > 0;
    });
  }
})();

/**
 * Quiz Run: the game Margin Chat adds to a vault so any document's questions can be played.
 * It is an ordinary HTML page in the vault. It holds no questions of its own; it asks
 * `marginChat.getQuestions()` for them and keeps its record in localStorage, which syncs with the vault.
 */
export const QUIZ_RUN_FILE_NAME = "Quiz Run.html";

export const QUIZ_RUN_HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quiz Run</title>
<style>
:root{--bg:#f7f8f6;--card:#fff;--ink:#17211d;--muted:#5f6f68;--line:#d9e0dc;--go:#2f8a64;--go-soft:#e2f2ea;--no:#c2543a;--no-soft:#fbe9e3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0c1418;--card:#131d23;--ink:#ecf4ef;--muted:#97a9a2;--line:#27363d;--go:#7acaa4;--go-soft:#173328;--no:#ff8d6d;--no-soft:#3a2119}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:680px;margin:0 auto;padding:20px 16px 40px;display:flex;flex-direction:column;gap:14px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-size:1.1rem;margin:0}.stats{display:flex;gap:14px;color:var(--muted);font-size:.9rem;font-variant-numeric:tabular-nums}.stats b{color:var(--ink)}
.track{height:6px;border-radius:3px;background:var(--line);overflow:hidden}.track i{display:block;height:100%;background:var(--go);transition:width .25s}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px}
.deck{font-size:.78rem;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}
.q{font-size:1.1rem;margin:0;overflow-wrap:anywhere}.a{margin:0;border-left:3px solid var(--go);padding-left:10px;overflow-wrap:anywhere}
code{font:.9em ui-monospace,Menlo,monospace;background:var(--bg);padding:1px 5px;border-radius:4px}pre{background:var(--bg);border-radius:8px;padding:10px;overflow-x:auto;margin:0}pre code{background:none;padding:0}
.choices{display:flex;flex-direction:column;gap:8px}
button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 14px;text-align:left}
button:hover:not(:disabled){border-color:var(--go)}button:focus-visible{outline:2px solid var(--go);outline-offset:2px}button:disabled{cursor:default}
button.primary{background:var(--go);border-color:var(--go);color:var(--bg);font-weight:600;text-align:center}
button.right{border-color:var(--go);background:var(--go-soft)}button.wrong{border-color:var(--no);background:var(--no-soft)}
.row{display:flex;gap:8px;flex-wrap:wrap}.row button{flex:1;text-align:center}
.verdict{font-weight:600}.verdict.ok{color:var(--go)}.verdict.miss{color:var(--no)}
.muted{color:var(--muted)}.empty h2{margin:0;font-size:1.05rem}
</style></head><body><main id="app"></main>
<script>
(function () {
  var KEY = "quiz-run:v1", app = document.getElementById("app");
  var S = load(), questions = [], order = [], at = 0, picked = null, shown = false, run = { right: 0, asked: 0, streak: 0 };
  function load() { try { var v = JSON.parse(localStorage.getItem(KEY) || "{}"); return { seen: v.seen || {}, best: v.best || 0, total: v.total || 0 }; } catch (e) { return { seen: {}, best: 0, total: 0 }; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function md(s) {
    var parts = String(s).split(/\x60\x60\x60[a-z]*\n?([\s\S]*?)\x60\x60\x60/);
    return parts.map(function (part, i) {
      if (i % 2) return "<pre><code>" + esc(part.replace(/\n$/, "")) + "</code></pre>";
      return esc(part).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    }).join("");
  }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  // Missed questions come first, then ones never seen, then the rest.
  function rank(q) { var r = S.seen[q.id]; return !r ? 1 : r.wrong > r.right ? 0 : 2; }
  function plan() { order = shuffle(questions).sort(function (a, b) { return rank(a) - rank(b); }); at = 0; picked = null; shown = false; run = { right: 0, asked: 0, streak: 0 }; }
  // A question without choices gets them from other short answers when there are enough; otherwise you mark yourself.
  function choicesFor(q) {
    if (q.choices) return { list: q.choices, correct: q.correct };
    var short = function (x) { return !x.choices && x.answer && x.answer.length <= 90 && x.answer.indexOf("\n") < 0; };
    if (!short(q)) return null;
    var seen = {}; seen[q.answer] = 1;
    var others = shuffle(questions.filter(function (x) { if (x.id === q.id || !short(x) || seen[x.answer]) return false; seen[x.answer] = 1; return true; })).slice(0, 3);
    if (others.length < 3) return null;
    var list = shuffle(others.map(function (x) { return x.answer; }).concat([q.answer]));
    return { list: list, correct: list.indexOf(q.answer) };
  }
  var current = null;
  function mark(ok) {
    var q = order[at], r = S.seen[q.id] || (S.seen[q.id] = { right: 0, wrong: 0 });
    if (ok) { r.right++; run.right++; run.streak++; } else { r.wrong++; run.streak = 0; }
    run.asked++; S.total++; if (run.streak > S.best) S.best = run.streak; save();
  }
  function render() {
    if (!questions.length) {
      app.innerHTML = '<section class="card empty"><h2>No questions yet</h2><p class="muted">Quiz Run asks the flashcards and quiz questions in your notes. In Margin Chat, press <b>Questions</b> above this game to pick the notes it asks from, or have AI write some.</p></section>';
      return;
    }
    var head = '<header><h1>Quiz Run</h1><div class="stats"><span>Streak <b>' + run.streak + '</b></span><span>Best <b>' + S.best + '</b></span><span><b>' + run.right + '</b> of ' + run.asked + '</span></div></header>'
      + '<div class="track"><i style="width:' + Math.round(100 * at / order.length) + '%"></i></div>';
    if (at >= order.length) {
      app.innerHTML = head + '<section class="card"><p class="q">Round done: ' + run.right + ' of ' + run.asked + ' right.</p><p class="muted">Missed questions come first next round.</p><button class="primary" data-a="again">Play again</button></section>';
      return;
    }
    var q = order[at]; if (!current || current.id !== q.id) current = { id: q.id, c: choicesFor(q) };
    var c = current.c, body = '<div class="deck">' + esc(q.deck) + ' · question ' + (at + 1) + ' of ' + order.length + '</div><p class="q">' + md(q.question) + '</p>';
    if (c) {
      body += '<div class="choices">' + c.list.map(function (text, i) {
        var cls = picked === null ? "" : i === c.correct ? "right" : i === picked ? "wrong" : "";
        return '<button class="' + cls + '" data-a="pick" data-i="' + i + '"' + (picked === null ? "" : " disabled") + '>' + md(text) + '</button>';
      }).join("") + '</div>';
      if (picked !== null) body += '<p class="verdict ' + (picked === c.correct ? "ok" : "miss") + '">' + (picked === c.correct ? "Correct" : "Not quite") + '</p>'
        + (q.choices && q.answer ? '<p class="a">' + md(q.answer) + '</p>' : "") + '<button class="primary" data-a="next">Next</button>';
    } else if (!shown) {
      body += '<button class="primary" data-a="show">Show answer</button>';
    } else {
      body += '<p class="a">' + md(q.answer) + '</p><div class="row"><button data-a="miss">Not yet</button><button class="primary" data-a="knew">I knew it</button></div>';
    }
    app.innerHTML = head + '<section class="card">' + body + '</section>';
  }
  app.addEventListener("click", function (event) {
    var b = event.target.closest("button[data-a]"); if (!b) return;
    var a = b.getAttribute("data-a");
    if (a === "pick" && picked === null) { picked = Number(b.getAttribute("data-i")); mark(picked === current.c.correct); }
    else if (a === "show") shown = true;
    else if (a === "knew" || a === "miss") { mark(a === "knew"); at++; shown = false; }
    else if (a === "next") { at++; picked = null; }
    else if (a === "again") plan();
    render();
  });
  function take(content) {
    var next = (content && content.questions) || [];
    var same = next.length === questions.length && next.every(function (q, i) { return q.id === questions[i].id && q.question === questions[i].question; });
    if (same) return;
    // New questions join the round in progress; the question on screen stays.
    var fresh = next.filter(function (q) { return !questions.some(function (o) { return o.id === q.id; }); });
    var started = questions.length && at < order.length && run.asked + (picked !== null || shown ? 1 : 0) > 0;
    questions = next;
    if (started) { var keep = {}; next.forEach(function (q) { keep[q.id] = q; }); order = order.slice(0, at + 1).filter(function (q) { return keep[q.id]; }).concat(order.slice(at + 1).filter(function (q) { return keep[q.id]; }), fresh); at = Math.min(at, order.length); }
    else plan();
    render();
  }
  render();
  if (window.marginChat) { window.marginChat.getQuestions().then(take); window.marginChat.onQuestions(take); }
})();
</script></body></html>
`;
